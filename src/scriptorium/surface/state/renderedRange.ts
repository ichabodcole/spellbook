// The DOM half of E51: turning what the human highlighted in the rendered view
// into offsets in the source, and a note's source range back into something
// paintable.
//
// ⛔ DELIBERATELY THIN. Everything decidable without a DOM lives in
// `projection.ts` and has cells; this file only walks nodes and builds Ranges,
// because that is the part a unit test cannot reach. If a rule starts forming
// here, it belongs next door.
import {
  alignRuns,
  type Projection,
  type RunPlacement,
  runOffset,
  toPlain,
  toSource,
} from "./projection";

/** Every text node under `root`, in document order. */
export function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** The rendered text nodes, each with where it begins in the projection. */
export type Aligned = { nodes: Text[]; starts: (RunPlacement | null)[] };

export function align(root: Node, p: Projection): Aligned {
  const nodes = textNodes(root);
  return {
    nodes,
    starts: alignRuns(
      p.plain,
      nodes.map((n) => n.data),
    ),
  };
}

/**
 * The projection offset of one DOM point.
 *
 * `dir` decides what happens at a point the projection has no offset for — the
 * whitespace between two block tags, say. A START looks FORWARD to the next
 * real text and an END looks BACK to the previous one, so a selection dragged
 * past the end of a paragraph covers that paragraph rather than swallowing the
 * gap after it.
 */
function plainAt(a: Aligned, container: Node, offset: number, dir: "start" | "end"): number | null {
  // A selection boundary can sit on an ELEMENT, with `offset` counting child
  // nodes rather than characters — dragging past the last word of a block is
  // the common way to get one. Resolve it to a text node first.
  let node: Text | null = null;
  let within = offset;
  if (container.nodeType === Node.TEXT_NODE) {
    node = container as Text;
  } else {
    const kids = container.childNodes;
    const at = Math.min(offset, kids.length - 1);
    const from = kids[Math.max(0, at)] ?? container;
    const inside = textNodes(from);
    node = (dir === "start" ? inside[0] : inside[inside.length - 1]) ?? null;
    within = dir === "start" ? 0 : (node?.data.length ?? 0);
  }
  if (!node) return null;

  const i = a.nodes.indexOf(node);
  if (i === -1) return null;
  const own = a.starts[i];
  if (own) return runOffset(own, Math.min(within, node.data.length));

  // This run is not in the projection. Take the nearest one that is.
  if (dir === "start") {
    for (let j = i + 1; j < a.starts.length; j++) {
      const s = a.starts[j];
      if (s) return s.at;
    }
    return null;
  }
  for (let j = i - 1; j >= 0; j--) {
    const s = a.starts[j];
    if (s) return runOffset(s, a.nodes[j]?.data.length ?? 0);
  }
  return null;
}

/**
 * Where a DOM selection is in the SOURCE, or null when it cannot be placed.
 *
 * Null is a real answer and callers must treat it as one: a selection wholly
 * inside something the projection does not carry has no source range, and
 * inventing one would anchor a note onto whatever happened to be nearby.
 */
export function resolveRange(
  root: Node,
  p: Projection,
  range: Range,
): { from: number; to: number } | null {
  const a = align(root, p);
  const lo = plainAt(a, range.startContainer, range.startOffset, "start");
  const hi = plainAt(a, range.endContainer, range.endOffset, "end");
  if (lo === null || hi === null) return null;
  const { from, to } = toSource(p, Math.min(lo, hi), Math.max(lo, hi));
  return from === to ? null : { from, to };
}

/** A Range over the rendered text for a SOURCE range — what a highlight needs. */
export function paintRange(
  a: Aligned,
  p: Projection,
  srcFrom: number,
  srcTo: number,
): Range | null {
  const plain = toPlain(p, srcFrom, srcTo);
  if (!plain || plain.to <= plain.from) return null;
  let start: { node: Text; offset: number } | null = null;
  let end: { node: Text; offset: number } | null = null;
  for (let i = 0; i < a.nodes.length; i++) {
    const s = a.starts[i];
    const node = a.nodes[i];
    if (!s || !node) continue;
    // The node's own span in `plain`, which excludes the leading characters it
    // has and the projection does not.
    const e = runOffset(s, node.data.length);
    if (!start && plain.from < e) start = { node, offset: s.lead + Math.max(0, plain.from - s.at) };
    if (plain.to > s.at && plain.to <= e) end = { node, offset: s.lead + (plain.to - s.at) };
    else if (plain.to > e) end = { node, offset: node.data.length };
  }
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.node, Math.min(start.offset, start.node.data.length));
    range.setEnd(end.node, Math.min(end.offset, end.node.data.length));
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

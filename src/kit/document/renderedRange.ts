// The DOM half of the rendered view's selection: turning what the reader
// highlighted into offsets in the source, and a note's source range back into
// something paintable.
//
// Deliberately thin. Everything decidable without a DOM lives in `projection.ts`
// and has tests; this file only walks nodes and builds Ranges, which is the part a
// unit test cannot reach. If a rule starts forming here, it belongs next door.
import type { Anchor } from "./place";
import { sourceLine } from "./place";
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
 * The projection offset of one DOM point. `dir` decides what happens at a point
 * the projection has no offset for (the whitespace between two block tags): a start
 * looks forward to the next real text and an end looks back to the previous one, so
 * a selection dragged past the end of a paragraph covers that paragraph rather than
 * swallowing the gap after it.
 */
function plainAt(a: Aligned, container: Node, offset: number, dir: "start" | "end"): number | null {
  // A selection boundary can sit on an element, with `offset` counting child nodes
  // rather than characters (dragging past the last word of a block is the common
  // way to get one). Resolve it to a text node first.
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
 * Where a DOM selection is in the SOURCE, or null when it cannot be placed. Null is
 * a real answer: a selection wholly inside something the projection does not carry
 * has no source range, and inventing one would anchor a note onto whatever happened
 * to be nearby.
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
  // ⛔ A START PAST ITS END IS A SELECTION THE PROJECTION CANNOT PLACE, never one
  // to turn round. A DOM range runs forwards, so the two cross only when both
  // ends fell in text with no place (a run that did not align) and each borrowed
  // its neighbour: the start the next placed run, the end the previous one.
  // Swapped, that covered everything between those neighbours, and "alpha"
  // became a note over the whole body (kit-lone-cr-line-endings).
  if (lo > hi) return null;
  const { from, to } = toSource(p, lo, hi);
  return from === to ? null : { from, to };
}

/** A Range over the rendered text for a SOURCE range: what a highlight needs. */
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
    // The node's own span in `plain`, which excludes the leading characters it has
    // and the projection does not.
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

/**
 * Where each rendered block begins: the source line it came from, and its top in
 * the scroller's own coordinates. The unit is an element with text of its own, not
 * a top-level block: a list has no text of its own and its items do, so anchoring
 * at the list would make a fifty-item list one anchor. Walking every element and
 * keeping the ones with a placed text node directly under them gives a paragraph, a
 * list item, a heading, a table cell and a code block one anchor each.
 *
 * Kept strictly increasing in both line and top, because interpolation between
 * anchors is only meaningful if it is monotone: an out-of-order entry (a blockquote
 * and the paragraph inside it share a line) is dropped rather than reconciled.
 * Whitespace-only runs are not an element's line: micromark puts a newline between a
 * blockquote and the paragraph inside it, and that run is placed at the end of the
 * previous block.
 */
export function lineAnchors(
  root: HTMLElement,
  scroller: HTMLElement,
  p: Projection,
  text: string,
): Anchor[] {
  const a = align(root, p);
  const where = new Map<Text, number>();
  for (let i = 0; i < a.nodes.length; i++) where.set(a.nodes[i] as Text, i);
  // The scroller's content origin: `top` is relative to the viewport, so adding the
  // current scroll back gives a position that does not move when it does.
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const out: Anchor[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    let placed: RunPlacement | null = null;
    for (const child of el.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE) continue;
      if ((child as Text).data.trim() === "") continue;
      const i = where.get(child as Text);
      if (i === undefined) continue;
      const s = a.starts[i];
      if (s) {
        placed = s;
        break;
      }
    }
    if (!placed) continue;
    const line = sourceLine(p, text, placed.at);
    const top = el.getBoundingClientRect().top - origin;
    const last = out[out.length - 1];
    if (last && (line <= last.line || top <= last.top)) continue;
    out.push({ line, top });
  }
  return out;
}

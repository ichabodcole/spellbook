// Mod-click on a link in the raw editor follows it (kit-heading-links-build,
// decision 2), the convention in VS Code and Obsidian's source mode. A plain
// click still places the caret, so editing a link's text stays as it was.
//
// Which link is under the pointer is read from the clicked line alone, with
// the same shapes the link layer reads (`[label](target)`, `[label](<target>)`,
// `![alt](target)`, `[[name|label]]`) and bare web addresses; a link inside
// code is an example, not a link, and is left alone.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type LinkAct, linkAct } from "../chat/renderedLink.ts";
import { linkScheme } from "../lib/linkTarget.ts";
import { caretInCode } from "../lib/markdownCode.ts";
import { onMac } from "../lib/platform.ts";

/** One label character: anything but a bracket. */
const LABEL = String.raw`(?:[^\[\]\n]|\[[^\[\]\n]*\])*`;
/** `[label](target)` or `[label](<target>)`, with an optional title; `!` for an image. */
const MD_LINK = new RegExp(
  String.raw`!?\[${LABEL}\]\(\s*(?:<([^>\n]*)>|((?:[^\s()]|\([^\s()]*\))*))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)`,
  "g",
);
const WIKI_LINK = /\[\[([^[\]\n]+)\]\]/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()[\]]+/g;
/** A backslash escape: markdown's, of any ASCII punctuation. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;

/** A link on a line: its target as written and where the whole link sits on the line. */
export type LineLink = { href: string; from: number; to: number };

/**
 * The link on `line` that covers offset `at` (0-based, within the line), or
 * null. A markdown link's target is returned as written, escapes undone; a
 * wiki link's is its name (`name#Heading` keeps its heading).
 */
export function linkAt(line: string, at: number): LineLink | null {
  const covers = (from: number, to: number) => at >= from && at <= to;
  const taken: [number, number][] = [];
  for (const m of line.matchAll(MD_LINK)) {
    const from = m.index;
    const to = from + m[0].length;
    taken.push([from, to]);
    if (!covers(from, to)) continue;
    const href = (m[1] ?? m[2] ?? "").replace(ESCAPE, "$1").trim();
    return href === "" ? null : { href, from, to };
  }
  for (const m of line.matchAll(WIKI_LINK)) {
    const from = m.index;
    const to = from + m[0].length;
    if (taken.some(([a, b]) => from < b && to > a)) continue;
    taken.push([from, to]);
    if (!covers(from, to)) continue;
    const inner = m[1] as string;
    const pipe = inner.indexOf("|");
    const href = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    return href === "" ? null : { href, from, to };
  }
  for (const m of line.matchAll(BARE_URL)) {
    const from = m.index;
    const to = from + m[0].length;
    if (taken.some(([a, b]) => from < b && to > a)) continue;
    if (covers(from, to)) return { href: m[0], from, to };
  }
  return null;
}

/**
 * What a Mod-click on a link does with its target: the rendered view's rule
 * (`linkAct`), so a web or mail address opens outward and never reaches the
 * daemon, a `#heading` jumps in this document, and a path is followed. A
 * target with any other scheme (`op:`, `javascript:`, `data:`) does nothing:
 * the rendered view refuses those before a click can reach them.
 */
export function rawLinkAct(href: string): LinkAct {
  const act = linkAct({ href, blocked: false });
  return act.kind === "follow" && linkScheme(href) !== undefined ? { kind: "none" } : act;
}

/**
 * The editor extension: a primary-button Mod-click (Cmd on a Mac, Ctrl
 * elsewhere, read when the click happens) on a link hands its target to
 * `follow` and takes the click, so it neither moves the caret nor adds a
 * cursor. `follow` answers false to let the click through. Anywhere else, a
 * Mod-click does what CodeMirror does with one.
 */
export function modClickFollowsLinks(follow: (href: string) => boolean): Extension {
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0 || event.shiftKey || event.altKey) return false;
      if (!(onMac() ? event.metaKey : event.ctrlKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      const hit = linkAt(line.text, pos - line.from);
      if (!hit) return false;
      // Inside code, the link is an example.
      if (caretInCode(view.state.sliceDoc(0, line.from + hit.from + 1))) return false;
      if (!follow(hit.href)) return false;
      event.preventDefault();
      return true;
    },
  });
}

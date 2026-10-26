// A reveal and a clear in the same render (kit-reveal-frontmatter-and-selection).
// Opening another document at a place (a link-check entry, a search result)
// clears what was held in the document left and asks for the reveal at once. The
// clear used to run after the reveal and collapse the range it had just selected
// to its end; the reveal spends it. A clear on its own still clears.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { cleanup, installDom, mount, removeDom } from "../lib/testDom.ts";
import { DocumentView } from "./DocumentView.tsx";

beforeAll(() => {
  installDom();
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON() {},
  };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => rect;
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const TEXT = "# A\n\nsee [the ghost](./missing.md) here\n";
const from = TEXT.indexOf("[the ghost]");
const to = from + "[the ghost](./missing.md)".length;

const selected = () => {
  const v = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  const sel = v?.state.selection.main;
  return sel ? TEXT.slice(sel.from, sel.to) : null;
};
const view = (reveal: { from: number; to: number; seq: number } | null, clearSeq: number) => (
  <DocumentView docKey="a" text={TEXT} editable reveal={reveal} clearSeq={clearSeq} />
);

test("a reveal that comes with a clear keeps its whole range", async () => {
  const m = await mount(view(null, 0));
  await m.render(view({ from, to, seq: 1 }, 1));
  expect(selected()).toBe("[the ghost](./missing.md)");
  await m.unmount();
});

test("a clear on its own, after a reveal, still collapses the selection", async () => {
  const m = await mount(view(null, 0));
  await m.render(view({ from, to, seq: 1 }, 0));
  expect(selected()).toBe("[the ghost](./missing.md)");
  // Spent, as the pane spends it, and then the chip's X.
  await m.render(view(null, 0));
  await m.render(view(null, 1));
  expect(selected()).toBe("");
  await m.unmount();
});

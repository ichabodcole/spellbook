// The raw editor's line-number gutter (scriptorium-toggle-line-numbers-in-raw-mode).
// Turning it on or off reconfigures the editor in place, through a compartment:
// the editor is the same one after, with its scroll, its selection and its undo
// history. A quiet reading mode fades the gutter and never hides it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { isolateHistory, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { DocumentView, QUIET_GUTTER_CLASS } from "./DocumentView.tsx";

beforeAll(() => {
  installDom();
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
afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await removeDom();
});

const TEXT = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the story.`).join("\n");

function view(): EditorView {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  const v = dom && EditorView.findFromDOM(dom);
  if (!v) throw new Error("no editor");
  return v;
}
const gutters = () => document.querySelectorAll(".cm-lineNumbers").length;

test("turning the numbers on and off keeps the editor, its scroll, its selection and its undo", async () => {
  const at = (lineNumbers: boolean) => (
    <DocumentView docKey="d" text={TEXT} editable lineNumbers={lineNumbers} />
  );
  const m = await mount(at(false));
  await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor to mount");
  expect(gutters()).toBe(0);
  const before = view();

  // Two edits, each its own undo step, then a selection and a scroll.
  await settle(() => {
    before.dispatch({ changes: { from: 0, insert: "A" }, userEvent: "input.type" });
    before.dispatch({
      changes: { from: 1, insert: "B" },
      userEvent: "input.type",
      annotations: isolateHistory.of("full"),
    });
    before.dispatch({ selection: { anchor: 40, head: 52 } });
    before.scrollDOM.scrollTop = 180;
  });
  const edited = before.state.doc.toString();
  expect(edited.startsWith("ABLine 1")).toBe(true);

  await m.render(at(true));
  expect(gutters()).toBe(1);
  // The gutter's numbers are the source lines (past CodeMirror's hidden width spacer).
  const numbers = [...document.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")]
    .filter((e) => e.style.visibility !== "hidden")
    .map((e) => e.textContent)
    .filter((t) => t && /^\d+$/.test(t));
  expect(numbers.slice(0, 3)).toEqual(["1", "2", "3"]);
  const after = view();
  expect(after).toBe(before);
  expect(after.state.doc.toString()).toBe(edited);
  expect(after.state.selection.main.from).toBe(40);
  expect(after.state.selection.main.to).toBe(52);
  expect(after.scrollDOM.scrollTop).toBe(180);

  await m.render(at(false));
  expect(gutters()).toBe(0);
  expect(view()).toBe(before);
  // The history came through both toggles: one undo takes back the second edit.
  await settle(() => {
    undo(view());
  });
  expect(view().state.doc.toString().startsWith("ALine 1")).toBe(true);
});

test("JSON is numbered whatever the choice, and the choice adds no second gutter", async () => {
  const json = '{\n  "a": 1\n}\n';
  const m = await mount(<DocumentView docKey="j" text={json} format="json" lineNumbers={false} />);
  await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor to mount");
  expect(gutters()).toBe(1);
  await m.render(<DocumentView docKey="j" text={json} format="json" lineNumbers />);
  expect(gutters()).toBe(1);
  await m.render(<DocumentView docKey="j" text={json} format="json" lineNumbers={false} />);
  expect(gutters()).toBe(1);
});

test("a quiet reading mode fades the gutter, never hides it, and the editor stays the same", async () => {
  const at = (quiet: boolean) => (
    <DocumentView docKey="d" text={TEXT} editable lineNumbers quiet={quiet} />
  );
  const m = await mount(at(false));
  await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor to mount");
  const before = view();
  expect(before.dom.classList.contains(QUIET_GUTTER_CLASS)).toBe(false);

  await m.render(at(true));
  expect(view()).toBe(before);
  expect(before.dom.classList.contains(QUIET_GUTTER_CLASS)).toBe(true);
  expect(gutters()).toBe(1);
  // The fade is the chrome's: 40%, back at full strength under the pointer. The
  // editor's theme is a stylesheet CodeMirror mounts, read here as text.
  const css = [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n");
  expect(css).toMatch(/\.cm-quiet[^{]*\.cm-gutters\s*\{[^}]*opacity:\s*0\.4/);
  expect(css).toMatch(/\.cm-quiet[^{]*\.cm-gutters:hover\s*\{[^}]*opacity:\s*1/);
  expect(css).not.toMatch(/\.cm-quiet[^{]*\.cm-gutters\s*\{[^}]*display:\s*none/);

  await m.render(at(false));
  expect(before.dom.classList.contains(QUIET_GUTTER_CLASS)).toBe(false);
  expect(gutters()).toBe(1);
});

test("the gutter is drawn in the kit's tokens, for JSON and for markdown alike", async () => {
  // A fresh document for each: CodeMirror mounts a theme's rules once per document.
  const themed = () =>
    /\.cm-gutters\s*\{[^}]*border-right:\s*1px solid var\(--color-edge\)/.test(
      [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
    );
  for (const props of [{ format: "json" as const }, { lineNumbers: true }]) {
    await cleanup();
    await removeDom();
    installDom();
    const text = props.lineNumbers ? TEXT : '{\n  "a": 1\n}\n';
    await mount(<DocumentView docKey="t" text={text} {...props} />);
    await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor to mount");
    expect(gutters()).toBe(1);
    expect(themed()).toBe(true);
  }
});

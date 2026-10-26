// Tab in the raw editor indents, and Shift-Tab outdents, rather than moving focus
// to the next control (kit-editor-tab-indents). A keyboard still has a way out:
// Escape, then Tab, leaves the key to the browser, which moves focus on.
//
// The DOM here has no default action for Tab, so "focus moves on" is read as
// what decides it in a browser: the editor did not take the key (the event is
// not default-prevented) and the text is unchanged.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { DocumentView } from "./DocumentView.tsx";

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

const KEY_CODES: Record<string, number> = { Tab: 9, Escape: 27 };

function view(): EditorView {
  const dom = document.querySelector<HTMLElement>(".cm-editor");
  const v = dom && EditorView.findFromDOM(dom);
  if (!v) throw new Error("no editor");
  return v;
}

/** Press `key` in the editor; returns whether the editor took it (prevented the browser's default). */
async function press(key: string, shiftKey = false): Promise<boolean> {
  const event = new window.KeyboardEvent("keydown", {
    key,
    code: key,
    keyCode: KEY_CODES[key],
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  await settle(() => {
    view().contentDOM.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

/**
 * Mount an editor on `text` with the selection from `caret` to `head`, focused
 * unless `focus` is false. A range selected in a focused editor is left
 * unfocused: the test DOM reports the selection CodeMirror draws while
 * CodeMirror is still drawing it, which a browser does not, and CodeMirror
 * then complains.
 */
async function editorOn(
  text: string,
  caret: number,
  { editable = true, head = caret, focus = true } = {},
) {
  await mount(<DocumentView docKey="d" text={text} editable={editable} />);
  await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor to mount");
  await settle(() => {
    const v = view();
    v.dispatch({ selection: { anchor: caret, head } });
    if (focus) v.focus();
  });
  if (focus) await waitFor(() => view().hasFocus, "the editor to take focus");
}

const doc = () => view().state.doc.toString();

test("Tab indents the caret's line and focus stays in the editor", async () => {
  await editorOn("first\nsecond\n", 8);
  expect(await press("Tab")).toBe(true);
  await waitFor(() => doc() === "first\n  second\n", "the second line to be indented");
  expect(view().hasFocus).toBe(true);
  expect(document.activeElement).toBe(view().contentDOM);
});

test("Tab indents every line of a selection", async () => {
  await editorOn("one\ntwo\nthree\n", 1, { head: 6, focus: false });
  expect(await press("Tab")).toBe(true);
  await waitFor(() => doc() === "  one\n  two\nthree\n", "both selected lines to be indented");
});

test("Tab in a list item nests it", async () => {
  await editorOn("- one\n- two\n", 9);
  expect(await press("Tab")).toBe(true);
  await waitFor(() => doc() === "- one\n  - two\n", "the item to be nested");
});

test("Shift-Tab outdents the caret's line", async () => {
  await editorOn("first\n    second\n", 10);
  expect(await press("Tab", true)).toBe(true);
  await waitFor(() => doc() === "first\n  second\n", "the second line to be outdented");
  expect(view().hasFocus).toBe(true);
});

test("Escape and then Tab leave the key to the browser, so focus moves on", async () => {
  await editorOn("first\nsecond\n", 8);
  expect(await press("Escape")).toBe(false);
  expect(await press("Tab")).toBe(false);
  expect(doc()).toBe("first\nsecond\n");
  // Any other key typed in the editor ends the way out, and Tab indents again.
  await settle(() => {
    view().contentDOM.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "a", keyCode: 65, bubbles: true }),
    );
  });
  expect(await press("Tab")).toBe(true);
  await waitFor(() => doc() === "first\n  second\n", "Tab to indent again");
});

// The default keymap's Escape first collapses a selection, and a key the editor
// takes does not arm the way out; the next Escape does.
test("with text selected, the first Escape collapses it and the second opens the way out", async () => {
  await editorOn("first\nsecond\n", 6, { head: 12, focus: false });
  expect(await press("Escape")).toBe(true);
  expect(view().state.selection.main.empty).toBe(true);
  expect(await press("Escape")).toBe(false);
  expect(await press("Tab")).toBe(false);
  expect(doc()).toBe("first\nsecond\n");
});

test("a read-only editor leaves Tab to the browser", async () => {
  await editorOn("first\nsecond\n", 8, { editable: false });
  expect(await press("Tab")).toBe(false);
  expect(doc()).toBe("first\nsecond\n");
});

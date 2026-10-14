// A later DOM test file: `registerDom.ts` is already evaluated, so CodeMirror
// loads here with no DOM registered and reads the runtime's own navigator. The
// shortcut is pressed the way the link-insert tests press it, from the platform
// the DOM reports when the test runs; both must agree on what `Mod` is.

import "../../registerDom.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { installDom, removeDom } from "../../registerDom.ts";

beforeAll(() => {
  installDom();
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
});
afterAll(async () => {
  await removeDom();
});

test("Mod-Shift-K reaches a CodeMirror keymap loaded after another file removed the DOM", () => {
  let pressed = 0;
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "text",
      extensions: keymap.of([
        {
          key: "Mod-Shift-k",
          run: () => {
            pressed++;
            return true;
          },
        },
      ]),
    }),
  });
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  view.contentDOM.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "K",
      code: "KeyK",
      keyCode: 75,
      shiftKey: true,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    }),
  );
  view.destroy();
  parent.remove();
  expect(pressed).toBe(1);
});

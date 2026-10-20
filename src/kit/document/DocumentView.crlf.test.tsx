// A file written with CRLF line ends (kit-broken-links-visible's verifier): the
// daemon's offsets count each `\r\n` as two characters, and the editor's
// document holds one. A reveal (the link check's "open at the link", search,
// backlinks) or a passage pointed at must land on the same characters, not one
// character later per line above it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { cleanup, installDom, mount, removeDom } from "../lib/testDom.ts";
import { DocumentView, editorOffset } from "./DocumentView.tsx";

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

const CRLF =
  "---\r\ntitle: Crlf\r\nrelated: [./ruin.md, ./ghost.md]\r\n---\r\n# Crlf\r\n\r\nSee [gone](./gone-crlf.md).\r\n";

const editor = () => {
  const el = document.querySelector(".cm-editor") as HTMLElement | null;
  const v = el ? EditorView.findFromDOM(el) : null;
  if (!v) throw new Error("no editor");
  return v;
};
const selected = () => {
  const v = editor();
  const s = v.state.selection.main;
  return v.state.sliceDoc(s.from, s.to);
};

test("a reveal in a CRLF file selects the characters the daemon named", async () => {
  for (const want of ["./ghost.md", "[gone](./gone-crlf.md)"]) {
    const from = CRLF.indexOf(want);
    const m = await mount(
      <DocumentView
        docKey="d"
        text={CRLF}
        editable
        reveal={{ from, to: from + want.length, seq: 1 }}
      />,
    );
    expect(selected()).toBe(want);
    await m.unmount();
  }
});

test("a heading followed in a CRLF file is marked on its own line", async () => {
  const head = "# Crlf";
  const at = CRLF.indexOf(head);
  const m = await mount(
    <DocumentView
      docKey="d"
      text={CRLF}
      editable
      reveal={{ from: at, to: at, seq: 1, heading: { from: at, to: at + head.length } }}
    />,
  );
  expect(document.querySelector(".cm-flash")?.textContent).toBe(head);
  await m.unmount();
});

test("a passage pointed at in a CRLF file is marked where the daemon said", async () => {
  const want = "./ghost.md";
  const from = CRLF.indexOf(want);
  const m = await mount(
    <DocumentView
      docKey="d"
      text={CRLF}
      editable
      flash={{ from, to: from + want.length, seq: 1 }}
    />,
  );
  expect(document.querySelector(".cm-flash")?.textContent).toBe(want);
  await m.unmount();
});

test("editorOffset: each CRLF before the offset counts once; LF, lone CR and a BOM are untouched", () => {
  expect(editorOffset("a\r\nb\r\nc", 6)).toBe(4);
  expect(editorOffset("a\r\nb", 2)).toBe(1); // between \r and \n: the line's end
  expect(editorOffset("a\nb\nc", 4)).toBe(4);
  expect(editorOffset("a\rb", 2)).toBe(2);
  expect(editorOffset("﻿a\r\nb", 4)).toBe(3);
});

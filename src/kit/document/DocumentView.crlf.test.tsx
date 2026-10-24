// A file written with CRLF line ends (kit-broken-links-visible's verifier): the
// daemon's offsets count each `\r\n` as two characters, and the editor's
// document holds one. A reveal (the link check's "open at the link", search,
// backlinks) or a passage pointed at must land on the same characters, not one
// character later per line above it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { cleanup, installDom, mount, removeDom } from "../lib/testDom.ts";
import type { PlacedNote } from "../workspace/protocol";
import { DocumentView, daemonOffset, editorOffset, type SelectionReport } from "./DocumentView.tsx";

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

test("daemonOffset undoes editorOffset; a line's end is before its \\r", () => {
  const text = "a\r\nb\r\nc";
  for (let o = 0; o <= text.length; o++) {
    // Between a \r and its \n is no editor position: it reads back as the line's end.
    const back = daemonOffset(text, editorOffset(text, o));
    expect(back).toBe(text[o - 1] === "\r" && text[o] === "\n" ? o - 1 : o);
  }
  expect(daemonOffset(text, 1)).toBe(1); // a's end, before its \r
  expect(daemonOffset(text, 2)).toBe(3); // b
  expect(daemonOffset("a\nb", 2)).toBe(2);
  expect(daemonOffset("\uFEFFa\r\nb", 3)).toBe(4);
});

// kit-crlf-note-offsets: notes are placed by the daemon in its count, and a note
// the human writes from the raw view is anchored in it.
const placed = (want: string, id = "n1"): PlacedNote => {
  const from = CRLF.indexOf(want);
  return {
    id,
    version: 1,
    quote: want,
    before: "",
    after: "",
    at: from,
    body: "b",
    by: "agent",
    createdAt: "2026-10-22T00:00:00Z",
    resolved: false,
    from,
    to: from + want.length,
    how: "context",
    fromLine: null,
    toLine: null,
  };
};

test("a note placed by the daemon in a CRLF file paints on its own words", async () => {
  const want = "[gone](./gone-crlf.md)";
  const m = await mount(
    <DocumentView
      docKey="d"
      text={CRLF}
      editable
      notes={[placed(want), placed("Crlf\r\n\r\nSee", "n2")]}
    />,
  );
  const marks = [...document.querySelectorAll(".cm-note")].map((e) => e.textContent);
  expect(marks).toContain(want);
  // A note across lines covers them, ends included, and nothing after.
  expect(marks.join("|")).not.toContain("[ge");
  expect(marks.join("")).toContain("See");
  expect(marks.join("")).not.toContain("See ");
  await m.unmount();
});

test("the passage a note is being written about paints on its own words", async () => {
  const want = "./ghost.md";
  const from = CRLF.indexOf(want);
  const m = await mount(
    <DocumentView docKey="d" text={CRLF} editable pendingNote={{ from, to: from + want.length }} />,
  );
  expect(document.querySelector(".cm-note-pending")?.textContent).toBe(want);
  await m.unmount();
});

test("a selection in a CRLF file is reported in the daemon's count, so a note on it anchors there", async () => {
  const seen: SelectionReport[] = [];
  const m = await mount(
    <DocumentView docKey="d" text={CRLF} editable onSelect={(s) => seen.push(s)} />,
  );
  const v = editor();
  const want = "[gone](./gone-crlf.md)";
  const at = v.state.doc.toString().indexOf(want);
  v.dispatch({ selection: { anchor: at, head: at + want.length } });
  const s = seen.at(-1);
  expect(s && CRLF.slice(s.from, s.to)).toBe(want);
  expect(s?.text).toBe(want);
  await m.unmount();
});

test("a right-click in a CRLF file says the daemon's count, and finds the note under it", async () => {
  const want = "[gone](./gone-crlf.md)";
  const said: { from: number; to: number; noteIds: string[] }[] = [];
  const m = await mount(
    <DocumentView
      docKey="d"
      text={CRLF}
      editable
      notes={[placed(want)]}
      onContextMenu={(a) => {
        said.push(a);
        return true;
      }}
    />,
  );
  const v = editor();
  const at = v.state.doc.toString().indexOf(want);
  v.dispatch({ selection: { anchor: at, head: at + want.length } });
  // The pointer on the note's first character: in the editor's count it is
  // before the note's daemon offsets, so only the daemon's count finds it.
  const pos = at;
  const real = v.posAtCoords;
  v.posAtCoords = (() => pos) as typeof v.posAtCoords;
  v.contentDOM.dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
  v.posAtCoords = real;
  const a = said.at(-1);
  expect(a && CRLF.slice(a.from, a.to)).toBe(want);
  expect(a?.noteIds).toEqual(["n1"]);
  await m.unmount();
});

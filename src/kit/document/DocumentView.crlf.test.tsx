// A file written with CRLF line ends (kit-broken-links-visible's verifier): the
// daemon's offsets count each `\r\n` as two characters, and the editor's
// document holds one. A reveal (the link check's "open at the link", search,
// backlinks) or a passage pointed at must land on the same characters, not one
// character later per line above it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { EditorView } from "@codemirror/view";
import { createRef } from "react";
import { cleanup, installDom, mount, removeDom } from "../lib/testDom.ts";
import type { PlacedNote } from "../workspace/protocol";
import {
  DocumentView,
  daemonOffset,
  type EditorHandle,
  editorOffset,
  type SelectionReport,
} from "./DocumentView.tsx";

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

// kit-raw-save-converts-crlf: what the editor hands out to be written keeps the
// file's line endings. CodeMirror joins its lines with `\n`, so a raw edit and
// Save turned a CRLF file into LF.
const hex = (t: string | undefined) => Buffer.from(t ?? "").toString("hex");

/** A view of `text`, and what it last handed out to be written. */
const writer = () => {
  const w = {
    read: null as (() => string) | null,
    view: (text: string) => (
      <DocumentView
        docKey="d"
        text={text}
        editable
        handle={handle}
        onChange={(r) => {
          w.read = r;
        }}
      />
    ),
    written: () => w.read?.(),
  };
  return w;
};
const handle = createRef<EditorHandle>();

test("typing in a CRLF file writes CRLF, byte for byte", async () => {
  const w = writer();
  const m = await mount(w.view(CRLF));
  const v = editor();
  const end = v.state.doc.line(5).to; // `# Crlf`
  v.dispatch({ changes: { from: end, insert: " X" }, userEvent: "input.type" });
  expect(hex(w.written())).toBe(hex(CRLF.replace("# Crlf", "# Crlf X")));
  // Enter, as the keymap inserts it.
  v.dispatch({ changes: { from: end, insert: "\n" }, userEvent: "input" });
  expect(hex(w.written())).toBe(hex(CRLF.replace("# Crlf", "# Crlf\r\n X")));
  await m.unmount();
});

test("a link written through the editor in a CRLF file keeps CRLF", async () => {
  const w = writer();
  const m = await mount(w.view(CRLF));
  const at = editor().state.doc.toString().indexOf("Crlf\n\n");
  expect(handle.current?.replaceRange(at, at + 4, "[Crlf](./c.md)")).toBe(true);
  expect(hex(w.written())).toBe(hex(CRLF.replace("# Crlf", "# [Crlf](./c.md)")));
  await m.unmount();
});

test("a mixed file keeps each line's ending; an LF file stays LF", async () => {
  const MIXED = "one\r\ntwo\nthree\r\n";
  const LF = CRLF.replaceAll("\r\n", "\n");
  for (const text of [MIXED, LF]) {
    const w = writer();
    const m = await mount(w.view(text));
    editor().dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
    expect(hex(w.written())).toBe(hex(`X${text}`));
    await m.unmount();
  }
});

test("new text from the daemon brings its own endings, in the editor's count", async () => {
  const w = writer();
  const m = await mount(w.view("a\nb\n"));
  // An agent's edit lands as CRLF: applied as one change, its endings kept.
  const next = "a\r\nb and more\r\n";
  await m.render(w.view(next));
  const v = editor();
  expect(v.state.doc.toString()).toBe("a\nb and more\n");
  v.dispatch({ changes: { from: 0, insert: "Z" }, userEvent: "input.type" });
  const mine = w.written() ?? "";
  expect(hex(mine)).toBe(hex(`Z${next}`));
  // Its own text coming back is not news: nothing moves.
  await m.render(w.view(mine));
  expect(editor().state.doc.toString()).toBe("Za\nb and more\n");
  // The same characters with other endings (the file converted on disk): the
  // endings change, with nothing to apply to the characters.
  const lf = mine.replaceAll("\r\n", "\n");
  await m.render(w.view(lf));
  editor().dispatch({ changes: { from: 0, insert: "Y" }, userEvent: "input.type" });
  expect(hex(w.written())).toBe(hex(`Y${lf}`));
  await m.unmount();
});

test("links written in the rendered view of a CRLF file replay onto their own words", async () => {
  // In the daemon's count, as the rendered view takes them: the second after the first.
  const a = CRLF.indexOf("gone]");
  const first = { from: a, to: a + 4, insert: "GONE\r\nnow" };
  const mid = CRLF.slice(0, a) + first.insert + CRLF.slice(a + 4);
  const b = mid.indexOf("Crlf\r\n\r\n");
  const second = { from: b, to: b + 4, insert: "[Crlf](./c.md)" };
  const text = mid.slice(0, b) + second.insert + mid.slice(b + 4);
  const w = writer();
  const m = await mount(
    <DocumentView
      docKey="d"
      text={text}
      editable
      replay={{ base: CRLF, changes: [first, second] }}
      onChange={(r) => {
        w.read = r;
      }}
    />,
  );
  expect(editor().state.doc.toString()).toBe(text.replaceAll("\r\n", "\n"));
  // And the next key typed writes the text with the file's endings.
  editor().dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
  expect(hex(w.written())).toBe(hex(`X${text}`));
  await m.unmount();
});

test("a replayed step's break keeps the ending it was written with", async () => {
  // The rendered view wrote an LF break into a CRLF file: the daemon's text
  // holds that LF, and the next key typed in the raw view must write it so.
  const a = CRLF.indexOf("gone]");
  const step = { from: a, to: a + 4, insert: "GONE\nnow" };
  const text = CRLF.slice(0, a) + step.insert + CRLF.slice(a + 4);
  const w = writer();
  const m = await mount(
    <DocumentView
      docKey="d"
      text={text}
      editable
      replay={{ base: CRLF, changes: [step] }}
      onChange={(r) => {
        w.read = r;
      }}
    />,
  );
  editor().dispatch({ changes: { from: 0, insert: "X" }, userEvent: "input.type" });
  expect(hex(w.written())).toBe(hex(`X${text}`));
  await m.unmount();
});

test("a selection across a break quotes the file's ending", async () => {
  const seen: SelectionReport[] = [];
  const m = await mount(
    <DocumentView docKey="d" text={CRLF} editable onSelect={(s) => seen.push(s)} />,
  );
  const want = "Crlf\r\n\r\nSee";
  const v = editor();
  const at = v.state.doc.toString().indexOf("Crlf\n\nSee");
  v.dispatch({ selection: { anchor: at, head: at + 9 } });
  const s = seen.at(-1);
  expect(s?.text).toBe(want);
  expect(s && CRLF.slice(s.from, s.to)).toBe(want);
  await m.unmount();
});

// kit-lone-cr-line-endings: the raw view of a file with lone-CR endings, alone
// or mixed with LF or CRLF. A lone `\r` is one character in the editor and in
// the daemon's count alike, so notes, selections and right-clicks land on their
// own words; and what was selected goes with them (`seen`), for the daemon to
// hold a note's range to.
const LONE: [string, string][] = [
  ["lone CR", "# Lone\r\rFirst line alpha\rsecond line beta.\r"],
  ["lone CR and LF", "# Lone\n\rFirst line alpha\rsecond line beta.\n"],
  ["lone CR and CRLF", "# Lone\r\r\nFirst line alpha\rsecond line beta.\r\n"],
];

for (const [name, text] of LONE) {
  const note = (want: string): PlacedNote => {
    const from = text.indexOf(want);
    return { ...placed("x"), quote: want, at: from, from, to: from + want.length };
  };

  test(`${name}: a placed note paints on its own words, across the lone CR too`, async () => {
    const m = await mount(
      <DocumentView docKey="d" text={text} editable notes={[note("alpha\rsecond")]} />,
    );
    const marks = [...document.querySelectorAll(".cm-note")].map((e) => e.textContent).join("|");
    expect(marks).toBe("alpha|second");
    await m.unmount();
  });

  test(`${name}: a selection reports its own source, its lines and what was seen`, async () => {
    const seen: SelectionReport[] = [];
    const m = await mount(
      <DocumentView docKey="d" text={text} editable onSelect={(s) => seen.push(s)} />,
    );
    const v = editor();
    const at = v.state.doc.toString().indexOf("alpha");
    v.dispatch({ selection: { anchor: at, head: at + 5 } });
    const s = seen.at(-1);
    expect(s && text.slice(s.from, s.to)).toBe("alpha");
    expect(s?.seen).toBe("alpha");
    expect(s?.fromLine).toBe(3);
    await m.unmount();
  });

  test(`${name}: a right-click over the selection says what was seen`, async () => {
    const said: { from: number; to: number; seen?: string }[] = [];
    const m = await mount(
      <DocumentView
        docKey="d"
        text={text}
        editable
        onContextMenu={(a) => {
          said.push(a);
          return true;
        }}
      />,
    );
    const v = editor();
    const at = v.state.doc.toString().indexOf("alpha");
    v.dispatch({ selection: { anchor: at, head: at + 5 } });
    v.contentDOM.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    const a = said.at(-1);
    expect(a && text.slice(a.from, a.to)).toBe("alpha");
    expect(a?.seen).toBe("alpha");
    await m.unmount();
  });
}

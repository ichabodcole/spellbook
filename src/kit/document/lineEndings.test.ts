// kit-raw-save-converts-crlf: text read out of the raw editor keeps the file's
// line endings, byte for byte. CodeMirror joins its lines with `\n`, so before
// this a raw edit and Save turned a CRLF file into LF.

import { expect, test } from "bun:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { anchorOf, findAnchor } from "../workspace/anchors.ts";
import { editorText, endingsOf, lineEndings, setEndings, textWithEndings } from "./lineEndings.ts";

const CRLF = "---\r\ntitle: Crlf\r\n---\r\n# Crlf\r\n\r\nSee [gone](./gone.md).\r\n";
const LF = CRLF.replaceAll("\r\n", "\n");
/** Mostly CRLF, two LF breaks and a lone CR. */
const MIXED = "one\r\ntwo\nthree\r\nfour\r\nfive\rsix\nseven\r\n";

const open = (text: string) => EditorState.create({ doc: text, extensions: [lineEndings(text)] });
const run = (s: EditorState, ...specs: TransactionSpec[]) => {
  let state = s;
  for (const spec of specs) state = state.update(spec).state;
  return state;
};
/** Editor position of the end of line `n` (1-based). */
const endOf = (s: EditorState, n: number) => s.doc.line(n).to;
const hex = (t: string) => Buffer.from(t).toString("hex");

test("each file reads back byte-exact before any edit", () => {
  for (const text of [
    CRLF,
    LF,
    MIXED,
    "",
    "no break",
    "\r\n",
    "a\r",
    "\r\r",
    "a\rb\rc\r",
    "﻿bom\r\nline",
  ])
    expect(hex(textWithEndings(open(text)))).toBe(hex(text));
});

test("the default is the ending most breaks use, ties to the first met", () => {
  expect(endingsOf(CRLF).fallback).toBe("\r\n");
  expect(endingsOf(LF).fallback).toBe("\n");
  expect(endingsOf(MIXED).fallback).toBe("\r\n");
  expect(endingsOf("a\nb\r\nc").fallback).toBe("\n");
  expect(endingsOf("a\r\nb\nc").fallback).toBe("\r\n");
  expect(endingsOf("a\nb\r\nc\r\n").fallback).toBe("\r\n");
  expect(endingsOf("a\rb\nc\nd\re\n").fallback).toBe("\n");
  // Only the breaks written otherwise are marked.
  expect(endingsOf(CRLF).marks.size).toBe(0);
  expect(endingsOf(MIXED).marks.size).toBe(3);
});

test("typing in a CRLF file keeps every ending CRLF", () => {
  const s = run(open(CRLF), { changes: { from: endOf(open(CRLF), 4), insert: " X" } });
  expect(hex(textWithEndings(s))).toBe(hex(CRLF.replace("# Crlf", "# Crlf X")));
});

test("Enter in a CRLF file writes a CRLF break", () => {
  const s0 = open(CRLF);
  // Mid-line, at a line's end, and at a line's start: each before the last, so
  // s0's positions hold.
  const mid = s0.doc.line(4).from + 2;
  const s = run(
    s0,
    { changes: { from: mid, insert: "\n" } },
    { changes: { from: s0.doc.line(1).to, insert: "\n" } },
    { changes: { from: 0, insert: "\n" } },
  );
  expect(hex(textWithEndings(s))).toBe(
    hex("\r\n---\r\n\r\ntitle: Crlf\r\n---\r\n# \r\nCrlf\r\n\r\nSee [gone](./gone.md).\r\n"),
  );
});

test("a link inserted across a selection in a CRLF file keeps CRLF", () => {
  const s0 = open(CRLF);
  const at = editorText(CRLF).indexOf("Crlf\n\nSee");
  const s = run(s0, {
    changes: { from: at, to: at + 4, insert: "[Crlf](./crlf.md)" },
    selection: EditorSelection.cursor(at),
  });
  expect(hex(textWithEndings(s))).toBe(hex(CRLF.replace("# Crlf", "# [Crlf](./crlf.md)")));
});

test("a mixed file keeps each line's own ending; a new break takes the default", () => {
  const s0 = open(MIXED);
  const s = run(
    s0,
    // Enter mid `six`: the new break is CRLF, `six`'s own LF stays at its end.
    { changes: { from: s0.doc.line(6).from + 2, insert: "\n" } },
    // Typed at the end of the LF line `two` (earlier, so s0's position holds):
    // the LF stays after it.
    { changes: { from: endOf(s0, 2), insert: "!" } },
  );
  expect(hex(textWithEndings(s))).toBe(
    hex("one\r\ntwo!\nthree\r\nfour\r\nfive\rsi\r\nx\nseven\r\n"),
  );
});

test("a deleted break takes its ending with it", () => {
  const s0 = open(MIXED);
  // Join `two` and `three`: the LF goes, and `three`'s CRLF ends the joined line.
  const s1 = run(s0, { changes: { from: endOf(s0, 2), to: endOf(s0, 2) + 1 } });
  expect(hex(textWithEndings(s1))).toBe(hex("one\r\ntwothree\r\nfour\r\nfive\rsix\nseven\r\n"));
  // A selection over the break replaced with one break: the new one is the default.
  const s2 = run(s0, { changes: { from: endOf(s0, 5) - 1, to: endOf(s0, 5) + 2, insert: "\n" } });
  expect(hex(textWithEndings(s2))).toBe(hex("one\r\ntwo\nthree\r\nfour\r\nfiv\r\nix\nseven\r\n"));
});

test("a lone CR never lands straight before an LF, which would read back as one break", () => {
  const cases: [string, (s: EditorState) => TransactionSpec, string][] = [
    // `b` deleted: the CR and the LF meet.
    [
      "a\rb\nc\n",
      (s) => ({ changes: { from: s.doc.line(2).from, to: s.doc.line(2).to } }),
      "a\r\n\nc\n",
    ],
    // Enter at the start of `y`: an LF break straight after the CR.
    [
      "x\ry\nz\n",
      (s) => ({ changes: { from: s.doc.line(2).from, insert: "\n" } }),
      "x\r\n\ny\nz\n",
    ],
    // The default is CR itself, and a marked LF follows it.
    [
      "p\rq\nr\rs",
      (s) => ({ changes: { from: s.doc.line(2).from, to: s.doc.line(2).to } }),
      "p\r\n\nr\rs",
    ],
  ];
  for (const [file, edit, want] of cases) {
    const s = run(open(file), edit(open(file)));
    const saved = textWithEndings(s);
    expect(hex(saved)).toBe(hex(want));
    // Read back, it is the editor's lines exactly: none lost.
    expect(editorText(saved)).toBe(s.doc.toString());
    // A slice ending on that `\r` quotes it as the whole writes it.
    const cr = s.doc.line(1).to;
    expect(textWithEndings(s, 0, cr + 1)).toBe(saved.slice(0, saved.indexOf("\r") + 2));
  }
});

test("a break replaced by text leaves no ending behind for a break typed there later", () => {
  // LF is the default (a tie, met first); the CRLF break is replaced by `k`,
  // then `k` by a new break, which takes the default.
  const s0 = open("d\ncbc\r\n");
  const s1 = run(s0, { changes: { from: 5, to: 6, insert: "k" } });
  expect(textWithEndings(s1)).toBe("d\ncbck");
  const s2 = run(s1, { changes: { from: 5, to: 6, insert: "\n" } });
  expect(hex(textWithEndings(s2))).toBe(hex("d\ncbc\n"));
  // One break replaced by exactly one break keeps its own ending: the mark
  // stays over a break.
  const s3 = run(s0, { changes: { from: 5, to: 6, insert: "\n" } });
  expect(hex(textWithEndings(s3))).toBe(hex("d\ncbc\r\n"));
});

test("an LF file stays LF, and the plain text is read without a walk", () => {
  const s0 = open(LF);
  const s = run(s0, { changes: { from: endOf(s0, 4), insert: "\nmore" } });
  expect(textWithEndings(s)).toBe(LF.replace("# Crlf", "# Crlf\nmore"));
  expect(textWithEndings(s)).not.toContain("\r");
});

test("a slice is quoted with the file's endings", () => {
  const s = open(MIXED);
  const from = s.doc.line(2).from;
  const to = s.doc.line(4).to;
  expect(textWithEndings(s, from, to)).toBe("two\nthree\r\nfour");
  expect(textWithEndings(s, s.doc.line(5).from, s.doc.line(6).from)).toBe("five\r");
  // Only a CR before an LF is written as CRLF: a slice ending on a CR that
  // another CR follows keeps it as it is.
  const cr = open("a\r\rb");
  expect(textWithEndings(cr, 0, cr.doc.line(2).from)).toBe("a\r");
});

test("new text from the daemon brings its own endings", () => {
  const s0 = open(CRLF);
  const next = "a\nb\r\nc\n";
  const s = run(s0, {
    changes: { from: 0, to: s0.doc.length, insert: editorText(next) },
    effects: setEndings.of(endingsOf(next)),
  });
  expect(hex(textWithEndings(s))).toBe(hex(next));
});

test("a note whose quote spans a break is still found after a raw edit and save", () => {
  for (const file of [CRLF, MIXED]) {
    const s0 = open(file);
    // The note: a passage from inside line 2 to inside line 4, in the daemon's count.
    const from = file.indexOf(file === CRLF ? "Crlf\r\n---" : "o\nthree");
    const to = file.indexOf(file === CRLF ? "# Cr" : "fou") + 3;
    const anchor = anchorOf(file, from, to);
    expect(anchor.quote).toContain("\n");
    // An edit far from it, then the text the editor writes.
    const saved = textWithEndings(run(s0, { changes: { from: 0, insert: "Edited. " } }));
    const found = findAnchor(saved, anchor);
    expect(found.how).toBe("context");
    expect(saved.slice(found.from as number, found.to as number)).toBe(anchor.quote);
  }
});

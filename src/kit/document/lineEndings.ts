// The file's line endings, kept through the raw editor (kit-raw-save-converts-crlf).
//
// CodeMirror splits its document on `\r\n`, `\r` and `\n` alike and joins it
// back with `\n` (`doc.toString()`), so text read out of the editor was LF
// whatever the file held: a raw edit and Save turned a CRLF file into LF, the
// whole file changed in a diff, and a note whose quote held a `\r\n` was lost.
//
// ⛔ NOT CodeMirror's `lineSeparator` facet. It takes ONE separator and splits
// on that alone, so a mixed file's other endings would sit inside its lines as
// characters, and the offsets the daemon and the editor share would change.
//
// Instead each line break keeps the ending it had in the file. The ending most
// breaks use is the default; a break with another ending carries a mark over
// its one character, mapped through every change. A break typed (Enter, a
// paste, a link with a newline in it) has no mark and takes the default, so a
// CRLF file stays CRLF and a mixed file changes only where it was edited. A
// break deleted takes its mark with it, so the lines it joined are not given
// an ending they never had.

import {
  type EditorState,
  type Extension,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";

/** How a line break is written in a file. */
export type LineEnding = "\r\n" | "\n" | "\r";

/** A break written other than the default: its ending. */
class EndingMark extends RangeValue {
  constructor(readonly ending: LineEnding) {
    super();
  }
  // Text typed at the end of the line goes before the break, and text typed at
  // the start of the next line after it: the mark covers the break alone. Once
  // the break is gone the range is empty, and an empty range on these sides is
  // dropped by the mapping.
  override startSide = 1;
  override endSide = -1;
  override eq(other: RangeValue): boolean {
    return other instanceof EndingMark && other.ending === this.ending;
  }
}

const MARKS: Record<LineEnding, EndingMark> = {
  "\r\n": new EndingMark("\r\n"),
  "\n": new EndingMark("\n"),
  "\r": new EndingMark("\r"),
};

/** The endings of a document: the default, and each break written otherwise. */
export type Endings = { readonly fallback: LineEnding; readonly marks: RangeSet<EndingMark> };

const LF_ONLY: Endings = { fallback: "\n", marks: RangeSet.empty };

/** The breaks CodeMirror splits on, in the order it does. */
const BREAK = /\r\n|\r|\n/g;

/**
 * The endings of `text`, in the editor's count (each break one character). The
 * default is the ending most breaks use; a tie goes to the one met first, and a
 * text with no break defaults to `\n`.
 */
export function endingsOf(text: string): Endings {
  if (!text.includes("\r")) return LF_ONLY;
  // Each break's ending, at its position in the editor's count.
  const found: { ending: LineEnding; at: number }[] = [];
  const count = { "\r\n": 0, "\n": 0, "\r": 0 };
  let removed = 0;
  for (const m of text.matchAll(BREAK)) {
    const ending = m[0] as LineEnding;
    count[ending]++;
    found.push({ ending, at: (m.index as number) - removed });
    removed += ending.length - 1;
  }
  let fallback: LineEnding = found[0]?.ending ?? "\n";
  for (const { ending } of found) if (count[ending] > count[fallback]) fallback = ending;
  const marks = found.flatMap(({ ending, at }) =>
    ending === fallback ? [] : [MARKS[ending].range(at, at + 1)],
  );
  return { fallback, marks: RangeSet.of(marks) };
}

/** `text` as the editor holds it: every break one `\n`, as CodeMirror splits it. */
export function editorText(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Replace the endings outright: new text from the daemon carries its own. */
export const setEndings = StateEffect.define<Endings>();

/** The field, seeded from the text the editor opens with. */
export function lineEndings(initial: string): Extension {
  return endingsField.init(() => endingsOf(initial));
}

const endingsField = StateField.define<Endings>({
  create: () => LF_ONLY,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setEndings)) return e.value;
    if (!tr.docChanged || value.marks.size === 0) return value;
    return { fallback: value.fallback, marks: value.marks.map(tr.changes) };
  },
});

/**
 * The document from `from` to `to` with each break written as the file has it:
 * what the editor hands out to be written, and what a selection quotes.
 * Without the field (a view built without it), the plain `\n` text.
 */
export function textWithEndings(state: EditorState, from = 0, to = state.doc.length): string {
  const endings = state.field(endingsField, false) ?? LF_ONLY;
  if (endings.fallback === "\n" && endings.marks.size === 0) return state.sliceDoc(from, to);
  return joinLines(state.doc, endings, from, to);
}

function joinLines(doc: Text, { fallback, marks }: Endings, from: number, to: number): string {
  const out: string[] = [];
  const mark = marks.iter(from);
  let pos = from;
  const lines = doc.iterRange(from, to);
  while (!lines.next().done) {
    if (!lines.lineBreak) {
      out.push(lines.value);
      pos += lines.value.length;
      continue;
    }
    while (mark.value && mark.from < pos) mark.next();
    out.push(mark.value && mark.from === pos ? mark.value.ending : fallback);
    pos++;
  }
  return out.join("");
}

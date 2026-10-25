---
type: item
title: Saving after a raw edit turns a CRLF file into LF
description:
  Typing in the raw editor and saving rewrites a CRLF or mixed-ending file with
  LF endings throughout, because CodeMirror's doc joins lines with \n; a
  rendered-only edit keeps CRLF.
status: stable
lifecycle: active
id: 01a16682-c980-74c1-9c75-f2092e214ed9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# Saving after a raw edit turns a CRLF file into LF

Measured by the CRLF-notes verifier (2026-10-23) on the base and on the fix,
with the same result on both. A 61-byte file with 6 CRLF endings came back as 57
bytes with 0 CRLF and 6 LF after typing " X" in the raw editor and pressing
Cmd-S. Each of these converts the whole file:

- a mixed-ending file;
- Enter in a CRLF file;
- Add link through the editor.

An Add link in the rendered view, then Save, keeps CRLF. The cause: CodeMirror's
`doc.toString()` joins lines with `\n`. A whole-file line-ending change on save
is a surprise in a git diff. It may also orphan notes whose quote holds `\r\n`.

## Definition of done

- [x] Saving after a raw edit keeps the file's line endings: CRLF stays CRLF. A
      mixed file keeps the dominant ending, or each line's own, whichever is
      decided.
- [x] Notes whose quote spans a line break still match after the save.
- [x] Tested on CRLF, mixed and LF files, and checked in a real browser.
- [ ] Offered on kit-parity.

## Decision: a mixed file keeps each line's own ending

Each existing break keeps the ending it had in the file. A break that is new
(Enter, a paste, a link with a break in it) takes the file's dominant ending,
the one most breaks use; a tie goes to the one met first, and a file with no
break defaults to LF.

Why not the dominant ending throughout: that would rewrite every minority line
on the first keystroke, which is the same whole-file surprise in a git diff on a
smaller scale. It would also orphan a note whose quote crosses a minority break,
since the quote's `\n` would become `\r\n` in the file.

Two edges follow from this. A break that is deleted and then retyped, or brought
back by Undo, takes the dominant ending. A pasted `\r\n` also takes the dominant
ending, because CodeMirror splits pasted text into lines before the editor sees
it. In a pure CRLF or pure LF file neither edge changes anything.

## Done and verified

The fix is commit `fc669fb1`, on the editor side only:
`src/kit/document/lineEndings.ts` and its wiring in `DocumentView.tsx`. The save
path in `session.ts` is untouched.

- **Why not CodeMirror's `lineSeparator` facet.** It takes one separator and
  splits on that alone, so a mixed file's other endings would sit inside lines
  as characters. A state field keeps the file's default ending. Each break with
  a different ending gets a mark over its one character, and the marks are
  mapped through every change. The mark's sides are set so that text typed at a
  line's end goes before the break, and a deleted break drops its mark. For an
  LF-only file the text is read as before, with no walk over the lines.
- **What it changes.** Three places now carry the file's endings:
  - the text the editor hands out to be written (`onChange`);
  - the text of the human's selection, so an agent quoting it matches the file;
  - the daemon's new text, which is compared to the editor in the editor's count
    and brings its own endings.

  `EditorHandle.text()` stays in the editor's count, because every caller slices
  it with editor positions.

- **Found and fixed on the way.** Links written in the rendered view were
  replayed into the raw editor's undo history in the daemon's count. In a CRLF
  file, opening the raw view after one put the link a character off per line
  above it, and the next keystroke wrote that misplaced text. Each replayed step
  is now moved into the editor's count against the text it was taken in.
- **Tests.**
  - `lineEndings.test.ts` covers CRLF, mixed and LF files, byte-exact on the way
    out: Enter, typing at a line's end, a deleted break, a link, a slice, new
    daemon text, and a note across a break still found after the save.
  - `DocumentView.crlf.test.tsx` covers the same through the mounted editor,
    plus the replay.
  - Eight planted regressions each turned a test red, and each file was restored
    byte-equal.
  - In a real browser (Playwright Chromium, real keys, then Cmd-S, then the
    file's bytes compared), all six cases come back exact: typing, Enter, a
    mixed file, an LF file, Add link through the editor, and an agent's note
    across a CRLF break that is still placed on its quote after the save. On the
    base, the CRLF, mixed, Enter and link cases convert the file and the note is
    orphaned.

**Story Studio** (`18a06928`) has the same bug. Its
`packages/kit/src/document/DocumentView.tsx:715` writes
`update.view.state.doc.toString()`. Its replay (`:847`) also dispatches the
rendered view's changes unconverted, and it has no `editorOffset` at all.

## Port-back notes

- New `src/kit/document/lineEndings.ts`, which has no app names and depends only
  on `@codemirror/state`. It exports:
  - `endingsOf(text)`, the default ending plus a mark for each other break;
  - `lineEndings(initial)`, the state field seeded from the opening text;
  - `setEndings`, the effect that replaces the endings when the daemon's text
    arrives;
  - `textWithEndings(state, from?, to?)`, the document written with each break
    as the file has it;
  - `editorText(text)`, the text as CodeMirror holds it.
- `DocumentView.tsx`:
  - the `lineEndings(start)` extension;
  - `onChange` and the selection report's `text` read through `textWithEndings`;
  - the remote-text effect compares against `editorText(text)` and dispatches
    `setEndings`, even when no character changed (a file converted on disk).
- `DocumentView.tsx` replay: each step goes through `editorOffset(before, …)`
  against the text it was taken in, then `setEndings` from the final text. Story
  Studio needs `editorOffset` from `kit-crlf-note-offsets` first.

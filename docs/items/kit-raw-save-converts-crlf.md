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

The exact rules, and the edges they leave. In a pure CRLF or pure LF file none
of these edges changes anything.

- **A break replaced by exactly one break keeps its own ending.** Examples are a
  selection of just that break with Enter typed over it, or one `\n` pasted over
  it. The break's mark survives the change because it still sits over a break.
- **A break replaced by anything else loses its mark.** That covers a break
  deleted, a break replaced by text, and a break inside a wider replaced range.
  If a break is later typed in its place, that new break takes the dominant
  ending.
- **A break brought back by Undo takes the dominant ending.** The mark went with
  the deletion and Undo does not restore it.
- **A pasted `\r\n` takes the dominant ending.** CodeMirror splits pasted text
  into lines before the editor sees it.
- **Alt-Up and Alt-Down (`moveLine`) leave the endings where they were.** The
  lines move but their endings don't. Moving a minority-ending line therefore
  changes which line carries which ending.
- **A lone `\r` break directly before a `\n` break is written as `\r\n`.**
  Otherwise the pair `\r` + `\n` would read back as one `\r\n` break, and the
  file would lose a line on Save while the editor still showed it.
  - The choice is `\r\n` rather than the dominant ending for two reasons. It
    keeps the CR the line had. And it is two breaks whatever the default is,
    while the default may itself be `\r`.
  - A slice that ends on that `\r` (a quoted selection) writes it the same way,
    so the quote is found in the saved file.
  - A file only gets here when a lone-CR break and an LF break meet: a line
    between them was emptied, or a break was typed at the start of the line
    after the `\r`.
- **The dominant ending counts the whole file, frontmatter included.** If a
  file's frontmatter has more CRLF breaks than its body has LF breaks, CRLF
  becomes the default. Enter in the LF body then writes CRLF.

## Done and verified

The fix is commit `fc669fb1`, on the editor side only:
`src/kit/document/lineEndings.ts` and its wiring in `DocumentView.tsx`. The save
path in `session.ts` is untouched.

- **Why not CodeMirror's `lineSeparator` facet.** It takes one separator and
  splits on that alone, so a mixed file's other endings would sit inside lines
  as characters. A state field keeps the file's default ending. Each break with
  a different ending gets a mark over its one character, and the marks are
  mapped through every change. The mark's sides are set so that text typed at a
  line's end goes before the break, and a deleted break drops its mark. Where
  the text changed, a mark is kept only while it still covers a break. Without
  that rule, a break replaced by text left its mark over the text, and a break
  typed there later took the old ending. For an LF-only file the text is read as
  before, with no walk over the lines.
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
    plus the replay and a replayed break whose ending differs from the default.
  - Twelve planted regressions each turned a test red, and each file was
    restored byte-equal.
  - In a real browser (Playwright Chromium, real keys, then Cmd-S, then the
    file's bytes compared), all seven cases come back exact: typing, Enter, a
    mixed file, an LF file, a lone CR meeting an LF (four lines read back, as
    the editor shows), Add link through the editor, and an agent's note across a
    CRLF break that is still placed on its quote after the save. On the base,
    the CRLF, mixed, Enter and link cases convert the file and the note is
    orphaned.
- **Fix round after verification** (commit `15be6e2e`). The verifier found two
  problems, and its fuzz then found a third:
  - The verifier found that a lone `\r` meeting an LF lost a line on Save.
  - The verifier found that the replay's final reset of the endings had no test.
  - Its fuzz, with a lone-CR allowance added, found that a break replaced by
    text left its mark behind.

  All three are fixed and tested. With the allowance, the fuzz passes 60,000
  runs over CRLF, LF, mixed and lone-CR files.

**Story Studio** (`18a06928`) has the same bug. Its
`packages/kit/src/document/DocumentView.tsx:715` writes
`update.view.state.doc.toString()`. Its replay (`:847`) also dispatches the
rendered view's changes unconverted, and it has no `editorOffset` at all.

## Port-back notes

- New `src/kit/document/lineEndings.ts`, which has no app names and depends only
  on `@codemirror/state`. It exports:
  - `endingsOf(text)`, the default ending plus a mark for each other break;
  - `lineEndings(initial)`, the state field seeded from the opening text, which
    keeps a mark only while it covers a break where the text changed;
  - `setEndings`, the effect that replaces the endings when the daemon's text
    arrives;
  - `textWithEndings(state, from?, to?)`, the document written with each break
    as the file has it, except a lone `\r` directly before a `\n` break, which
    is written `\r\n`;
  - `editorText(text)`, the text as CodeMirror holds it.
- `DocumentView.tsx`:
  - the `lineEndings(start)` extension;
  - `onChange` and the selection report's `text` read through `textWithEndings`;
  - the remote-text effect compares against `editorText(text)` and dispatches
    `setEndings`, even when no character changed (a file converted on disk).
- `DocumentView.tsx` replay: each step goes through `editorOffset(before, …)`
  against the text it was taken in, then `setEndings` from the final text. Story
  Studio needs `editorOffset` from `kit-crlf-note-offsets` first.

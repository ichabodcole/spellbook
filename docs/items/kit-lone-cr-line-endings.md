---
type: item
title: A file with lone CR line endings breaks the rendered view
description:
  With old-Mac \r-only line endings, the rendered view paints no notes, offers
  no Add note, and a selection stores a note over the whole body without
  warning, on base and fix alike.
status: stable
lifecycle: active
id: 01a16682-ca6f-702a-abc7-6f9d9bcfb2a9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
---

# A file with lone CR line endings breaks the rendered view

Found by the CRLF-notes verifier (2026-10-23), on the base and on the fix alike.
`projection.ts` folds only `\r\n`. A file whose lines end in a lone `\r` (old
Mac endings) breaks the rendered view in three ways:

- it paints no notes;
- its right-click has no "Add note";
- selecting "alpha" stored a note over the whole body (offsets 9 to 191), with
  no warning.

Rare, but it silently attaches a note to the wrong text.

## Definition of done

- [x] Lone-`\r` files render, note and select correctly in rendered, raw and
      split. Or Scriptorium normalises or refuses them with a clear message.
- [x] No note is ever stored over a range the human didn't select.
- [ ] Tested; offered on kit-parity. (Tested: see below. The offer is the
      lead's.)

## Decision: render lone-CR files, and guard the note at the daemon

Lone-CR files are rendered, noted and selected like any other file. They are not
normalised and not refused. Why:

- **It matches the raw editor.** `kit-raw-save-converts-crlf` keeps each line's
  own ending, lone `\r` included. The raw view already reads, edits and saves a
  lone-CR file, so refusing it in the rendered view alone would refuse a file
  the kit otherwise supports.
- **Normalising rewrites the file.** Every line would change in a diff, which is
  the surprise the CRLF item was written to stop. It would also orphan notes
  whose quote crosses a lone `\r`.
- **The fix is small.** A lone `\r` is one character in the file, in CodeMirror
  and on the page (HTML parsing reads it as `\n`). So no offset needs mapping,
  unlike `\r\n`. The projection only has to read it as a break, and line numbers
  have to count it as CodeMirror does.

**The guard.** The rendered view went wrong because the page placed the
selection wrongly. A page fix alone would leave the next such fault just as
silent. So the page now sends what the human selected, as their view showed it
(`seen`, on the surface `note.add`). The daemon refuses a range that does not
hold it, with a 409 saying what to do: "Select the passage again and add the
note, or select it in the raw view." The check is `showsSelection` in
`projection.ts`. Spaces and line breaks are not compared. The range must show
the seen text:

- as raw source (a raw-view selection);
- or as rendered text (a rendered-view selection);
- or as rendered text found in order inside what was seen. This covers text the
  page draws that the projection never carries, such as a footnote's number;
- or widened only by the rest of a run that is not exact at either edge. An
  inline code span or a line with an escape resolves to the whole run, as it did
  before.

`seen` is optional on the wire, so an older page (Story Studio's today) still
adds its notes, unchecked.

**What the refusal costs.** The note's typed body goes with the refused attempt;
the human types it again. Refusals should only happen when the page mis-places a
selection, so this was left.

## Every place that assumes `\n` or `\r\n`

Fixed here (on the note, selection and split-scroll path):

- `document/projection.ts`: `emit` and `emitText` folded only `\r\n`. The
  wrapped-line search found only `\n`. `lineAt` counted only `\n`, so a lone-CR
  file was all line 1, and the split view scrolled against the wrong raw line.
- `document/renderedRange.ts`: when both ends fell in runs with no place, they
  borrowed their neighbours, crossed, and were swapped round. That was the wide
  note. Now there is no range.
- `workspace/anchors.ts` `linesOf`: the lines a note reports to the agent.
- `document/text.ts` `lineThrough`: keeping your place across a change.
- New `lib/lineBreaks.ts` `lineAt`, shared by the three line counters above.

Already right:

- `DocumentView`'s `editorOffset` and `daemonOffset`: a lone `\r` is one
  character on both sides.
- `document/lineEndings.ts` (`kit-raw-save-converts-crlf`).
- `findAnchor`: it matches substrings, whatever the endings.
- `lib/markdown.ts`: micromark takes a lone `\r` as a line ending, and the page
  reads it as `\n`.

Left. These are not on the note path, and each counts `\n` only:

- `lib/frontmatter.ts:20`, `scriptorium/backend/kit/frontmatter.ts:67`,
  `workspace/linkEdges.ts:235`, and `document/frontmatter.ts:67`:
  - frontmatter in a lone-CR file is not recognised;
  - the rendered view shows it as body text, with no header;
  - `meta set` does not see the block.
  - Page and daemon agree, so notes still land.
- `lib/headings.ts:54` and `lib/headingAnchor.ts:311`: in a lone-CR file only
  line 1 can be a heading. This affects the outline and heading links.
- `workspace/search.ts:78`: a search hit reports line 1, with the whole file as
  its line.
- `workspace/links.ts:686` and `linkEdges.ts:280`: link-check line numbers. Also
  `links.ts:494`, where a link label can run across a lone-CR blank line.
- `lib/markdownCode.ts:115`: code masking by lines. A fenced block in a lone-CR
  file may not be masked.
- `workspace/diff.ts:21`: a lone-CR file diffs as one line.
- `document/linkInsert.ts:295`: the line context of a link insert.

A follow-up item could move these onto `lib/lineBreaks.ts`.

## Done and verified

Commits on `impl/kit-lone-cr-line-endings`: `a1517a23` (the render fix and line
counting), `cfff65de` (the daemon guard and the page's `seen`), and a rebuild
with this record after them.

- **Reproduced first, in Chromium** (Playwright, scratch homes, `NODE_ENV=test`,
  real mouse drags and right-clicks). The base build at `20b84ce7` was used, on
  a lone-CR file, a lone-CR + LF file and a lone-CR + CRLF file:
  - the agent's note painted nothing in the rendered view;
  - right-click over "alpha" offered no Add note;
  - every raw-view note reported the wrong line (1 in the lone-CR file).
- **After the fix, same script, same three files**, in rendered, raw and split:
  - the agent's note paints on "beta" in every view;
  - Add note is offered over "alpha" (rendered) and "gamma" (raw);
  - the daemon stores exactly "alpha" or "gamma", on line 3 or 7 (as the raw
    gutter counts them);
  - a note from the Notes panel stores exactly its word;
  - every `note.add` frame the page sent carried `seen`;
  - there were no console errors.
- **Tests:**
  - `projection.test.ts`:
    - lone CR, lone CR + LF, lone CR + CRLF and all three, against the page's
      runs as the browser reads them;
    - passages both ways, and line counts;
    - `showsSelection`, including the wide-note regression.
  - `renderedRange.test.ts`: a selection inside an unplaced run gives no range,
    not its neighbours' span.
  - `notes.test.ts` and `server.test.ts`: the wide range is refused (409, naming
    the act) and stores nothing; the right range is taken; a non-text `seen` is
    a 400.
  - `DocumentView.crlf.test.tsx`: the raw view of the three files paints,
    selects and right-clicks on its own words, and reports `seen`.
  - `DocumentPane.contextMenu.test.tsx`: Add note sends `seen`.
  - `WorkspaceShell.panes.test.tsx`: the Notes panel sends `seen`, and a refusal
    reaches a toast.
  - `selection.test.ts`, `anchors.test.ts` and `text.test.ts`.
- **Mutation checks.** Sixteen regressions were planted one at a time. Each
  turned a test red, and each file was restored byte-equal.

**Story Studio** (`e41a4592`) has the bug too:

- `packages/kit/src/document/projection.ts` folds no `\r` at all;
- its `lineAt` (`:368`) counts `\n` only;
- `renderedRange.ts:101` swaps a crossed range round;
- `workspace/anchors.ts:110` counts `\n` only.

## Port-back notes

- **New `lib/lineBreaks.ts`:** `lineAt(text, offset)` counts lines as CodeMirror
  does (`\r\n`, a lone `\r`, `\n`).
- **`document/projection.ts`:**
  - `emit` and `emitText` read a lone `\r` as `\n`. A lone `\r` is one character
    either way, so its run stays exact.
  - `emitText` finds the next break of any kind (`nextBreak`).
  - `lineAt` is `lib/lineBreaks`'s.
  - New export `showsSelection(text, from, to, seen)`.
  - Story Studio first needs `kit-crlf-note-offsets`'s `\r\n` fold.
- **`document/renderedRange.ts`:** `resolveRange` returns null when the start is
  past the end, rather than swapping them.
- **`workspace/anchors.ts` and `document/text.ts`:** line counting through
  `lib/lineBreaks`.
- **Protocol:** surface `note.add` takes an optional `seen`.
  - `server.ts` refuses a non-string `seen` with a 400.
  - `session.addNote` takes `seen` and refuses with a 409 when `showsSelection`
    fails.
  - The daemon now imports `document/projection.ts`, which brings the markdown
    parser into its bundle (Scriptorium's `server.js` grew by about 257 KB).
- **The page sends `seen`:**
  - `SelectionReport.seen` and `ContextMenuRequest`'s `at.seen` (raw: the
    editor's slice; rendered: the DOM range's text);
  - `HeldSelection.seen`, and `heldAfter` compares it;
  - `NoteAtSelection`'s `At.seen`;
  - `DocumentPane`'s and `WorkspaceShell`'s `note.add` send it.

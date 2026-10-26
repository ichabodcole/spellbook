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
- [ ] No note is ever stored over a range the human didn't select. (Met for a
      range wider than, or other than, what was seen. Not met for a range
      elsewhere that shows the same text: see "Known limits".)
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
(`seen`, on the surface `note.add`). The check is `showsSelection` in
`projection.ts`, and it runs in two places:

- **The page runs it first.** It runs as the selection is made and as the menu
  opens. Over a selection it refuses:
  - the menu's Add note is off, marked "use the raw view";
  - the Notes panel says why and holds Add back;
  - the panel keeps what was typed until the passage is selected where it can be
    placed.
- **The daemon runs it again** before it stores a note, and refuses with a 409.

Both say the one act that works: "Select it in the raw view and add the note
there." Selecting again in the rendered view would give the same range and the
same refusal, so that act is not offered.

Spaces and line breaks are not compared. A range passes when it shows `seen`:

- **as raw source**: a raw-view selection;
- **as rendered text**: a rendered-view selection, with two allowances that may
  come together.
  - **Text the page draws that the projection never carries** may sit inside
    `seen`, cut at either end. That text is a footnote's number, its back-link,
    and the "Footnotes" heading (`Projection.pageOnly`).
  - **A run the projection cannot cut** may add the rest of itself at either
    edge. That is an inline code span, or a line with an entity or an escape. It
    may not add all of itself: a selection that starts or ends in such a run has
    one of its characters, unless it starts or ends on a space.

`seen` is optional on the wire, so an older page (Story Studio's today) still
adds its notes, unchecked.

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
- its `lineAt` (`:365`) counts `\n` only;
- `renderedRange.ts:101` swaps a crossed range round;
- `workspace/anchors.ts:110` counts `\n` only.

## Fix round (verifier: "With fixes")

The fix round touched four things.

- **Honest rendered selections were refused.** The verifier's fuzz drove the
  page's own `resolveRange` in Chromium, and the guard refused 52/864 LF, 52/864
  CRLF and 45/873 lone-CR placements. Two causes:
  - **The page widened some ranges itself.** At an element boundary,
    `renderedRange`'s `plainAt` read the child the offset names. For an end
    point, that child is after the point. A drag that ended between two blocks
    took the whole next cell, link or quote, and the guard was right to refuse
    it. It now takes the text on the correct side of the point, which is a
    narrower and correct range. Many points that crossed and gave no range now
    place.
  - **The rules could not combine.** A run the projection cannot cut and a
    footnote number in one selection matched neither rule. `showsSelection` is
    now one walk that allows both together, and the page's own text cut at
    either end of `seen`. The walk is a set of positions in the rendered text
    for each position in `seen`, so no choice is guessed.
- **The fuzz after the change:** 0 refused of 2773 LF, 2773 CRLF, 2780 lone-CR
  and 2625 mixed placements (`N` = 3000 per file, the verifier's `fuzz.ts`). All
  three mouse cases are stored. The original whole-body case is still refused.
- **A refusal no longer loses words.** The page checks before anything is typed.
  Its advice is the raw view only. In Chromium, with the page made to misplace a
  selection:
  - the menu showed Add note disabled, "use the raw view";
  - the Notes panel said why and held Add back;
  - the words typed there stayed;
  - after a double-click on the word in the raw view, Add stored them over that
    word;
  - no `note.add` was sent while the selection was refused.
  - A refusal that only the daemon makes (its text and the page's differ) still
    clears the panel; the toast says why.
- **Cheap holes closed.** `seen` may hold only page-drawn text beyond the range.
  "a" in another paragraph no longer passes for "Alpha", and "cat" no longer
  passes for a long `seen`. An uncut run at an edge may no longer be wholly
  unselected, so a whole paragraph no longer passes for "bold" between two
  escaped runs.

### Known limits

The check judges text, not place. Closing these needs the page to send where the
selection was, which is a follow-up.

- **A run the projection cannot cut,** elsewhere, that holds the selected words
  passes. For example, a whole other paragraph with an entity in it passes for
  `seen: "alpha"`. In the right place this is the run's honest widening, and the
  two cannot be told apart from text alone.
- **The same words elsewhere pass,** as they always would for a quote.
- **Only spaces differ:** "a b" passes for "ab".

### Seen on base, not caused here

- In a mixed-ending file whose frontmatter lines end in a lone `\r`, the
  "frontmatter could not be read, shown as written" box runs those lines
  together.
- Triple-clicking a paragraph in the rendered view offered no Add note. The
  `plainAt` fix in this round makes it work in the LF, CRLF and lone-CR files.
  It still offers none in the verifier's mixed file, whose rendered view is
  broken by the frontmatter case above.

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
  - `Projection` gains `pageOnly`, the bare text the page draws that `plain`
    does not carry (footnote numbers, back-links, the "Footnotes" heading).
  - `NOT_PLACED` (`projection.ts`) is the one refusal message, shared by the
    page and the daemon.
  - `renderedRange.ts` `plainAt`: an element boundary resolves to the text on
    its own side of the point (`Range.comparePoint`), not to the child the
    offset names.
  - The page checks first. `DocumentPane` puts `noteRefusal` on the
    `HeldSelection` it reports, and on the menu (`NoteAtSelection` gains
    `noteRefusalLabel`). The shell passes `refusal` to `NotesPanel`, whose Add
    then waits while what was typed stays.
  - The daemon now imports `document/projection.ts`, which brings the markdown
    parser into its bundle (Scriptorium's `server.js` grew by about 257 KB).
- **The page sends `seen`:**
  - `SelectionReport.seen` and `ContextMenuRequest`'s `at.seen` (raw: the
    editor's slice; rendered: the DOM range's text);
  - `HeldSelection.seen`, and `heldAfter` compares it;
  - `NoteAtSelection`'s `At.seen`;
  - `DocumentPane`'s and `WorkspaceShell`'s `note.add` send it.

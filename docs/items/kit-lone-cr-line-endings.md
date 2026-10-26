---
type: item
title: A file with lone CR line endings breaks the rendered view
description:
  With old-Mac \r-only line endings, the rendered view paints no notes, offers
  no Add note, and a selection stores a note over the whole body without
  warning, on base and fix alike.
status: stable
lifecycle: done
id: 01a16682-ca6f-702a-abc7-6f9d9bcfb2a9
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
priority: high
cycle: 2026-10-release-6
released_in: 6.0.0
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
- [ ] No note is ever stored over a range the human didn't select. Partly met,
      accepted by Cole on 2026-10-25, with the rest filed as
      `kit-note-guard-checks-place`. Not fully met, for two reasons given under
      "Known limits". (a) A run the projection cannot cut is stored whole. That
      is text beyond the selection, and the larger gap by volume: about 22% of
      random ranges in a rich document, the same as on base. (b) The place is
      not checked: a range elsewhere that shows the selected text passes. What
      the guard does stop is a range that shows more or other text than was
      seen, beyond what (a) allows, such as the crossed-ends case that stored
      the whole body.
- [x] Tested; offered on kit-parity (message 57, 2026-10-25).

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

- **An uncut run is stored whole.** Selecting inside an inline code span, or
  inside a line with an entity or an escape, stores the whole run, as base does.
  That is text beyond the selection in about 22% of random ranges in a rich
  document (the verifier's measure). Making the projection map entities and
  escapes character by character would shrink it.
- **The check judges text, not place.** Closing this needs the page to send
  where the selection was, which is a follow-up:
  - **A run the projection cannot cut,** elsewhere, that holds the selected
    words passes. For example, a whole other paragraph with an entity in it
    passes for `seen: "alpha"`. In the right place this is the run's honest
    widening, and the two cannot be told apart from text alone.
  - **The same words elsewhere pass,** as they always would for a quote.
  - **Only spaces differ:** "a b" passes for "ab".
- **Repetitive text** inside an uncut run (more than 150,000 steps of the walk)
  is settled the cheap way. What was seen must be found whole, starting within
  the leading edge's allowance and leaving at most the trailing edge's after it.
  With the page's own text, it is taken out all at once or not at all, so the
  fallback is stricter than the walk there.

### Seen on base, not caused here

- In a mixed-ending file whose frontmatter lines end in a lone `\r`, the
  "frontmatter could not be read, shown as written" box runs those lines
  together.
- Triple-clicking a paragraph in the rendered view offered no Add note. The
  `plainAt` fix in this round makes it work in the LF, CRLF and lone-CR files.
  It still offers none in the verifier's mixed file, whose rendered view is
  broken by the frontmatter case above.

## Fix round 2 (verifier: "With fixes", performance)

- **The rendered view no longer stalls.**
  - **The cause:** `showsSelection` projected the whole document on every call.
    The page called it on every selection report, and up to three times each
    time the menu drew.
  - **The fix:** the rendered view now asks once per selection report and once
    per right-click, passing the projection it already holds. The answer rides
    on the report (`SelectionReport.noteRefusal`, and `noteRefusal` on the
    right-click request), and the pane only reads it. The daemon keeps the
    projection of the last text it checked, so the second and later notes
    against the same text do not project again.
- **Timings** (the verifier's `projtime.ts`; my `projtime-cached.ts` for the
  page's call and the daemon's repeat):

  | Text size | Before, each check | Page check now | Daemon, first note | Daemon, next notes |
  | --------: | -----------------: | -------------: | -----------------: | -----------------: |
  |     11 KB |              18 ms |         0.4 ms |              16 ms |               0 ms |
  |     54 KB |              55 ms |         0.2 ms |              62 ms |             0.1 ms |
  |    214 KB |             222 ms |         0.4 ms |             232 ms |             0.2 ms |

  "Before" is the previous commit (`deec1091`), measured the same way.

- **In Chromium** (`jank.ts`, 214 KB, a real drag and a right-click):
  - base: 0 long tasks;
  - previous commit: 16 long tasks, 4.3 s in all, the longest 713 ms;
  - now: 0 long tasks.
- **The walk is bounded.** In a fenced block of dashes the check now takes 10 ms
  at 2 KB, 12 ms at 8 KB and 14 ms at 20 KB. Before, it took 36 ms, 718 ms and
  5.2 s.
- **The menu's reason can be read.**
  - A disabled item's title cannot be hovered, and Tab skips it.
  - The full reason is now menu text under Add note (`data-slot="why-full"`),
    and the item points to it with `aria-describedby`.
  - Opening the menu from the keyboard (Shift+F10) could not be tested headless.
    Once the menu is open, the reason is visible text however it was opened.
- **The fuzz still holds:** 0 refused of 2773 LF, 2773 CRLF, 2780 lone-CR and
  2625 mixed placements.
- **Round 4 (verifier: "With fixes, one small fix").** The fallback accepted
  wrong passages that the walk refuses:
  - **Shape A:** an uncut run of dashes, then text nobody selected.
  - **Shape B:** two code blocks with an unselected paragraph between them.

  It now keeps to each edge's allowance, and to the middle-run rule. With the
  fallback forced, the verifier's `fallback.ts` refuses every wrong shape at
  300, 3,000 and 30,000, and still accepts the honest one. About 360 ms of the
  30,000-dash case is the one projection of that text, not the check.

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
  - The page checks first, in `MarkdownView`, with its own projection
    (`showsSelection`'s optional fifth argument). `noteRefusal` rides on:
    - `SelectionReport`, and from there on the `HeldSelection` the pane reports;
    - the right-click request.
  - The pane reads it for the menu. `NoteAtSelection` gains `noteRefusalLabel`,
    and `noteRefusalShown`, which shows the reason as menu text.
  - The shell passes `refusal` to `NotesPanel`, whose Add (Cmd-Enter included)
    then waits while what was typed stays.
  - `showsSelection` without a projection keeps the last text's projection (the
    daemon's path).
  - The walk stops past a work budget (150,000 steps; `showsSelection`'s
    optional sixth argument sets it, so a test can force the fallback). The
    fallback then accepts only when two things hold:
    - **what was seen is found whole,** with the page's own text taken out of it
      or not, at a place that starts within the leading edge's allowance and
      leaves at most the trailing edge's allowance after it;
    - **the range is one run, or no run between its edges holds a character that
      was not seen.**

    The search is linear (Knuth, Morris, Pratt), because `indexOf` was quadratic
    on repetitive text.

  - The daemon now imports `document/projection.ts`, which brings the markdown
    parser into its bundle (Scriptorium's `server.js` grew by about 257 KB).

- **The page sends `seen`:**
  - `SelectionReport.seen` and `ContextMenuRequest`'s `at.seen` (raw: the
    editor's slice; rendered: the DOM range's text);
  - `HeldSelection.seen`, and `heldAfter` compares it;
  - `NoteAtSelection`'s `At.seen`;
  - `DocumentPane`'s and `WorkspaceShell`'s `note.add` send it.

## Loaded on first need (kit-note-guard-lazy, 2026-10-25)

Statically importing `projection.ts` into `session.ts` made every daemon and CLI
spawn load the markdown parser (239 modules instead of 208), which tipped the
spawn-heavy "who rewrote or reopened a note…" test in `daemon.integration` past
5 s and cascaded into six more failures under the parallel suite. The guard now
loads on first need: `NOT_PLACED` lives in the import-free `notPlaced.ts`,
`session.ts` holds the guard behind `loadNoteGuard()`, and the daemon's surface
`note.add` awaits it when `seen` is present (commits `e9077fd2`, `4e278dda`,
`1bb2b2cc`, `930c81ad`). The guard's decisions are unchanged: 147 cases through
the shipped daemon matched the in-process answers.

**Port-back:** `addNote` with `seen` before the guard is loaded throws a plain
`Error`, not a `SessionError`. A host that calls `session.addNote({ seen })`
directly, not through the daemon's `note.add`, must `await loadNoteGuard()`
first, or the human sees an internal error.

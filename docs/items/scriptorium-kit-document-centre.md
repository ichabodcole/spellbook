---
type: item
title: The flagged Scriptorium edits documents in the kit's document pane
description:
  "Put DocumentPane in the interim frame's centre with a minimal workspace
  context, wire the held selection to chat and notes, and fill Scriptorium's
  slots: trust, stale, split view."
status: stable
lifecycle: active
id: 01a14dc5-6f94-7529-ac57-306dea4e021a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, document]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# The flagged Scriptorium edits documents in the kit's document pane

The interim frame from the panes cycle has chat, context, Notes and Tasks, and a
centre that says the document pane comes next. This item puts the kit's
`DocumentPane` there. It is still the interim frame: the shell replaces it in
cycle 5.

**The pane needs a workspace context.** It reads everything through
`useWorkspace()`, which Story Studio's shell provides and our frame does not.
The frame builds a small one from what it already has: the daemon, the state,
the open document, the theme. It adds:

- one held selection, with report and drop;
- reveal and focus for notes;
- a toast store for announcements;
- plain stand-ins for the shell's columns and quiet mode.

Story Studio's own test host (`DocumentPane.test.tsx`) is the template.

**Then the panes are wired to it.** The chat attaches the held selection, and
Notes can add, go to and focus a note. All three are no-ops in the frame today.

**Scriptorium's slots:**

- the trust chip left on, so it shows only where a document has `verified`
  (E69);
- a stale chip added through `frontmatterChips`, from `stale_after`, as the
  shipped header shows;
- split view offered;
- the view-mode key on Spellbook's name.

**An outside change** is the kit's Reload/Keep toast, not the shipped banner.
Following Cole's ruling of 2026-10-18 (cycle doc, ruling 3), the toast gains
"See the difference", which opens compare against the file on disk, so the
warning keeps the act that answers it (E54). This is a generic kit change, and
it is offered back. **Find** is the kit's find bar.

**What it gains:** heading anchors, images and embeds, and "Linked from".

## Definition of done

- [x] With `SCRIPTORIUM_KIT=1`, opening a document shows it in the kit's
      document pane. The human can edit, save, revert, switch and make versions,
      compare and merge, in raw, rendered and split views.
- [x] A selection in either view goes to chat as an attachment, and Notes can
      add a note on it, go to a note and paint the one chosen.
- [x] The trust chip shows only on a document with `verified`, and a stale
      document shows a stale chip.
- [x] The frame's tests no longer say the document pane is coming. A real
      browser check edits, saves and notes a document.
- [ ] After the port, the open edges in
      [scriptorium-selection-edges-the-review-found](scriptorium-selection-edges-the-review-found.md),
      [scriptorium-selection-hygiene-duplication-and-cost](scriptorium-selection-hygiene-duplication-and-cost.md)
      and
      [scriptorium-a-coalesced-scroll-is-lost-in-one-ordering](scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md)
      are checked against the kit's code. Each is closed, or re-aimed at the
      kit. _(Checked: see "The three older items" below. Closing or re-aiming
      them is the lead's to take to Cole.)_
- [ ] The outside-change toast offers "See the difference", which opens compare
      against the file on disk. The change is offered on kit-parity. _(Added
      after Cole's ruling of 2026-10-18. The toast and the frame's wiring are
      done and verified; the kit-parity offer is the lead's.)_
- [x] The shipped Scriptorium is unchanged.

## Done and verified

Commits on `impl/scriptorium-kit-document-centre`, on `cycle/document-pane` at
`42394bd7`, which has the line-number toggle and the reference edges:

- `5548697b`: the kit's outside-change toast offers "See the difference". The
  pane's `ShowDiff` can name the file on disk.
- `66bf891d`: the frame's centre is `DocumentPane`, with a small workspace
  (`frameWorkspace.ts`), the held selection wired to chat and Notes, and
  Scriptorium's slots. It also gets the frame's own stylesheet.
- `f6a27165`: the rebuilt `dist/kit`.
- `ff8439ef`: gate honesty re-declares the frame's new sheet (31/2,902 →
  32/2,916).
- `c9facc09`: a TODO for `lineNumbers`, which `404373f4` fills.
- `9b2e9a71` and `cb900bb4`: this doc.
- After the verifier's ruling ("Ready, with fixes (tests only)"):
  - `404373f4`: the frame passes `lineNumbers`, kept under
    `scriptorium:line-numbers`. The pane already wires the reference edges in
    "Linked from" (`onOpenEdge`) itself.
  - `5a0a35de`: a cell for each mutation the verifier found surviving (below).
  - `ca198a83`: the rebuilt `dist/kit`.

The workspace follows Story Studio's shell at `b6d5956` wherever the pane can
tell the difference. It has:

- one held selection, through the kit's own rules, which is told to the daemon
  on every change and again on a reconnect;
- a one-shot reveal, for a note, a backlink, or a link followed to a heading;
- the chosen note, which is let go when the human switches document or version,
  or resolves the note;
- a request to compare, for the toasts.

What the pane does not read is left out: pointed-at documents, refs added by
hand, the floating composer, and the image viewer. The columns are a plain
stand-in. When the pane collapses a column (reader mode), the frame hides it.
Quiet mode changes nothing, because the frame's chrome is one thin header.

**Deliberate choices:**

- **The stale chip** is read off the fields the header shows, by the shipped
  rule (`isStale` from `backend/frontmatter.ts`). So it always agrees with the
  fields beside it. Reading `appState.docMeta` would describe the file on disk,
  which can differ from the version on screen. The chip claims no key, so
  `stale_after` is still listed, as the shipped header lists it.
- **The view mode** is kept under `scriptorium:view-mode`. Each session has its
  own origin, so the key is not shared with the shipped surface. The shipped
  surface does not keep a view mode at all.
- **The new-version toast** is wired too. Its "Show diff" uses the same compare
  request as "See the difference".
- **The stylesheet.** The frame now has its own sheet, `surface/kit/styles.css`,
  which imports the shipped `../styles.css` and then the kit's `document.css`.
  So the shipped sheet is untouched, and only this page carries the document
  rules. Where both sheets style `.md-prose`, the kit's rules come later and
  win. A property that only the shipped rules set still applies on this page.
  Cycle 5's shell brings a sheet of its own. The shipped sheet still scans all
  of `surface/`, so the frame still uses only classes the shipped surface
  already uses.
- **`addUnavailable`** on `NotesPanel` is no longer set by any host. It was our
  port-back addition from the panes cycle. It can be dropped rather than offered
  back.
- **The chat's subject** is left to the daemon, as in the shell when nothing is
  pointed at. `say` sends `withSelection` from the composer.
- **A selection's `path` is the active version's file, not the original. This is
  a contract change at the cutover.**
  - **Shipped:** the shipped surface sends `select` with `path: original`, the
    file on disk (`surface/App.tsx`). The daemon stores each message with
    `selection` (that path) and, beside it, `activePath`, the version's file.
  - **Kit:** the kit daemon takes the `select` path as it comes. It checks only
    `doc` and `version` (`selectionOnScreen`). It then puts the path in the
    message's one `about.path`. The kit protocol defines that field as "Absolute
    path of the version's file … so the agent knows what to read". With no
    selection, the daemon fills it with the active version's file itself
    (`activeOf`).
  - **Why the version's file:** sending the original would make `about.path`
    mean two things, depending on whether a selection rode along. It would also
    point `fromLine` and `toLine` at a file whose lines they do not count while
    the version differs from the file on disk.
  - **What the agent loses:** after the cutover, an agent reading a human
    message gets the version's file and no longer the original beside it. It can
    still find the original through `state` (`docs[].original`).
  - Pinned in `frameWorkspace.test.tsx` and in `Frame.document.test.tsx`, which
    checks the stored message's `about.path` against the version's file and
    against the original.

**Tests:** `Frame.document.test.tsx` (8 cells, on a real flagged daemon) covers
these:

- the empty state;
- an edit and Save;
- split, and the view-mode key;
- a raw selection as the chat's chip and in `say`, and the chip's X;
- a rendered selection noted from Notes, which consumes it, and going to that
  note;
- the trust and stale chips, and the stale rule;
- "See the difference" opening compare against the file.

`Frame.test.tsx`'s three "pane is coming" cells now hold the pane's empty state,
the Notes form, and a document opened from the tree. `chat.test.tsx` gains one
cell for the toast's new button.

**Mutation checks.** Each of these was planted, seen red, and then restored:

- dropping the toast's button: red in the kit's cell and the frame's;
- a note that does not drop the selection;
- `say` without the selection;
- the stale rule inverted: red in both chip cells;
- going to a note without choosing it;
- `frontmatterTrust={false}`;
- "See the difference" aimed at v1 instead of the file.

**After the verifier's ruling.** Its 19 mutations left 11 alive. Each now has a
cell. `frameWorkspace.test.tsx` (8 cells) drives the hook over a hand-made
daemon whose `send` stays the same across renders, as the real client's does. A
fresh function per render had hidden the reconnect mutation.
`Frame.document.test.tsx` gains 4 cells (13 in all): line numbers, reader mode,
the new-version toast's "Show diff", and `about.path`. Its view-mode cell now
asserts the literal `"scriptorium:view-mode"`. A scripted run planted 16
mutations, one at a time, and every one went red:

- **The held selection:**
  - the `shown` event no longer clears it (E66);
  - `select` not sent again on a reconnect;
  - `select` sent while disconnected;
  - `heldHere` ignoring the version;
- **The chosen note:**
  - kept across a version switch;
  - a second click that does not let go;
  - a resolved note that stays chosen;
  - going to a note without revealing it;
  - `letGoOfNote` doing nothing;
- **The `select` path:**
  - the original's path (2 cells red);
  - the first version's file;
- **`Frame.tsx`:**
  - the new-version toast's "Show diff" aimed at the file;
  - the chat column not hidden in reader mode;
  - the view-mode key changed;
  - `lineNumbers` not passed;
  - the line-number key changed.

**Real browser** (Playwright, on `127.0.0.1` only). The session ran on a scratch
home with `SCRIPTORIUM_KIT=1` and `open` stubbed, against the built `dist/kit`.
There was no console warning or error. What happened:

- **Opening:** `lantern.md`, opened from the tree, showed in raw view.
- **Chips:** rendered view showed `note`, `draft`, `machine-confirmed` and
  `stale`. `stale` has the title "Past its stale_after date", and `stale_after`
  is still listed. `plain.md`, which has no `verified` key, showed only `note`.
- **Chat:** double-clicking "lantern" in the rendered view put the chip
  "lantern.md · v1 · line 11" in the chat. Clicking into the composer kept it.
  The message was stored with `about` {doc, version 1, the v1 path, line 11,
  "lantern"}.
- **Notes:** the form quoted "lantern". Add note made the note at 118–125. The
  daemon's selection became null, and the form said "No selection". Clicking the
  note in the panel bordered it, and the document painted "lantern" with
  `doc-note-focus`.
- **Versions:** typing in raw made the document dirty, and Save wrote the file.
  "New version from v1" with the label "foggier" made v2, and the edit went to
  v2. Switching back to v1 showed v1's text.
- **Compare and merge:** Compare against v2 showed one change. "Take" merged it
  into v1, and Revert took v1 back to the file.
- **Split** showed the editor and the rendered view side by side.
- **Outside change:** with an unsaved edit ("MINE"), the file was changed on
  disk ("THEIRS").
  - The toast said "lantern.md changed on disk" and offered "See the
    difference", "Reload" and "Keep". The first button's label is "Compare
    lantern.md with the file on disk".
  - Clicking it opened compare against `lantern.md` (the file), with both sides
    visible. The edit and the flag stayed, and the pane's banner stayed.
  - "Keep mine" saved and cleared the flag.
- **Reader mode** hid both columns, and leaving it brought them back.
- **Links:** following the link to `plain.md` moved the tree's highlighted row.
  The rendered view showed "Linked from" with 1 link from lantern.

Screenshots are in the implementer's scratchpad (`centre-live/01…09`).

**A second browser check, after the rebase** (session `2858b113`, the same
setup, no console warning or error):

- **Line numbers:**
  - The raw view offered the toggle, off at first. On, the gutter numbered 1–6.
  - The choice was stored as `scriptorium:line-numbers=on`, and nothing was
    stored under `spellbook:line-numbers`.
  - A selection on gutter line 4 put "lantern.md · v1 · line 4" on the chip.
  - In split, only the raw half had a gutter.
  - The choice survived a reload.
- **"Linked from" on `lantern.md`:** it listed "1 reference", headed
  "frontmatter: references, not links in the text". The entry was `keeper` with
  `related: ./lantern.md`. Clicking it opened `keeper`.

**The gate** at `ca198a83`, after the rebase, exited 0, with 6,525 passing
across 437 files. It ran under a scratch HOME, SCRIPTORIUM_HOME and TMPDIR. An
earlier run, before the rebase, exited 1 with two failures in files this item
does not touch: the shipped `backend/cli-contract.test.ts` and
`kit/workspace/diskGuard.test.ts`. Each of those passed when run alone, and the
verifier's two gates had neither failure. **The shipped Scriptorium:** before
and after, its `--help`, `--version`, `open --no-open`, `state` and `close` on a
scratch home match. The only differences are the entry id (a hash of the scratch
path) and the epoch. Its built `index-x7h9dpmj.css`, `index-w940m06p.js`,
`cli.js` and `server.js` are byte-identical. The branch changes only `dist/kit`.

## The three older items, checked against the kit

These were read against the kit's code, and the verdicts come from reading it.
None of them was driven in a browser, except edges 4 and 7, which the browser
check above covers. This is a proposal for the lead to take to Cole. No item's
lifecycle was changed.

**[scriptorium-selection-edges-the-review-found](scriptorium-selection-edges-the-review-found.md):**

- **1. An unplaceable selection keeps the old passage on the chip. It still
  holds.**
  - `renderedSelectionAct` returns `"ignore"` for one it cannot resolve
    (`src/kit/context/selection.ts`).
  - The kit's `MarkdownView` acts only on `report` and `clear`.
  - Re-aim at those two.
- **2. Ctrl+click is read as a context press everywhere. It still holds.**
  - The same line is in `src/kit/document/MarkdownView.tsx` (`onPointerDown`).
  - Re-aim.
- **3. An Escape-dismissed note menu leaves the chip with no highlight. It still
  holds.**
  - The keydown only spends the context press (`MarkdownView.tsx`).
  - Re-aim.
- **4. A note from the Notes panel does not consume the selection. This is gone
  on the kit path.**
  - The frame's `addNote` drops the selection, as Story Studio's shell does.
  - A test pins it, and the browser check saw it.
  - Close it at cutover.
- **5. A second tab wipes the daemon's selection. It still holds, and copying
  the shell carries it.**
  - The daemon's `select` overwrites its one selection
    (`src/kit/workspace/server.ts`).
  - The host sends `select: null` on connect when it holds none, as the shell
    does.
  - Re-aim at the kit daemon and the host. Which viewer wins is still a question
    for real use.
- **6. The chip keeps its text after the version menu. It still holds, with a
  narrower trigger.**
  - Choosing the active version is now a no-op (`VersionMenu.tsx`).
  - A press outside the pane that empties the selection is still `ignore`
    (`selection.ts`, `pressedHere`).
  - Re-aim. It could merge with 3 as "a press outside the pane empties the paint
    and nothing reports it". The repro needs re-taking on the kit.
- **7. The tree keeps the previous document after a link. This is gone on the
  kit path.**
  - The frame derives the active row from `state.openDoc` on every snapshot.
  - The browser check saw the row move.
  - Close it at cutover.

**[scriptorium-selection-hygiene-duplication-and-cost](scriptorium-selection-hygiene-duplication-and-cost.md):**
both still hold.

- The `clearSeq` edge-detect is still written out in both
  `src/kit/document/MarkdownView.tsx` and `DocumentView.tsx`.
- `align()` is byte-identical in `src/kit/document/renderedRange.ts`, with the
  `runs.map(r => r.trim())` in `projection.ts`.
- Re-aim both at the kit files. Measure before changing anything.

**[scriptorium-a-coalesced-scroll-is-lost-in-one-ordering](scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md):**
both windows still hold.

- `createPlace` in `src/kit/document/place.ts` has the same `left` and
  `afterFrame` guard.
- `src/kit/document/place.test.ts` carries both PINNED cells.
- Re-aim the references and acceptance criteria at the kit files.
- The kit's copies do not cite this item, while the shipped ones do. Add the
  citation when it is re-aimed, or the pointer goes when the shipped surface is
  deleted.

## Port-back notes

- **`chat/OutsideChangeToasts.tsx`:**
  - It takes an optional `onShowDiff(doc)`. Given one, "See the difference"
    comes first, before Reload and Keep. Like Keep, it decides nothing: it opens
    compare and lets the toast go. Without it the toast is Story Studio's as it
    was.
  - Reload now reads its handler at click time (`wiring`), as `NewVersionToasts`
    does, instead of through its own ref.
  - The header comment says why the button is there.
- **`document/DocumentPane.tsx`:** `ShowDiff.version` is `DiffSide`, not
  `number`, so a request can name the file on disk (`"original"`). The pane
  already passed it straight to `setAgainst`.
- **The shell:** Story Studio's `WorkspaceShell` would pass
  `onShowDiff={(doc) => …}` to `OutsideChangeToasts`, opening its `showDiff`
  with `version: "original"`. Nothing in the shell has to change for the toast
  to stay as it is.
- **`chat/NotesPanel.tsx`'s `addUnavailable`** (our addition, from the panes
  cycle) now has no host using it. Don't offer it back.
- Everything else in this item is Scriptorium's own (`surface/kit/`), and none
  of it goes back.

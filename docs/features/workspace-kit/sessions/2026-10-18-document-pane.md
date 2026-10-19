---
type: session
title: The document pane
description:
  "The fifth Workspace Kit cycle, the fourth of the workspace stack: the kit's
  document pane ported and put in the flagged Scriptorium's centre, with the map
  as its app view, Add a block, line numbers and four kit slots."
tags: [kit, scriptorium, story-studio]
status: stable
generated: { by: claude-opus-5-5, at: 2026-10-18 }
---

# The document pane

## Context

This was the fourth of five workspace-stack cycles
([cycle](../../../cycles/2026-10-document-pane.md),
[port shape §2b](../../../items/workspace-stack-port-shape/write-up.md#2b-the-cycles)).
The panes cycle had landed the day before, so the flagged Scriptorium
(`SCRIPTORIUM_KIT=1`) had chat, sets and moves, but no way to read or edit a
document.

Cole approved the cycle, its seven items and four rulings in a Scriptorium
review session. He then took in the line-number toggle and approved it after two
notes. The branch was `cycle/document-pane`.

As before, every item was built by a subagent in its own worktree, checked by a
verifier with no stake in it, sent back for fixes, and then cherry-picked. Dist
was rebuilt once after each pick.

## What Happened

**The port base.** Story Studio's `develop` was at `b6d5956` when the cycle was
planned, read with `git show` and `git log` only. Ten commits since `027d7a3`
touch `document`. The two we leave out elsewhere, copy-in `6b3d943` and the
plugin host `3d029f0`, change only its tests. So the module came over from
`develop` whole: 9,020 lines, plus 10,025 lines of tests.

**The items, in the order they ran:**

1. **First wave, in parallel.**
   - **`kit-port-document`.** The verbatim port, our names, and a
     `testWorkspace` helper that only makes a folder. CodeMirror and mdast are
     now declared at the root, pinned exactly to Story Studio's lockfile.
     - The document stylesheet rules went into a sheet of their own,
       `theme/document.css`. Putting them in `base.css` would have changed the
       shipped Scriptorium's rendered view.
     - The verifier found every themed spell's CSS 10% larger, because
       `base.css` scanned the whole kit. `base.css` now names the folders it
       scans, `document.css` scans its own, and a test fails if a kit folder is
       scanned by neither. Every other spell's dist went back to byte-identical.
   - **`kit-context-row-marker`.** Story Studio's `rowMarker`, taken without its
     plugin host. It turned out to be a `WorkspaceShell` prop (from `1dd40cc`),
     not a sidebar prop, so it sits on our `ContextSidebar` in the same shape.
     The frame fills it with the shipped `statusMark`. In a real browser, its
     marks matched the shipped tree on 18 documents.
   - **`kit-docmeta-push-cost`.** Each state frame now marks an unchanged app
     view (`appStateUnchanged`) for a connection that already has it, and the
     client keeps its copy. Its first design skipped the typing-pause broadcast
     entirely. The verifier found that Story Studio's Canvas and a second
     surface's compare read `docs[].hash`, so the pause broadcasts again,
     marked.
2. **Second wave.**
   - **`kit-backlinks-reference-edges`.** "Linked from" lists frontmatter
     references as references, not links in the text. The verifier found that
     the port-back note was false: Story Studio has no edge slot yet, so this
     can only go back after `kit-link-edges-slot` does.
   - **`scriptorium-toggle-line-numbers-in-raw-mode`.** An opt-in toggle, using
     a CodeMirror compartment so the editor is never rebuilt. A press leaves
     focus in the editor.
   - **`scriptorium-kit-document-centre`.** `DocumentPane` in the frame's
     centre, on a small workspace context (`frameWorkspace.ts`). It brings:
     - the held selection, going to chat and Notes;
     - the trust chip (E69) and a stale chip;
     - split view and line numbers;
     - "See the difference" on the kit's outside-change toast (Cole's ruling 3).
3. **Third wave.**
   - **`scriptorium-kit-map-view`.** The shipped map, re-fed from the kit's
     `LinkGraph`, in the pane's `appView`. The verifier found that a node mixed
     two moments. A new flagged-path verb, `scriptorium.map`, now returns the
     graph and that set's `docMeta` together, and every showing asks again.
   - **`scriptorium-kit-suggest-meta`.** E35's "Add a block" on the kit path,
     through a new generic `textOffer` slot. The block matches the shipped
     suggestion byte for byte on 12 of 13 test documents; the 13th is CRLF
     (Discoveries).
4. **Joined mid-cycle: `kit-read-reply-reverts-sent-edit`** (Cole's ruling 5).

**Cole's mid-cycle rulings (2026-10-18):**

- The typing race is fixed in this cycle.
- Broken links must be visible to the human. That is filed as an item; the map
  lands without its "leaving" and "dangling" numbers.
- Reader mode should cover the raw editor too. That is filed as an item.

## Notable Discoveries

- **The port carried a data-loss race.** On open, the pane sends a `read` as
  well as receiving the daemon's push. If that reply lands after an edit has
  been sent, the client's copy reverts, and the next keystroke overwrites the
  daemon's text. Story Studio has the same code.
  - The fix orders replies by request id. It uses no timer and needs no protocol
    change.
  - A verifier showed the bug in a real browser on the base, and showed it gone
    on the branch, through a proxy kill and restart.
- **Each verifier found what its implementer couldn't.**
  - CSS bloat in five other spells.
  - A Story Studio reader of `docs[].hash`.
  - A false port-back claim.
  - Duplicate React keys on real data.
  - A stale second tab overwriting another tab's typing.
  - A map node showing two moments.

  Every item but one needed a fix round. Seven of the eight verifiers invented
  mutations that survived the author's tests.

- **Share the answer, not the copy.** The first "Add a block" decided whether a
  document had frontmatter from its own tab's text. A stale tab could therefore
  overwrite another tab's typing. The shipped app answers from the daemon's
  shared state, and so does the fix (`appState.noFrontmatter`).
- **The kit doesn't send edits to other tabs.** A second tab never sees what the
  first typed (filed). Several fixes this cycle had to work around that.
- **Load makes the gate flaky.** With three agents running, two items reported
  red gates on files they didn't touch. Each of those files passed when run
  alone, and every verifier's own full gate was green. Running the gate on the
  committed tip, without load, settled each one.

## Changes Made

- **The document module.**
  - `src/kit/document`: 77 files from Story Studio `b6d5956`.
  - `src/kit/theme/document.css`, and an explicit `@source` list in `base.css`.
  - At the root: `@codemirror/*`, `@lezer/highlight`, `@lezer/json` and
    `mdast-util-*`, pinned exactly to Story Studio's versions.
- **Kit slots and props, each optional:**
  - `rowMarker` and `withRowMarker` on `ContextSidebar`;
  - `textOffer` on `DocumentPane`;
  - `lineNumbers` and `lineNumbersKey` on `DocumentPane`;
  - `onShowDiff` on `OutsideChangeToasts`, with `ShowDiff.version` widened to
    `DiffSide`;
  - `onOpenEdge` on `Backlinks`.
- **The wire:** `StateFrame`, `appStateUnchanged` and `resolveAppState`. The
  daemon, the protocol and the client must be ported together.
- **The client:** `sentEdit` request-id ordering in `daemonClient.ts`.
- **The flagged Scriptorium:**
  - `frameWorkspace.ts`, `useMapView.tsx`, `MapView.tsx`, `mapGraph.ts`,
    `suggestMeta.ts` and the frame's own `styles.css`;
  - the backend verbs `scriptorium.map` and `scriptorium.meta.suggest`, and
    `appState.noFrontmatter`.
- **The shipped Scriptorium.** Its behaviour, CLI and page are unchanged. Two
  things in its dist moved: CodeMirror went up by a patch version, and its
  `dist/server.js` gains the flagged-path verbs.

## Review

**Census:** every item had a verifier with no stake in it. Each verifier was a
`general-purpose` agent with full tools, and ran its checks rather than reading
the code. Read-only reviewers were not used, because the work needs browsers and
daemons.

| Item                                          | Rounds | Verdict           | Browser             |
| --------------------------------------------- | ------ | ----------------- | ------------------- |
| `kit-port-document`                           | 2      | Yes               | shipped app smoke   |
| `kit-context-row-marker`                      | 2      | Yes               | 18-doc parity       |
| `kit-docmeta-push-cost`                       | 3      | With fixes, fixed | wire frames         |
| `kit-backlinks-reference-edges`               | 2      | With fixes, fixed | real slot           |
| `scriptorium-toggle-line-numbers-in-raw-mode` | 2      | Yes               | IME, 50k lines      |
| `scriptorium-kit-document-centre`             | 2      | With fixes, fixed | full DoD            |
| `scriptorium-kit-map-view`                    | 2      | With fixes, fixed | side by side        |
| `scriptorium-kit-suggest-meta`                | 2      | With fixes, fixed | 13 docs, two tabs   |
| `kit-read-reply-reverts-sent-edit`            | 2      | Yes               | lag proxy, restarts |

The combined gate on `cycle/document-pane` before the race fix had 6,580
passing, 0 failing. Its final run is recorded in the cycle's Outcome. The
shipped Scriptorium's parity harnesses and acc were identical across every item.

## Follow-up

- **Filed this cycle (triage):**
  - `kit-watcher-frontmatter-edit-no-broadcast`
  - `kit-second-tab-misses-edits`
  - `kit-broken-links-visible` (Cole's ruling 6)
  - `kit-reader-mode-covers-raw` (Cole's ruling 7)
- **Cole approved all four on 2026-10-19.** They stay in triage until he moves
  them.
- **The three older items the centre item re-checked against the kit.** Cole
  ruled on 2026-10-19 as proposed below, and each item is now re-aimed at the
  kit, under `feature/workspace-kit`:
  - `scriptorium-selection-edges-the-review-found`. Edges 4 and 7 are gone on
    the kit path; close them at the cutover. Edges 1, 2, 3, 5 and 6 still hold;
    re-aim them at the kit's `selection.ts`, `MarkdownView.tsx` and `select`.
  - `scriptorium-selection-hygiene-duplication-and-cost`. Both points still
    hold; re-aim it at `renderedRange.ts` and `projection.ts`.
  - `scriptorium-a-coalesced-scroll-is-lost-in-one-ordering`. Both windows still
    hold in `kit/document/place.ts`; re-aim it there.
- **An agent-facing contract change for the cutover.** A selection's
  `about.path` is now the session's version file, not the original on disk. The
  original is still in `state`.
- **The map's copy.** `MapView.tsx` is a copy of the shipped `MapOverlay.tsx`
  until the cutover deletes the shipped surface. A fix to one must be made in
  both.
- **Kit-parity offers** (made at landing): `rowMarker`, the state-frame trio,
  `textOffer`, line numbers, `onShowDiff`, the read-reply fix, and "Linked from"
  references once the edge slot goes back.

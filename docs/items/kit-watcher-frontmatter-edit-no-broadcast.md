---
type: item
title:
  An outside frontmatter edit to an unopened document reaches the surface late
description:
  On the flagged backend, editing an unopened document's frontmatter on disk
  sends no state frame, so tree marks and docMeta lag until the next unrelated
  broadcast; the agent's state is fresh.
status: stable
lifecycle: done
id: 01a14e0e-a6b6-7237-9ab1-28c625941f8d
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-18 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
from: 01a1486e-3a72-755d-ae24-fcfc18a8e5ee
cycle: 2026-10-shell
---

# An outside frontmatter edit to an unopened document reaches the surface late

The `kit-docmeta-push-cost` verifier found this on 2026-10-18. It reproduces on
the base (`cycle/document-pane` at `3fc49187`) as well, so the cycle's change
did not cause it.

With `SCRIPTORIUM_KIT=1`, editing on disk the frontmatter of a document that is
in a set but not open sends no `state` frame: 0 frames in 6 s, old and new. The
surface's `docMeta` stays as it was, and so do the tree's status marks
(`kit-context-row-marker`), until the next unrelated broadcast, such as a chat
line. The agent's `GET /state` reads fresh `docMeta` every time.

## Definition of done

- [x] An outside edit to an unopened document's frontmatter reaches the
      surface's `docMeta` within the watcher's debounce, and a test pins it.
- [x] The change is generic, for example the watcher re-evaluating the app's
      view on a tree change, and it is offered on kit-parity. _(Offered on
      kit-parity, message 46, 2026-10-20.)_
  - Generic: verified. The offer is written below as Port-back notes; posting it
    on kit-parity is left to the lead.

## What the shipped Scriptorium does

The same thing. Checked on 2026-10-19 on a scratch home, with the shipped daemon
(no flag) and a raw socket. Editing an unopened document's frontmatter on disk
sent 0 frames in 3 s, while `state` read the new status. The shipped watcher
sends a `state` frame only for a change to the tree's shape (`rescan` in
`src/scriptorium/backend/session.ts`). So this is a gap the kit inherited, not
something the port lost.

## Done and verified

Commit `3410b97f` on `impl/kit-watcher-frontmatter-edit-no-broadcast` changes
`src/kit/workspace/server.ts`:

- When the context settle fires (`CONTEXT_CHANGED_SETTLE_MS`, 400 ms, the same
  moment `context.changed` goes out), the daemon asks the app's view again
  (`refreshAppView`).
- It broadcasts only if some connection holds a different copy. The check uses
  the `viewSent` record from `kit-docmeta-push-cost`, so the frame it sends
  marks an unchanged view in the usual way, and a connection that missed a frame
  gets the view whole.
- A view that did not change sends no frame, and a burst is one evaluation.
- `viewState` takes the view the refresh already computed, so the hook runs once
  for that frame.

Measured on the flagged backend, on a scratch home:

| Outside edit               | State frames | First frame after the writes              |
| -------------------------- | ------------ | ----------------------------------------- |
| 3 frontmatter edits        | 1            | 405 ms                                    |
| 500 frontmatter edits      | 1, 126 KB    | about 1.1 s (FSEvents spreads the events) |
| 500 edits to the body only | 0            | none                                      |

The hook took about 15 ms with a cold cache over 500 changed files.

Tests:

- `src/kit/workspace/server.test.ts` covers three cases. An outside change to a
  file the app's view reads reaches the surface within the settle. A change that
  leaves the view alone sends no frame. A burst of 200 files sends one frame.
- `src/scriptorium/backend/kit/wiki.integration.test.ts` checks that an outside
  edit to an unopened document's frontmatter reaches the surface's `docMeta`
  within 2 s. The test first waits for the shared session to go quiet, because
  an unrelated broadcast (the attention sweep) would otherwise hide the bug.

Checked in a real browser (Playwright, flagged daemon, scratch home). The tree
showed `two.md` with its `status: draft` mark. Editing the file on disk to
`stable` removed the mark, and editing it back to `draft` brought the mark back
about 1 s after the write. Nothing in the surface was touched in between.

Deliberate choices:

- **The refresh rides the context settle, not each file's 60 ms settle.** One
  evaluation per burst, at the moment the kit already tells surfaces the context
  changed.
- **The hook now runs once more per settled burst of outside changes, even when
  nothing is sent.** That replaces the earlier "once per broadcast" rule. Its
  cost is the app's: Scriptorium's `docMeta` is cached by mtime.
- **No timer when no surface is connected.** `GET /state` is fresh anyway.
- **The settle has a cap (`CONTEXT_CHANGED_MAX_WAIT_MS`, 2 s).** The verifier
  found that a steady trickle starved the settle: with one file written every
  300 ms, no `state` and no `context.changed` went out for the whole 10 s. That
  starvation predates this item, but the refresh had inherited it.
  - While events keep arriving, the cue and the refresh now fire at least every
    2 s. Otherwise the settle is the 400 ms trailing one, as before.
  - In the verifier's harness, 34 writes over 10.2 s now send 4 frames and 4
    cues during the trickle, where before they sent none.

The verifier's fixes are in `ca8a846a` and `731a1e81`, fixups to `3410b97f`.
They add the cap, a trickle test, and three tests that its mutations had
survived:

- one connection stale and the other current, where the stale one must be
  refreshed;
- a hook that throws in the timer, which is logged while the daemon keeps
  serving;
- the hook running once per settle.

The flagged integration test now also asserts that the session went quiet before
the edit.

Not fixed, and older than this item: a burst of 2,000 files takes about 22 s to
reach the surface. That time is the watcher's own per-file cost (the session's
`onFileEvents` and the recheck for each path), not the refresh.

## Port-back notes

For kit-parity, against Story Studio `develop` at `6235e992`.

- **It depends on `kit-docmeta-push-cost`'s port-back.** It reads `viewSent` and
  `sendState`, and `6235e992` has neither. Port that one first.
- `packages/kit/src/workspace/server.ts`:
  - `viewState(pre?)` takes an already-computed `appState`;
  - the new `refreshAppView()` sits next to `broadcastState`;
  - `refreshAppView()` is called in the `cueContextChanged` timer, after
    `pruneImageThumbs()`;
  - `cueContextChanged` gets a cap, the new exported
    `CONTEXT_CHANGED_MAX_WAIT_MS` (2 s). A trickle of events now fires the cue
    at least that often. Story Studio's `context.changed` gains this too, which
    changes behaviour on its own: its link check refreshes during a long trickle
    of writes.
- Paths the watcher marks as not in the context are not covered, because they
  never cue the settle: dot-paths, and the session's own docs folder.
- Behaviour Story Studio would see: an app whose `appState` reads files that are
  in the context but not held (an index, a canvas that reads frontmatter) now
  updates on an outside edit, within about 400 ms, with at most one frame per
  burst.
- Its hook runs once more per settled burst. A test that counts hook calls
  against state frames still holds, as long as nothing in the context changes on
  disk during it.
- The tests to port:
  - in `server.test.ts`: "an outside edit to an unopened document reaches the
    app's view once the watcher settles…", "a steady trickle of outside writes
    still reaches the surface…" and "an app view that throws when the watcher
    settles…";
  - in `stateDrop.test.ts`: "the watcher's refresh sends the view to the one
    connection that missed it…".

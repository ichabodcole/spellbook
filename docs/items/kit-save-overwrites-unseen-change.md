---
type: item
title: Save can overwrite an outside change the file watch never reported
description:
  save() checks the original still exists but never compares its hash with
  originalHash, so an outside change the watch missed (just after a watch arms,
  or dropped by a saturated fseventsd) is overwritten silently, with no 'Changed
  on disk' banner.
status: stable
lifecycle: done
id: 01a16b3f-7b43-75d4-a4b5-db63b7063d23
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: items/kit-watch-tests-unproven-watch.md
priority: urgent
cycle: 2026-10-release-6
---

# Save can overwrite an outside change the file watch never reported

The kit learns of outside changes only from file-watch events. Two gaps let one
go unseen:

- **Right after a watch arms**, until FSEvents starts delivering for it:
  milliseconds normally, up to about 3 s on a machine whose `fseventsd` is
  saturated (measured on 2026-10-23, while other sessions ran parallel suites).
  Watches arm on `context.add`, on opening a document outside a recursive root
  (`watchRoots` in `session.ts`, `syncWatchers` in `server.ts`), and on a daemon
  restart. An agent can easily write to a file it just opened inside that
  window.
- **Possibly, a saturated `fseventsd` dropping an event for a live watch.** Not
  yet shown; it's the open question in `kit-watch-tests-unproven-watch`.

Nothing catches up a missed event. The only rescans are on restore, `refilter`
and watch events; the `originalsUnder` 400 ms recheck runs only after an event.

**The sharp case is Save.** `save()` asks the disk whether the original exists
("Asked of the disk, not of the flag", around `session.ts:2681`), so a missed
delete can't make Save write somewhere stale. But it never compares the file's
current hash with the document's `originalHash` before `writeOwned` (around
`session.ts:2706`). An outside change the watch missed is overwritten silently,
with no "Changed on disk" banner. A missed delete also leaves the document not
marked missing until another event lands in that folder.

Found by the verifier of the polish cycle's watch-test fix (2026-10-23). Story
Studio's kit has the same shape; check its `save` before porting.

## Definition of done

- [x] Save compares the original's current hash with `originalHash`, and on a
      mismatch refuses or asks, the way it already handles a missing original,
      with the act that answers it (show the diff, keep theirs, or overwrite).
- [ ] Optionally, once a new watch is proved live, the documents it covers are
      re-stated once, so a change in the arm window is caught.
- [x] A test changes a file with no watch event delivered, then Saves, and shows
      the outside change survives.

## Done and verified

Commit `6ffc9049` on `impl/kit-save-overwrites-unseen-change`. `save()` reads
the original and, when its text is neither the one the session last read
(`originalHash`) nor the text about to be written, refuses with a 409
`UnseenChangeError` and classifies the change as the watcher would have
(`onFileEvent`). With unsaved edits the document is flagged `outsideChanged`, so
the existing "Changed on disk" banner, toast and chat line offer "See the
difference", "Keep mine" and "Take the file's"; with none, the file's text is
loaded. The refusal's hint names those acts. The daemon passes the refusal's
event to `handleFileEvent`, so the surface and the agent's tail hear it as a
delivered event. Once the flag is up, Save is the deliberate "Keep mine".

Deliberate choices:

- **No new banner or path.** A mismatch caught at Save lands the human in the
  same state as a delivered event, reusing the E54 flow.
- **The same text is not a conflict.** An outside write equal to the human's
  text lets Save go ahead.
- **No agent save verb exists.** Save is the human's alone (`op: "save"` from
  the surface), so the guard sits in `session.save()`, where any future caller
  meets it.
- **The optional box is skipped.** Nothing proves a watch live today:
  `syncWatchers` arms `fs.watch` with no probe. Re-stating documents "once a
  watch is proved live" would mean building that probe (a write per new watch,
  then waiting for it), which is not small. Save's check closes the data-loss
  case without it. A missed event still leaves the banner unraised until Save,
  or the next event in that folder.
- **A daemon `watch` test seam** (absent: `fs.watch`) lets `saveUnseen.test.ts`
  run a daemon whose watch never reports. That makes the missed event certain
  rather than a race.

Tests are in `src/kit/workspace/saveUnseen.test.ts`: four session-level tests
(no watcher at all) and one daemon test with the watch suppressed. A real
Chromium run on Scriptorium's page with the watch suppressed covered typing, the
outside write, and Cmd+S, after which the file kept the outside text and the
banner rose. It then covered "See the difference" showing the outside line,
"Keep mine" writing the human's text, and, on a second round, "Take the file's"
loading the outside text.

Story Studio's kit has the same bug: `packages/kit/src/workspace/session.ts`
`save()` at `7aaa0692` checks only existence.

## Port-back notes

- `session.ts`: `UnseenChangeError` (extends `SessionError`, carries the
  `FileEvent` it classified). In `save()`, after the JSON check: when the file
  is there and `outsideChanged` is not up, read it, and if its hash is not
  `originalHash` and its text is not the active text, call
  `onFileEvent(d.original)` and throw `UnseenChangeError` (the reloaded wording
  for a clean document, the banner wording otherwise).
- `server.ts`: the `save` op's catch passes `e.event` to `handleFileEvent`
  before `broadcastState`. There is a new `watch?` option on
  `WorkspaceDaemonOptions`, a test seam.
- `index.ts`: exports `UnseenChangeError`.
- Story Studio's `save()` also rescans for `keepsOrderIn` and deletes `typedIn`
  after the write. The new check sits before the write and touches neither.

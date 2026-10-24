---
type: item
title: Save can overwrite an outside change the file watch never reported
description:
  save() checks the original still exists but never compares its hash with
  originalHash, so an outside change the watch missed (just after a watch arms,
  or dropped by a saturated fseventsd) is overwritten silently, with no 'Changed
  on disk' banner.
status: stable
lifecycle: triage
id: 01a16b3f-7b43-75d4-a4b5-db63b7063d23
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: items/kit-watch-tests-unproven-watch.md
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

- [ ] Save compares the original's current hash with `originalHash`, and on a
      mismatch refuses or asks, the way it already handles a missing original,
      with the act that answers it (show the diff, keep theirs, or overwrite).
- [ ] Optionally, once a new watch is proved live, the documents it covers are
      re-stated once, so a change in the arm window is caught.
- [ ] A test changes a file with no watch event delivered, then Saves, and shows
      the outside change survives.

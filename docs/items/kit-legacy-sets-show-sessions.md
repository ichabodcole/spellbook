---
type: item
title: A set restored from an older manifest can still show the sessions folder
description:
  Restore keeps a set whose root shows the sessions folder (or add ~ with a link
  into it), so the agent can read other sessions' files through it; every write
  through such a set is refused.
status: stable
lifecycle: done
id: 01a14911-a3e4-77de-8b03-11407216f2de
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, security]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# A set restored from an older manifest can still show the sessions folder

Found by the wiki-layer cycle's security reviews (2026-10-17). A manifest
written before the fix can hold a set whose root shows the sessions folder, and
restore keeps it. `add ~` with a link inside `~` into the sessions does the
same. Every write through such a set is refused by `disk.ts`, but search,
`meta`, `show` and the tree can still read other sessions' files.

## Definition of done

- [x] On restore, a set whose real root holds or lies in the sessions or the app
      home is dropped or narrowed, with a chat line.
- [x] The tree scan does not follow a link into the sessions or the app home,
      with a test.

## Done and verified

On `impl/kit-tree-docs` (2026-10-19), one commit: "Kit: no set shows the
sessions or the app home, from an old manifest or through a link".

**Reproduced first**, on a scratch `SCRIPTORIUM_HOME` with the flagged
Scriptorium. Two problems showed up. `add ~` with `~/peek` linked to
`~/.scriptorium/kit/sessions` mirrored `peek/<id>/manifest.json`, and `meta`
read another session's manifest through it. A manifest edited to hold a set
inside another session restored with that session's `docs/` and `manifest.json`
in its tree, and nothing was said.

**The fix, in the kit and generic:**

- **The scan guard.** `scanTree` and `entryForPath` take an optional
  `ScanGuard`, a test on where a path really is. The session passes
  `ownPlaceGuard(ownPlaces)` (new in `noHome.ts`) on every scan: add, rescan,
  restore and the undo of a hide. Anything whose realpath lies in the sessions
  root or the app home is left out of the tree, and so out of search, `meta`,
  links and the graph. That covers a link into them, and the sessions folder met
  in plain sight. The cost is one `realpath` per folder and one per link.
  Folders are read with `withFileTypes`, so there is no extra `lstat` per file.
  A home-workspace app's `imported/` exception is kept.
- **Restore.** `WorkspaceSession.restore` takes `{ appHome }`, and the daemon
  passes it, so the app home is known before the first scan. Then:
  - an entry that lies among the own places is **dropped**: a set's root, or a
    listed file, as written or as resolved;
  - a set that holds them in plain sight (what `notASet` refuses) is **kept,
    narrowed** by the guard.

  Each is recorded in `RestoreReport.ownPlaceSets`, and the manifest is written
  back. The daemon says one chat line for each (`set.dropped`, `set.narrowed`).

**Verified:**

- `src/kit/workspace/ownPlaces.test.ts` has three new tests:
  - restore drops a set in another session, a set in the app home and a document
    listed there, and the next restore says nothing;
  - restore narrows a set holding the app home in plain sight;
  - the `add ~` case: links to the sessions, to one session, to a manifest and
    to the app home are left out, a link elsewhere is shown, and a rescan keeps
    that.
- `src/scriptorium/backend/kit/legacySets.integration.test.ts` uses the real
  launcher. A link into the sessions shows nothing and `meta` through it is
  refused. Restore drops one set and narrows another, with both chat lines.
- The scratch repro was re-run after the fix and was clean.
- Two tests were adapted, both in `ownPlaces.test.ts`:
  - "make-set refuses a document listed among the sessions": the old entry is
    now dropped at restore, so make-set answers 404 rather than 409. The file is
    still untouched.
  - "scenB": the set holding the sessions is now narrowed, so some acts are
    refused earlier, as no location (400) or not shown (404), rather than by the
    write backstop's 409. Nothing is written either way. The backstop itself
    (`worldDisk`) is unchanged, but this test no longer reaches it through a
    restored set.
- Three more suites build "a set that shows the sessions" on purpose, to test
  the write guard: `diskGuard.test.ts` (four holes), `trash.guards.test.ts`
  (one) and Scriptorium's `diskGuard.integration.test.ts`. Each hole is now
  closed twice: the path is not shown, and then the write is refused. So each
  test now accepts 400, 404 or 409, and still holds that nothing is written. The
  integration suite's "not vacuous" check is turned round: the old `$SH` set is
  dropped, with its chat line, so X no longer shows V's files. `worldDisk`'s own
  unit tests are unchanged and pass.
- **After the verifier's review**, the write guard is reached again through the
  sessions themselves. With the scan hiding the sessions, no test reached
  `worldDisk` through the real daemon: disabling its target check turned 8 unit
  tests and no integration test red. What only the write guard still catches is
  a path the scan showed, turned into a way into another session afterwards. So
  there are new cells for that:
  - `diskGuard.test.ts`, "after the scan": hole 1 (a shown document swapped for
    a link to another session's `v1.md`, then `writeShown`), hole 1 by a link (a
    shown folder swapped for a link into another session's folder), and hole 2
    (a shown image's folder swapped the same way, then `describeImage`). Each
    expects the guard's 409.
  - `diskGuard.integration.test.ts`, on the real launcher: `meta-set` and
    `image.describe` through a link chain the scan saw leading to `outside/`,
    retargeted afterwards to another session's files. The chain runs through
    `outside/`, which no set shows, so no watcher rescans first and the cell is
    deterministic.
  - With the target check disabled (`inOwnPlaces` → `null` in `disk.ts`), 11
    unit tests (the 3 new among them) and the new integration cell go red.
- The narrowed set's chat line said `notASet`'s reason, which could name the
  wrong thing ("… is the top of the disk"). It now names what is left out:
  "`<set>` stays a set, but scriptorium's own folder inside it (`<folder>`),
  where its sessions live, is left out of its tree, search and links".
  `<folder>` is the outermost own folder the set holds.
- `scanTree`'s root check is defence in depth and deliberately untested; a
  comment says so. Every route refuses such a root, and restore drops one.

**Known limits:**

- A **hard link** to a session's file, inside a set, is shown: it has its own
  path, and nothing on disk says where its other name is. Writes through it are
  refused (`worldDisk`'s `nlink` check on the same device).
- Two concurrent `open --restore` of one session start two daemons. This is
  older than this item, and is `kit-workspace-concurrent-restore`.
- An expandable bundle's own insides are read by their own walker, which has no
  guard yet. Scriptorium registers no bundle type.
- I did not run the real sessions through the converter myself. The verifier ran
  a copy of all 63: none was dropped or narrowed, and every `pre-migrate` file
  was byte-equal.

## Port-back notes

- `workspace/tree.ts`: new `ScanGuard` type. `scanTree(root, cap, skip, guard?)`
  and `entryForPath(abs, id, skipFor?, guard?)` take it, and `folderWalker`
  applies it to each entry of a set, and to the root. Without a guard, the scan
  does exactly what it did before.
- `workspace/noHome.ts`: new `ownPlaceGuard(own)`.
- `workspace/session.ts`: `scanGuard()` is passed on every `scanTree` and
  `entryForPath` call. `restore(…, opts?: { appHome })`, the private
  `settleOwnPlaceSets`, and `RestoreReport.ownPlaceSets`.
- `workspace/server.ts`: passes `appHome` to `restore`, and says the two new
  chat lines (`set.dropped`, `set.narrowed`).

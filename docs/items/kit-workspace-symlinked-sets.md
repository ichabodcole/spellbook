---
type: item
title: Mirrored sets follow symlinks out of the workspace and through loops
description:
  A directory symlink pointing outside the workspace shows its files in a
  mirrored set, and symlink loops are walked until the 2000-entry cap, listing
  alias paths as separate documents. Inherited from Story Studio's tree.ts.
status: stable
lifecycle: active
id: 01a13c65-0307-737d-bd5b-d00816a2d5cf
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, workspace]
parent: feature/workspace-kit-follow-ups
priority: medium
cycle: 2026-10-release-6
---

# Mirrored sets follow symlinks out of the workspace and through loops

Found by the finalize review of the
[workspace-daemon cycle](../cycles/_archive/2026-10-workspace-daemon.md)
(2026-10-14). The tree code is the same as Story Studio's `tree.ts`.

- A directory symlink inside a mirrored set that points outside the workspace
  shows that folder's files as documents in the set.
- Loops such as `self -> .` and `up -> ..` are walked about 39 levels deep,
  until the 2000-entry cap. Each alias path, like `self/self/…/x.md`, is listed
  as its own document. The walk always ends.

## Definition of done

- [x] A mirrored set either doesn't follow directory symlinks, or follows only
      those that stay inside the workspace. Say which.
- [x] A loop is visited once.
- [x] Tests cover an outward symlink and a loop.
- [ ] Offered to Story Studio on `kit-parity`.

## Policy: a link to a folder is shown, never entered

A mirrored set does not follow directory symlinks at all, wherever they lead.
The link keeps its row in the tree, as a folder with nothing read under it.

Why not "follow only links that stay inside":

- **Inside the set's root**, a followed link only ever shows files the set
  already shows, a second time under an alias path. Every alias is a second
  document for one file, which the session's one-path-per-document model cannot
  reconcile.
- **Inside the workspace** is not a boundary every app has: an app with no home
  workspace keeps none. Where there is one, a link from one set into another
  folder of it puts the same file in two places, the same double entry the
  chat-and-toast nits item notes at the root.
- **Not following** makes every folder a scan reads a real one, so a loop
  (`self -> .`, `up -> ..`) is read once by construction. No visited-set is
  needed.

Why the row stays rather than the link being left out: the link itself can still
be renamed, moved or put in the Trash from the tree. Leaving it out silently
made a linked folder vanish, and broke the "the link itself may go" Trash path.
The row reads as an empty folder. Telling the two apart needs a protocol mark,
which is a follow-up and not part of this item.

**Nothing goes into a link's row.** `destinationOrDie` in `session.ts` refuses
any folder of a set's tree that is a link, or that really is somewhere else
because a folder above it was swapped for a link since the scan. The same check
covers every route that takes a destination: a new document, folder or bundle,
`addFolder`, an import, a move or move plan, a drop or `fs.same`, and an image
drop. A move _out of_ a link row is already refused, because the files under it
are not shown. The refusal is a 400 in the house envelope. Its hint names the
act that answers it: `add <the link's path>`, which adds the linked folder as a
set of its own. Before this guard, `new-doc`, `new-folder`, `import --into` and
`move` into a link row all wrote where the link led, and the file then vanished
from the set. The Trash and duplicate guards still refuse as before.

**Following the hint works, whatever the order of the sets.** Once the linked
folder is added as a set of its own, its path is both a link's row in the set
holding the link and the root of the new set. `destinationOrDie` checks the
sets' own roots before any tree folder. So a root always takes things, even when
the holding set was added first, which is the order `add` gives. After something
is made, `adoptNew` re-reads every set whose root holds it, not only the first.
So the new file shows at once in the link's own set and opens. A folder shown in
a tree but gone from disk since the scan is refused with a 404 that says so.

A link named like a bundle (`Linked.boardbundle`) is a link's row too, not a
bundle read through it: its `info.json` and main file are not the set's either.
A link to a **file** still shows as the document it is, which is unchanged. A
set **rooted** at a link is still read through it: the link is the set, not
inside it. So `open world wlink` still adds both `/world` and `/wlink`, and this
item does not change the chat-and-toast nit.

## Done and verified

- **Commits:** `2f4b5ae7` holds the fix, its tests, the adapted tests and the
  rebuilt Scriptorium `dist`. `9828cffb` is this record. The fix round (the
  verifier's "With fixes") follows them: the destination guard, the cap test,
  and dirent link detection.
- **The fix:** `folderWalker` in `src/kit/workspace/tree.ts` reads each folder
  with `withFileTypes` and knows from the entries which names are links. A link
  to a folder becomes a childless `group` row, counted toward the cap like any
  folder, and is not walked. This covers set, member and bundle-own modes,
  because all three walk through this one function.
- **Tests:** `tree.symlinks.test.ts` covers, with and without a scan guard:
  - an outward link;
  - an inward link;
  - `self -> .`;
  - `up -> ..` one level down;
  - a link named like a bundle;
  - a file link;
  - a set rooted at a link;
  - outward links and loops inside an expandable bundle's member folder and its
    own files;
  - a link row counting toward the cap.

  `linkRows.session.test.ts` covers the destination guard: new document, folder
  and bundle, `addFolder`, import, image drop, `fs.same`'s folder, move and move
  plan into the row, a move out of it, an inward link, a folder swapped for a
  link (and one under it), the link itself still moving, and a set rooted at a
  link still taking new documents. The CLI verbs the verifier ran (`new-doc`,
  `new-folder`, `import --into`, `move`) were driven against a real daemon: each
  exits 2 with the hint, and nothing is written outside.

  Following the hint is covered in both orders: the linked folder added as a set
  after, or before, the set holding it, beside a third unrelated set. At its top
  level and in a subfolder, `createDoc`, `createFolder` and `importText` all
  land, show at once in the link's set, and make no new entry. The verifier's
  order scenario (`new-doc` at the top level and in `sub/`, parent first and
  link first) exits 0 in all four cases against a real daemon.

- **Changed existing tests:** five tests assumed linked folders were read.
  - Two now reach their deeper guard by the swap route: a shown folder is
    replaced by a link before a rescan. These are `trash.guards` "leads outside"
    and `bundles` "a bundle that is a link is not duplicated".
  - The paste test now asserts the earlier "not shown" refusal. A new
    session-level swap test keeps `imagesDirBeside`'s "leads outside" guard
    exercised.
  - `ownPlaces` "the add ~ case" expects `elsewhere` as a link row with nothing
    under it.
  - `src/scriptorium/backend/kit/diskGuard.integration.test.ts` "retargeted into
    another session": the image's link chain is now a second set rooted at a
    link (`open set linked-pics`). Its write-guard assertions are unchanged.
- **No fail-open in the walk:** the first round's `isLink` helper (`lstat`, with
  a `catch` meant to fail closed) is gone. Link detection now comes from the
  directory entries already read, so there is no second call that could fail.

### Known limits

- **The swap race:** this is slightly wider than with the first round's `lstat`.
  A folder replaced by a link between the listing and the walk is walked one
  level: its entries are listed through the link. It cannot loop, because the
  next level's listing sees any link inside it as a link. Writes there are still
  refused, by the realpath check in `notThroughLinkOrDie`.
- **Filesystems that don't report the entry type:** on these, `readdir` gives no
  entry type, so a link may not be recognised and is walked as a folder. APFS,
  ext4 and other common local filesystems report it.

## Port-back notes

- `tree.ts` `folderWalker`: every folder is read with
  `readdirSync(dir, { withFileTypes: true })`, which was only done with a guard
  before. A name whose entry `isSymbolicLink()` and whose `stat` is a directory
  becomes `{ kind: "group", rel, children: [] }`, counted once, with no walk and
  no bundle read. Story Studio has the same bug: at `7aaa0692`,
  `packages/kit/src/workspace/tree.ts` around line 497 `statSync`s each entry
  and walks into any directory, link or not. Its `"tree"` mode is our `"set"`.
- `session.ts` `destinationOrDie` -> new `notThroughLinkOrDie(abs, entry)`: a
  tree folder that is a link, or whose realpath is outside the entry's real
  root, is refused with a 400 and the hint `add <path>`. Story Studio's
  `destinationOrDie` has no such check either. Without it, the tree fix alone
  turns a linked folder into an empty row you can still write through.
- `session.ts` `destinationOrDie`: a mirrored entry's own root is matched before
  any tree folder of any entry, so the order of the context no longer decides
  between a link row and a set rooted at the same path. `notThroughLinkOrDie`
  refuses a folder gone from disk with a 404 ("is no longer on disk").
- `session.ts` `adoptNew`: re-reads every mirrored entry whose root holds the
  new path, not only the first (`coveringEntry`).

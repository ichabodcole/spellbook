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
be renamed, moved or put in the Trash from the tree. Its old guards still refuse
what they refused: dropping into a link that leads out, Trash through it,
duplicating it. Leaving it out silently made a linked folder vanish, and broke
the "the link itself may go" Trash path. The row reads as an empty folder.
Telling the two apart needs a protocol mark, which is a follow-up and not part
of this item.

A link named like a bundle (`Linked.boardbundle`) is a link's row too, not a
bundle read through it: its `info.json` and main file are not the set's either.
A link to a **file** still shows as the document it is, which is unchanged. A
set **rooted** at a link is still read through it: the link is the set, not
inside it. So `open world wlink` still adds both `/world` and `/wlink`, and this
item does not change the chat-and-toast nit.

## Done and verified

- **Commits:** `2f4b5ae7` holds the fix, its tests, the adapted tests and the
  rebuilt Scriptorium `dist`. This record follows it.
- **The fix:** `folderWalker` in `src/kit/workspace/tree.ts` checks `lstat` for
  each folder it is about to enter. A link becomes a childless `group` row and
  is not walked. This covers set, member and bundle-own modes, because all three
  walk through this one function.
- **Tests:** `tree.symlinks.test.ts` covers, with and without a scan guard:
  - an outward link;
  - an inward link;
  - `self -> .`;
  - `up -> ..` one level down;
  - a link named like a bundle;
  - a file link;
  - a set rooted at a link;
  - outward links and loops inside an expandable bundle's member folder and its
    own files.
- **Changed existing tests:** four tests assumed linked folders were read.
  - Two now reach their deeper guard by the swap route: a shown folder is
    replaced by a link before a rescan. These are `trash.guards` "leads outside"
    and `bundles` "a bundle that is a link is not duplicated".
  - The paste test now asserts the earlier "not shown" refusal. A new
    session-level swap test keeps `imagesDirBeside`'s "leads outside" guard
    exercised.
  - `ownPlaces` "the add ~ case" expects `elsewhere` as a link row with nothing
    under it.

## Port-back notes

- `tree.ts` `folderWalker`: before entering a folder, `isLink(abs)`
  (`lstatSync(...).isSymbolicLink()`, fail-closed). A link becomes
  `{ kind: "group", rel, children: [] }` and is counted once, with no walk and
  no bundle read. Story Studio has the same bug: at `7aaa0692`,
  `packages/kit/src/workspace/tree.ts` around line 497 `statSync`s each entry
  and walks into any directory, link or not. Its `"tree"` mode is our `"set"`.
- `isLink`: a new private helper in `tree.ts`.

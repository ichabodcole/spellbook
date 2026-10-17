---
type: item
title: Kit set promotion that keeps the entry id, and Scriptorium's make-set
description:
  Add a session API that turns a listed entry into a mirrored set and keeps its
  id, and build Scriptorium's make-set and folder creation on it.
status: stable
lifecycle: ready
id: 01a1478f-341d-770a-8ad1-8c3f9e934f0e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# Kit set promotion that keeps the entry id, and Scriptorium's make-set

Scriptorium's `make-set` turns a single document into a set: a folder named for
it, with the document moved in. The entry keeps its id
(`src/scriptorium/backend/session.ts`, `set.make`). The kit has no session API
to switch an entry from listed to mirrored
([write-up, 3a](../items/workspace-stack-port-shape/write-up.md#3a-the-wiki-layer-against-the-four-extension-points)).

With no default workspace
([scriptorium-no-default-workspace](./scriptorium-no-default-workspace.md)),
turning a document into a set and creating a folder at a location you pick are
how you make room for new files. So this item matters more than it did.

## Definition of done

- [x] The kit has a session API that promotes a listed entry to a mirrored set
      and keeps its id. Notes, versions and chat references to the entry
      survive, with tests.
- [x] The flagged Scriptorium's `make-set` uses it.
- [x] The flagged Scriptorium can create a folder at a location the caller
      names, as a new added folder.
- [ ] The API is offered to Story Studio on kit-parity.

## Done and verified

Two commits on `impl/kit-set-promotion`: `b17f7f94` (the kit) and `b451b19f`
(Scriptorium on it). The kit's session has `makeSet(path, { links })`, its way
back `unmakeSet(path)`, and `addFolder(path)`. On the wire they are the
structure ops `set.make` and `folder.add`, with system facts of the same names.
The flagged Scriptorium's own verbs `make-set` and `add-folder` post them. The
tests are `src/kit/workspace/setPromotion.test.ts` (ported from the shipped
`structure.test.ts`), `setPromotion.server.test.ts` and two cells in
`kit.integration.test.ts`.

Deliberate choices:

- **Undo.** The shipped undo of `make-set` deletes the folder, which is refused
  while the document is in it. On the kit the arrows run `unmakeSet`: the
  document goes back, listed by the same entry, and redo makes the set again.
- **Links.** The move into the folder can break links into and out of the
  document. `set.make` reports them (`broken`, each with the target that lands)
  and never rewrites them. `relink` does not apply to it, because its offer only
  rides a move or a rename.
- **Chat references.** They name a document by slug, and the slug survives. The
  `path` they recorded is not rewritten, as with any kit move.
- **Only a document.** An image or a bundle listed on its own is refused.
- **`add-folder` inside a set** makes a folder of that set, refused where
  `new-folder` refuses one. Outside every set it needs an existing parent, and
  it is never inside a bundle or among the sessions. The workspace is untouched;
  removing it is the next item's job.

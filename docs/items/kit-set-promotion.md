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

- [ ] The kit has a session API that promotes a listed entry to a mirrored set
      and keeps its id. Notes, versions and chat references to the entry
      survive, with tests.
- [ ] The flagged Scriptorium's `make-set` uses it.
- [ ] The flagged Scriptorium can create a folder at a location the caller
      names, as a new added folder.
- [ ] The API is offered to Story Studio on kit-parity.

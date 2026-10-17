---
type: item
title:
  A kit slot for app-supplied link edges, and Scriptorium's frontmatter
  references on it
description:
  Let an app add link edges with a kind to the kit's link cache and graph, and a
  resolver slot for its own wiki forms; Scriptorium's frontmatter references and
  wiki forms are the first users.
status: stable
lifecycle: ready
id: 01a1478f-32fb-74d2-98a8-cc6678eb222a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
cycle: 2026-10-wiki-layer
parent: feature/workspace-kit
---

# A kit slot for app-supplied link edges, and Scriptorium's frontmatter references on it

Scriptorium draws edges from frontmatter references (`fieldRefs` and
`looksLikeRef`, `src/scriptorium/backend/links.ts`), and resolves wiki forms the
kit doesn't: `type/slug` keys, bare names and the repo root. The kit's link
cache and graph have no place for either
([write-up, 3a](../items/workspace-stack-port-shape/write-up.md#3a-the-wiki-layer-against-the-four-extension-points);
[kit-links-differential](./kit-links-differential.md), `wikiForms`).

Story Studio asked that the slot be generic: edges supplied by the app, each
with a kind, not only frontmatter (kit-parity message 42). Their Atlas concept
graph would use it.

## Definition of done

- [ ] An app can supply extra edges, each with a kind, to the kit's link cache
      and graph. `graph`, `backlinks` and `link-check` include them and can
      filter by kind. Body links behave exactly as before.
- [ ] An app can add a resolver for its own wiki forms, tried after the kit's.
- [ ] The flagged Scriptorium supplies its frontmatter references as edges and
      its wiki forms as a resolver. The links differential's `wikiForms` case
      now passes on the kit path.
- [ ] Edges stay current when a document's frontmatter changes, with a test.
- [ ] The slot is offered to Story Studio on kit-parity.

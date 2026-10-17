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
lifecycle: done
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

**Done and verified (2026-10-16).**
`feat(kit): a slot for app-supplied link edges` adds the kit slot,
`WorkspaceDaemonOptions.links` (`LinkSlot`, `src/kit/workspace/linkEdges.ts`):
`edges(doc)` returns edges with a kind, read in the same pass as a document's
links and cached under the same stamp; `resolve(input)` returns more places a
target may name, asked only when the kit's own lookup finds no file. `graph`
marks app edges `edge: <kind>` and counts `edgeKinds`; `backlinks` lists them
under `edges`, apart from `backlinks`; `link-check` reports those nothing
answers under `edges`, counted in `count`. All three take `--edge a,b`, where
`link` names the body links. With no slot, every answer is unchanged.
`feat(scriptorium): frontmatter references and wiki forms` puts Scriptorium's
frontmatter references (`fieldRefs`, kind `frontmatter`) and its wiki forms on
the slot. Deliberate choices: the edge kind is `edge` on the wire, because
`kind` already means a document's kind in `graph` and a link's kind in
`backlinks`; app edges fold, filter by `rel` and count as links in the graph;
Scriptorium's names are looked up in the set the link is written in, as the
shipped resolver looks in its bundle.

The fix round
(`fix(kit): app links reach every document kind; the resolver is capped`, after
a no-stake verifier): the graph and backlinks sift by STEM before resolving
(`landingName` drops a document extension on both sides), so `concept/thing` and
`[[log]]` reach `thing.markdown` and `log.txt` as the shipped Scriptorium counts
them; before, they vanished from both and link-check stayed silent. The same
change fixes the kit's own `v1.2` link to `v1.2.md`, which the old sift passed
over. What the sift still misses is a resolver form that does not end in the
stem (an alias, an id): followed and checked, not drawn or counted. That is
written on `LinkSlot` for Story Studio to weigh. A resolver's places are capped
at `APP_RESOLVE_CAP` (16) per target and deduped through a `Set`; 100,000 places
took 145 s for one ask before. Tests now hold relative places dropped,
`setLinkSlot` clearing the link cache, and `truncated` set when the edges alone
pass `BACKLINK_CAP`. Each was proved by a planted mutant. Scriptorium's resolver
keeps each set's repo root for the daemon's life, and a comment says why. The
kit path's acc census re-records `graph`, `backlinks` and `link-check`, whose
flag choices gained `--edge`.

## Definition of done

- [x] An app can supply extra edges, each with a kind, to the kit's link cache
      and graph. `graph`, `backlinks` and `link-check` include them and can
      filter by kind. Body links behave exactly as before.
- [x] An app can add a resolver for its own wiki forms, tried after the kit's.
- [x] The flagged Scriptorium supplies its frontmatter references as edges and
      its wiki forms as a resolver. The links differential's `wikiForms` case
      now passes on the kit path.
- [x] Edges stay current when a document's frontmatter changes, with a test.
- [ ] The slot is offered to Story Studio on kit-parity.

---
type: item
title:
  The broken-links sign counts project-docs references and listed documents as
  broken
description:
  "In a review session of listed project docs, the sign reads '30 broken
  frontmatter references, 26 leaving the set': typed references like
  feature/<slug> and cycle/<file> are resolved as relative paths, and every link
  from one listed document to another counts as leaving."
status: draft
lifecycle: triage
id: 01a1662a-a793-762c-aa2e-5a5ac8f9a347
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, links]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# The broken-links sign counts project-docs references and listed documents as broken

Cole noticed this on 2026-10-22, in the polish cycle's review session: a cycle
doc plus 15 items, each added on its own. The status bar read "30 broken
frontmatter references, 26 leaving the set". Almost none of them is broken.

- **The 30 "broken" are project-docs references.**
  `parent: feature/workspace-kit-follow-ups` and `from: cycle/2026-10-shell` are
  typed references that `pdocs` resolves (`feature/<slug>` →
  `docs/features/<slug>/feature.md`, `item/<slug>`, `cycle/<file>`). Scriptorium
  tries them as paths relative to the document
  (`tried: docs/items/feature/workspace-kit-follow-ups.md`), finds nothing, and
  calls them broken.
- **The 26 "leaving" are links between the listed documents** (or to siblings on
  disk). Each document added alone is its own set, so every cross-link leaves a
  set. For hand-picked review sessions that is nearly every link.

## Definition of done

- [ ] Decide, with Cole, what the sign should count (options below). Then
      implement it.
- [ ] In a session like the review above, the sign shows only links that are
      really broken.
- [ ] A real broken link (a typo'd path, a deleted file) still shows, and its
      list still opens it at its line.

**Options to weigh:**

- **Resolve project-docs references** when the document's tree has a
  `.project-docs.json`, using its `docsRoot`. Scriptorium is mostly used on
  project docs, so this makes `parent:`, `from:` and `blocked_by` (ids) real
  edges in the map too. It is app-side, through the kit's link resolver slot.
- **Not count an unresolvable frontmatter value as broken** unless it looks like
  a path (has an extension or `./`). It is smaller, but it loses real typos.
- **Not count links between the session's own documents as "leaving",** when
  sets were added one document at a time. Or show "leaving" only as a hint,
  never in the sign.

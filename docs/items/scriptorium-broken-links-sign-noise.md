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
status: stable
lifecycle: ready
id: 01a1662a-a793-762c-aa2e-5a5ac8f9a347
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, links]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
cycle: 2026-10-polish
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

The ruling (Cole, 2026-10-22): Scriptorium learns nothing about project-docs.
`.project-docs.json` is another tool's file, and reading it would mean adding a
reader for every convention that follows.

- [ ] A frontmatter value counts as broken only if it looks like a path (it has
      an extension, or starts `./`, `../` or `/`) and misses. Any other value
      that doesn't resolve, such as `feature/workspace-kit-follow-ups`, is an
      **unresolved reference**: it is listed as such in `link-check` and the
      sign's list, and is not counted in the sign.
- [ ] Links between the session's own documents don't count as "leaving", even
      when each was added as its own set.
- [ ] In a session like the review above, the sign shows only links that are
      really broken.
- [ ] A real broken link (a typo'd path, a deleted file) still shows, and its
      list still opens it at its line.

**Not taken, and why:**

- **Reading `.project-docs.json`:** it couples Scriptorium to one tool.
- **Searching by name:** a wrong guess is worse than no answer.
- **A Scriptorium-owned rules file:** only if the agent-taught rules in
  [scriptorium-link-rules](scriptorium-link-rules.md) get repetitive.

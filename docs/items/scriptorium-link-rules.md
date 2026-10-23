---
type: item
title: The agent can teach a session how its references resolve
description:
  A verb that registers patterns like 'feature/{slug}' →
  'docs/features/{slug}/feature.md' in a session, so a project's own reference
  convention resolves (and shows on the map) without Scriptorium knowing any one
  tool's config.
status: draft
lifecycle: triage
id: 01a16652-46da-730d-ad93-949798608954
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-22 }
tags: [kit, scriptorium, links]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-polish
---

# The agent can teach a session how its references resolve

Cole, 2026-10-22, in the polish cycle's review. Projects write references in
their own conventions: project-docs' `feature/<slug>`, `item/<slug>` and
`cycle/<file>`, and others elsewhere. Scriptorium shouldn't read any one tool's
config to understand them
([scriptorium-broken-links-sign-noise](scriptorium-broken-links-sign-noise.md),
ruling 3 of the polish cycle). The agent can, though. It reads the project and
learns its convention as any agent does.

**The shape:** a verb, for example
`link-rule 'feature/{slug}' 'docs/features/{slug}/feature.md'` (relative to a
set root or an absolute base). It stores the pattern in the session. Link
resolution tries the session's rules before giving up, so a matching value
becomes a real edge: in the map, backlinks and `link-check`. The SKILL tells the
agent to register a project's conventions when it opens a session, if it knows
them. Scriptorium knows only "a pattern maps a value to a path".

## Definition of done

- [ ] A verb adds, lists and removes a session's link rules. Rules survive
      restore.
- [ ] Frontmatter and body references that match a rule resolve through it, and
      show as edges in the map, backlinks and `link-check`.
- [ ] A rule that resolves to a missing file reports the reference as broken,
      not unresolved.
- [ ] The SKILL tells the agent when and how to register rules.
- [ ] Nothing in Scriptorium names project-docs or any one tool.

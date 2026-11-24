---
type: session
title: Where session vocabularies come from — 2026-11-24
description:
  Research on where Scriptorium's profiles and relation vocabularies come from,
  Cole's rulings on it, and the two build items filed from it.
tags: [scriptorium, profiles, relations]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Where session vocabularies come from — 2026-11-24

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

Scriptorium sessions are short-lived and gather files from anywhere, so a
vocabulary kept in the folder a session happens to open is either missing or
written again each time. The question was where profiles and relation
vocabularies should come from instead.

## What Happened

A research agent wrote the write-up on 2026-11-17: four layers, nearest winning
(the folder's own, the repo's up to the git root, a global user folder, built-in
packs attached by a marker file), with `@studio/profiles/` as the folder name to
match Story Studio.

Cole ruled on 2026-11-24, in the Scriptorium session:

- Layering, the git-root lift and the global layer: as recommended.
- The folder is `@scriptorium/profiles/`, since `@studio` is Story Studio's own
  name. The kit takes the name from the app.
- The `project-docs` pack attaches by `.project-docs.json`, as recommended,
  after he checked that only the file's presence counts and Scriptorium never
  writes it. At his agreement the pack also reads the file's `docsRoot`, so it
  applies only to documents under that folder.

Two build items were filed `--from` the research item:
[kit-profile-layers](../../kit-profile-layers.md), blocked by the kit split, and
[scriptorium-vocabulary-layers](../../scriptorium-vocabulary-layers.md), blocked
by the kit item.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `doc-reviewer` (All tools) chosen, as the branch is docs only.

It checked the code citations against the repo and Story Studio's at `80262894`,
ran the docs lint and Prettier, and checked the build items against the rulings.
Verdict: with fixes. The kit-parity paragraph and Finding 6 still argued for
`@studio`; five line citations had drifted (`session.ts` by +32); the kit item
named a split step by a label only the unlanded kit-split write-up defines; and
the Scriptorium item lacked the no-git-repo and `lint.types` cases. All fixed
and re-checked.

## Follow-up

- [frontmatter-chip-editing](../../frontmatter-chip-editing/item.md) can now be
  researched; its build items, when filed, wait on the two above.

---

**Related Documents:**

- [How should short-lived Scriptorium sessions get their profiles and relations?](../item.md)
- [Vocabularies for short-lived sessions](../write-up.md)

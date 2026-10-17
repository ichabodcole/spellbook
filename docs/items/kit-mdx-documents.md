---
type: item
title: The kit path no longer shows .mdx documents
description:
  The kit's document kinds leave out .mdx, so meta, find and the tree on
  Scriptorium's kit path drop .mdx files the shipped app shows; decide whether
  the kit counts them.
status: draft
lifecycle: triage
id: 01a1486e-3b17-70ac-bb92-06ee1694742a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
---

# The kit path no longer shows .mdx documents

Found by the wiki-verbs verifier (2026-10-17). The kit's document kinds include
`.json` and leave out `.mdx`, so on Scriptorium's kit path `.mdx` files vanish
from the tree, `meta` and `find`, where the shipped app shows them.

## Definition of done

- [ ] A ruling on whether the kit counts `.mdx` as a document, recorded here.
- [ ] If yes, `.mdx` documents appear on the kit path, with a test.

---
type: item
title: The kit path no longer shows .mdx documents
description:
  The kit's document kinds leave out .mdx, so meta, find and the tree on
  Scriptorium's kit path drop .mdx files the shipped app shows; decide whether
  the kit counts them.
status: stable
lifecycle: ready
id: 01a1486e-3b17-70ac-bb92-06ee1694742a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# The kit path no longer shows .mdx documents

Found by the wiki-verbs verifier (2026-10-17). The kit's document kinds include
`.json` and leave out `.mdx`, so on Scriptorium's kit path `.mdx` files vanish
from the tree, `meta` and `find`, where the shipped app shows them.

**Ruling (Cole, 2026-10-19, shell cycle):** yes, at the level the shipped
Scriptorium has always had. An `.mdx` file is a text document: it appears in the
tree, `meta` and `find`, and opens, edits, versions, compares and takes notes,
and its rendered view is plain markdown. MDX's own capabilities, `import` and
`export` lines and JSX components, are not compiled or run. That would mean
running a document's code in the page, and it would be an item of its own.

## Definition of done

- [x] A ruling on whether the kit counts `.mdx` as a document, recorded here.
- [ ] If yes, `.mdx` documents appear on the kit path, with a test.

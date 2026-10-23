---
type: item
title:
  Opening a link's place misses frontmatter in rendered view and collapses the
  selection
description:
  Opening a broken frontmatter reference at its place highlights nothing in
  rendered view, and a cross-document open collapses the selection to the link's
  end in raw and split.
status: stable
lifecycle: ready
id: 01a157b0-882a-76ca-a864-ff5e8a1e46d6
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, document]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# Opening a link's place misses frontmatter in rendered view and collapses the selection

Found by the `kit-broken-links-visible` verifier on 2026-10-20, on the flagged
Scriptorium. Neither is caused by that item; both sit in the pane's general
`openAt` path, which the link check's list now uses for every entry.

- **Rendered view, frontmatter:** opening a broken frontmatter reference (for
  example `related: [./ghost.md]` on `d-block.md`) opens the document but shows
  nothing at the reference. The field strip is not highlighted. Body links and
  leaving links do highlight in rendered view.
- **Raw and split, cross-document:** opening a link in another document
  reproducibly collapses the selection to the link's end. The line is right. The
  older "missing heading" entry does the same.

## Definition of done

- [ ] In rendered view, opening a frontmatter reference highlights its field in
      the header strip.
- [ ] A cross-document open selects the link's whole range in raw and split.
- [ ] Both are tested, and offered on kit-parity.

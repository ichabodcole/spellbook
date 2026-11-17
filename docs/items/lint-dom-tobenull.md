---
type: item
title: Refuse toBeNull on DOM queries
description:
  A Biome rule and a kit expectNull helper, because Bun's toBeNull can pass on a
  live element and dumps the DOM when it fails.
status: draft
lifecycle: backlog
id: 01a1eb00-572b-777b-80c9-d4caef836306
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Refuse toBeNull on DOM queries

From the Story Studio port scan (2026-11-17). Bun's `expect(…).toBeNull()` can
pass on a live DOM element, and when it fails it dumps the whole DOM. A test
asserting that an element is gone can therefore be green when it is still there.

Story Studio added a GritQL plugin, `scripts/lint/dom-tobenull.grit`, that
refuses `toBeNull` on DOM queries, and a kit helper, `expectNull`, to use
instead (`460f8290`). Spellbook has neither, and no Biome plugins yet.

## Definition of done

- [ ] A Biome rule refuses `toBeNull` on a DOM query result, with a message
      naming the helper.
- [ ] A kit `expectNull` helper asserts absence without dumping the DOM.
- [ ] Existing tests that hit the rule are converted, and the gate is green.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)

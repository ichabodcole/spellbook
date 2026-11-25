---
type: item
title: Test what the session's read side caches and resolves
description:
  "S5's fault injection found six faults in the read side no test catches: four
  cache-prune sites, a stale resolvable list, and docsAfter ignoring the
  post-move world."
status: draft
lifecycle: triage
id: 01a21498-935c-768d-826d-3422ae0745fa
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s5/sessions/2026-11-25-kit-split-s5.md
---

# Test what the session's read side caches and resolves

S5's adversarial review planted 18 faults in the read side's parts. The suite
caught 12. The six it missed are not in the branch, but nothing would notice if
a later change made them, and S7 to S11 keep editing this code.

## Definition of done

- [ ] A test fails if `linkGraph` stops pruning the link cache when `within` is
      unset, or prunes it when `within` is set.
- [ ] A test fails if `linkCheck` stops pruning the heading cache.
- [ ] A test fails if `profiles`' survey stops pruning the link cache.
- [ ] A test fails if `readIndex`'s `resolvable` list goes stale after the app's
      frontmatter changes.
- [ ] A test fails if a move plan's app resolution ignores the post-move world
      (`docsAfter`).
- [ ] A behaviour test (not only a cost test) fails if the relation vocabulary
      the picker sees goes stale.

## Related Documents

- [The session's read side (S5) — 2026-11-25](./kit-split-s5/sessions/2026-11-25-kit-split-s5.md)

---
type: item
title: Give readIndex a method that prunes its heading cache
description:
  linkCheck prunes readIndex.headingCache with an inline loop on another part's
  field; a pruneHeadingCache method on the owner would let headingCache,
  linkSlot and linkCheckOpts go back to private where they can.
status: draft
lifecycle: triage
id: 01a21498-94bf-72db-93d6-749260163b90
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s5/sessions/2026-11-25-kit-split-s5.md
---

# Give readIndex a method that prunes its heading cache

At S5, `linkCheck` kept its inline loop over `readIndex.headingCache`, because
the step moved code only. That left `headingCache`, `linkSlot` and
`linkCheckOpts` public on `readIndex`, against the rule that a cache is pruned
by a method on the part that owns it.

## Definition of done

- [ ] `readIndex` has a `pruneHeadingCache` method, and `linkCheck` calls it.
- [ ] `headingCache` is private again; `linkSlot` and `linkCheckOpts` are
      private, or reached through a method, wherever no other part writes them.
- [ ] The architecture page drops the exception it states for this.
- [ ] No test's expectations change, and the gate passes.

## Related Documents

- [The session's read side (S5) — 2026-11-25](./kit-split-s5/sessions/2026-11-25-kit-split-s5.md)

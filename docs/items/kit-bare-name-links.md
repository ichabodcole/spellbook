---
type: item
title: A bare-name link finds its document by name
description:
  A bare name like `[x](Real)` looks only in the link's own set, and
  case-sensitively, so it misses `real.md` even in the same set. Which sets it
  searches is a product call.
status: draft
lifecycle: triage
id: 01a176c6-13ca-72cb-b896-0601d5f93949
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# A bare-name link finds its document by name

A bare name like `[x](Real)` looks only in the link's own set, and
case-sensitively, so it misses `real.md` even in the same set. Which sets it
searches is a product call.

Bullet 27 of the nits item, re-checked on 2026-10-25. The SKILL documents the
own-set rule. Evidence is in the re-check report the item records.

## Definition of done

- [ ] `[x](Real)` resolves to the one document named `real.md`,
      case-insensitively, in its own set or, if Cole rules so, anywhere in the
      context.
- [ ] Two candidates are reported as ambiguous, and the SKILL says which rule
      holds.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)

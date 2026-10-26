---
type: item
title: A folder and a link to it become two sets
description:
  "`open world wlink`, where `wlink` links to `world`, adds two sets with the
  same real folder, and `open world world` lists the entry twice."
status: draft
lifecycle: triage
id: 01a176c6-1472-7678-bd93-11cc3cd3f7a0
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/scriptorium-chat-and-toast-nits.md
---

# A folder and a link to it become two sets

`open world wlink`, where `wlink` links to `world`, adds two sets with the same
real folder, and `open world world` lists the entry twice.

Bullet 28 of the nits item, re-checked on 2026-10-25.
`kit-workspace-symlinked-sets` left this here on purpose. Evidence is in the
re-check report the item records.

## Definition of done

- [ ] `open world world` lists the entry once.
- [ ] `open world wlink` (same `realRoot`) adds one set, or says the second path
      is the same folder, consistent with the symlinked-sets policy.
- [ ] Tests cover both.

## Related Documents

- [Scriptorium: small chat and toast leftovers](./scriptorium-chat-and-toast-nits.md)

---
type: item
title: Settle Scriptorium's two cn semantics
description:
  Scriptorium's kit primitives use the kit's join-only cn while its own
  components still use the npm cn (tailwind-merge); the surface dep cap says one
  semantics per spell and needs a ruling for spells on the kit.
status: draft
lifecycle: triage
id: 01a138c6-b13d-738a-be53-c5c299d80b4c
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [scriptorium, kit, house-style]
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-13-kit-foundation.md
---

# Settle Scriptorium's two cn semantics

Scriptorium moved onto the kit's primitives in the kit-foundation cycle. They
use the kit's `cn`, which only joins classes. Scriptorium's own components still
import the npm `cn` (tailwind-merge) at about 18 call sites. The surface dep cap
in `grimoire/house-style.md` says "one semantics per spell" and describes `cn`
as what the registry's recipes import. It says nothing about a spell on the kit.
The finalize review (2026-10-13) found no call site that conflicts today.

## Definition of done

- [ ] A ruling on whether a spell on the kit keeps tailwind-merge for its own
      components, written into the surface dep cap
- [ ] Scriptorium follows the ruling

## Related Documents

- [Kit foundation — 2026-10-13](../features/workspace-kit/sessions/2026-10-13-kit-foundation.md)

---
type: item
title: Move the primitives rule into the kit
description:
  "Fire registry-primitives-variant-extends-recipe's own repeal: the rule moves
  to src/kit/ui and gains the opt-out for spells that skip the kit's UI."
status: stable
lifecycle: active
id: 01a13706-977e-7489-9eef-6b7bfd11797c
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, house-style]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
blocked_by: [01a13706-96dd-765f-9c64-2ecf15ee08f2]
---

# Move the primitives rule into the kit

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle. The
house-style rule `registry-primitives-variant-extends-recipe` names its own
repeal: "when the kit ships the primitives itself". This cycle fires it. The
rule moves to `src/kit/ui` (one registry install, variants added inside the
recipe) and gains the opt-out from the feature's "Kit UI is the default, not a
requirement": a spell that does not take the kit's UI keeps its own
`surface/ui/` under the current rule.

## Definition of done

- [x] `grimoire/house-style.md` states the moved rule and the opt-out, and the
      repealed form is gone
- [x] Any ward that enforces the rule checks the new location _(none does: the
      rule is `enforced-by: none`, and the grimoire wards pass, 303/303)_

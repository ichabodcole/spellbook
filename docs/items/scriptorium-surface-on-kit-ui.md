---
type: item
title: Move Scriptorium's surface onto src/kit/ui
description:
  Scriptorium's surface drops its own primitives for the ported kit's, as the
  first adopter.
status: stable
lifecycle: active
id: 01a13706-982a-7562-89f2-4404be644989
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, scriptorium]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
blocked_by: [01a13706-96dd-765f-9c64-2ecf15ee08f2]
---

# Move Scriptorium's surface onto src/kit/ui

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Scriptorium, the first adopter, drops its own `surface/ui/` primitives for the
ported `src/kit/ui`. It is the proof that the foundation works before the
workspace stack is built on it next cycle.

**Done and verified (2026-10-13).** Scriptorium's own `surface/ui/`,
`components.json` and path alias are gone. Where Scriptorium's look differed
from a recipe, it became a variant inside the kit: the button sizes `chrome`,
`2xs` and `3xs`, `DialogContent size="md"`, `DropdownMenuContent size="md"` and
`DropdownMenuItem stacked`. The kit's `cn` only joins classes, so recipe bases
that clashed with their own sizes (radius, text size, icon size) were fixed in
the recipes, and `recipe-conflicts.test.tsx` now guards them. Two no-stake
verifications compared 52 screenshot pairs (light and dark, hover, focus and
keyboard states) and found them identical, apart from timestamps. The one
visible change is the add-path input below 768px, which shows 16px text where it
showed 12px (shadcn's default, which avoids mobile zoom on focus).

## Definition of done

- [x] Scriptorium's surface imports its primitives from `src/kit/ui` and no
      longer has its own copies
- [x] Scriptorium's tests and build pass, and the shipped `dist/` is rebuilt
- [x] A no-stake verifier has driven the shipped launcher in a real browser and
      found no visual or behavioural regression

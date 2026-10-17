---
type: item
title: Spells get the kit primitives' CSS only when they adopt them
description:
  The kit's @source pulls the primitives' utility classes into every spell that
  imports base.css, growing their CSS 33-71% with classes they never use; make
  the primitives' CSS opt-in.
status: stable
lifecycle: triage
id: 01a1376e-9fb0-7452-82e6-c1d987e38191
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, css]
parent: feature/workspace-kit
---

# Spells get the kit primitives' CSS only when they adopt them

Since the theme and ui port, `src/kit/theme/base.css`'s `@source "../"` scans
the kit's primitives. Every spell that imports `base.css` therefore gets their
utility classes, used or not. Bounty's CSS grew 33%, digestify's 47%,
mind-mapper's 52% and imago's 71% (measured by the theme/ui verifier,
2026-10-13). It is dead CSS rather than a visual risk.

The implementer's sketch of the fix:

1. Move the primitives into `src/kit/ui/primitives/`. `Dot` and `ConfirmDialog`
   stay where they are.
2. Add `@source not "../ui/primitives"` to `base.css`.
3. Add a `primitives.css` holding `@source "../ui/primitives"`, which a spell
   imports when it adopts the primitives.
4. Extend kit-styling-ward and kit-adoption-ward so that a spell importing a
   primitive must also import `primitives.css`. Otherwise a primitive could
   render unstyled and no ward would notice.
5. Keep `tw-animate-css` in `base.css`. Bounty and grapevine use its animations
   without adopting the primitives (Cole kept them, 2026-10-13).

## Definition of done

- [ ] A spell that does not adopt the kit primitives builds the same CSS it did
      before the theme and ui port, apart from the animations and the
      pointer-cursor rule
- [ ] A spell that adopts them gets their classes through one import, and a ward
      catches a primitive used without it

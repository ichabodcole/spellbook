---
type: item
title: What still differs from Atlas after the shell port
description:
  After Scriptorium is on the kit's shell, run it beside Atlas, list what still
  differs, and decide each difference.
status: stable
lifecycle: ready
id: 01a13706-9597-7581-b770-897b4bbb4706
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, scriptorium, atlas]
parent: feature/workspace-kit
---

# What still differs from Atlas after the shell port

Part of [Workspace Kit](../features/workspace-kit/feature.md). It was step 1 of
the first cycle, as a side-by-side comparison before the port. Cole agreed
(2026-10-13) to port first and compare what is left instead: the foundation
cycle's primitives already converge on the kit's, and the shell port gives
Scriptorium Atlas's layout by default. So this runs after the shell port, on the
real result rather than a prediction.

Run Atlas (Story Studio) and the ported Scriptorium side by side: the header,
sidebars, status strip and chat, and how each tells a connected session apart
from an agent that is listening. Cole finds Atlas tighter and cleaner in places.
It is a look, not a redesign. **Spellbook keeps its own colour theme** (Cole,
2026-10-13), so the look is at layout, density and behaviour, not at colour.

Before the shell port, its item carries a short list of what Scriptorium does
better and must not lose (for example E53 and E65's waiting marks), so this
check is not the only guard.

## Definition of done

- [ ] A write-up with screenshots of both apps, area by area, listing each
      remaining difference with a call: keep Atlas's, keep Scriptorium's, or
      take both
- [ ] Cole has ruled on each call, and the ones that need work are filed

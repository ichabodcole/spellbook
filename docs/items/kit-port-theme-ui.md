---
type: item
title: Port theme and ui with the happy-dom harness
description:
  Port the kit's theme and primitives into src/kit with the happy-dom test
  harness and the fuller base.css.
status: draft
lifecycle: triage
id: 01a13706-96dd-765f-9c64-2ecf15ee08f2
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, ui, story-studio]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Port theme and ui with the happy-dom harness

Step 3 of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port Story Studio's `theme` and `ui` into `src/kit`: the Base UI primitives
installed once, the fuller `base.css`, and the happy-dom component-test harness.
Spellbook's `Dot` and `ConfirmDialog` stay where they read ahead of Story
Studio's. The comparison (`kit-atlas-scriptorium-comparison`) feeds its theme
calls in first.

## Definition of done

- [ ] `src/kit/ui` holds the primitives and `src/kit/theme` the fuller theme,
      with the comparison's theme calls applied
- [ ] The happy-dom harness runs the ported component tests in the repo gate
- [ ] The styling, CSS-scope and kit-adoption wards pass

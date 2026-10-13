---
type: item
title: Port theme and ui with the happy-dom harness
description:
  Port the kit's theme and primitives into src/kit with the happy-dom test
  harness and the fuller base.css.
status: stable
lifecycle: active
id: 01a13706-96dd-765f-9c64-2ecf15ee08f2
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, ui, story-studio]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Port theme and ui with the happy-dom harness

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port Story Studio's `theme` and `ui` into `src/kit`: the Base UI primitives
installed once, the fuller `base.css`, and the happy-dom component-test harness.
Spellbook's `Dot` and `ConfirmDialog` stay where they read ahead of Story
Studio's.

**Spellbook keeps its own colour theme** (Cole, 2026-10-13). The port takes
Story Studio's theme structure (the fuller `base.css`, its token layers, and
what the primitives need from them) and keeps Spellbook's palette in it. It does
not adopt Story Studio's colours.

**From the `lib`/`wire` scoping (2026-10-13):**

- The harness is Story Studio's `lib/afterIo`, `lib/registerDom` and
  `lib/testDom`. It needs `@happy-dom/global-registrator`, which is a new dev
  dependency. Port `testDom` without its re-export of `testImages`, which only
  the workspace stack uses.
- Leave out `ui`'s `ImageViewer`, `ImageDescription` and `usePaneSize`, along
  with their barrel lines. Only the shell uses them, and they would pull in
  about 900 lines of workspace-stack `lib` (`docFormat`, `bundles`, `sidecar`,
  `viewport`).
- Rename `theme/mode.ts`'s `story-studio:theme` key and `theme/index.ts`'s
  `@story-studio/kit` specifier.

## Definition of done

- [ ] `src/kit/ui` holds the primitives and `src/kit/theme` the fuller theme,
      with Spellbook's palette kept
- [ ] The happy-dom harness runs the ported component tests in the repo gate
- [ ] The styling, CSS-scope and kit-adoption wards pass

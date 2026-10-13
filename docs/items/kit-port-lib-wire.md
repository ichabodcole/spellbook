---
type: item
title: Port lib and wire from Story Studio's kit
description:
  Port the kit's lib and wire modules into src/kit, merged with the places
  Spellbook is ahead.
status: draft
lifecycle: triage
id: 01a13706-9638-77c4-8471-bc5a17295b37
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, story-studio]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Port lib and wire from Story Studio's kit

Step 2 of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port Story Studio's `lib` and `wire` into `src/kit`: the detached `startDaemon`,
`stdinWaiting`, reply hints, the faster stop that skips the drain wait when
nothing is open, and the new exit codes. Merge with the places Spellbook is
ahead: `tailHandoff`'s `by: human` and the registry's `--` warning. Names are
translated as the feature's port order says (`STORY_STUDIO_*` to `SPELLBOOK_*`,
`app` to `spell` where it names one of ours). The kit stays a leaf
(`import-boundary-wards`).

## Definition of done

- [ ] `src/kit/lib` and `src/kit/wire` match Story Studio's at the ported
      commit, plus Spellbook's ahead-of-kit changes, each with its tests
- [ ] Every spell that imports `src/kit/wire` builds and passes its tests
- [ ] The wards pass; any ward the port breaks is filed as a finding, not
      loosened

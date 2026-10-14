---
type: item
title: Port lib and wire from Story Studio's kit
description:
  Port the kit's lib and wire modules into src/kit, merged with the places
  Spellbook is ahead.
status: stable
lifecycle: done
id: 01a13706-9638-77c4-8471-bc5a17295b37
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, story-studio]
cycle: 2026-10-kit-foundation
parent: feature/workspace-kit
---

# Port lib and wire from Story Studio's kit

Part of [Workspace Kit](../features/workspace-kit/feature.md)'s first cycle.
Port the foundation part of Story Studio's `lib` and `wire` into `src/kit`, and
merge it with the places Spellbook is ahead. Names are translated as the
feature's port order says (`STORY_STUDIO_*` to `SPELLBOOK_*`, `app` to `spell`
where it names one of ours). The kit stays a leaf (`import-boundary-wards`).

**Scoped on 2026-10-13** (a read-only pass over both kits):

- **Ported:**
  - `lib`: `cn` with its state-function overload, and `storage`.
  - `wire`:
    - the drain-skip fix in `housekeeping`;
    - the exit codes 124 and 130, and an error `token`;
    - the `Host` guard in `origin` (DNS rebinding), which also accepts the host
      the server is bound to, so `--host` keeps working;
    - the session-pointer API in `discovery`;
    - `startDaemon` in `detach`;
    - the in-process `daemon.test`.
- **Spellbook's kept:**
  - `tailHandoff` (`by`, `closedBy`, `goneBy`, and the `spell` key that Story
    Studio renamed to `app`);
  - the error envelope's `server` key (Story Studio's `details`).

  Taking theirs would have broken eight spells' callers and the agent-facing
  output. The registry's `--` warning turned out to be in both kits already.

- **Additive only:** no spell moves onto `startDaemon` or the pointer API in
  this item.
- **Moved:**
  - `stdinWaiting` and reply hints go to the workspace stack, their only
    consumer.
  - The test harness (`afterIo`, `registerDom`, `testDom`) goes to
    `kit-port-theme-ui`.
  - `pushLoop` is out of scope, per the feature.

## Definition of done

- [x] `src/kit/lib` and `src/kit/wire` carry the ported parts above, each with
      its tests, and Spellbook's ahead-of-kit changes are intact
- [x] Every spell that imports `src/kit/wire` builds and passes its tests
- [x] The wards pass; any ward the port breaks is filed as a finding, not
      loosened
- [x] A no-stake verifier has run the claims, including a real spell's daemon
      refusing a forged `Host` and serving its own

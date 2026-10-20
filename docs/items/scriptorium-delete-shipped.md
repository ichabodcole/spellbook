---
type: item
title: Delete the shipped Scriptorium
description:
  "After Cole has used the flipped build: delete the shipped backend and
  surface, move the kit surface into place, remove the escape hatch, and
  recalibrate every ward that named the shipped code, in one commit."
status: draft
lifecycle: backlog
id: 01a15b3a-286c-7796-a786-03b475f24240
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium]
cycle: 2026-10-cutover
parent: feature/workspace-kit
from: cycle/2026-10-cutover
blocked_by:
  [01a15b3a-2716-70a6-872a-d30f3aad2a2c, 01a15b3a-27c0-706a-8a19-5ca5ca424431]
---

# Delete the shipped Scriptorium

Once Cole has used the flipped build and said go, the shipped Scriptorium goes:
about 20.3k lines of source and 10.6k of tests under `src/scriptorium/backend/`
and `src/scriptorium/surface/` outside `kit/`.

- **The kit surface moves into `surface/`,** and `theme.css` folds into
  `styles.css` (`kit-styling-ward` reads `styles.css` directly, so the move
  alone would turn it red). The entries thin, and the escape hatch goes.
- **Dead seams go:** `subSurfaceNames`, `kitDaemonCwd`, `FRAME_DIST` and
  `FRAME_DEV_ENTRY`, and the npm `cn` dependency.
- **Tests retire or move:** `links.differential`, `bomReaders`, `metaSetBytes`,
  `cli-contract`, `dev-styled` and `scriptorium-kit-path-ward` retire, since
  each compared the two paths or guarded their separation.
  `tail-handoff.integration` moves under `backend/kit/`, and `sinks` is
  re-aimed.
- **Every ward row that named the shipped code** is recalibrated, each with its
  reason in the commit.

It lands as one commit with a named merge, so git can bring the shipped app back
if it is ever needed. Nothing may be built on the shipped code between the flip
and this commit.

## Definition of done

- [ ] No shipped Scriptorium source or test remains, the hatch is gone, and
      every recalibrated ward row says why.
- [ ] `dist` is rebuilt, `dist-check` is clean, and every other spell's `dist`
      is byte-identical.
- [ ] The paths the SKILL names in `dist` still exist.
- [ ] In a real browser, a converted session opens on the new `dist`, and in dev
      mode from the repo root.
- [ ] The gate is green, and the change lands as one commit with a named merge.

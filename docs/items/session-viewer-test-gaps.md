---
type: item
title: Test the viewer's transitions the suite doesn't pin
description:
  S6's fault injection left eleven viewer faults uncaught; tests for an
  unrelated move, a delete elsewhere, the viewer's persists, a refilter and the
  two forgotten transitions would catch them.
status: draft
lifecycle: triage
id: 01a214e9-439e-703b-b3d5-ba81f745ad70
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-25 }
parent: feature/kit-split
from: items/kit-split-s6/sessions/2026-11-25-kit-split-s6.md
---

# Test the viewer's transitions the suite doesn't pin

S6's adversarial review planted 33 faults in `session/viewer.ts` and its call
sites; the suite caught 22. Its differential harness confirms the branch has
none of the 11 that survived, but nothing would notice if a later change made
one.

## Definition of done

- [ ] A test fails if a rename or move of something other than the open image
      closes it (`followMove`).
- [ ] A test fails if deleting a path that isn't the open document changes what
      the centre shows (`forgetPath` → `docsForgotten`).
- [ ] A test reads the manifest on disk after `openImage`, `closeImage` and
      `closeDoc` and fails if any of them stops persisting, or persists before
      the viewer has changed.
- [ ] A test fails if a refilter that hides the open image stops closing it.
- [ ] A test with a restored `openDoc` that names no document fails if
      `forgetDoc` uses `docsForgotten` (the reason the two stay apart).
- [ ] "a deleted open document gives way to the first held, and the aside stays"
      in `viewer.session.test.ts` sets up an aside, so its name is true.

## Related Documents

- [The session's tier 2 parts and the viewer (S6) — 2026-11-25](./kit-split-s6/sessions/2026-11-25-kit-split-s6.md)

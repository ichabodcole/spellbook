---
type: item
title: Close the DOM test harness's remaining leak paths
description:
  The domGuard preload stops a load-time throw leaking the DOM, but a forgotten
  removeDom, a probe at the next file's load time, and bun test outside the repo
  root still leak.
status: draft
lifecycle: triage
id: 01a13777-83bd-74c3-b0c9-9c0fe8d00e9f
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, testing]
parent: feature/workspace-kit
---

# Close the DOM test harness's remaining leak paths

The theme and ui port added a happy-dom harness for component tests, plus a
preload (`src/kit/lib/domGuard.ts`, in the root `bunfig.toml`). Before each
test, the preload removes a DOM that no file has claimed. The no-stake verifier
(2026-10-13) confirmed the original leak is fixed, and found four smaller gaps:

- **At load time:** the guard is a `beforeEach`, so a later file whose imports
  probe `window` once still sees a stale DOM.
- **A forgotten `removeDom`:** a file that calls `installDom` and never
  `removeDom` keeps its claim, so the guard leaves its DOM in place.
- **Outside the root:** Bun reads `bunfig.toml` from the cwd only, so `bun test`
  run from `src/<spell>/` or a skill directory has no guard. No repo workflow
  does that today.
- **Extensionless imports:** the preload's re-registration hook matches only
  specifiers ending in `.ts`. A file that imports `.../registerDom` without the
  extension stays order-dependent. Every import uses `.ts` today. (Finalize
  re-verification, 2026-10-13.)
- **`THEME_TOKENS` is hand-written:** a token added to `base.css` but not to the
  list goes unpinned.

## Definition of done

- [ ] A ward or lint requires `afterAll(removeDom)` in any test file that
      imports `testDom` or `registerDom`
- [ ] `THEME_TOKENS` is derived from `base.css`, or a test fails when a
      `--color-*` token is missing from it
- [ ] The load-time and outside-root gaps are either closed or written down as
      accepted, with the reason

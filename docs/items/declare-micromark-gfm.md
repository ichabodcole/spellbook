---
type: item
title: Declare micromark-extension-gfm in package.json
description:
  Scriptorium imports micromark-extension-gfm in backend/links.ts and
  surface/state/markdown.ts, but package.json does not declare it; it resolves
  only transitively.
status: draft
lifecycle: done
id: 01a1371b-0c3d-7137-b719-2313811b2630
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [deps, scriptorium]
cycle: 2026-10-cutover
---

# Declare micromark-extension-gfm in package.json

`src/scriptorium/backend/links.ts:45` and
`src/scriptorium/surface/state/markdown.ts` import `micromark-extension-gfm`,
but the root `package.json` does not declare it. It resolves only because
another dependency pulls it in, so an upgrade that drops it would break
Scriptorium's link extraction without warning. Found by the `lib`/`wire` scoping
for the kit-foundation cycle (2026-10-13).

**Satisfied by the workspace port (2026-10-14),** which declares both `yaml` and
`micromark-extension-gfm`. It's ready to close at triage.

## Definition of done

- [ ] `package.json` declares `micromark-extension-gfm` at the version now
      resolved, and the gate passes

## Closed at the cutover

Already satisfied, found by the cutover survey (2026-10-20): the root
`package.json` and `src/scriptorium/package.json` declare
`micromark-extension-gfm` ^3.0.0. It stays needed after the deletion: the kit's
`document/projection.ts`, `lib/markdown.ts` and `lib/markdownCode.ts` import it.

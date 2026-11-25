---
type: item
title: "Finish the session split: views out, the facade left, the parts public"
description:
  The views move to session/views.ts, session.ts is left as the lifecycle and
  its delegates under 1,200 lines, the tier test runs strict, and the parts
  become public readonly fields.
status: draft
lifecycle: backlog
id: 01a20f86-9134-771c-84f4-f5e4034f54de
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-90a6-7488-81de-acac08e2ef93]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Finish the session split: views out, the facade left, the parts public

This is step S11 of the kit split ([feature](../features/kit-split/feature.md)).
`views`. The facade is then `create`, `restore`, `listSaved`, the constructor
and a delegate per public member. The tier test runs strict, and the parts
become public `readonly` fields (`session.documents`, …) as Story Studio's did.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-proposed-module-map-sessionts),
and its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] `server.test.ts`, `show.test.ts` and `doctor.test.ts` pass.
- [ ] `session.ts` is under 1,200 lines and its override is removed.
- [ ] The tier test runs strict over every part.
- [ ] The parts are public `readonly` fields on the session.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, whose type-check ward covers the kit).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)

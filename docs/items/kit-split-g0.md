---
type: item
title: Upgrade Biome to 2.5.x and add a kit typecheck to the gate
description:
  Biome moves from 2.4.16 to 2.5.x, where noExcessiveLinesPerFile is a style
  rule, and a typecheck over src/kit and src/scriptorium joins the gate, so
  every split step after it is typechecked.
status: draft
lifecycle: backlog
id: 01a20f86-8b1a-738f-aaca-e6def070f969
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
---

# Upgrade Biome to 2.5.x and add a kit typecheck to the gate

This is step G0 of the kit split ([feature](../features/kit-split/feature.md)).
Tooling only, before the guard. Biome goes to 2.5.x (Story Studio runs 2.5.15);
in our 2.4.16 the size rule exists only in `nursery`. A `typecheck` script over
`src/kit` and `src/scriptorium` (about 40 s, passing today) runs in
`bun run gate`. Kept apart from G1 so a Biome minor's new findings don't mix
with the guard.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-build-steps), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [ ] Biome is at 2.5.x in `package.json` and the lockfile.
- [ ] A `typecheck` script covers `src/kit` and `src/scriptorium`, and
      `bun run gate` runs it.
- [ ] Any new Biome findings are fixed in this step, and nothing else is mixed
      in.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes, typecheck included.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)

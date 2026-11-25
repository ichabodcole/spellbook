---
type: item
title: Upgrade Biome to 2.5.x
description:
  Biome moves from 2.4.16 to 2.5.x, where noExcessiveLinesPerFile is a style
  rule, with the upgrade's new findings fixed; the gate's type-check ward
  already typechecks src/kit and src/scriptorium.
status: stable
lifecycle: review
id: 01a20f86-8b1a-738f-aaca-e6def070f969
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Upgrade Biome to 2.5.x

This is step G0 of the kit split ([feature](../features/kit-split/feature.md)).
Tooling only, before the guard. Biome goes to 2.5.x (Story Studio runs 2.5.15);
in our 2.4.16 the size rule exists only in `nursery`. It was also to add a
`typecheck` script over `src/kit` and `src/scriptorium` to `bun run gate`; at G0
the gate turned out to typecheck both already, through the type-check ward
(`grimoire/type-check-ward.test.ts`), so none was added. Kept apart from G1 so a
Biome minor's new findings don't mix with the guard.

Detail, risks and the lessons that apply:
[the write-up](./kit-split-oversized-modules/write-up.md#the-build-steps), and
its [step table](./kit-split-oversized-modules/write-up.md#the-build-steps).

## Definition of done

- [x] Biome is at 2.5.x in `package.json` and the lockfile.
- [x] A `typecheck` script covers `src/kit` and `src/scriptorium`, and
      `bun run gate` runs it. _Met by the existing type-check ward
      (`grimoire/type-check-ward.test.ts`), which already typechecks both inside
      `bun test`; no separate script was added (see the write-up's "The gate
      already typechecks")._
- [x] Any new Biome findings are fixed in this step, and nothing else is mixed
      in.
- [x] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [x] The gate passes, typecheck included.

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)

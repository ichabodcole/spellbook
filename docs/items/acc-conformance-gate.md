---
type: item
title: Gate every spell CLI on acc check
description:
  Run acc check (with recorded surfaces) over all nine spell CLIs in the repo
  gate, so a conformance regression fails the build.
status: draft
lifecycle: ready
id: 01a0e03d-fbd1-718e-a658-38394032b42a
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
---

# Gate every spell CLI on `acc check`

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

Nothing runs `acc` today: `bun run gate` is build + biome + docs check +
`bun test`, and the five `acc.config.json` files are only read when someone runs
the kit by hand. Conformance reached by the per-spell items will drift back
without this.

Land it early, with each spell's current state as `knownFailures` debt, so every
later item lands against it and burns the debt down rather than adding the check
at the end.

## Definition of done

- [ ] A ward (`grimoire/acc-conformance.test.ts` or a `gate` step) runs
      `acc check` from each spell's skill folder against its launcher, for all
      nine, and fails when any exits non-zero.
- [ ] It enumerates the spells from the roster, not a hand-kept list, with a
      zero-denominator guard (nine found, not zero).
- [ ] It reads recorded surfaces where a spell has them, so the census runs in
      the gate, not only the root probes.
- [ ] It runs the pinned kit and fails loudly if `acc version` differs from the
      pin.
- [ ] A deliberately broken CLI (a planted unknown-flag path that exits 0) makes
      it fail. Show the red run in the session.

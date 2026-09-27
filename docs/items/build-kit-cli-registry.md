---
type: item
title: Build the kit CLI registry and prove it on three spells
description:
  Build src/kit/cli/registry.ts (one table drives parse, dispatch, help,
  rejections, --version and the acc schema), behind a golden snapshot of all
  nine CLIs, and move glamour, scriptorium and grapevine onto it.
status: draft
lifecycle: ready
id: 01a0e04b-f53e-722b-85c5-2be0123c9035
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
cycle: 2026-09-acc-conformance
parent: feature/spell-cli-acc-conformance
from: 01a0e03d-fc41-75f2-8096-9a86bd1ff0c8
---

# Build the kit CLI registry and prove it on three spells

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).
The design is
[the shared-registry write-up](shared-cli-registry-in-the-kit/write-up.md), **as
amended by
[its cold read](shared-cli-registry-in-the-kit/artifacts/cold-read.md)**: where
the two disagree, the cold read's six changes win.

Every other spell item's step 6 (and bounty's, imago's and digestify's L0 fixes,
which are dispatch bugs) builds on this module, so it lands first.

## Decisions already taken (decision log #9–#11)

- **The verb-first proving ground is grapevine**, beside glamour and
  scriptorium: it exercises `globalFlags` (`--as`/`--from`), interceptors that
  pass arguments on, and it has an independent census (33 agreements, 0
  disagreements) to check against. mind-mapper's `doc` sub-verb is handled in
  its own item.
- **Interceptors pass the remaining arguments to their row.**
  `grapevine --version --human` keeps working; `glamour --version --junk` goes
  from exit 0 to 2, which is the contract (an unknown flag).
- **The golden snapshot covers all nine CLIs**, not only the three moved, so it
  is the regression net for the whole cycle.

## Definition of done

- [ ] **Golden snapshot, before any move:** a fixture and a test recording, for
      each of the nine CLIs from the current launchers, `schema` (where it
      exists), `help`, and a corpus of accepted and rejected invocations with
      exit code, stream and `choices`. Include every invocation the spell's
      `SKILL.md` documents. Later diffs to it are deliberate and named in the
      commit.
- [ ] `src/kit/cli/registry.ts` implements the write-up's `defineCli` API with
      the cold read's changes: defaulted values ignored by the per-verb check
      and `default` modelled in the options table; interceptors pass remaining
      arguments on; flags before a sub-verb specified (or a recorded exception
      hook); the verbless empty-argv case specified; the unknown-root-flag rule
      scoped to `verb-first`.
- [ ] Unit tests for the module itself, including A6 (`--` terminator), C2/D2
      (bare invocation: usage on stderr, exit 2), D1 (`--version`), A3
      (rejections carry `choices` and name the offending token) and defaults.
- [ ] glamour, scriptorium and grapevine run on it. Their golden snapshots are
      unchanged except for deliberate, listed changes (the `version --bogus` fix
      at least). Their `cli-contract.test.ts` suites and grapevine's census pass
      after a build.
- [ ] The grimoire wards that read a spell's `parseArgs` call from source
      (`grimoire/lib/entry-points.ts` and flag-invariant, strict-parse,
      terminator) read a spell on the registry correctly.
- [ ] The write-up is corrected per the cold read's change 6.
- [ ] `bun run gate` is green, unpiped, and the acc ward still passes for all
      nine.

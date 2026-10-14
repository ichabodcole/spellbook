---
type: artifact
title: Cold read of the shared CLI registry write-up
description:
  An adversarial no-stake review of the registry recommendation, with claims run
  against the code, counterexamples, API gaps, and the six changes it requires
  before ratifying.
status: stable
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Cold read of the shared CLI registry write-up

A no-stake reviewer read [the write-up](../write-up.md) on 2026-09-26 and ran
its claims through the launchers, with temp `*_HOME` directories. **Verdict:
ratify with changes.** The six changes below are requirements on
[item/build-kit-cli-registry](../../build-kit-cli-registry.md).

## Confirmed

- `version --bogus` exits 0 in glamour and scriptorium, **and in astrolabe and
  mind-mapper too**. grapevine's exits 2.
- grapevine passes A6 at the root by accident (`-- -- --zz-value` is refused as
  `unknown flag at the root: --`).
- bounty's and imago's A6, C2 and D2 are in dispatch: `argv[0]` is split off,
  and a bare invocation hits `case undefined` (`:1726`) and prints help at
  exit 0.
- The dispatches of glamour and scriptorium differ only in braces, the spell
  name, and scriptorium's choices-only-on-unknown-option rule.
- All 10 line citations spot-checked are accurate.

## Wrong or unsupported

- `exit-site-inventory` does not depend on the flag scan. The affected wards are
  flag-invariant, strict-parse and terminator.
- "No exit-code change except `version`" is too narrow. grapevine's
  `--version`/`--help` interceptors pass the remaining arguments to the row
  (`grapevine --version --human`, `-V --as me` both work today). Either choice
  changes someone: not passing them breaks grapevine; passing them makes
  glamour's `--version --anything` go from exit 0 to 2.
- The module is not a leaf: it imports `printJson` from `kit/lib`.
- Moving the existing three rewrites every row: `run(pos, flags, session)`
  becomes `run(inv)`.
- Bare invocation is "the same in all three" in exit code and streams only; the
  messages differ.

## Counterexamples to "no working invocation is refused"

1. mind-mapper `doc --project P delete D1 --force` resolves to `doc delete`
   today (`doc` finds its sub-verb from a probe parse, `:1366`, so flags may
   come first). Matching two-token names on adjacent raw tokens breaks it.
2. digestify with no arguments (`cat doc | review.ts`) is valid: every flag has
   a default. Refusing an empty argv breaks it.
3. Step 4's "a dash-led token that is not an interceptor is an unknown root
   flag", applied to every grammar, refuses `glamour --session x info`, which
   its contract test pins.
4. bounty, imago and astrolabe parse one global flag map, so they accept every
   flag on every verb today. Per-verb sets will refuse those: arguably a fix,
   but it must be stated.

## API gaps

- **`default:` in options (the biggest).** astrolabe and digestify declare
  defaults; `parseArgs` puts them in `values`, so an `Object.keys(values)` check
  refuses every row that does not list them, including the added `schema`,
  `help` and `version` rows.
- A sub-verb found after flags (mind-mapper `doc`).
- A verbless root: empty argv, and the auto-added rows, are unspecified;
  digestify uses `allowPositionals: false`.
- Whether interceptors pass the remaining arguments to their row.
- Arity that depends on a flag (imago `handoff --clear`, mind-mapper
  `--to|--clear`) can only be declared optional.

## The proving ground is weak

glamour and scriptorium are the only `flags-anywhere` spells; all six adopters
are `verb-first`. The move exercises none of nesting, aliases, `globalFlags`,
defaults, a verbless root, custom help or `rejectHint`. Their contract tests
import `VERBS`/`flagsFor`/`VERB_SPEC` from the module under test, so the table
is checked against itself, and a flag dropped while porting passes. They spawn
the built `dist/`, so `bun test` without a build runs old code.

## The six changes

1. **Golden snapshot first:** before any move, record each CLI's `schema`,
   `help` and a corpus of accepted and rejected invocations (exit code,
   `choices`) from the current binaries; diff after.
2. **Prove it on a verb-first spell too:** grapevine (census 33/0) or
   mind-mapper, beside glamour.
3. **Stage 2 ignores defaulted values** (`tokens: true`, or apply defaults after
   the check); model `default` in `OptionsTable`.
4. **Specify:** interceptors passing the remaining arguments to their rows;
   flags before a sub-verb (or mind-mapper's `doc` recorded as an exception);
   the verbless empty-argv case.
5. **Scope step 4's unknown-root-flag rule to verb-first.**
6. **Correct the write-up:** the ward list, the "leaf" claim, the
   loose-`version` defect's spells, and that per-verb sets deliberately refuse
   flags the six accept today.

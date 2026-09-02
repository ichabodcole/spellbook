# bounty: conformance gaps grapevine just fixed, plus a latent declared-vs-accepted drift

**Found:** 2026-08-24, during the standard-grapevine working session (acc +
trellis), by running `acc check` against bounty as the modelled-declaration test
target. **Status:** backlog — bounty was a bystander in that session; nothing
here was changed.

## The gaps (same class grapevine fixed on `feat/grapevine-self-declaration`)

`acc check` on `plugins/spellbook/skills/bounty/scripts/cli.ts`: NOT CONFORMANT
(L0), 3 core violated —

- **C2 / D2:** bare invocation prints help to stdout at exit 0 (usage-error
  population reads `2,2,0`). grapevine conformed (bare → usage error, exit 2,
  `help` stays exit 0) with the reasoning "callers are agents; a bare call is an
  unset variable". The same reasoning applies here, or bounty declines it
  deliberately — either way the choice should be made, not inherited.
- **D1:** no `--version` (`exited 2, stdout empty`). bounty has the same
  daemon/CLI version-skew hazard family as grapevine.
- **D3:** help names no machine-mode flag and no schema command.
- Root `--nope` is consumed as an unknown _verb_ with a signpost
  (`run: cli.ts help`), so the root rejection never enumerates — invisible to
  root-only flag-surface capture even though…

## …the latent drift, pre-registered as a prediction

bounty's verb-level rejection DOES enumerate, with the exact marker shape
(`recognized flags: --as --expect --id …`) — but it enumerates **one global
21-flag registry on every verb**, while its help prose describes per-verb sets
(`state [--mine | --owner | --as]`, `--full is accepted but redundant`). That is
accepted-and-ignored at fleet scale — acc DT-1's disease, the one grapevine's
COMMANDS registry was built to cure.

**Prediction, checkable the day acc's kit probes below the root:** a declaration
modelled from bounty's help will produce `accepted-not-declared` findings for
roughly 17 of 21 flags on a verb like `state`. The modelled declaration used in
the session is archived in the session scratch and reproduced trivially from
help; the fix, if wanted, is grapevine's shape — a command registry the parser,
dispatcher, help, and (eventually) a `schema` verb all walk.

## Prediction outcome (2026-08-26) — HIT at substance, corrected in detail

Run by acc's recorded-surface reader against the captured `state` rejection
(`docs/investigations/2026-08-25-recorded-surface-batches/`), both registrations
pinned in their tree before the differ existed:

- **18 `accepted-not-declared` of 22 enumerated** (registration said ~17 of 21;
  the denominator was corrected to 22 from the verbatim capture before any diff
  ran). Substance held exactly: help declares 4, the parser accepts 22 — 5.5×.
- **0 `declared-not-accepted`** — the modelled declaration is a strict SUBSET of
  what the parser takes. The hand-written model understated, never misstated: a
  better finding than the one registered.

The drift is now measured, not predicted. The fix remains grapevine's shape
(per-verb registry); grapevine's own full census on the same reader read **33 of
33 paths compared, 0 disagreements**.

## Suggested route

Fold into the spell-grooming ritual or pick up as a focused chore branch once
`feat/grapevine-self-declaration` lands, using grapevine's registry as the
template.

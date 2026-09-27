---
type: item
title: Take astrolabe's CLI through the full acc guidance
description:
  "Bring the astrolabe CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: done
id: 01a0e03d-f7b2-77ee-826f-531310afcd7c
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take astrolabe's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/astrolabe && bunx acc check ./scripts/cli.ts`:

- L0: **conformant**. Failing: A6 (diagnostic: a value after `--` is still
  parsed as an option).
- `acc.config.json`: present, `defaultOutput: json`.
- Root rejections name the flag set: **no** (`did not enumerate`: the rejection
  lists verbs, not flags).
- `schema` verb from one registry: **no**.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/astrolabe/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
      Done 2026-09-26: A6 passes (the kit treats every token after `--` as a
      positional) and the one `knownFailures` entry is deleted. No debt left.
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`. Already
      true at baseline: every verb prints one JSON document.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`: `--help --version -V -h`).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census. 15 records
      in `acc.recorded-surfaces.json` (captured with `ASTROLABE_HOME` and
      `TMPDIR` on a temp dir; every probe is refused at parse, so no daemon was
      contacted): 9 enumerated, 6 (`state`, `list`, `info`, `version`, `schema`,
      `help`) stated an empty set. Against the emitted `schema`: 16 of 16
      declared paths compared, 0 disagreements.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account). The table is the kit's
      (`src/kit/cli/registry.ts`): astrolabe's shared flag map, verb switch,
      `VERBS`/`ROOT_TOKENS` lists and hand-written help are gone. The golden
      snapshot showed only deliberate changes: per-verb flag sets (a flag from
      another verb is refused, with the verb's own set as `choices`); `schema`
      and `version` join the verbs; `version --bogus` (and `help --x`) exit 2; a
      flag before the verb is an unknown root flag with the interceptors as
      `choices`; a verb given more positionals than it declares refuses the
      extra (`state -- --x` was accepted and ignored, now exit 2); the kit's
      wording and help. `status`'s flag-dependent arity (a summary or `--stdin`)
      is the row's `check` hook. The defaulted flags (`clear`, `stdin`,
      `no-open`) never trip a row that does not list them (pinned in
      `cli.test.ts`).
- [x] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session. Listed in the adopter's report
      for the lead to file.
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note
      (`feat(astrolabe): the CLI runs on the kit registry`).

**Not fixed here:** `astrolabe close` with no daemon still exits 0 with an error
envelope ([item](astrolabe-close-exits-zero-with-error-envelope.md)). The
migration kept `cmdClose`'s hand-built payload as it was; routing it through
`die` is a product decision left to spell-hardening (decision #5).

---
type: item
title: Take imago's CLI through the full acc guidance
description:
  "Bring the imago CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-fa0b-703c-b354-d56fa1712797
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take imago's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/imago && bunx acc check ./scripts/cli.ts`:

- L0: **NOT conformant**. Failing: A6, C2, D1, D2, D3.
- `acc.config.json`: **none**, so B5 is `unverified`.
- Root rejections name the flag set: **no** (`did not enumerate`: the rejection
  lists verbs, not flags).
- `schema` verb from one registry: **no**.

- Same five failures as bounty, from its own copy of the same parsing pattern
  (each spell parses its own args), so it needs its own fix.
- C2/D2: a bare invocation prints 1.9 KB of help to stdout and exits 0.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/imago/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
      Done 2026-09-26: A6, C2, D1, D2 and D3 pass, and all five `knownFailures`
      entries are deleted. No debt left.
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
      Decision #16: `sessions` was imago's one prose data verb. It now prints
      one JSON document (`{"sessions": [...]}`), with `--human` for the old
      lines. No documented consumer read the prose (SKILL.md, `references/`,
      `src/imago/surface/`), so no debt was recorded.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`: `--help --version -V -h`).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census. 20 records
      in `acc.recorded-surfaces.json` (captured with `IMAGO_HOME` and `TMPDIR`
      on a temp dir): 17 enumerated, 3 (`version`, `schema`, `help`) stated an
      empty set. Against the emitted `schema`: 21 of 21 declared paths compared,
      0 disagreements.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb. The table is the kit's (`src/kit/cli/registry.ts`,
      [item/build-kit-cli-registry](build-kit-cli-registry.md)): imago's own
      parser, verb switch, verb lists and help text are gone. The golden
      snapshot showed only deliberate changes: a bare invocation is exit 2 on
      stderr; `--version`/`-V`/`version` and `schema` answer; per-verb flag sets
      (a flag from another verb is refused, with the verb's own set as
      `choices`); a flag before the verb is an unknown root flag; the kit's
      wording and help. `handoff`'s flag-dependent arity (exactly one of
      `<text...>` or `--clear`) is the row's `check` hook; the declaration can
      only mark `<text>` optional.
- [x] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session. Listed in the adopter's report
      for the lead to file.
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note
      (`feat(imago): the CLI runs on the kit     registry`).

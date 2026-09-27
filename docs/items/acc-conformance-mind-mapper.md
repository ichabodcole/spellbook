---
type: item
title: Take mind-mapper's CLI through the full acc guidance
description:
  "Bring the mind-mapper CLI to L0 conformance and through acc steps 4–6:
  declared default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-faef-74e2-af6c-6fc6892ec0f9
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take mind-mapper's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/mind-mapper && bunx acc check ./scripts/cli.ts`:

- L0: **conformant**. Failing: none.
- `acc.config.json`: present, `defaultOutput: json`.
- Root rejections name the flag set: **no** (`did not enumerate`: the rejection
  lists verbs, not flags).
- `schema` verb from one registry: **no**.

- It is WIP and intentionally undeclared in the roster by Cole's ruling;
  conformance work does not change that.

- **Golden snapshot finding (2026-09-26):** mind-mapper ships no SKILL.md (WIP
  by ruling), so its golden corpus comes from its help text. Its `doc` group
  takes flags before its sub-verb (`doc --project P delete D1 --force`); declare
  it with the registry's `groups: { doc: { subVerbAt: "first-positional" } }`.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/mind-mapper/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`: `--help --version -V -h`; it used to list the verbs).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census. 46 records
      in `acc.recorded-surfaces.json` (captured with `MIND_MAPPER_HOME` and
      `TMPDIR` on a temp dir; no daemon started): 43 enumerated, 3 (`version`,
      `schema`, `help`) stated an empty set. Against the emitted `schema`: 47 of
      47 declared paths compared, 0 disagreements.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb. The table is the kit's (`src/kit/cli/registry.ts`,
      [item/build-kit-cli-registry](build-kit-cli-registry.md)): mind-mapper's
      two-stage parser, `VERB_SPEC`, the dispatch if-chain and the doc probe
      parse are gone. `doc` is declared with
      `groups: { doc: { subVerbAt: "first-positional" } }`, so
      `doc --project P delete D1 --force` still resolves to `doc delete`, and
      `doc -- delete` now reads the doc named "delete" (it was unaddressable).
      Flag-dependent rules are row `check` hooks: `--to | --clear` (node anchor,
      proposal zone), `<kind> | --clear` (doc kind; the declaration can only
      mark `<kind>` optional), `--set | --stdin | --clear` (actions, tags), one
      subtask op, and the lens `--node`/`--doc` rules. ⚠ Help stays hand-written
      (the registry's `help:` override): the table does not render it, and
      `cli-contract.test.ts` binds every verb to a help line instead. The golden
      snapshot showed only expected kinds (verb-list order, `version`/`schema`
      joining, root rejections naming the interceptors, `version --bogus` → 2,
      help text); every per-verb and nested record held.
- [x] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session. Listed in the adopter's report
      for the lead to file.
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note
      (`feat(mind-mapper): move the CLI onto the kit registry`).

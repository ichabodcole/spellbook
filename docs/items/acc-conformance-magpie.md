---
type: item
title: Take magpie's CLI through the full acc guidance
description:
  "Bring the magpie CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: done
id: 01a0e03d-fa7f-7013-9d71-ad4b939e09cc
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take magpie's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/magpie && bunx acc check ./scripts/cli.ts`:

- L0: **conformant**. Failing: none.
- `acc.config.json`: present, `defaultOutput: json`.
- Root rejections name the flag set: **no** (`did not enumerate`: the rejection
  lists verbs, not flags).
- `schema` verb from one registry: **no**.

- **Golden snapshot finding (2026-09-26):** SKILL.md:134 documents `cmd` without
  `--stdin`, which is rejected today (exit 2). Fix the doc or the verb,
  deliberately.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/magpie/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
      Still true after the move (2026-09-26): 17 of 17 core rules pass, 0
      unverified (was 16 plus D3 unverified). No `knownFailures`, none added.
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`. Already
      declared, and true: every verb prints one JSON document (`sessions`
      switched before this cycle), `tail` is JSONL, help is prose.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`). Root: `enumerated 4 flags: --help --version -V -h` (was
      `did not enumerate`: the root rejection listed verbs). Every verb already
      named its own set; the kit keeps that.
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census. 19 records
      in `acc.recorded-surfaces.json`, paths from the registry's own
      `cli.paths`, captured with `MAGPIE_HOME` and `TMPDIR` on a temp dir: 15
      enumerated, 4 (`sessions`, `version`, `schema`, `help`) stated an empty
      set. Against the emitted `schema`: 20 of 20 declared commands checked, 0
      disagreements.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account). The table is the kit's
      (`src/kit/cli/registry.ts`): magpie's two-stage `parseArgs`, `VERB_SPEC`,
      verb switch and hand-written help are gone. `CLI_OPTIONS` stays a literal
      handed to `defineCli` by name, which is what the old `:311–321` comment
      needed: the flag-invariant ward reads `defineCli({ options: IDENT`. The
      golden snapshot showed only deliberate changes: `version` and `schema`
      answer and join the roster; a flag before the verb and a bare `-- --x` are
      unknown root flags (interceptors as `choices`); the kit's help and
      wording; arity from the table. Bare invocation (exit 2) and per-verb flag
      sets were already in place. `discover.ts` (internal) is untouched.
- [x] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session. Listed in the adopter's report
      for the lead to file.
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note
      (`feat(magpie): dispatch through the kit     CLI registry`).

## Decision #14: `cmd` without `--stdin`

Fixed in the doc, not the verb. SKILL.md showed `cmd [--stdin]`, as if a bare
`cmd` did something; it has always needed a body, as an argument or on stdin,
and refuses without one (exit 2). The row now reads `cmd --stdin` (pipe the JSON
body). Making a bare `cmd` read stdin implicitly was the alternative, rejected:
a verb that reads stdin without being asked blocks forever when an agent runs it
with an inherited, never-closed stdin, which is a worse failure than a usage
error that names the fix. The refusal is now the row's `check` hook, so its
message says both forms. The documented golden record is
`cmd --stdin <<< '{"type":"phase.advance"}'`, accepted (exit 5, no session in
the fresh home). Line counts in SKILL.md are unchanged, so no later documented
line moved.

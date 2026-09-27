---
type: item
title: Take glamour's CLI through the full acc guidance
description:
  "Bring the glamour CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-f917-7544-84c7-012cf357f242
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
---

# Take glamour's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/glamour && bunx acc check ./scripts/cli.ts`:

- L0: **conformant**. Failing: none.
- `acc.config.json`: present, `defaultOutput: json`.
- Root rejections name the flag set: yes (`enumerated`).
- `schema` verb from one registry: yes.

- The reference implementation (see `docs/features/glamour-acc-l0/`). What is
  left is step 5: wire its recorded surfaces into `acc.config.json` so the
  census runs on every check.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/glamour/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`).
- [ ] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account). **Since 2026-09-26 the
      table is the kit's** (`src/kit/cli/registry.ts`,
      [item/build-kit-cli-registry](build-kit-cli-registry.md)): glamour's own
      dispatcher, help renderer and declaration emitter are gone. The golden
      snapshot showed only deliberate changes: `version` is now a declared,
      strict row (so `version --bogus` and `--version --junk` exit 2, and
      `version` joins the verb roster, help and `schema`); the root's `choices`
      put long spellings first; the rejection wording is the kit's
      (`unknown command`, `missing required <x>`, `unexpected argument "x"`);
      `schema` lists each row's flags in options-table order; `help --x` states
      `choices: []`.
- [ ] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session.
- [ ] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note.

---
type: item
title: Take grapevine's CLI through the full acc guidance
description:
  "Bring the grapevine CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-f991-7508-bc57-39af03b6cbbd
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
---

# Take grapevine's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/grapevine && bunx acc check ./scripts/cli.ts`:

- L0: **conformant**. Failing: none.
- `acc.config.json`: **none**, so B5 is `unverified`.
- Root rejections name the flag set: yes (`enumerated`).
- `schema` verb from one registry: yes.

- Has a registry-derived surface and a `schema` verb, but no `acc.config.json`,
  so B5 is `unverified`.
- Surfaces were recorded in August
  (`features/spell-hardening/artifacts/2026-08-25-recorded-surface-batches/`);
  they are not wired into any config.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/grapevine/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`. (The
      baseline above predates `c3568f35`, which added the config; B5 passes.)
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census. The batch
      is `plugins/spellbook/skills/grapevine/acc.recorded-surfaces.json`
      (generated with `probe-plan --declaration` from the spell's own `schema`,
      homes pointed at empty temp dirs), which the acc ward passes as
      `--recorded-surfaces` (decision #8). Census (acc 0.1.15, 2026-09-26): 32
      records, all enumerated (every verb takes the global `--as`/`--from`, so
      none is empty); **33 of 33 declared command paths compared, 0
      disagreements**. Rejections name their set at every recorded verb (step
      4b). Re-record when the surface changes: the ward reads a stale batch
      without complaint.
- [x] **Documented invocations (decision #14):** the `mark` and `reopen` rows
      (:222, :223) and Typical Flow (:676-687) now pass `--as`, as the file
      already tells agents to on every verb; Typical Flow no longer relies on
      `export GRAPEVINE_FROM`. Doc fixed, not the verb: identity is rightly
      required.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account). **Since 2026-09-26 the
      table is the kit's** (`src/kit/cli/registry.ts`,
      [item/build-kit-cli-registry](build-kit-cli-registry.md)), verb-first with
      `globalFlags: ["as", "from"]`, grapevine's own `version` row (`--human`),
      its hand-written help, and the body hint as `send`'s and `announce`'s
      `rejectHint`. The golden snapshot's only diff is sorted `choices` on the
      per-verb rejections (20 records). Not recorded there, and deliberate: a
      flag another verb takes is refused as misplaced (`send c --timeout 5`
      answers "--timeout is not accepted by send", where node said "Unknown
      option"); an unknown verb reads `unknown command "x"` (was
      `unknown command: x`); a flag given without its value no longer carries
      `choices`; and `grapevine -- -- --zz` is now `unknown command "--zz"`, the
      terminator honoured, where it was refused as the root flag `--`. The
      census, re-recorded with `acc probe-plan` against the new build: **33 of
      33 declared paths compared, 0 disagreements**; L0 still conformant.
- [ ] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session.
- [ ] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note.

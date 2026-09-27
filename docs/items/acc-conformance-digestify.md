---
type: item
title: Take digestify's CLI through the full acc guidance
description:
  "Bring the digestify CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-f89e-7196-9f0c-71b17620c377
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take digestify's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/digestify && bunx acc check ./scripts/review.ts`:

- L0: **NOT conformant**. Failing: C1, D1.
- `acc.config.json`: **none**, so B5 is `unverified`.
- Root rejections name the flag set: yes (`enumerated`).
- `schema` verb from one registry: **no**.

- C1: `--help` and `-h` exit 2 with nothing on stdout.
- D1: `--version` exits 2 with nothing on stdout.
- Its entry point is `scripts/review.ts`, not `scripts/cli.ts`. Check the target
  is safe to probe first (`how-to-establish-your-target-is-safe-to-check.md`):
  if its first argument is a file path, the probes are input.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/digestify/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [x] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account).
- [ ] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session.
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note.

## Outcome (2026-09-26)

- **acc v0.1.15:** L0 conformant, 17/17 core passed, 0 core unverified. C1 and
  D1 are fixed and their `knownFailures` deleted; `acc.config.json` keeps
  `defaultOutput: json`, and B5 passes. A7 moved from unverified to pass: help
  advertises `--theme <digestify|cthulhu|classic>` in a notation acc reads. F2
  (diagnostic, not core) reads `--version` first byte at ~115 ms against a 100
  ms guideline; not recorded as debt, because a timing reading near the line
  flips run to run and would go stale.
- **Step 6:** `src/digestify/backend/review.ts` defines a verbless `root` row on
  `defineCli` (flags only, `allowPositionals: false`). `cat doc | review.ts`
  with no arguments is still the review. The registry adds `help`, `version` and
  `schema`; since the root takes no positionals, `-- help` is refused as a stray
  argument, as it was before.
- **Step 5:** `acc probe-plan` against the emitted declaration offers the three
  auto rows (`version`, `schema`, `help`) as the paths below the root, each
  probed with the sentinel flag. All three read `stated an empty set`. The batch
  is `plugins/spellbook/skills/digestify/acc.recorded-surfaces.json`. Against
  the emitted declaration the census reads **4 of 4 paths compared, 0
  disagreements**, after a kit fix (`fix(kit)`: a verbless root's flag rejection
  now names the interceptors, which the declaration publishes at `path: []`;
  before it, the census read 4 disagreements). The "advertised verbs vs recorded
  paths" comparison does not run for a verbless tool: no root capture asserts a
  verb set.
- **Step 7:** friction for the lead to file: see the session report.

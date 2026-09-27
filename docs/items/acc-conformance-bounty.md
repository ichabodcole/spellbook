---
type: item
title: Take bounty's CLI through the full acc guidance
description:
  "Bring the bounty CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: ready
id: 01a0e03d-f826-7663-8e5f-e343cc87d3c6
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
blocked_by: []
---

# Take bounty's CLI through the full acc guidance

Part of
[Spell CLI acc conformance](../features/spell-cli-acc-conformance/feature.md).

**Baseline (acc v0.1.15, 2026-09-26),** from
`cd plugins/spellbook/skills/bounty && bunx acc check ./scripts/cli.ts`:

- L0: **NOT conformant**. Failing: A6, C2, D1, D2, D3.
- `acc.config.json`: **none**, so B5 is `unverified`.
- Root rejections name the flag set: **no** (`did not enumerate`: the rejection
  lists verbs, not flags).
- `schema` verb from one registry: **no**.

- A6 here is spell-hardening's `c1`
  ([item/terminator-eats-session-key](terminator-eats-session-key.md)): a flag
  after `--` becomes part of the title and the write lands on the most recent
  board, at exit 0. Coordinate; do not fix it twice.
- C2/D2: a bare invocation prints 2.7 KB of help to stdout and exits 0. The
  contract is usage on stderr, exit 2 (grapevine made this break at V2.0); say
  so in the release note.
- D1: `--version` exits 2 with nothing on stdout.
- D3: help names no machine-mode flag and no `schema` command.

Follow the `acc` skill (`.claude/skills/acc/SKILL.md`) and read the guides from
the pinned install, `node_modules/agent-cli-conformance/docs/wiki/guides/`.
Source is `src/bounty/backend/`; the checked target is the launcher, never
`dist/` directly (running `dist/cli.js` alone exits 0 silently).

## Definition of done

- [ ] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [ ] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
- [ ] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`).
- [ ] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census.
- [ ] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account).
- [ ] **Step 7:** anything in the kit that bit is filed upstream in the acc
      repo, or noted "nothing" in the session.
- [ ] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note.

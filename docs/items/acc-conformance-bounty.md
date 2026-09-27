---
type: item
title: Take bounty's CLI through the full acc guidance
description:
  "Bring the bounty CLI to L0 conformance and through acc steps 4–6: declared
  default, named rejections, recorded surfaces, one registry."
status: draft
lifecycle: done
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

- [x] **Step 3:** `acc check` reports `L0 conformant` with no failing rule; any
      exception is a `knownFailures` entry with its reason (debt, not a waiver).
- [ ] **Step 4a:** `acc.config.json` in the skill folder declares
      `"defaultOutput": "json"`, and B5 reads checked, not `unverified`.
      **Carried** to
      [item/bounty-json-output-in-lockstep-with-anthill](bounty-json-output-in-lockstep-with-anthill.md)
      (decision log #20).
- [x] **Step 4b:** an unknown flag is refused with the valid flag set in
      `choices` at the root and at every verb (the root reading says
      `enumerated`).
- [x] **Step 5:** every verb path is recorded (`acc probe-plan`, per
      `how-to-record-surfaces-below-the-root.md`), wired into the config, and
      each reads `enumerated` or `stated an empty set` in the census.
- [x] **Step 6:** one table drives the parser, help, rejections and a `schema`
      verb (`how-to-derive-your-surface-from-one-registry.md`; take the
      shared-registry research's answer into account).
- [x] **Step 7:** what bit is collected in the feature's
      [upstream feedback draft](../features/spell-cli-acc-conformance/acc-upstream-feedback.md)
      (filing waits for Cole, decision log #23).
- [x] Behaviour changes a user can see (exit codes, help on stdout) are named in
      the commit, for the release note.

## Migration notes (2026-09-26)

Done on `feature/acc-conformance-bounty`: bounty dispatches through
`src/kit/cli/registry.ts`. `acc check` went from NOT conformant (A6, C2, D1, D2,
D3) to **L0 conformant** with no failing core rule, and all five `knownFailures`
entries were deleted. The census reads 18 recorded paths (13 enumerated, 5
stated an empty set) and 0 disagreements against the emitted declaration.

- **Step 4a is not met, on purpose (decision #16's exception).** `list` and
  `sessions` still print prose, because a consumer parses it: anthill's
  `team-convene` reads `bounty sessions` stdout (`parseBountySessions`, the
  regex `^(\S+)\s+(\d+)\s+tasks?\b`) to find a keyed snapshot before it reopens
  a board. That is the anthill#43 data-loss guard, and it skips lines it cannot
  parse, so a JSON flip would switch the guard off silently rather than fail. So
  no `defaultOutput` is declared, and B5 stays `unverified`. B5 cannot be
  recorded as `knownFailures` debt: an entry for a rule that does not fail is
  reported inert, and the acc ward refuses inert entries. **The debt is recorded
  here instead.** To pay it: give anthill a JSON reader (or a `sessions --human`
  it can call), then flip both verbs to JSON with `--human` and declare
  `defaultOutput: json`. `list` has no known parser and could flip on its own,
  but then plain output is still not JSON on every verb.
- **F2 (diagnostic) now fails:** `--version` answers in about 115 ms against the
  100 ms guideline, because it now loads the whole bundle. It was refused
  quickly before. It does not affect L0.
- **`--` inside a verb (c1).** A flag after `--` is a positional. On `add` and
  `message` it becomes text (`add -- text --session-key K` titles the card "text
  --session-key K"). On a verb whose positionals are full, the arity check now
  refuses it by name (`update t1 -- --session-key K`, exit 2), where it used to
  be dropped silently. A test in `src/bounty/backend/server.test.ts` pins both.
- No documented invocation was rejected (decision #14): every SKILL.md
  invocation in the golden corpus is still accepted.

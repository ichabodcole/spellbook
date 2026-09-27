---
type: item
title:
  The -- terminator eats --session-key; the write lands on the ambient board
description:
  A real flag after -- is swallowed as a positional (row 2's demotion half), so
  a bounty write lands on the ambient board at exit 0.
status: draft
lifecycle: backlog
id: 01a0dea2-8c12-7351-b60a-057892e894b3
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-26 }
cycle: 2026-09-acc-conformance
parent: feature/spell-hardening
from: features/spell-hardening/sprints/05-the-gate/carries.md
---

# The `--` terminator eats `--session-key`; the write lands on the ambient board

Carried from sprint 05 as card `c1` (`t-2df67738`, owner at teardown:
`daedalus`). When `--session-key` comes after a `--` terminator, parsing
swallows it as a positional instead of treating it as a flag. The bounty write
then lands on the ambient board, at exit 0, with nothing saying the key was
ignored.

This is row 2's **demotion** half: a real flag silently demoted to a positional.
Sprint 05's `terminator-invariant` solved only **promotion** (free text read as
a flag name), so a reader of sprint 05's deliverables would think row 2 is
closed. It is not.

The denominator is already measured: **16 entry points across 8 spells** set
`strict:`/`allowPositionals:` (re-measured at sprint 05's finalize; the card
first recorded 15). Reuse `grimoire/flag-invariant.test.ts`'s by-behaviour
enumeration and `grimoire/lib/entry-points.ts`. Do not re-derive the population.

## Definition of done

- [ ] A flag after `--` is either honoured or refused with a named reason, on
      every one of the 16 entry points. It is never silently taken as a
      positional.
- [ ] A ward asserts the demotion half over the enumerated entry points, with a
      zero-denominator guard.

Per spell, as each moves onto the kit CLI registry (the lead closes this item
after all spells move):

- [x] **bounty** (2026-09-26). At the root, `bounty -- --x` is
      `unknown command "--x"`, never an option (acc A6 passes). Inside a verb, a
      flag after `--` is a positional by design. `update t1 -- --session-key K`
      is now **refused** by the arity check with the token named (exit 2), where
      it used to be dropped silently. `add -- text --session-key K` still takes
      the flag as **title text** at exit 0, on the ambient board. That meets A6,
      but not this item's "never silently taken as a positional" for variadic
      verbs (`add`, `message`). Pinned by the golden fixture and by a test in
      `src/bounty/backend/server.test.ts`.

## Related Documents

- [Sprint 05 → 06 carries: the `c1` card and its denominator](../features/spell-hardening/sprints/05-the-gate/carries.md)
- [Sprint 06 plan, design call 2](../features/spell-hardening/sprints/06-filed-is-not-fixed/plan.md)

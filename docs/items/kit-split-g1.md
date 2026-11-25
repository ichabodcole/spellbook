---
type: item
title:
  "Guard the kit's file sizes: the 1,200-line limit, the tier test and the
  start-path test"
description:
  Biome's 1,200-line limit applies to src/**/*.{ts,tsx} outside tests, with 15
  overrides frozen at today's counts, and a ported tier test and a new
  start-path test fail any step that breaks the split's rules.
status: draft
lifecycle: backlog
id: 01a20f86-8ba5-7686-8775-15ef37334619
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, refactor]
blocked_by: [01a20f86-8b1a-738f-aaca-e6def070f969]
parent: feature/kit-split
from: 01a17a8e-259e-77a4-b704-af6c786e9732
cycle: 2026-12-kit-split
---

# Guard the kit's file sizes: the 1,200-line limit, the tier test and the start-path test

This is step G1 of the kit split ([feature](../features/kit-split/feature.md)).
The guard every later step works under: Biome's `noExcessiveLinesPerFile` at
1,200 in an `overrides` block for `src/**/*.ts` and `src/**/*.tsx` minus tests,
with the 15 frozen overrides the write-up lists; `session-tiers.test.ts` ported
from Story Studio with an empty table until S2; the start-path test that
replaces `noteGuard.lazy.test.ts`'s first test; the ownership rule and the
lessons as a playbook; Story Studio's `workspace-session.md` architecture page,
ported; one line in `AGENTS.md`.

Copy `tests/architecture/session-tiers.test.ts` and
`docs/architecture/workspace-session.md` from Story Studio's current develop,
not from the write-ups; they agreed to a near-verbatim port (kit-parity 73). Our
page records the parts we have and they don't, since their table lists only
theirs.

Detail, the override counts and the start-path test: the write-up's
[step table](./kit-split-oversized-modules/write-up.md#the-build-steps) and the
"guard, in detail" paragraphs under it.

## Definition of done

- [ ] The limit is on, with the 15 overrides frozen at Biome's counts
      re-measured at G1 (the write-up's counts are a 2026-11-17 baseline).
- [ ] Growing a listed file by one line fails the lint (tried, then reverted).
- [ ] `session-tiers.test.ts` exists and passes with an empty table.
- [ ] The start-path test passes today: the CLI entry loads no
      `workspace/session`, `workspace/server`, micromark or mdast; the daemon
      loads no `document/projection` or mdast until `loadNoteGuard` runs; the
      daemon's third-party packages are exactly today's 28.
- [ ] The playbook, the architecture page and the `AGENTS.md` line are in place.
- [ ] Behaviour is unchanged: no test's expectations change (a test that reached
      into moved private state is only repointed to the same state at its new
      address).
- [ ] The gate passes (`bun run gate`, with the kit typecheck from G0).

## Related Documents

- [Split the kit's oversized modules, starting with session.ts](./kit-split-oversized-modules/item.md)

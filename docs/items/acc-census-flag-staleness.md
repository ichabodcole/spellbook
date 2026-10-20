---
type: item
title: A recorded census goes stale on flags without anyone noticing
description:
  acc stays conformant when a census record lists a flag that no longer exists,
  or misses an output change on an existing verb; only added or removed verbs
  fail the gate. Applies to Scriptorium's default and kit censuses alike.
status: draft
lifecycle: ready
id: 01a13c0d-a2e8-7086-8455-9aad6109461c
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [acc, scriptorium]
from: items/scriptorium-on-kit-daemon.md
blocked_by: [01a15b3a-2716-70a6-872a-d30f3aad2a2c]
parent: feature/workspace-kit
cycle: 2026-10-cutover
---

# A recorded census goes stale on flags without anyone noticing

Found while verifying [the flagged Scriptorium](./scriptorium-on-kit-daemon.md)
(2026-10-14). There are two cases:

- A census missing a verb's record: acc stays conformant but lists the verb as
  not covered. `acc.test.ts` asserts that list is empty, so adding or removing a
  verb fails the gate.
- A census whose record lists a flag the verb no longer has: acc exits 0 and
  stays conformant, and nothing reports it. An output change on an existing verb
  is missed the same way.

This applied to Scriptorium's default census and its kit census. After the
cutover's flip there is one, in the skill folder. The cutover survey
(2026-10-20) also measured the first case's gap in the house ward:
`grimoire/acc-conformance.test.ts` asserts neither `notCoveredByBatch` nor
`recordedNotAdvertised`; only Scriptorium's kit `acc.test.ts` does. The flip
moves that assertion into the house ward, so this item is the flag and output
half.

## Definition of done

- [ ] A census record whose flags or output no longer match the CLI fails a gate
      test, or acc reports it.
- [ ] Checked on Scriptorium's one census after the flip, and on the other
      spells' censuses the house ward runs.

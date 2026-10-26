---
type: item
title: A profile change on disk can time out its test in a parallel run
description:
  profiles.integration's 'a profile file changed on disk pushes context.changed'
  cell timed out once in 20 parallel soak runs and never again in 30
  instrumented runs; find the cause from a trace and fix it.
status: draft
lifecycle: triage
id: 01a171f4-4fe1-7001-a0f7-102607eead05
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/spellbook-parallel-tests.md
---

# A profile change on disk can time out its test in a parallel run

Found 2026-10-24 by the parallel-tests soaks
([spellbook-parallel-tests](spellbook-parallel-tests.md)).
`src/kit/workspace/profiles.integration.test.ts`'s cell "a profile file changed
on disk pushes context.changed, and the next ask sees it" hit its 5 s test
timeout once in 20 full parallel runs. It never failed again: not in 30 full
runs with every kit wait instrumented, nor in the round-2 soak (20 of 20). Which
wait hung is unknown.

The likely candidate, untested: the test writes the profile moments after
`context.add` armed the watch, and a fresh macOS watch can lose a write made in
its first moments (the cause behind `kit-watch-tests-unproven-watch` and the
relink cell). `writeUntilSeen` would cover that shape. Cole closed the parallel
tests item on 2026-10-25 with this one filed rather than fixed.

## Definition of done

- [ ] The hung wait named from a trace of a failing run, not from the timing.
- [ ] The cause fixed in the test (or in the code, if a user could see it), with
      no sleeps, skips or longer timeouts.
- [ ] The file passes `--rerun-each=50` beside a looping full parallel suite.

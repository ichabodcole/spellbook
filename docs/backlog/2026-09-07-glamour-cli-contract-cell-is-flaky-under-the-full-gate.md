# glamour's CLI-contract cell is flaky under the full gate

**Filed:** 2026-09-07 · **Found by:** the digestify conversion's Phase 0
baseline · **Severity:** low impact, high leverage — a flaky cell in the
baseline is a cell that can absorb a real regression later.

## What happened

The first `bun run gate` at `f4ee01b`, before a line of the port existed, came
back **exit 1**: 1,754 pass, 1 fail, 225.8 s.

```
plugins/spellbook/skills/glamour/tests/cli-contract.test.ts:336
(fail) a daemon refusal with HTTP 400 maps to kind usage / exit 2, body verbatim under error.server
  Expected: 2
  Received: 5
```

- Re-run in isolation (`bun test <that file>`): **29 pass, exit 0.**
- Re-run of the whole gate, unchanged tree: **1,755 pass, exit 0.**

## Why it matters more than a re-run

The cell asserts a CLI contract — that a daemon's HTTP 400 maps to
`kind: usage`, exit 2. What it received was **5**, which is not a contract
outcome at all; it is a runtime failure of the spawned process under full-suite
parallelism (146 files, many spawning daemons and binding ports).

So the cell is currently unable to distinguish "the contract broke" from "the
machine was busy". **That is exactly the property a gate cell must not have**,
and it is the property that lets a real regression land under a re-run.

## Not fixed here, and why

Behaviour-faithful is not the issue — this is not digestify's code and touching
another spell's test from a conversion branch is how a port's blast radius grows
without anyone deciding it should. It is recorded so the next agent who sees a
lone red here knows to re-run **and knows that re-running is a workaround**.

## What a fix would look like

Either the cell distinguishes a spawn/resource failure from a contract failure
and reports the difference (an exit code the contract does not define is a
FINDING, not a mismatch), or the spawn is made robust under contention. The
first is cheaper and more honest: an unexpected exit code should fail with a
message that says which of the two happened.

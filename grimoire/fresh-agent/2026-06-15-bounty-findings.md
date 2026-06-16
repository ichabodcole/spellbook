---
date: 2026-06-15
spell: bounty
spell_version: bounty (house-pattern migration — daemon + cli.ts; pre-release on develop)
agent: claude (two general-purpose subagents, cold — "alice" + "bob")
task: "you're a worker on this shared board — find and do your work" — drive the spell from SKILL.md alone
---

# Fresh-Agent Findings — bounty (2026-06-15)

## Setup

Two cold general-purpose subagents (`alice`, `bob`) were each given **only** the
bounty `SKILL.md` + the cli path — no source, no other docs, no narration of
what the board contained. A board was pre-seeded by a "lead" with a small
decomposition carrying a real dependency (`ship export feature` → engine[bob],
ui[alice], merge[alice, blockedBy engine], + an unowned release-notes). They
were told to find their assigned/claimable work, do it (advance status), respect
any blocked task, and report friction. This doubled as a live multi-agent
acceptance test (the experience layer the issues #6–#10 came from) and a
fresh-agent SKILL test.

Verdict: **delivers cold** — both agents oriented, found their lane, claimed,
self-updated status, confirmed via read-back, and (alice) correctly _held_ a
blocked task, all with zero narration. The SKILL rewrite landed. But the test
surfaced a real **readback-parity gap** that a green suite (71 tests) missed —
two independent agents hit it.

## Friction log

- **[A — fixed] `state` had no ownership filter.** The SKILL pushes `state` as
  _the_ orient/confirm command, but it returned the whole board; only `tail` had
  `--mine`/`--owner`. So the snapshot path an agent leans on was a firehose
  while the live path was clean. _(both agents)_ → fixed:
  `state --mine`/`--owner`.
- **[B — fixed] `state` didn't compute blocked-ness.** Agents got the raw
  `blockedBy` edge list and had to hand-join it against each blocker's status to
  know if a task was blocked _now_. The surface shows humans `⛔ blocked by N`;
  agents got nothing computed — and post-A, the blocker task is filtered out of
  the worker's view, so it couldn't even look it up. _(alice — the sharper
  half)_ → fixed: derived `blocked` + `liveBlockers:[{id,title,status}]` in the
  `/state` projection (response-only; survives the `--mine` filter).
- **[C — backlog F1] No one-shot `tail --drain`/`--once`.** `--since 0` streams
  then blocks; macOS lacks `timeout`; the only documented non-blocking consume
  is the Monitor tool. Both agents fell back to a background-then-kill dance to
  peek their lane.
- **[D — fixed (isolation) / backlog F2 (filter)] `sessions` firehose.** Dumped
  ~85 snapshots, almost all `e2e-*` fixtures — because the e2e suite was writing
  snapshots to the real `~/.bounty` (a test-isolation leak). → fixed: tests
  spawn with a per-run tmp `BOUNTY_HOME` (83 leaks → 0). A `sessions`
  recency/limit filter is backlogged (F2).
- **[E — doc] "review doesn't fire `unblocked`" is an easy trap.** Correct per
  the contract (only `done` clears a blocker), but bob parked engine in
  _review_, so alice's merge stayed blocked — a skimming agent could assume "I
  finished → downstream unblocked." → folded a one-line note into the SKILL deps
  section.

## What was nice (kept)

- Scoped `tail --mine` with the `# scoped to …` notice on **stderr** (off the
  Monitor wake-set) — genuinely good worker ergonomics.
- The `unblocked`-by-absence semantics: a correct agent simply isn't woken until
  the blocker clears, so it naturally waits.
- Cooperative `claim` rejection is real and loud (bob tried to steal alice's
  task — rejected, exit 1, clear stderr).
- Read-back-not-inference held: the `{ok, sent}` ack is explicitly _not_ proof;
  `state` confirms, and the monotonic `cursor` is a nice secondary signal.

## Lesson (→ scenario)

The headline finding generalized into
[`2026-06-15-readback-parity.md`](../scenarios/2026-06-15-readback-parity.md):
an agent's snapshot readback must reach **parity** with the human surface —
scope it the way the live path scopes, and compute the same derived state the
surface computes, rather than handing the agent raw fields to re-derive.

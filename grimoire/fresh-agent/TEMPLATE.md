---
date: YYYY-MM-DD
spell: <spell-name>
spell_version: <internal narrative version, e.g. grapevine V1.6.7>
agent: <which model / runtime ran the cold pass>
task: <the real task the fresh agent attempted>
---

# Fresh-Agent Findings — <spell> (<date>)

## Setup

What the cold agent was given (trigger + intent only) and what it was asked to
do. Confirm it had no build-time context.

## Friction log

Chronological. Where it hesitated, guessed, backtracked, or hit a confusing
result.

- …

## The questions (the gold)

Every "how do I…?" / "wait, what does X mean?" — each is a located
curse-of-knowledge gap.

- **Q:** … → **gap:** <what the author knew that the agent couldn't reach>

## Disposition

| Finding | On the route? | Action                                    |
| ------- | ------------- | ----------------------------------------- |
| …       | yes/no        | fix SKILL.md / surface / scenario / decay |

## Decay signals

Anything the spell now over-explains because the underlying model improved →
route to `../decay-ledger.md`.

# Fresh-Agent Testing — the empirical half

> _"Send a cold agent in to use a tool and report the friction. This reveals the
> agent's actual failure distribution — where things break, not where you
> imagined they would."_

The fresh agent's true asset isn't authorship — it's **interrogation.** It asks
about the things the doer found too obvious to mention, and each question is a
curse-of-knowledge gap located precisely. The breakdowns tell you _that_
something's missing; the questions tell you _what_.

## Subtract first

The loop has a front half. **Before** sending the cold agent in, cut the draft
to the least-explicit version you think works — agents over-specify by default
(`house-style.md` → "Start minimal; subtract before you test"). The test then
reveals what was actually load-bearing. You're not testing a polished doc;
you're testing a deliberately spare one to find the floor.

## The protocol

1. **Pick a cold agent** — a new session with no context from building the
   spell. The lack of context is the credential, not a deficiency.
2. **Give it only the name + intent** — not the implementation notes. If it
   can't get going from the SKILL.md alone, that's finding #1.
3. **Have it use the spell for a real task** and narrate friction as it goes:
   where it hesitated, guessed, backtracked, or got a confusing result.
4. **Harvest the questions.** Every "wait, how do I…?" is a located gap. These
   are worth more than the agent's suggested fixes.
5. **Log the findings** (`TEMPLATE.md`, named `YYYY-MM-DD-<spell>-findings.md`).
6. **Route the gaps:** breakdowns on the route → fix the SKILL.md / surface;
   judgments worth keeping → `../scenarios/`; a rule that earned its keep again
   → bump it in `../decay-ledger.md`.

## What this is _not_

Not QA for correctness bugs (that's `bun test`). This is for **friction and
curse-of-knowledge gaps** in the spell's documentation and ergonomics — the
distance between what the author knew and what a stranger can reach.

## The second job — across time

A single fresh-agent pass sees _today's_ failure distribution. The harder job is
watching across _time_: every spell carries a reachability assumption that ages
as the models beneath it strengthen. A line you needed today becomes dead weight
tomorrow. When a finding says "the SKILL.md over-explains something the agent
now handles fine," that's a **decay signal** — route it to `../decay-ledger.md`,
not just a doc edit.

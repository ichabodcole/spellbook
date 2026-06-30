---
date: 2026-06-30
spell: astrolabe
spell_version: astrolabe v1 (initial build, feature/cross-project-observatory)
agent: cold general-purpose subagent (no build context), Opus 4.8
task:
  register two projects → tend one (join/status/attention) → read back → remove
  → close, CLI-only, no source
---

# Fresh-Agent Findings — astrolabe (2026-06-30)

## Setup

The cold agent was given only the `astrolabe` name + intent, the path to
`SKILL.md`, the cli path, and a throwaway `$ASTROLABE_HOME`. It was forbidden
from reading the implementation source or opening a browser — CLI + `state`
read-back + `cli.ts help` only. It completed the full register → tend →
read-back → remove → close flow without ever needing the source.

## Friction log

1. **Given cli path was dead** — the test harness pointed at the cached plugin
   path, but astrolabe isn't released yet (feature branch), so no cached version
   ships it. Cold agent fell back to the repo copy. _Packaging/test-setup
   artifact, not the SKILL.md._
2. **`cli.ts help` was thinner than the SKILL.md verb table** — help omitted
   `--question`/`--phase`/`--description`/`--avatar`/`--id`/`--stdin`/`--as`.
   The natural first move (run `help`) would have left the agent unable to
   attach a question to an attention flag or a phase to a status. Two sources
   disagreeing on the surface area is a trap.
3. **`add` didn't return the id it created** — output was `{ok,applied}` with no
   `id`, but the very next step (`join <id>`) requires it. The agent had to run
   `list` to discover the slug, and the slug rule wasn't stated.
4. **Zone label vs value** — SKILL named zones "Needs you / Active / Quiet" but
   `state` returns `zone:"attention"` etc.; the literal values weren't
   documented.
5. **No story for ending a `join`** — the doc only said "hold it open"; the
   agent guessed (correctly) that terminating the process idles the card.
6. **`close` → `info` race** — `info` reported `running:true` immediately after
   a successful `close`, then `running:false`; momentarily contradicts the
   read-back-to-confirm rule.
7. **stderr "liveness ticks" never appeared** — the doc emphasized a
   stdout/stderr split with "liveness ticks on stderr," but events came on
   stdout and stderr stayed empty in a short run; the agent second-guessed
   whether `join` was healthy.

## The questions (the gold)

- **"What's the id of the project I just registered?"** → gap: `add` didn't echo
  it and the slug rule was unstated. _Sharpest gap — every later verb keys off
  it._
- **"How do I attach the question / set the phase?"** → gap:
  `--question`/`--phase` were in the SKILL table but not in `help`.
- **"How do I end a `join` / take a card offline?"** → gap: undocumented.
- **"Did `close` actually work?"** → gap: no note that `info` can lag teardown.
- **"What are the possible `zone` values?"** → gap: only labels documented.
- **"What is the `cursor` field for?"** → gap: unmentioned.

## Disposition

| Finding                       | On the route? | Action                                                                  |
| ----------------------------- | ------------- | ----------------------------------------------------------------------- |
| #2 help ≠ SKILL surface       | yes           | **Fixed** — enriched `cli.ts help` to list the flags                    |
| #3 add doesn't echo id        | yes           | **Fixed** — daemon now returns the derived `id`; SKILL states slug rule |
| #4 zone label vs value        | yes           | **Fixed** — SKILL documents the literal `zone` strings                  |
| #5 ending a join              | yes           | **Fixed** — SKILL: end the join to idle the card (no leave verb)        |
| #6 close→info teardown lag    | yes           | **Fixed** — SKILL: a post-close read can briefly lag                    |
| #7 stderr ticks over-promised | yes           | **Fixed** — SKILL softened: events ride stdout, only diagnostics stderr |
| #8 cursor unexplained         | yes           | **Fixed** — SKILL: one-line note (resume point, ignorable)              |
| #1 dead cached cli path       | no            | Packaging — astrolabe ships at release; not a doc fix                   |

## Decay signals

Nothing the spell now over-explains. The run reinforced (→ `decay-ledger.md`):
**"Architect for the reader's context"** (the id-echo + help/SKILL surface
mismatch were pure curse-of-knowledge gaps a cold agent located precisely) and
**"Start minimal; subtract before you test"** (the subtraction pass left the
id-echo implicit; the cold pass added back exactly what was load-bearing).

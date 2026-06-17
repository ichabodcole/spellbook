# Bounty — Idiomatic Kanban Feature Audit

**Created:** 2026-06-16 **Status:** Current **Spell:** `spellbook/bounty`
**Source:** board task `kanban-audit` (#20)

---

## Overview

Bounty is a duplex agent↔user task board, not a project-management product. The
audit lens is therefore **not** "does idiomatic Kanban tool X have this?" but
"does this feature earn its place on a _thin, agent-driven membrane_?" — the
house rule is the surface stays a membrane (chat is the substance, the board is
the state), so anything that pulls Bounty toward a heavyweight PM app is
declined on purpose, not by oversight.

Verdicts: **Have** (already shipped) · **Building** (in this backlog) · **Keep**
(earns a place — recommend building) · **Defer** (plausible, not yet) ·
**Decline** (actively doesn't fit the membrane).

## What Bounty already has

Four columns (To do → Doing → Review → Done) with a soft Review gate · cards
with title + notes · drag between columns · **within-column reorder** (the
`task.move` index path already supports it) · per-card **owner/assignee** + a
`@name` badge · **dependencies** (`blockedBy` + cycle guard + the `unblocked`
event) with a live `⛔ blocked by N` cue · scoped tails / `--mine` · snapshot +
restore (board-level "templates") · the doer-owns-state lifecycle (now in
SKILL.md).

That's already most of a Kanban core. The gaps are mostly _refinements_, which
is why the human noted these as "things I'm noticing," not bugs.

## Feature-by-feature

| Idiomatic feature                 | Verdict      | Rationale                                                                                                                                                                                                                      |
| --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Columns + soft WIP gate           | **Have**     | Review-as-gate is the soft version; see WIP limits below for the hard version.                                                                                                                                                 |
| Within-column reorder             | **Have**     | `task.move` carries an `index`; drag already reorders inside a column.                                                                                                                                                         |
| Card description (rich/edit)      | **Building** | `card-detail` (#19): notes are read-only today; truncate-on-card + click-for-detail modal lets the human edit.                                                                                                                 |
| Labels / tags                     | **Building** | `tags` (#18): chips on the card + `--tag`. The connector feature — unlocks filtering and color-coding.                                                                                                                         |
| Assignees / owners                | **Have**     | `owner` + scoped tails. Multi-agent ownership is a first-class concept here, beyond most boards.                                                                                                                               |
| Dependencies / blocking           | **Have**     | `blockedBy` + `unblocked` + cycle guard. The board's one real edge over a flat list.                                                                                                                                           |
| Due dates / SLAs                  | **Defer**    | Largely subsumed by `heartbeat` (#29)'s _expected time_ → a poke. An explicit calendar date adds UI weight for little agent value.                                                                                             |
| Card aging / staleness cue        | **Keep**     | Cheap surface cue (a card in Doing too long dims / shows an age badge) that pairs with `heartbeat` — the visual half of the same signal.                                                                                       |
| WIP limit (per-column cap)        | **Keep?**    | A _soft_ cap on Doing ("you have 3 in Doing — finish before pulling more") fits the doer-owns-state model: it keeps a self-pulling worker focused. Soft (a cue), never a lock — same spirit as the Review gate. Worth a spike. |
| Card filtering / search (surface) | **Keep**     | The agent already filters via `--mine`/`--owner`; the _human_ surface has no filter. Once `tags` lands, a by-tag / by-owner filter on the board is the natural pair.                                                           |
| Priority / card color             | **Defer**    | `tags` can encode priority (a `p1` chip) without a separate field. Revisit only if tag-as-priority proves clumsy.                                                                                                              |
| Swimlanes (horizontal grouping)   | **Decline**  | Grouping by owner is what scoped tails + `--mine` already give the agent; horizontal lanes are a lot of surface for a small board.                                                                                             |
| Card comments / activity feed     | **Decline**  | Chat (grapevine) **is** the substance channel by design (board = state, chat = substance). A comment thread on a card duplicates it.                                                                                           |
| Subtasks / checklists             | **Decline**  | `blockedBy` already models cross-task structure; checklists pull a card toward being its own board.                                                                                                                            |
| Card-level archive                | **Decline**  | Board-level `close` + `restore` (snapshots) covers persistence; per-card archive vs. `remove` is needless ceremony.                                                                                                            |

## Recommendations

Three "Keep" candidates earn a place and are small enough to fit the membrane —
suggest greenlighting as backlog items (in priority order):

1. **Surface filter (by tag / owner)** — _depends on `tags` (#18)_. Gives the
   human the lens the agent already has. Highest leverage once tags exist.
2. **Card aging / staleness cue** — the visual companion to `heartbeat` (#29); a
   dim + age badge on a card sitting in Doing past its expected time. Cheap, and
   reinforces the same "is this actually moving?" signal.
3. **Soft WIP cue on Doing** — a spike, not a commitment. A non-blocking nudge
   when a worker's Doing column exceeds N, supporting the doer-owns-state focus.
   Decline if it feels like a lock.

Everything else is either already shipped, in this backlog, or a deliberate
decline that keeps Bounty a thin membrane rather than a PM tool.

## Note on staying lightweight

The throughline of every Decline: **the board is state, chat is substance, and
the agent is the runtime.** Features that try to make the board carry
discussion, deep structure, or its own configuration are the ones to refuse.
When unsure whether a Kanban feature belongs, ask whether it makes the membrane
thicker — if so, it probably lives in chat or in the agent, not on the board.

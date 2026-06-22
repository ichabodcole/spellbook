---
date: 2026-06-18
spell: imago
spell_version: imago context-library (post-1.7.0, unified Context Library)
agent: claude (general-purpose subagent, cold)
task: "make a poster, save go-to quick prompts, capture a style to reuse" — drive the spell from the SKILL.md (+ mediaforge.md) alone
---

# Fresh-Agent Findings — imago Context Library (2026-06-18)

## Setup

A cold general-purpose agent was given only imago's name + one-line intent and a
user request that exercises the **Context Library** path: "make me a poster, and
as we go save a couple of go-to prompts and capture a style I like so I can
reuse them." It was restricted to reading **only** `SKILL.md` and the reference
it points at, `references/mediaforge.md` — no source, no types, no git. It was
asked to mentally drive the spell and report its questions/stumbles, not fixes.

This is the first cold pass over the **context-library** contract — the earlier
[2026-06-14 log](2026-06-14-imago-findings.md) predates it (it tested the old
standalone `style`/`prompt` verbs).

Verdict: **partially** — SKILL.md is internally coherent, but `mediaforge.md`
(which the SKILL orders the agent to read before generating) still described the
**pre-context-library API**, contradicting the SKILL at exactly the read/write
points the task needed.

## The finding (the gold): the reference had drifted from the contract

The context-library revision updated `SKILL.md` to the unified `context` verb +
linked-sets state, but left `references/mediaforge.md` describing the old API.
The two docs disagreed on the same operations:

| Operation          | SKILL.md (current)                                        | mediaforge.md (stale)                                |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------- |
| Capture a style    | `context style "<n>" --content … --image … --link active` | `style "<n>" --description … --image …`              |
| Capture wake event | `context.capture`                                         | `style.capture` (would miss the wake if copied)      |
| Read active styles | `state.activeContextIds` resolved against `state.library` | `state.styles.filter(s => s.active)` (no such field) |
| Words field        | `--content`                                               | `--description`                                      |
| Where styles live  | unified Context Library + active-context tray             | "drawer's Styles tab", `style.toggle`                |

A cold operator who trusted the reference _as instructed_ would run rejected
verbs (`style …`, `--description`), grep the wrong event name, and read a
`state.styles` field that no longer exists — all at generation time.

Secondary: **saving a quick prompt** (the user's literal ask) was inferable from
exactly one verb-table cell (`kind:"prompt"` + `--link quickPrompts`), never
shown as an example, never mentioned in "The loop"; and the doc never said
whether quick prompts fold into generation (they don't — composer-only).

## Disposition

| Finding                                                        | On the route? | Action                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mediaforge.md describes the stale style/context API            | yes           | **Fixed** — rewrote the styles block: `state.activeContextIds`/`library`, `context.capture`, defers the write command to SKILL.md (the single contract); dropped `--description`/`state.styles`/Styles-tab |
| No worked example for "save a quick prompt"; fold-in unclear   | yes           | **Fixed** — added a compact `context prompt … --link quickPrompts` example to SKILL.md + "composer-only, not folded into generation" note                                                                  |
| `state.focus` / `ContextEntry` field shapes punted to types.ts | minor         | left — SKILL names types.ts as the single contract; resolving ids → entries is walkable. Watch if it recurs.                                                                                               |
| `prompt` vs reserved `context`/`skill` kinds undistinguished   | minor         | left — `context`/`skill` are reserved/unused this pass; documenting them now would be speculative                                                                                                          |

## Decay signals

Reinforces **"Reference, don't inline"** (a reference that restates contract
detail rots when the contract moves) and **"Architect for the reader's
context"** (the cold reader hit the trap precisely because it followed the
SKILL's own "read this first" instruction into stale material). Bumped both in
the decay-ledger; scenario captured at
`scenarios/2026-06-18-reference-drifts-from-contract.md`.

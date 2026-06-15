---
date: 2026-06-14
spell: imago
spell_version: imago V1 (pre-release)
agent: claude (general-purpose subagent, cold)
task: "let's use imago to make and refine an image" — drive the spell from the SKILL.md alone
---

# Fresh-Agent Findings — imago (2026-06-14)

## Setup

A cold general-purpose agent was given only imago's name + one-line intent (an
image create⟷annotate⟷edit canvas) and a user line ("let's use imago to make and
refine an image"). It was restricted to reading the SKILL.md (+ the reference it
points at, `references/mediaforge.md`) — no source, no other docs, no git. It
was asked to mentally walk through actually driving the spell and report its
questions/stumbles, not fixes.

Verdict: **partially** — it grasped the philosophy and the per-event loop, but
stalled on the concrete operational interface (bootstrap, the live data shapes).

## Friction log

- Couldn't assemble the **startup sequence** (open → capture session_id →
  Monitor the tail) — no example; had to infer it from fragments.
- The wake-set **grep read as ambiguous** — `tail -f <tail output> | grep`
  looked like a raw command separate from "wrap with Monitor."
- No **event-payload** or **`state`** shapes given → would reverse-engineer
  field names live; couldn't tell where the focused variant / batch+variant ids
  come from.
- Hit several **doc contradictions** (below).

## The questions (the gold)

- **Q:** How do I actually start and wire the Monitor? → **gap:** the bootstrap
  (open → session_id → Monitor `tail`) was never spelled out.
- **Q:** Is that `grep` a command or an illustration? do I pipe through it? →
  **gap:** the wake-set filter vs. the Monitor mechanic weren't disentangled.
- **Q:** What's in a `marks.commit` / `proposal.send` payload? what's the
  `state` shape? where do variant/batch ids come from? → **gap:** no pointer to
  the contract (the `AgentEventPayload`/`ImagoState` types) as the source of
  shapes.
- **Q (contradiction):** do `focus.set` / `variant.like` wake me? SKILL's grep
  listed them; the loop + mediaforge said they're ambient. → **gap:** wake set
  not aligned to the ambient-signal principle.
- **Q (contradiction):** nano-banana — push `--width/--height` to 2048, or does
  it ignore them? → **gap:** mediaforge said both.
- **Q (contradiction):** `style <name…>` vs `style … --description --image`? →
  **gap:** the SKILL verb table predated the styles rework; the new
  `--description` /`--image` flags (and the new `prompt` verb) were missing.

## Disposition

| Finding                                                | On the route? | Action                                                                                                           |
| ------------------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| No bootstrap example                                   | yes           | **Fixed** — added open→Monitor bootstrap to SKILL.md                                                             |
| grep ambiguity                                         | yes           | **Fixed** — clarified "that grep IS the wake set," `cli.ts tail` not raw `tail -f`                               |
| Event/state shapes unspecified                         | yes           | **Fixed** — added "where the shapes live" → `AgentEventPayload`/`ImagoState` in types.ts + how to read focus/ids |
| focus/like wake-set contradiction                      | yes           | **Fixed** — removed `variant.like`/`focus.set` from the wake grep; ambient-read note                             |
| nano width/height contradiction                        | yes           | **Fixed** — mediaforge reworded (nano ignores `--width/--height`)                                                |
| style verb flags missing + `prompt` verb absent        | yes           | **Fixed** — SKILL verb table updated (`style … --description --image`, added `prompt`)                           |
| model short-name → full id mapping is manual           | minor         | left as-is (the mapping table is present in mediaforge)                                                          |
| `bun cli.ts` shorthand vs `${CLAUDE_PLUGIN_ROOT}` path | minor         | left as-is (SKILL establishes the full path; mediaforge uses shorthand within the routing brain)                 |

## Decay signals

None new. (The doc's problem was under-specification of the live interface, not
over-explanation of model behavior.)

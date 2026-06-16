# Backlog — imago "skills" / captured methodologies

**Date:** 2026-06-16 · **Status:** backlog / design idea (cole) · **Spell:**
imago

## The idea

A new **app-contextual data structure**: a saved, reusable **process /
methodology** — not a button, not a one-shot prompt. You and the agent go
through a working session (bring in an image → collage → pull references → edit
→ color-correct → …), reach a good end state, and realize **the _process_ was
the reusable thing.** You save that process as a "skill": a (possibly long)
instruction set describing _how_ to do this kind of thing — the steps, the tools
used in the app, the inputs it needs, and what to check for along the way.

Invoking one **injects it as context** to the agent ("here's the process we're
going to follow"); the conversation continues from there. It is **not** a
deterministic auto-run — the agent re-applies the _thinking_, adapts it to the
new inputs, and keeps the human in the loop.

Photoshop-power-user analogy: someone develops a repeatable way to make a
lightning effect — which generation/filter tools, how they composite, the color
correction — and that _methodology_ is the asset, not any single click.

## Why it fits this class of app (the principle worth keeping)

This is the sharpened imago/conjuration tenet — a reasoning-agent ↔ human
surface:

- **Automate the deterministic busywork** — work where neither agent-judgment
  nor human-judgment adds anything, only toil. (E.g. the comms layer:
  event-driven sends instead of the agent polling every N seconds; the
  agent-event contract cleanup — imperatives notify, ambient is read.) Make
  those progradic + deterministic.
- **Do NOT wrap judgment/creative work in buttons** that bake in unasked
  assumptions — the "make-sandwich button" (this is exactly why we dropped the
  proposed "Harmonize" button: "harmonize" smuggles in match-base-vs-restyle,
  whose-palette-wins, blend-vs-crisp — all answered by silent defaults).
- Instead, **capture and replay judgment as _context_** the human authors and
  owns, and the agent reasons from. **Save the _thinking_, not the click.**

## What makes it distinct (design notes)

- **Retrospective authoring is the novelty.** Most "save a workflow" features
  are prospective (define a macro up front). This is "we just _discovered_ a
  good process — crystallize it after the fact." The **agent is well-positioned
  to author it** because it was _in_ the session: "here's the process we
  followed, cleaned up" (the live run is usually inefficient as you figure it
  out — the saved version is the distilled one).
- **It's a context primitive, not a control primitive.** imago already has
  context primitives: **styles** = look-context, **selected refs** =
  subject-context, the **conversation** = working-context. A skill is
  **process-context** — it slots cleanly into the existing model.
- **Replay is adaptive, not deterministic** — invoking seeds the agent with the
  methodology; the agent adapts to the new inputs. That's why it's not a button.

## Relation to existing primitives

| Primitive       | What it captures             | Shape                              |
| --------------- | ---------------------------- | ---------------------------------- |
| quick-prompt    | a one-shot instruction       | short snippet → fills the composer |
| style           | a look (durable, toggleable) | words + a canonical image          |
| **skill (new)** | **a process / methodology**  | **long, structured; own surface**  |

Could _technically_ live inside the quick-prompts library, but it likely wants
to be **more robust**: longer text, maybe structure (steps / tools / inputs /
checks), and its **own catalog + editor surface** for authoring and selecting.

## Open questions (bank for when this is picked up)

- Structure: freeform text vs. a light schema (steps · tools-used ·
  inputs-needed · what-to-check)?
- Authoring: agent-assisted distillation from the session transcript (likely
  yes) — a "save this as a skill" action that asks the agent to write the
  methodology, then the human edits it.
- Home: a new app-local data structure + catalog, or an extension of the
  quick-prompts library? (cole leans: its own, more-robust thing.)
- Does this generalize beyond imago to other Spellbook agent-surface spells?
  (The principle does; the data structure might be imago-specific for now.)

## Not now

cole flagged this as backlog. Next up is a round of UX/UI polish + small design
refactors from actual usage — capture those separately; this waits.

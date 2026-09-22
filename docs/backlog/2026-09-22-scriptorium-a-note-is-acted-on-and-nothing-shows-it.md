---
type: backlog
title:
  "Backlog — Scriptorium: agents act on every note, and the human cannot see
  that they are"
description:
  The designed "a note is not a request" rule is falsified in use; agents act on
  note.added, and the surface shows no sign work has started
tags: [scriptorium, notes, co-presence, design]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: agents act on every note, and the human cannot see that they are

## Designed vs. observed

**Designed:** `note.added` tells the agent a note exists — it names the
document, not the text — and the agent does nothing until asked. The skill says
so outright: _"**A note is not a request.** They are marking something for
themselves unless they say otherwise."_ (`SKILL.md:136`).

**Observed** (Cole, Operator doc, 2026-09-20, §1): the agent receives the event,
runs `notes --doc` to find out what it is, and acts — almost every time, despite
that line. Cole's reading is that this is the **proper** instinct, and that the
outcome has been good. So the behaviour stays; the design around it is what is
wrong.

## The house rule this confirms

> If we send a message to an agent, assume it will act. Do not send purely
> ambient notifications.

Same rule as "response names the next act" and the ambient-vs-intent split: the
event bus is for intent, and `note.added` is being delivered as intent while the
skill calls it ambient. The Monitor-expiry item (linked below) has the same
root.

## What is missing

Messages already get "something is happening" (E53: `WaitingBadge`, the 30-s
`waiting` event, the `working` verb). **Notes get nothing**, so between adding a
note and the agent's reply the human sees no sign anything is underway.

## Options, none chosen

1. **Surface-side, agent-free:** a pending marker on a new note until the agent
   next speaks about it. Cheap; honest only if it can also go stale (E53's
   `stalled` rule — a spinner is a claim).
2. **Agent touchpoint:** the agent acknowledges the note (reuse `working`, or a
   note-scoped equivalent) and the note shows "being worked on". Needs the event
   to _name_ that act — a skill line alone is what failed here.
3. **Make the event self-sufficient:** carry the note text when it is short,
   saving the `notes` round trip.
4. **Later — batch review:** notes held until the human sends them as one
   message, so a review is not interrupted by edits. This is the case the
   original "not a request" design was reaching for; it may belong to it.

Also: rewrite `SKILL.md:136` to match what agents actually do, whichever option
lands.

## References

- `plugins/spellbook/skills/scriptorium/SKILL.md:136`, `:149`
- `src/scriptorium/surface/components/WaitingBadge.tsx`, `NotesPanel.tsx`
- `src/scriptorium/backend/cli.ts:873` (`working`)
- Related:
  [./2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md](./2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`

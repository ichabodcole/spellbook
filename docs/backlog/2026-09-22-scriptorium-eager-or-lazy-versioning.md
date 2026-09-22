---
type: backlog
title:
  "Backlog — Scriptorium: should an asked-for change become a version at once,
  or wait?"
description:
  Agents often hold requested edits until told to consolidate, so there is no
  new version to diff; decide eager vs lazy, possibly as a user setting
tags: [scriptorium, versions, agent-behavior, design]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: should an asked-for change become a version at once, or wait?

## Expected vs. observed

**Expected** when Scriptorium was built: the human asks for a change, the agent
cuts a new version (`version-new`) with it, and the human diffs old against new
in compare mode.

**Observed** (Cole, Operator doc, 2026-09-20, §5): often the agent takes the
request — broad ("less of this prose, more formal") or narrow ("this word, not
that one") — and asks what is next **without applying it**, until the human says
"consolidate those into a new version".

Cole's position: **not clearly worse, just not what was designed.** Undecided.

| Eager (apply now)                   | Lazy (apply on request)      |
| ----------------------------------- | ---------------------------- |
| Every ask is diffable immediately   | No waiting between asks      |
| Human waits for each change to land | Human has to say "apply now" |

## Possible direction

A setting the human picks, which becomes the agent's expectation: **eager** —
apply every change as a version; **lazy** — gather, apply when asked. Whichever
way it goes, the skill should _state_ the collaboration mode — this gap exists
because an agent arriving without the builders' intent defaulted to something
else. A setting has to reach the agent through the state/event it already reads,
not only through prose.

## Decide first

- Try eager deliberately for a while (skill wording only) before building a
  setting — per wait-for-real-use-signal, the setting is only worth building if
  both modes turn out to be wanted.

## References

- `plugins/spellbook/skills/scriptorium/SKILL.md:9`, `:66`, `:98` (versions
  guidance)
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`

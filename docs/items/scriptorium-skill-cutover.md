---
type: item
title: The Scriptorium SKILL describes the kit's contract
description:
  Rewrite the SKILL to the kit's verbs, flags, events and refusals, so an agent
  reading only the SKILL drives a session on the flipped build; lands before
  Cole's trial.
status: draft
lifecycle: backlog
id: 01a15b3a-27c0-706a-8a19-5ca5ca424431
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-20 }
tags: [kit, scriptorium, skill]
cycle: 2026-10-cutover
parent: feature/workspace-kit
from: cycle/2026-10-cutover
blocked_by: [01a15b3a-2716-70a6-872a-d30f3aad2a2c]
---

# The Scriptorium SKILL describes the kit's contract

`plugins/spellbook/skills/scriptorium/SKILL.md` still describes the shipped
Scriptorium. After the flip, an agent reading it would be told about verbs,
flags and events the default no longer has. The survey of 2026-10-20 listed each
passage with what it becomes. Most are a change of vocabulary:

- `about` and `via` on the human's messages, and how to tell a typed question
  from a button press;
- the note events and `system` facts (`note.edited`, `set.make`, `folder.add`,
  `manifest.migrated`);
- `link-check` in place of `dangling --entry`, and `relink` after a move;
- the WORKSPACE entry replaced by "name where every new file goes", with
  `add-folder`, `make-set` and `import --into`;
- `reveal` as an agent verb, 21 new flags, and `--entry` gone;
- a verb with no `--session` going to the newest session only, and the refusal
  when the human ended it;
- a stalled note's "Ask the agent";
- older sessions converting as they open.

One passage is wrong, not just renamed: rule 2 promises `active.outside` with
`activatedBeforeWritten: true`, which the kit's fact doesn't carry. It is
reworded around `preservedAs`.

This lands before Cole's trial, so the agent in that trial reads the contract it
is actually running.

## Definition of done

- [ ] Every passage in the survey's list is rewritten, and every verb and flag
      the SKILL names exists in the CLI's `schema`.
- [ ] `tail-rule-parity` and `shipped-skill-references` are green.
- [ ] A cold agent given only the SKILL drives a scratch session end to end:
      open, tail, answer a message with a version, resolve a note, `link-check`,
      relink after a move, and close.

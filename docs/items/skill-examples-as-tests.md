---
type: item
title: Run SKILL.md examples as tests?
description:
  Whether to run skill bash examples against a real daemon, and how that sits
  with skills-lean-on-cli-help.
status: draft
lifecycle: backlog
id: 01a13647-91e9-72a7-9942-3a779f5c1949
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [skills, testing]
from: items/story-studio-port-back/write-up.md
---

# Run SKILL.md examples as tests?

Story Studio runs every bash block in a skill against a real daemon with a fake
provider, under sh and zsh, and checks `references/verbs.md` lists exactly the
registered verbs (`apps/sound-stage/skills.stage.test.ts`,
`atlas.test.ts:670+`). Nothing in Spellbook runs skill examples. Cole took it
after a look: first settle how it sits with the open `skills-lean-on-cli-help`
item, which moves detail out of skills into CLI help.

## Definition of done

- [ ] A ruling on whether skill examples run as tests, given
      `skills-lean-on-cli-help`, and an item to build it if yes

## Related Documents

- [What to take back from Story Studio](./story-studio-port-back/write-up.md)

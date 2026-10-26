---
type: item
title: Three grapevine hints count the wrong thing
description:
  truncation_hint reports the full body length rather than what was cut, tail
  --last n counts mark and reopen frames tail never shows, and doctor's hint
  says list spawns a daemon when it doesn't.
status: draft
lifecycle: triage
id: 01a176ad-1b41-742e-b500-e653179c0122
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: items/bounty-grapevine-skill-review.md
---

# Three grapevine hints count the wrong thing

Found by the SKILL review and confirmed by its verifier (2026-10-25):

- **`truncation_hint`** reports "+N chars" with N the full body length, not what
  was cut: a 3000-character body under `--max 40` says "+3000 chars".
- **`tail --last n`** counts mark and reopen status frames, which `tail` never
  shows: three messages and two marks, then `--last 3`, shows only one message,
  and the grounding hint still suggests `--from-start`.
- **`doctor`**, with no daemon, says "Run any verb (e.g. `cli.ts list`) to spawn
  one", but `list` never starts the daemon.

## Definition of done

- [ ] `truncation_hint` counts the characters actually cut.
- [ ] `--last n` counts only frames `tail` prints.
- [ ] `doctor`'s hint names a verb that starts the daemon.
- [ ] Each is tested.

## Related Documents

- [Review bounty + grapevine SKILL.md for accuracy and usefulness](./bounty-grapevine-skill-review.md)

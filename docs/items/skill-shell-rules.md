---
type: item
title: Shell rules for skills in house style
description:
  Launcher as a shell function, literal session ids, references/verbs.md
  generated from help.
status: draft
lifecycle: backlog
id: 01a13647-904e-72e5-b055-9981e6f3208e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [house-style, skills]
from: items/story-studio-port-back/write-up.md
---

# Shell rules for skills in house style

Skills hand agents shell snippets that break under zsh. zsh does not word-split
`$S`, so `S="bun …/cli.ts"; $S say` fails; it did in the first post of the Story
Studio review. `<id>` placeholders are read as redirects. Story Studio's rules:
define the launcher as a function (`S() { bun …/cli.ts "$@"; }`), write session
ids as literals, and generate `references/verbs.md` from `help`.

## Definition of done

- [ ] `grimoire/house-style.md` carries the shell rules
- [ ] Spellbook's skills follow them (a grep finds no `$S`-style launcher
      variable)

## Related Documents

- [What to take back from Story Studio](./story-studio-port-back/write-up.md)

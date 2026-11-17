---
type: item
title: Run CI's Linux check locally
description:
  A check:linux script runs the same steps as CI inside a pinned Linux
  container, so a red CI run can be reproduced before pushing.
status: draft
lifecycle: backlog
id: 01a1eb00-56a0-75ea-ac09-a88785e22ef1
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Run CI's Linux check locally

From the Story Studio port scan (2026-11-17). Spellbook keeps finding out on CI
what failed only on Linux; a memory note records three red CI runs in one day
from checks that passed locally. There is no way to run CI's steps on Linux
before pushing.

Story Studio's `scripts/check-linux.sh` (`89abe47b`, `e8d578ee`) runs
`git archive HEAD` into a pinned `oven/bun` container and runs the same steps as
CI, with no Actions minutes; `CHECK_LINUX_HOST` runs it on another machine over
SSH. It reproduced all 11 failures of one red run. Story Studio requires it for
branches that touch saving, watching or paths.

## Definition of done

- [ ] `bun run check:linux` runs the gate's steps on a clean copy of HEAD in a
      Linux container pinned to CI's Bun version.
- [ ] It exits with the gate's result, and says how to run it on another host.
- [ ] The testing playbook says when to run it.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)

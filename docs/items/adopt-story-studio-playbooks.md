---
type: item
title: Adopt Story Studio's branch, cycle and test-speed lessons
description:
  Bring Story Studio's implementing-a-branch, running-a-cycle and release
  playbooks, and its test-speed notes, into Spellbook's playbooks.
status: draft
lifecycle: backlog
id: 01a1eb00-5844-71d0-b2c8-a7d09df1b6a3
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# Adopt Story Studio's branch, cycle and test-speed lessons

From the Story Studio port scan (2026-11-17). Story Studio has written down
lessons Spellbook keeps relearning, which today are scattered across memory
notes:

- **`implementing-a-branch-playbook.md`**: a brief for implementers, whatever
  the harness. The shared gate lock; checking load before a gate; never
  `--no-verify`, and checking `.husky/_/pre-commit` exists in a new worktree,
  because git silently runs no hook without it; running each package's tests in
  one process; rules for a pure-refactor split (keep hook order, blind tests,
  free names).
- **`running-a-cycle-playbook.md`** and **`release-playbook.md`**: read the last
  cycle's carried-forward list at start; at close, sort each lesson into a
  playbook or a note and check every closed research item has its follow-up
  filed.
- **Test-speed notes** from its `2026-10-test-speed` cycle, written for other
  repos' playbooks: lost watcher writes on macOS, `--rerun-each` beside a
  looping suite, splitting the slowest file, recording timers as they fire.
  Spellbook's `test-speed-playbook.md` was adapted from Story Studio's earlier
  and lacks these.

## Definition of done

- [ ] Spellbook has an implementing-a-branch playbook, adapted to its gate,
      worktrees and spells.
- [ ] Spellbook's cycle and release practice is written down, taking Story
      Studio's rituals where they fit.
- [ ] The test-speed notes are folded into `test-speed-playbook.md`.
- [ ] Memory notes now covered by a playbook point to it.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)

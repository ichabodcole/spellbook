---
type: item
title: Parallel tests in the gate?
description:
  Whether Spellbook's daemons can share a parallel bun test run, and the
  test-speed playbook if so.
status: draft
lifecycle: backlog
id: 01a13647-9270-73d4-8b90-318f67c0d67d
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [testing, gate]
from: items/story-studio-port-back/write-up.md
---

# Parallel tests in the gate?

Story Studio runs `bun test --parallel --timings=tests/timings.json`; by their
notes the gate went from about 292 s serial to about 22 s, then 15 s after
removing waits. Their test-speed playbook: measure, parallelise, wait on
conditions not time, fix flakes at the cause with `--rerun-each=50`. Unknown:
whether Spellbook's daemons can share a parallel run (temp discovery pointers).

## Definition of done

- [ ] A measured answer on whether Spellbook's suite can run in parallel, and
      what blocks it if not
- [ ] If yes, an item to switch the gate and adopt the playbook

## Related Documents

- [What to take back from Story Studio](./story-studio-port-back/write-up.md)

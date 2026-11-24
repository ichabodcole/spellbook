---
type: item
title: CI logs the runner's memory
description:
  The gate job prints free memory every 30 seconds, so a runner shut down for
  memory leaves evidence; sharding waits until that happens.
status: stable
lifecycle: backlog
id: 01a1eb00-58ce-704a-acf5-c719b37dacc4
kind: chore
generated: { by: claude-opus-5-5, at: 2026-11-17 }
from: 01a1eabb-ee28-7737-826d-38ba3dd5b5bf
---

# CI logs the runner's memory

From the Story Studio port scan (2026-11-17). Story Studio's CI runner was shut
down mid-run with no log: one whole test run reached about 9.7 GB on the 2-core
runner. It now prints `free -m` every 30 seconds during the gate, so a shutdown
shows what led to it, and it shards the run into six serial `bun test --shard`
passes inside one job (`1376e1b5`, `44b24933`, `f706c1a7`).

Spellbook's gate (491 test files, about 5 minutes) passes, so sharding waits
until a run actually dies. The sampler is one line and turns that first silent
shutdown into evidence. Serial shards inside one job would keep the required
`gate` check, so they fit the no-matrix rule when the time comes.

## Definition of done

- [ ] The gate job prints the runner's free memory every 30 seconds while it
      runs, and stops when it ends.
- [ ] The CI notes say: shard the run, as Story Studio does, on the first runner
      shut down for memory.

## Related Documents

- [Which of Story Studio's new document UX should Scriptorium take?](./story-studio-document-ux-port/item.md)

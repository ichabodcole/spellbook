---
type: item
title: Allow-list Biome roots
description:
  Name the roots Biome scans instead of denying paths, so agent worktrees are
  never scanned by the gate.
status: draft
lifecycle: backlog
id: 01a13647-90da-72c6-aafa-9e81eea7fe0a
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [tooling, biome]
from: items/_archive/story-studio-port-back/write-up.md
---

# Allow-list Biome roots

Spellbook's `biome.json` denies paths, so the gate scans `.claude/worktrees` and
fails on their nested `biome.json` (the gate-vs-worktree failures). Story Studio
names only the roots to scan.

## Definition of done

- [ ] `biome.json` lists the roots it scans
- [ ] The gate passes from the main checkout while an agent worktree exists

## Related Documents

- [What to take back from Story Studio](./_archive/story-studio-port-back/write-up.md)

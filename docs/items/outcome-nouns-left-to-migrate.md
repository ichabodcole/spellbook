---
type: item
title: Spell replies still using the old spellings the outcome contract replaced
description:
  "Leftovers from #82: bounty update's noop, grapevine's already_running,
  restarted/rolled verb echoes, and reap's parallel arrays have not moved to
  outcome nouns."
status: draft
lifecycle: triage
id: 01a0e73e-84ae-7600-95c9-3bc26f0a1c0d
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-hardening
---

# Spell replies still using the old spellings the outcome contract replaced

[#82](https://github.com/ichabodcole/spellbook/issues/82) asked for a shared
spelling for "asked for, didn't happen" and "done, but not the way you'd
assume". Cole ruled on it 2026-08-08, and it shipped as
[the outcome contract](../../grimoire/outcome-contract.md) (`455acaf4`, v2.2.0).
imago and magpie adopted `outcome:` nouns in v2.2.0, and astrolabe `close` in
v4.0.0. #82 was closed 2026-09-28 with this item carrying what is left, found by
an audit on `ad758f10`:

- **bounty `update`** prints `noop: true` (`src/bounty/backend/cli.ts` ~1619);
  the thread proposed `outcome: "already-current"`.
- **grapevine `start`** reports `already_running` as a boolean
  (`src/grapevine/backend/cli.ts` ~1398).
- **grapevine `restarted: true` / `rolled: true`**: the verb echoes the thread
  flagged (~1406, 1438, 1498, 1538).
- **grapevine `reap`** returns parallel `kept`/`reaped`/`skipped` arrays, where
  `skipped` means "kill failed" (~1818–1847), instead of per-item
  `results: [{outcome, reason}]`.

Each is a wire change a caller can see, so it needs a release note. Where the
canonical copy of the vocabulary lives is still deliberately unruled.

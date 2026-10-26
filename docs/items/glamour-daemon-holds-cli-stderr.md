---
type: item
title: glamour's daemon holds the CLI's stderr open
description:
  glamour open spawns its daemon with stderr inherited, so a caller that reads
  the CLI's stderr to EOF (spawnSync with pipes, Python capture_output) blocks
  until the daemon exits.
status: draft
lifecycle: triage
id: 01a177a1-fa57-736f-a5d5-cfd3936fc570
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [glamour, cli]
from: items/shrink-shipped-dist.md
---

# glamour's daemon holds the CLI's stderr open

Found by the no-stake verifier of `shrink-shipped-dist` (2026-10-26).

`glamour open` spawns its daemon with `stdio: ["ignore","pipe","inherit"]`
(`src/glamour/backend/cli.ts:540`). It is the only spell whose daemon inherits
the CLI's stderr; the others use `"ignore"` or a log fd. So the CLI's stderr
pipe stays open until the daemon exits.

From a shell, `glamour open --no-open` returns at once and users are not
affected. A caller that reads stderr to EOF does block: `Bun.spawnSync` with
piped stderr, or Python's `capture_output`. Measured: with `--timeout 10` the
call returned after 10.1 s, when the daemon timed out. With no `--timeout` it
blocked for 155 s, until the daemon was killed. An implementer took this for a
daemon that dies before its page loads. It is the same at `spellbook-v5.2.0`.

## Definition of done

- [ ] glamour's daemon no longer holds the CLI's stderr: a log fd, as the other
      spells do, or `"ignore"`.
- [ ] A test spawns `open` with piped stderr and shows it returns while the
      daemon is still up.

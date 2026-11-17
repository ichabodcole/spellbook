---
type: item
title: A closed stdout pipe crashes a kit CLI with an EPIPE stack
description:
  "`<cli> schema | true` closes stdout early; with no error listener Bun prints
  an EPIPE stack and exits 1. Image Farm's exitOnBrokenPipe exits 0 quietly."
status: stable
lifecycle: done
id: 01a1eabe-f743-74c8-beb8-146638bf1f67
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, cli]
parent: feature/workspace-kit-follow-ups
priority: medium
cycle: 2026-11-research-and-safety
---

# A closed stdout pipe crashes a kit CLI with an EPIPE stack

Reported by Image Farm on `kit-parity` (message 63, point 2), their item
`cli-epipe-envelope` (develop `30241167`). `cli schema | head -1` closes the
pipe before the write finishes. The write raises an `error` event on
`process.stdout`; with no listener Bun treats it as fatal, prints an `EPIPE`
stack and exits 1. It is an event, not a thrown error, so no JSON envelope is
possible. Not reproduced here yet. Their repro:

```sh
bash -c 'set -o pipefail; <cli> schema | true'
```

On develop, only `tail` handles this (`src/kit/wire/tailEvents.ts` ends at 0 on
`EPIPE`). `exitOnBrokenPipe` is not on our side.

**Image Farm's fix:** `src/lib/exitOnBrokenPipe.ts`, a stdout `error` listener
that exits 0 quietly on `EPIPE` and rethrows anything else, with `stream` and
`exit` as parameters so it unit-tests. `dispatch` in `registry.ts` installs it
once per process. Port-back files: `src/lib/exitOnBrokenPipe.ts`, its test,
`src/lib/index.ts` (one export) and `src/cli/registry.ts`.

## Definition of done

- [ ] `schema | true` and `version | true` under `set -o pipefail` exit 0 with
      empty stderr, for a kit CLI. Process tests hold it.
- [ ] Another stdout error still surfaces.
- [ ] Posted on `kit-parity`, or Image Farm's change is ported.

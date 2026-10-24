---
type: item
title: Two link.check watch cells time out under load
description:
  links.integration.test.ts 'dot-paths never push context.changed' and
  '_meta/profiles made after the session started…' time out at bun's 5 s default
  on a busy machine (1 of 50 alone, 4 of 50 beside a busy suite, 2026-10-23),
  the second even though it already writes until seen.
status: stable
lifecycle: ready
id: 01a16b4e-ad20-7428-8cdc-0883057bcb84
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-23 }
parent: feature/workspace-kit-follow-ups
from: items/kit-backlinks-test-watch-race.md
priority: high
cycle: 2026-10-release-6
---

# Two link.check watch cells time out under load

After the polish cycle fixed the backlinks race in
`src/kit/workspace/links.integration.test.ts`, a 50-run loop of the whole file
(2026-10-23, on a machine whose `fseventsd` was saturated by other sessions'
suites) still failed in two other cells, each at bun's 5 s default timeout:

| Cell                                                                                   | Alone (50) | Beside a busy `bun test src/kit` (50) |
| -------------------------------------------------------------------------------------- | ---------- | ------------------------------------- |
| `link.check > dot-paths (.git, .DS_Store, .obsidian) never push context.changed`       | 1          | 2                                     |
| `link.check > a listed document's _meta/profiles made after the session started is w…` | 0          | 3                                     |

The second already writes until seen, and it failed on the cycle's base too (the
watch investigation, `kit-watch-tests-unproven-watch`). The likely cause is the
same as that item's: proving a new watch live, or waiting for its first event,
can take up to about 3 s on a saturated machine, which leaves too little of the
5 s. Unconfirmed.

## Definition of done

- [ ] Confirm the cause of each cell's timeout from a trace, not from the timing
      alone.
- [ ] Fix it the way `kit-watch-tests-unproven-watch` did (prove the watch live,
      write until seen), with a budget only where the wait is the OS's own.
- [ ] The whole file passes 50 runs in a row, alone and beside a busy
      `bun test src/kit`.

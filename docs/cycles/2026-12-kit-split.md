---
type: cycle
title: Split the kit
description:
  Port Story Studio's split of the kit's oversized modules, step by step with
  behaviour unchanged, so later kit work and ports land on small files.
tags: [kit, refactor]
status: stable
lifecycle: active
started: 2026-11-24
appetite:
  Stop when session.ts and server.ts are under the 1,200-line limit with their
  overrides removed (S11 and D9 landed) and CI is green on two pushes in a row;
  the R, V, W and P steps carry over if they have not started.
after: []
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Split the kit

## Why now

Cole ruled on 2026-11-17 that the kit split comes before the Story Studio UX
ports, and on 2026-11-24 that this cycle is dedicated to it. Nine filed items
(the inbox, the Activity and icon tabs, the page key, vocabulary layers and
more) each wait on a step of the split, because they change code the split
moves. Every later port from Story Studio is also cheaper once our files match
theirs.

## Scope

Approved by Cole on 2026-11-24, the optional fixes included. The plan is
[the kit-split write-up](../items/kit-split-oversized-modules/write-up.md); its
steps are filed under [feature/kit-split](../features/kit-split/feature.md),
each blocked by the one before in its chain.

**Lane A, the session and the daemon (in order):**

- **G0, G1**: Biome 2.5.x (the gate already typechecks), then the 1,200-line
  guard with frozen overrides. Everything else waits on G1.
- **S2 to S11**: `session.ts` into parts, tier by tier. **S3 and S9 land
  alone**, and S9 needs Linux CI green before S10.
- **D1 to D9**: `server.ts` into `daemon/` parts. D1 any time after G1; D2 waits
  for S11. **D2 and D4 land alone**, and D4 needs Linux CI green after.

**Lane B, the surface (alongside lane A, never during an "alone" step):**

- **W1 to W5**: WorkspaceShell, W1 first.
- **P1 to P6**: DocumentPane.
- **R1, V1 to V4**: `protocol.ts` and `verbs.ts`, and
  [cli-yaml-off-start-path](../items/cli-yaml-off-start-path.md).

Two lanes at most (Cole's call 8). Each step lands with behaviour unchanged and
no test's expectations changed.

**Fixes alongside** (none touches a file the split moves):

- [grapevine-hold-has-no-way-out](../items/grapevine-hold-has-no-way-out/item.md),
  [grapevine-paused-daemon-reads-as-gone](../items/grapevine-paused-daemon-reads-as-gone/item.md),
  [grapevine-small-hint-miscounts](../items/grapevine-small-hint-miscounts/item.md):
  the grapevine spell, all `ready`.
- [bounty-latest-pointer-and-list-title](../items/bounty-latest-pointer-and-list-title/item.md)
  and
  [glamour-daemon-holds-cli-stderr](../items/glamour-daemon-holds-cli-stderr/item.md),
  both `ready`.

Out of scope, deliberately: kit bugs and features, including the nine items
waiting on split steps. They change the files being moved, and land after the
step they wait on, in a later cycle. The frontmatter-chip build waits on the
vocabulary items, which wait on S5.

## Outcome

_Written at close._

## Sessions

<!-- One line per branch: `- <type>/<slug> (open)`, then `(landed YYYY-MM-DD)`. -->

- chore/kit-split-g0 (landed 2026-11-24)
- fix/grapevine-hold-has-no-way-out (landed 2026-11-24)
- chore/kit-split-g1 (landed 2026-11-24)
- fix/grapevine-paused-daemon-reads-as-gone (landed 2026-11-24)
- fix/grapevine-small-hint-miscounts (landed 2026-11-24)
- fix/glamour-daemon-holds-cli-stderr (landed 2026-11-24)
- fix/bounty-latest-pointer-and-list-title (landed 2026-11-24)
- chore/kit-split-w1 (landed 2026-11-25)
- chore/kit-split-s2 (landed 2026-11-25)
- chore/kit-split-w2 (landed 2026-11-25)
- chore/kit-split-s3 (landed 2026-11-25)
- chore/kit-split-w3 (landed 2026-11-25)

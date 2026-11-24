---
type: feature
title: Split the kit's oversized modules
description:
  The kit's session, daemon, shell, pane, protocol and verbs files are split
  along Story Studio's seams into parts under 1,200 lines, with behaviour
  unchanged and a Biome limit that keeps them split.
tags: [kit, refactor]
status: draft
lifecycle: backlog
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Split the kit's oversized modules

## Overview

`src/kit/workspace/session.ts` (about 9,000 lines) and `server.ts` (about 5,400)
are too big to work in: parallel branches collide in them, an agent reads them
in slices, and every port from Story Studio's kit is a rewrite by hand into one
file. Story Studio has already split the same kit. This feature ports their
split, adapted where our code differs: `session.ts` into parts under
`workspace/session/` behind the `WorkspaceSession` facade, `server.ts` into
closure parts under `workspace/daemon/`, and `WorkspaceShell.tsx`,
`DocumentPane.tsx`, `protocol.ts` and `verbs.ts` along Story Studio's W, P, R
and V seams. A 1,200-line Biome limit with frozen overrides, a tier test and a
start-path test keep it split.

The research, the module maps and the step table are in
[the write-up](../../items/kit-split-oversized-modules/write-up.md). Cole
approved all eight of its decisions on 2026-11-24 (its Decided section).

## Scope

**In:** the steps G0, G1, S2 to S11, D1 to D9 (no D8), R1, V1 to V4, W1 to W5
and P1 to P6, one item each (`kit-split-<step>`), plus
[cli-yaml-off-start-path](../../items/cli-yaml-off-start-path.md) (decision 6).

**Out:** the bounty, grapevine, mind-mapper and imago files, and
`ContextSidebar.tsx`. They stay whole under frozen overrides and are split the
first time a change would push one past its number.

## Rules for every step

- Behaviour-preserving, and lands alone as its own commit or branch.
- No test's expectations change. A test changes only where it reached into
  private state that moved, and then only to reach the same state at its new
  address.
- The gate passes (`bun run gate`, plus the kit typecheck G0 adds).
- Two lanes at most. S3, S9, D2 and D4 run alone, and S9 and D4 wait for a green
  Linux CI before the next step. The daemon steps (D2 on) wait for S11.
- Step names follow Story Studio's numbering, so "after S7" means the same tree
  in both repos.

## Related Documents

- [Splitting the kit's oversized modules](../../items/kit-split-oversized-modules/write-up.md)

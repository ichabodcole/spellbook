---
type: cycle
title: Workspace daemon
description:
  Port Story Studio's workspace daemon into src/kit and run a flagged second
  Scriptorium on it, the first of five workspace-stack cycles.
tags: [kit, scriptorium, story-studio]
status: stable
lifecycle: planned
started: 2026-10-14
appetite:
  Stop when the flagged Scriptorium daemon and CLI run on src/kit/workspace with
  E65's daemon half, and the gate and acc are green on the branch; anything that
  needs the surface or the wiki layer is filed for later cycles.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-14 }
---

# Workspace daemon

## Why now

The [kit foundation](./2026-10-kit-foundation.md) landed on 2026-10-13. The
workspace stack comes next. The
[port-shape write-up](../items/workspace-stack-port-shape/write-up.md) splits it
into five cycles, daemon first, on a second Scriptorium built on the kit behind
`SCRIPTORIUM_KIT`. Cole ruled the base (`027d7a3`, without Story Studio's
workspace model) and the four open questions on 2026-10-13 and 2026-10-14.
There's no release until the whole stack is done, so the shipped Scriptorium is
untouched until the cutover cycle.

## Scope

Run `kit-port-workspace` first, then the next three in parallel, then the
flagged Scriptorium:

- **[item/kit-port-workspace](../items/kit-port-workspace.md)**: the workspace
  daemon in `src/kit/workspace`.
- **[item/kit-workspace-manifest-guard](../items/kit-workspace-manifest-guard.md)**:
  the kit refuses a manifest that isn't its own.
- **[item/kit-links-differential](../items/kit-links-differential.md)**: one
  link extractor, held to Scriptorium's tests.
- **[item/kit-workspace-e65-daemon](../items/kit-workspace-e65-daemon.md)**:
  E65's daemon half in the kit.
- **[item/scriptorium-on-kit-daemon](../items/scriptorium-on-kit-daemon.md)**:
  the flagged Scriptorium daemon and CLI.

Out of scope, deliberately:

- the wiki layer and session migration (cycle 2);
- the chat and context panes (cycle 3);
- the document pane and the map (cycle 4);
- the shell and the cutover (cycle 5);
- Story Studio's new workspace model.

## Outcome

_Written at close, not before — and for an `abandoned` cycle too._

[What shipped. What was cut, and why. What carried over to the next cycle: each
item still open, and the cycle it joined. What was learned that will change how
the next cycle is scoped. For an `abandoned` cycle, what was falsified: the
assumption that stopped it. Two paragraphs is usually enough; the point is that
a reader six months from now can tell what happened without reading every
session.]

## Sessions

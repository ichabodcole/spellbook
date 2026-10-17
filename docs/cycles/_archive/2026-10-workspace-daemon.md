---
type: cycle
title: Workspace daemon
description:
  Port Story Studio's workspace daemon into src/kit and run a flagged second
  Scriptorium on it, the first of five workspace-stack cycles.
tags: [kit, scriptorium, story-studio]
status: stable
lifecycle: closed
started: 2026-10-14
appetite:
  Stop when the flagged Scriptorium daemon and CLI run on src/kit/workspace with
  E65's daemon half, and the gate and acc are green on the branch; anything that
  needs the surface or the wiki layer is filed for later cycles.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-14 }
closed: 2026-10-14
---

# Workspace daemon

## Why now

The [kit foundation](./2026-10-kit-foundation.md) landed on 2026-10-13. The
workspace stack comes next. The
[port-shape write-up](../../items/workspace-stack-port-shape/write-up.md) splits
it into five cycles, daemon first, on a second Scriptorium built on the kit
behind `SCRIPTORIUM_KIT`. Cole ruled the base (`027d7a3`, without Story Studio's
workspace model) and the four open questions on 2026-10-13 and 2026-10-14.
There's no release until the whole stack is done, so the shipped Scriptorium is
untouched until the cutover cycle.

## Scope

Run `kit-port-workspace` first, then the next three in parallel, then the
flagged Scriptorium:

- **[item/kit-port-workspace](../../items/kit-port-workspace.md)**: the
  workspace daemon in `src/kit/workspace`.
- **[item/kit-workspace-manifest-guard](../../items/kit-workspace-manifest-guard.md)**:
  the kit refuses a manifest that isn't its own.
- **[item/kit-links-differential](../../items/kit-links-differential.md)**: one
  link extractor, held to Scriptorium's tests.
- **[item/kit-workspace-e65-daemon](../../items/kit-workspace-e65-daemon.md)**:
  E65's daemon half in the kit.
- **[item/scriptorium-on-kit-daemon](../../items/scriptorium-on-kit-daemon.md)**:
  the flagged Scriptorium daemon and CLI.

Out of scope, deliberately:

- the wiki layer and session migration (cycle 2);
- the chat and context panes (cycle 3);
- the document pane and the map (cycle 4);
- the shell and the cutover (cycle 5);
- Story Studio's new workspace model.

## Outcome

**What shipped.** All five items shipped. Story Studio's workspace daemon now
lives in `src/kit/workspace`, from `027d7a3` plus the agreed picks. Every test
runs under a scratch home. The kit refuses a manifest that isn't its own, and
its links code is held to Scriptorium's tests: every difference takes the kit's
rule, except relation names, which both kits now lowercase. E65 follows Story
Studio's `85a319e`, plus a one-ask guard. With `SCRIPTORIUM_KIT=1`, a second
Scriptorium runs on the kit, and the default path is byte-identical.

**What was cut.** Spellbook's own E65 daemon half (`d1ca788d`) was cut in favour
of Story Studio's. Converging cost one revert and left one wire for both apps.
The guard's `about.ask` marker is already superseded: Cole ruled that the kit's
buttons get their own `via` values, so the guard moves to `via: "ask"` when
Story Studio's via-and-refs daemon half (`bbc54fd`) is ported.

**Carried over.** No item stayed open. The via-and-refs port goes to the next
cycle, ahead of the wiki layer (cycle 2) or with it. Seven findings were filed
to triage; see the session.

**What was learned.**

- **Built bundles.** A bundler's `NODE_ENV` define silently removed the kit's
  safety guards from every built bundle. Any guard that must hold in `dist/`
  needs a test that builds it.
- **Reviews.** Both finalize reviews found correct but unpinned invariants. In
  this codebase a planted regression is the review step that finds the most.
- **Parallel work.** Two agents building the same feature in parallel (E65) cost
  a revert. Next cycle, check `kit-parity` for in-flight Story Studio work
  before starting an item that ports back.

## Sessions

- cycle/workspace-daemon (landed 2026-10-14):
  [Workspace daemon — 2026-10-14](../../features/workspace-kit/sessions/2026-10-14-workspace-daemon.md)

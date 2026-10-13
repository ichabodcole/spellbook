---
type: cycle
title: Kit foundation
description:
  Port Story Studio's kit foundation (lib, wire, theme, ui, cli) into
  Spellbook's kit, with Scriptorium as its first adopter.
tags: [kit, scriptorium, story-studio]
status: draft
lifecycle: planned
started: 2026-10-13
appetite:
  Stop when Scriptorium's surface runs on the ported src/kit/ui and every
  spell's acc passes with per-verb help; anything that turns into a
  workspace-layer question is filed for the next cycle, not stretched into this
  one.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-13 }
---

# Kit foundation

## Why now

Cole approved [Workspace Kit](../features/workspace-kit/feature.md) on
2026-10-13: Spellbook's kit and Scriptorium re-base on Story Studio's kit. The
foundation comes first because every spell can use it and the workspace stack is
built on it. Scriptorium adopts it in this cycle, so the stack starts next cycle
on a foundation that has already been used.

## Scope

The feature's First Cycle, one item per step. The Atlas comparison moved to
after the shell port (Cole, 2026-10-13):

- **[item/kit-port-lib-wire](../items/kit-port-lib-wire.md)** — `lib` and
  `wire`, merged with Spellbook's ahead-of-kit fixes.
- **[item/kit-port-theme-ui](../items/kit-port-theme-ui.md)** — the primitives,
  the theme and the happy-dom harness.
- **[item/kit-primitives-rule](../items/kit-primitives-rule.md)** — the
  house-style rule moves into the kit, with the opt-out.
- **[item/scriptorium-surface-on-kit-ui](../items/scriptorium-surface-on-kit-ui.md)**
  — Scriptorium's surface on `src/kit/ui`.
- **[item/kit-per-verb-cli-help](../items/kit-per-verb-cli-help.md)** — per-verb
  help, with an acc re-run.

Out of scope, deliberately: the workspace stack (`workspace`, `chat`, `context`,
`document`, `shell`), which is next cycle, and with it E71, the evolutions, the
`via`/`refs` change, the Atlas comparison and the open questions about profiles
and the Atlas items. Other spells move onto the kit only when they opt in. The
planned [reply-shape leftovers](./2026-09-reply-shape-leftovers.md) stay
planned.

## Outcome

_Written at close, not before — and for an `abandoned` cycle too._

[What shipped. What was cut, and why. What carried over to the next cycle: each
item still open, and the cycle it joined. What was learned that will change how
the next cycle is scoped. For an `abandoned` cycle, what was falsified: the
assumption that stopped it. Two paragraphs is usually enough; the point is that
a reader six months from now can tell what happened without reading every
session.]

## Sessions

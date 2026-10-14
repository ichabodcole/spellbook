---
type: cycle
title: Kit foundation
description:
  Port Story Studio's kit foundation (lib, wire, theme, ui, cli) into
  Spellbook's kit, with Scriptorium as its first adopter.
tags: [kit, scriptorium, story-studio]
status: stable
lifecycle: closed
started: 2026-10-13
appetite:
  Stop when Scriptorium's surface runs on the ported src/kit/ui and every
  spell's acc passes with per-verb help; anything that turns into a
  workspace-layer question is filed for the next cycle, not stretched into this
  one.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-13 }
closed: 2026-10-13
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

**Shipped:**

- **The kit foundation, in `src/kit`:**
  - `lib`'s `cn` and `storage`;
  - `wire`'s drain skip, exit codes, `Host` guard, session pointers and
    `startDaemon`;
  - the theme with Spellbook's palette;
  - the Base UI primitives, with a happy-dom harness and a recipe-conflict
    guard;
  - per-verb CLI help in the registry.
- **The primitives rule, moved into the kit,** with Cole's opt-out.
- **Scriptorium on the kit's primitives,** pixel-identical, verified over 52
  screenshot pairs.

Every item passed a no-stake verification, and the branch passed a two-reviewer
finalize review after one fix round. The gate ran 3,483 tests, and acc is
conformant on all nine spells.

**Cut:** the Atlas/Scriptorium comparison, moved to after the shell port. Once
the primitives converge on the kit and the shell brings Atlas's layout by
default, a before-the-port look would have predicted what the port settles. It
stays open as `kit-atlas-scriptorium-comparison`.

**Not in Scope, and what changed how the next cycle is scoped:**

- **Story Studio's kit relies on tailwind-merge without having it.** Its recipes
  clashed with their own sizes. The kit now forbids base/variant clashes, and
  Story Studio has the fix.
- **A raw `--help` scan dropped commands at exit 0.** Two narrow fixes leaked
  before "let the parser decide" held. Ported code that interprets input needs a
  differential test against the base, not shape-by-shape fixes.
- **Test files under `src/kit` ship classes into every spell's CSS,** because
  Tailwind scans them.

Seven follow-ups are filed, none of them blocking:

- `kit-dom-harness-gaps`
- `kit-primitives-css-opt-in`
- `declare-micromark-gfm`
- `kit-discovery-pointer-hardening`
- `kit-cli-registry-followups`
- `origin-ward-same-server`
- `scriptorium-cn-semantics`

The next cycle is the workspace stack. It gets the evolutions listed in
[Workspace Kit](../features/workspace-kit/feature.md), and Story Studio's links
port-back may already be there when it starts.

## Sessions

- cycle/kit-foundation (landed 2026-10-13)

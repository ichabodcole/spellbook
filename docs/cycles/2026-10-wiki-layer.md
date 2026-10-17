---
type: cycle
title: Wiki layer
description:
  "Give the kit daemon the four slots Scriptorium's wiki layer needs, and move
  the flagged Scriptorium's wiki verbs and session migration onto them: the
  second of five workspace-stack cycles."
tags: [kit, scriptorium, story-studio]
status: stable
lifecycle: active
started: 2026-10-16
appetite:
  Stop when the flagged Scriptorium's CLI covers every shipped wiki verb through
  kit slots, a dry-run migration converts copies of Cole's real sessions, and
  the gate and acc are green; anything that needs a pane is filed for cycle 3.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-16 }
---

# Wiki layer

## Why now

The [workspace daemon](./2026-10-workspace-daemon.md) cycle landed on
2026-10-14. A flagged Scriptorium now runs on the kit's daemon, but without the
wiki layer it can't do what the shipped one does. The
[port-shape write-up](../items/workspace-stack-port-shape/write-up.md) puts the
wiki layer and the session migration here, between the daemon and the panes,
because both are daemon work and the panes (cycle 3) will need them.

Story Studio has nothing in flight on these slots (kit-parity message 42), so we
build each one here and offer it back.

## Scope

Run `kit-port-via-refs` first, so every later item builds on the current wire.
The four slot items can then run in parallel. The verbs item follows the slots
it uses.

- **[item/kit-port-via-refs](../items/kit-port-via-refs.md)**: the workspace
  half of Story Studio's `bbc54fd` and `4e6d4d4`; the one-ask guard keys on
  `via: "ask"`.
- **[item/kit-link-edges-slot](../items/kit-link-edges-slot.md)**: app-supplied
  edges with a kind, and a wiki-form resolver; Scriptorium's frontmatter
  references on them.
- **[item/kit-tree-scan-filter](../items/kit-tree-scan-filter.md)**: an app
  filter on the tree scan; Scriptorium's `hide` and `unhide`.
- **[item/kit-set-promotion](../items/kit-set-promotion.md)**: promote an entry
  and keep its id; Scriptorium's `make-set` and folder creation.
- **[item/scriptorium-no-default-workspace](../items/scriptorium-no-default-workspace.md)**:
  the kit lets an app declare no home workspace, and nothing writes a new file
  to a place the caller didn't name.
- **[item/kit-manifest-migrate-hook](../items/kit-manifest-migrate-hook.md)**: a
  whole-manifest migrate before restore; Scriptorium's converter, dry-run on
  copies of real sessions.
- **[item/scriptorium-kit-wiki-verbs](../items/scriptorium-kit-wiki-verbs.md)**:
  `meta`, `find`, `info`, `forget`, trust tiers, the move plan as a daemon
  command, and the remove verbs.

Out of scope, deliberately:

- **Any surface.** The confirm dialog for a move plan, "ask for a location" when
  nothing is selected, and drawing the map all wait for the panes (cycles 3 and
  4).
- **Story Studio's `0ff5698`.** It touches only the context and document panes,
  so it comes with cycles 3 and 4.
- **Layout in daemon prefs.** That is cycle 5. Story Studio's
  `kit-prefs-sessions` item (two sessions saving `prefs.json` at once can lose a
  write) should be settled before then.
- **Undo for setting the workspace.** With no default workspace, the kit path
  doesn't need it.
- **The shipped Scriptorium.** It stays as it is until the cutover, including
  [scriptorium-mixed-link-line-quadratic](../items/scriptorium-mixed-link-line-quadratic.md),
  which the cutover closes.

## Outcome

_Written at close, not before — and for an `abandoned` cycle too._

[What shipped. What was cut, and why. What carried over to the next cycle: each
item still open, and the cycle it joined. What was learned that will change how
the next cycle is scoped. For an `abandoned` cycle, what was falsified: the
assumption that stopped it. Two paragraphs is usually enough; the point is that
a reader six months from now can tell what happened without reading every
session.]

## Sessions

- cycle/wiki-layer (open)

# Grapevine watch — human parity on channel actions, and hiding archived channels

**Filed:** 2026-09-05 · **From:** Cole, while poking the rewritten watch surface
on `feat/grapevine-conversion` · **Type:** UX change (new behaviour — NOT for
the conversion branch, whose contract is behaviour-faithful)

## The ask

1. **A right-click context menu on each channel in the rail** so a human can do
   what an agent can do: archive, unarchive, delete — "the same functionality an
   agent has, in the UI."
2. **Hide archived channels from the rail** — they accumulate and take visual
   attention.

## The parity gap, measured

The daemon exposes these channel-lifecycle routes (`daemon.ts` header):

| route                            | agent (CLI) | human (watch surface today)   |
| -------------------------------- | ----------- | ----------------------------- |
| `DELETE /channels/:name`         | yes         | yes — the 🗑 + confirm dialog |
| `POST /channels/:name/archive`   | yes         | **no**                        |
| `POST /channels/:name/unarchive` | yes         | **no**                        |
| `POST /channels` (create)        | yes         | **no**                        |
| `PUT /channels/:name/topic`      | yes         | **no**                        |

The surface's only mutating rail call is the delete
(`src/grapevine/surface/state/useGrapevine.ts:220`). Archive and unarchive are
the ask; create and topic are the same shape and worth deciding on in the same
pass (in or out — say which).

## Sequencing (agreed with Cole 2026-09-05)

1. Land `feat/grapevine-conversion` as the faithful rewrite (its inventory is
   the baseline this work is measured against).
2. `feat/grapevine-shadcn` — real `components.json` + registry primitives.
   **This item informs which primitives that branch installs:** `ContextMenu`
   (base flavor; mind-mapper already vendors a hand-rolled one), and a control
   for the archived filter (`Switch`, or a `ToggleGroup` "all / active").
3. `feat/grapevine-ux` — this item. The behaviour inventory gains rows for every
   new action, and the rows for "archived rows are always visible" are
   deliberately amended.

## Notes for the build

- Archive/unarchive on the CURRENT channel changes the composer (archived note
  vs composer) — the inventory already has the row for the agent-driven case;
  the human-driven case must hit the same state.
- Hiding archived channels must not hide the one you are on (URL hash names it).
- The delete confirm is already an `AlertDialog`; archive probably needs none
  (reversible), delete keeps it.

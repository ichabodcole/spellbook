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
3. **Create a channel and edit a channel's topic from the surface** (ruled in by
   Cole, 2026-09-05) — full parity with the agent's lifecycle verbs.

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
(`src/grapevine/surface/state/useGrapevine.ts:220`). **All four missing rows are
in scope** — archive, unarchive, create, topic edit.

## Sequencing (agreed with Cole 2026-09-05)

1. Land `feat/grapevine-conversion` as the faithful rewrite (its inventory is
   the baseline this work is measured against).
2. `feat/grapevine-shadcn` — real `components.json` + registry primitives.
   **This item informs which primitives that branch installs:** `ContextMenu`
   (base flavor; mind-mapper already vendors a hand-rolled one), and a control
   for the archived filter (`Switch`, or a `ToggleGroup` "all / active"); a
   `Dialog` + `Field`/`Input` for create; an inline edit or `Popover` for the
   topic (the header already shows it).
3. `feat/grapevine-ux` — this item. The behaviour inventory gains rows for every
   new action, and the rows for "archived rows are always visible" are
   deliberately amended.

## Notes for the build

- Archive/unarchive on the CURRENT channel changes the composer (archived note
  vs composer) — the inventory already has the row for the agent-driven case;
  the human-driven case must hit the same state.
- Hiding archived channels must not hide the one you are on (URL hash names it).
- Topic edit appends a `kind:"topic"` message with a `from` — the human's alias
  is the natural `from`, so the edit should require a joined identity (or fall
  back to the persisted default alias from `/identity`).
- Create must handle the daemon's 409 for an archived name of the same channel —
  offer unarchive instead.
- The delete confirm is already an `AlertDialog`; archive probably needs none
  (reversible), delete keeps it.

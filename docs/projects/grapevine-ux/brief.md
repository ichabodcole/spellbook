# Grapevine UX — the brief

**Created:** 2026-09-05 · **Author:** Cole Reed + Claude Code (orchestrator) ·
**Mode:** loose — a brief, not a plan; this file doubles as the proposal.
**Branch:** `feat/grapevine-ux`, cut from develop at the shadcn landing
(`de4de84`). **Source:**
[the backlog item](../../backlog/2026-09-05-grapevine-watch-human-parity-and-archive-hiding.md).

## Why

The watch surface lets a human do one lifecycle thing to a channel: delete it.
The agent, through the CLI, can create, set a topic, archive, unarchive and
delete. Cole's ask: **the same functionality an agent has, in the UI** — and a
way to **hide archived channels**, which accumulate and take visual attention.

This is the third grapevine branch today and the first that **changes behaviour
on purpose.** The conversion was behaviour-faithful; the shadcn branch was
behaviour-identical. Both were verified against the 72-row inventory. This
branch **amends the inventory**: every new action gets rows, and the rows that
said "archived rows are always visible" are deliberately rewritten. The
inventory is still the contract; it just moves.

## The mission

Six additions to the watch surface, all composing registry primitives:

1. **Right-click context menu on every rail row** (`ContextMenu`, base flavour):
   _Edit topic_, _Archive_ / _Unarchive_ (whichever applies), _Delete…_. Delete
   keeps its `AlertDialog` confirm; archive and unarchive need none
   (reversible). The current channel's row gets the same menu.
2. **Create a channel** — a `+` button in the rail header (`Button` icon
   variant, `data-icon`) opening a `Dialog` with a `Field` for the name and an
   optional `Field` for the topic; Enter submits. The daemon returns **409 for
   an archived name** — the dialog must say so and offer _Unarchive instead_,
   which unarchives and navigates. On success navigate to the new channel
   (`#name`).
3. **Edit the topic inline** — clicking the topic line in the header turns it
   into an `Input`; Enter commits (`PUT /channels/:name/topic` with `from` = the
   joined alias, or the persisted default alias from `/identity` if lurking; if
   neither exists, the edit is disabled with a tooltip saying to join first);
   Escape cancels; blur cancels. The context menu's _Edit topic_ focuses the
   same input. Also disabled on an archived channel (the daemon will 409).
4. **Hide archived channels** — a `Switch` labelled _Show archived_ in the rail
   header, default **off**, persisted in `localStorage` under a
   `grapevine:show-archived` key (the state module owns the key, like the
   alias). **The current channel is always shown even when archived** (the URL
   hash names it; hiding it would strand the user).
5. **Archive/unarchive on the current channel** must swap the composer for the
   archived note and back, exactly as the agent-driven case already does (the
   inventory's rows cover the agent path; the human path must land in the same
   state — the rail poll is the source of truth, do not optimistically mutate).
6. **Every action is also reachable without the mouse**: the rail rows are
   focusable, the context menu opens on the keyboard's menu key / Shift+F10, the
   create dialog and topic input are tabbable. The old page's Tab order is the
   floor.

**Rulings (Cole, 2026-09-05):** all five lifecycle verbs in scope; the `+`
button in the rail header for create; click-to-edit topic in the header, with
the context menu as a second path; a `Switch` for archived, remembered per
browser, current channel always visible.

**House principle that applies:** the surface's controls are shortcuts for acts
the agent already performs through the same daemon routes. No new daemon route,
no new message kind. If an action needs something the daemon does not expose,
stop and report — the backend is out of scope.

## Technical direction

- **Primitives:** `bunx --bun shadcn@latest add context-menu dialog switch` from
  `src/grapevine/` (the skill's probe fails from the repo root — run it there;
  see the shadcn project's brief). `tooltip` if the disabled-topic hint needs
  one. Nothing hand-rolled where a registry primitive exists; the `shadcn`
  skill's Critical Rules apply (Field/FieldGroup in the create dialog;
  DialogTitle; `data-icon`; `gap-*`; `size-*` except the kit-styling ward's
  `size-2` sentinel).
- **State:** the mutating calls (`POST /channels`, `PUT …/topic`,
  `POST …/archive`, `POST …/unarchive`) go in the hook next to the existing
  delete; the pure parts (the show-archived key, the visible-rows filter with
  the current-channel exception, the 409 → "unarchive instead" mapping, the
  `from` resolution for a topic edit) go in `surface/state/` with tests. The
  filter rule is exactly the kind of thing a unit test should pin.
- **Inventory:** amend
  `docs/projects/grapevine-conversion/behaviour-inventory.md` in place — it is
  the living contract for this surface, not the conversion's artefact. New rows
  for each action, each state (menu open, dialog open, 409, disabled topic,
  hidden archived), and each keyboard path. Rewrite the archived-visibility rows
  and mark them _amended 2026-09-05 (UX branch)_.
- **Styling:** tokens and L1 aliases as they are; grow the alias block only for
  names the three new primitives consume. `source(none)` + `@source "./"` stay.
- **Verification:** drive every new row in both modes (type, don't fill; the
  fixed-port proxy from the first load; scoped `GRAPEVINE_HOME`); confirm the
  agent path and the human path land in the same state by doing each action once
  from the CLI and once from the UI and comparing the rail and header;
  screenshots of every new state; `bun run gate` unpiped; `dist-check`; the
  `ward` skill (this is a spell revision WITH new features — the `V1.x` banner
  and SKILL.md's `/watch` paragraph are owed an update, and the fresh-agent
  scenario re-run rule applies; the ward will say).
- **Conventions:** biome before every commit; story chapters (primitives + state
  → context menu + archive/unarchive → create → topic → hide archived →
  inventory + SKILL.md + wards); trailers; no push, no merge.

## Records

- `docs/projects/grapevine-ux/decision-log.md` — live.
- `docs/projects/grapevine-ux/ux-journal.md` — the process, for the agent who
  adds human parity to bounty or digestify next: what a "same as the agent"
  action needs from the daemon, how the inventory was amended, every gotcha.
- `docs/projects/grapevine-ux/sessions/2026-09-05-human-parity.md` at the end.

## Done means

- All six additions work in both modes, by mouse and keyboard.
- Agent path and human path land in the same state for every action.
- The inventory is amended and every new row is driven or explained.
- SKILL.md and the `V1.x` banner say what the surface now does.
- Gate green, dist-check green, wards run, records written.

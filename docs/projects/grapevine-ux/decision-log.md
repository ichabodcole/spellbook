# Grapevine UX — decision log

## 2026-09-05 — orchestrator, with Cole

- **Create: a `+` button in the rail header → Dialog.** Not taken: context menu
  on the rail's empty space only (undiscoverable).
- **Topic: click-to-edit inline in the header, plus _Edit topic_ in the context
  menu.** Not taken: Dialog-only via the menu (header stays read-only).
- **Archived filter: a Switch "Show archived", default off, remembered in
  localStorage; the current channel always visible.** Not taken: an all/active
  toggle group that resets every load.
- **Scope: all five lifecycle verbs** (Cole ruled create and topic edit in
  earlier today) plus hiding.
- **No backend changes.** Every action maps to an existing daemon route; the
  surface's controls are shortcuts for acts the agent already performs.
- **The inventory is amended in place, not forked.** It is the surface's living
  contract; the conversion's copy would go stale the moment this lands.

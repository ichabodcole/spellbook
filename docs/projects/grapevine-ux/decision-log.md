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

## 2026-09-05 — implementing agent

- **`/identity` is fetched on every init (R1 amended).** The brief's `from` rule
  for a lurker's topic edit needs the persisted default alias even when a
  localStorage override exists, and the old page fetched `/identity` only when
  no override did. The fetch is one small GET per load; the pre-fill rule is
  unchanged (override wins). Not taken: fetching lazily on the first click of
  the topic line — the disabled state with its tooltip has to be known before
  the click, so the identity has to be known before it too.
- **_Edit topic_ on a non-current row parks an intent and switches channel.** A
  channel switch is a full reload (C3), so the request cannot survive in React
  state; it survives in `localStorage["grapevine:intent"]`, keyed by channel and
  consumed once on init. Not taken: a second topic editor (a Dialog) for other
  rows — the brief says the menu's _Edit topic_ focuses the same header input,
  and one editor is one set of rules. Not taken: disabling the item on
  non-current rows — an agent can `topic` any channel.
- **Shift+F10 is synthesised; the menu key is native.** Measured: Chrome on
  macOS fires a native `contextmenu` event for the ContextMenu key and none for
  Shift+F10 (0 events through Playwright's key press). The row's trigger gets a
  keydown handler that dispatches a `contextmenu` event at the row, so the
  brief's "menu key / Shift+F10" both open the same Base UI menu. Not taken: a
  visible "⋯" button per row (a fourth stop per row in the Tab order).
- **The disabled topic line is `aria-disabled`, not `disabled`.** A `disabled`
  button is unfocusable and swallows pointer events, so the tooltip that says
  _why_ could never open (the shadcn docs' span-wrapper workaround trips biome's
  `noNoninteractiveTabindex`). `aria-disabled` keeps it in the Tab order and
  hoverable; its click does nothing.
- **The menu item reads _Delete…_; the dialog still says _Close channel_.** The
  brief names the item; C11's confirm text is verbatim from the old page and the
  CLI verb is `close`. Left as is; if Cole wants one word, it is the dialog's,
  and that is a C11 amendment.
- **The `+` carries no `data-icon`.** The brief's parenthetical says
  `data-icon`; the skill's icon rule reserves `data-icon="inline-start|end"` for
  an icon beside text, and the button recipe's `has-data-[icon=…]` arms only
  adjust padding on text sizes. An icon-only `size="icon-xs"` button with a bare
  `<PlusIcon />` is the recipe's own shape.
- **One typography override, named:** the switch's `FieldLabel` takes
  `text-xs font-normal text-ink-dim` — the rail is an 11–12 px column and a 14
  px medium label reads as a heading in it. It is a call-site override on a
  Label, which the skill's styling rule discourages; the alternative (an sr-only
  label and a tooltip) hides the one word Cole asked to see.
- **No backend change, and one backend finding reported, not fixed:** the
  daemon's `PUT /channels/:name/topic` has no archived check — only the CLI's
  `topic` verb refuses (through its `POST /channels` 409). The surface disables
  the edit on an archived channel itself, so the human path matches the CLI
  path; the raw route stays as it was.

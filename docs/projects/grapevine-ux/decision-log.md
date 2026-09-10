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
  daemon's `PUT /channels/:name/topic` has no archived check. _Corrected
  2026-09-06 after verify:_ neither does the CLI's `topic` verb — `cli.ts:405`
  discards its ensure's 409 (I had written that it refused; the verifier ran
  it). The surface disables the edit on an archived channel and cancels one an
  archive overtakes, so the human path is **stricter** than the agent path here;
  the route and the verb stay as they were, filed.

## 2026-09-06 — after the verify pass (implementing agent; orchestrator's defaults pending Cole)

- **A topic typed for an existing channel is set (a `PUT /topic` follows the
  create).** The dialog's `Set as <signer>.` hint is a promise, and the human
  who typed a topic meant it. Not taken: dropping the promise for existing names
  and saying "channel exists — opening" — quieter, but it makes the topic field
  mean two things depending on a fact the human cannot see before Enter. Note
  the CLI's `open --topic` does NOT clobber an existing topic; the dialog is now
  the `open` + `topic` pair, not `open` alone.
- **The delete act has one name: _Close channel…_** (menu item), matching the
  dialog's title/button and the CLI verb `close`. Orchestrator's default,
  reversible; Cole may prefer _Delete…_ for the menu, which is the brief's word.
- **ArrowDown does not wrap at the menu's bottom; ArrowUp wraps at the top.**
  Measured to be Base UI's own behaviour with the recipe's defaults (no
  `loopFocus` set by us); recorded in the inventory row, not fought.
- **A failed _Unarchive instead_ stays in the dialog** with the daemon's reason
  on the Name field. Not taken: a toast (no toast primitive installed; the field
  already has an error slot).

## 2026-09-06 — Cole, reviewing the surface

- **The per-row 🗑 is removed.** With _Close channel…_ in the context menu the
  hover-reveal button was a second path to the one destructive act. Not taken:
  keeping both (two affordances for delete, none for archive, was the wrong
  emphasis). Consequence: the rail's Tab order loses one stop per row (L6), and
  C10's driven arms now run through L1b.
- **Menu hover was invisible; _Edit topic_ swallowed the click.**
  `--color-accent` aliased the same token as `--color-popover`, so the
  highlighted item had the menu's own fill; now `edge`. And the menu item stayed
  enabled while the header's editor was disabled (lurking, no alias), so the
  click did nothing — the item now mirrors `topicEditState` and shows the short
  reason. Not taken: a toast on click (a disabled item that says why is the
  shadcn-shaped answer).

## 2026-09-06 — Cole, on the create-with-topic divergence

- **The dialog no longer replaces an existing topic.** Ruled by Cole after the
  divergence was put to him: the surface now does exactly what `POST /channels`
  does — set a topic only where none exists — which is what the CLI's
  `open --topic` has always done. The follow-up `PUT` is gone, and with it the
  one case where the two paths disagreed. _Edit topic_ is the act that replaces
  a topic, on both sides.
- **The promise is made conditional rather than dropped.** The Topic field's
  hint reads `Set as <signer>.` for a new name and
  `Set as <signer>, if this channel has no topic yet. Use Edit topic to replace one.`
  for a name the rail already lists — the dialog knows only what the rail lists,
  because `GET /channels` carries no topic. Not taken: fetching the channel on a
  name match to show its current topic (a request per keystroke, and it
  duplicates _Edit topic_); reporting after the fact from the create response
  (honest, but it tells the human only once the act is already done).

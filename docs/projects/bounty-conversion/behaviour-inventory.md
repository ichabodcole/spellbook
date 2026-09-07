# Bounty board surface — behaviour inventory

**Created:** 2026-09-06 · **Extracted from:**
`plugins/spellbook/skills/bounty/scripts/template.html` at `f4ee01b` (1,003
lines; styles 18–364, markup 366–582, script 584–1001) · **Purpose:** the oracle
for the React rewrite at `src/bounty/surface/`. One row per observable
behaviour, with the line range that implements it and how to drive it against a
real daemon.

**Fidelity ruling (Cole, 2026-09-06): behaviour-faithful, restyled.** Every row
below is a contract. The _look_ moves onto the kit token layer and shadcn
primitives, so colour/radius/spacing differences are expected and are NOT
regressions; anything in the **Behaviour** column that changes IS.

The **Driven** column is filled by the implementing agent and re-filled by a
verify agent who did not write the code. Values: `dev`, `release`, `both`,
`test` (covered by an automated cell — name it), or `not: <why>`. **A
`not: <why>` row is a claim the verifier will run** — five of grapevine's seven
fell.

---

## How to drive it

```sh
# a scoped daemon, so a live ~/.bounty daemon is never touched
export BOUNTY_HOME=$(mktemp -d)
CLI=plugins/spellbook/skills/bounty/scripts/cli.ts

bun $CLI open --title "the board" --no-open      # spawn; prints url + session_id
bun $CLI add "wire the seam" --status doing --owner cole --tag a,b --size S
bun $CLI add "second" --status doing --owner cole            # 2 in Doing -> wip cue
bun $CLI update <id> --notes "a long description"
bun $CLI block <id> --on <other>                 # blocked cue
bun $CLI unblock <id> --on <other>
bun $CLI message "hello"                         # a toast
bun $CLI state                                   # read-back
bun $CLI tail                                    # SSE event stream (JSONL)
bun $CLI close                                   # ends the session
```

**Mode.** The daemon is release iff
`plugins/spellbook/skills/bounty/dist/index.html` exists, else dev;
`SPELLBOOK_SURFACE_MODE=dev|release` overrides. Drive **both** — a dev daemon
with root deps present renders an identical-looking board.

**Drive the WebSocket, not just the CLI.** The board's whole wire is one socket
at `/ws`. For the failure rows (W-series) put a **fixed-port pass-through proxy
in front of the daemon from the FIRST page load** (playbook Gotcha 9) — the page
reconnects to its own origin forever, so a drive that starts on the daemon's own
port cannot induce a drop later without a fresh page. A `page.route` / `ws`
interceptor covers the malformed-frame and reconnect rows from one setup.

**Type, do not `fill()`.** Playbook R8: `fill()` fires one input event and
missed grapevine's one severe regression. Every input row below (`K4`, `C5`,
`M2`) must be driven **per-key with a delay**.

**Drag is a pointer SEQUENCE, not `dragTo()`.** A verifier's `dragTo()` is one
synthetic event. The real interaction is `dragstart` → several `dragover` →
`drop`, and rows D4/D5/D8/D10 only exist _between_ those events. Drive them as
`page.mouse.down()` → several `move()`s → `up()`, or dispatch the HTML5 drag
events individually with a shared `DataTransfer`. A row marked "sequence" below
is one a single-event drag cannot see.

---

## 1 · Wire — the WebSocket is the only channel

The page makes **no `fetch()` calls at all**. Its entire contract is one socket.

| ID  | Behaviour                                                                                                                               | `template.html` | Drive                                                                                                   | Driven |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- | ------ |
| W1  | Connects to `WS_URL` on boot; `conn` starts `""` (→ "connecting…")                                                                      | 974–976, 587    | load the board; before the socket opens the dot is grey and the label reads `connecting…`               |        |
| W2  | `onopen` → `conn = "connected"`                                                                                                         | 977             | load the board; dot goes warm-gold with a glow, label `connected`                                       |        |
| W3  | `onclose` → `conn = "closed"`; retries `connect()` after **1000 ms**, forever, unless `closedByServer`                                  | 978–981         | kill the proxy under a loaded page; watch the label flip to `closed`, then reconnect ~1 s after restart |        |
| W4  | `onerror` does nothing — the error is never shown; it surfaces only via the subsequent close                                            | 982             | point the page at a dead port; only `closed` ever appears, no error UI                                  |        |
| W5  | `onmessage` `JSON.parse` in try/catch — **a malformed frame is silently dropped** and the board keeps running                           | 983–985         | inject `not json` through the proxy; board unchanged, no console-visible break                          |        |
| W6  | `init` → title, `tasks` (copy), `document.title` set iff title non-empty, `restoreFailed`                                               | 941–954, 986    | any `open`; also re-sent on **every** reconnect and after every `task.move`                             |        |
| W7  | `task.add` → append, **deduped by id** (a second frame for the same id is ignored)                                                      | 955–958, 987    | `cli add`; then replay the same frame through the proxy — no duplicate card                             |        |
| W8  | `task.update` → find by id, **merge** the patch (`Object.assign` over a copy); unknown id silently ignored                              | 959–963, 988    | `cli update <id> --notes x`; then send a patch for a bogus id — nothing happens                         |        |
| W9  | `task.remove` → splice by id; unknown id silently ignored                                                                               | 964–968, 989    | `cli remove <id>`; then repeat — nothing happens                                                        |        |
| W10 | An **unknown `type`** is silently ignored (no else branch)                                                                              | 986–996         | inject `{"type":"nope"}` — board unchanged                                                              |        |
| W11 | `message` → toast with `msg.text`                                                                                                       | 990–994         | `cli message "hello"`                                                                                   |        |
| W12 | A `message` whose text **starts with `session ended:`** also ends the session (see T4)                                                  | 995             | `cli close`                                                                                             |        |
| W13 | `send()` is a **silent no-op** unless the socket is `OPEN` — clicks during a reconnect gap are dropped with no feedback                 | 801–804         | kill the proxy, click a status pill, restore the proxy: the click is **lost**, not replayed             |        |
| W14 | Outgoing verbs, exhaustively: `task.add`, `task.toggle`, `task.edit`, `task.move`, `task.remove`, `close`. No others.                   | 810–929         | `cli tail` while driving each affordance                                                                |        |
| W15 | A `task.move` makes the daemon rebroadcast a full `init` (not a patch) — the whole list re-renders, including the source column's shift | server.ts 1407  | drag a card between columns while tailing; the browser frame is `init`                                  |        |

## 2 · Page shell and first paint

| ID  | Behaviour                                                                                                                                          | `template.html` | Drive                                                                              | Driven |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- | ------ |
| P1  | `x-cloak` on `<body>` + `[x-cloak]{display:none!important}` — **nothing is painted until the client framework has booted**; no flash of raw markup | 59, 366         | throttle the network and reload: the page is blank, never a half-rendered skeleton |        |
| P2  | `color-scheme: dark` and a dark radial-gradient ground                                                                                             | 20, 22, 54      | load the board; form controls render dark                                          |        |
| P3  | Board title arrives in `<title>` (server substitution) and `init()` seeds `this.title = document.title`; the WS `init` frame then overrides it     | 6, 370, 631     | `open --title "x"`; the tab title and the `<h1>` both read `x`                     |        |
| P4  | Favicon at `/assets/favicon.png`                                                                                                                   | 7               | check the tab icon; `GET /assets/favicon.png` is 200                               |        |
| P5  | Session id rendered as a `<code>` in the header meta                                                                                               | 374             | compare the header text to `open`'s printed `session_id`                           |        |
| P6  | The header wordmark is `/assets/wordmark.webp`, alt text **"Bounty Board"**, 48 px tall                                                            | 62–64, 369      | the image loads (200) and has that alt                                             |        |
| P7  | Body gets `.ended` (opacity 0.6, **`pointer-events: none`**) when `ended` — the whole board becomes inert, not just dimmed                         | 363, 366        | `cli close`, then try to click a pill: nothing responds                            |        |
| P8  | `/assets/*` path-traversal guard: a `..` segment or a leading `/` is 404 JSON                                                                      | server.ts 1337  | `curl '<url>/assets/../server.ts'` → `{"error":"not found"}` 404                   |        |

## 3 · Restore-failed banner (b16)

| ID  | Behaviour                                                                                                                                                         | `template.html` | Drive                                                                                 | Driven |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- | ------ |
| B1  | Renders iff `restoreFailed` is truthy; `role="alert"`; **no dismiss control** — it must outlive a glance                                                          | 385–395         | `open --restore <path to a corrupt json>`; the banner is present and cannot be closed |        |
| B2  | Shows the fixed copy, then `restoreFailed.path` as `<code>` and `restoreFailed.reason` as italic muted text. Both are **text nodes** (untrusted-string XSS guard) | 386–394         | restore a file whose name contains `<b>`; the tag renders literally                   |        |
| B3  | `applyInit` sets it only when `msg.restoreFailed` is a **truthy object**; anything else (absent, `null`, a string) → `null`. `undefined` must read "not reported" | 950–953         | inject an `init` with `restoreFailed: "boom"` — no banner                             |        |
| B4  | It is a **boot fact**: it survives later task traffic, and it is re-asserted on every reconnect because `init` carries it every time                              | 946–949         | trigger a restore failure, add tasks, reconnect — banner still there                  |        |

## 4 · Filter bar (client-only view narrowing)

| ID  | Behaviour                                                                                                                                                          | `template.html`  | Drive                                                                                                  | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------- | --- |
| F1  | The whole bar renders **iff** `boardTags().length                                                                                                                  |                  | boardOwners().length` — a board with no tags and no owners has no filter bar at all                    | 401    | fresh board: no bar. `add x --tag a`: bar appears |     |
| F2  | `tags` facet label renders iff there are tags; `owners` label iff there are owners; a 1 px separator **only when both** facets are non-empty                       | 403–419          | a tag-only board has no separator; add an owner and it appears                                         |        |
| F3  | Chips are the **union** of what is on the board and what is currently active, sorted — so a filter for a tag that has since vanished stays individually toggleable | 664–673          | filter on tag `a`, `cli update` to remove tag `a` from every card; the `a` chip is still there, active |        |
| F4  | Owner chips render as `@name`; tag chips render bare                                                                                                               | 406–427          | visual                                                                                                 |        |
| F5  | Clicking a chip toggles that value in/out of its facet and persists immediately                                                                                    | 677–688          | click, reload, the chip is still active                                                                |        |
| F6  | `clear` button renders **iff** any filter is active; clears both facets and persists                                                                               | 428–430, 689–693 | click clear; chips deactivate; reload keeps them cleared                                               |        |
| F7  | **`cardPassesFilter`** — OR within a facet, AND across facets; an empty facet passes everything. ⚠ **MIRROR of `server.ts`'s `cardPassesFilter`** (b16 lockstep)   | 698–706          | tags `a`+`b` selected shows cards with either; adding an owner filter intersects                       |        |
| F8  | Non-matching cards are **hidden, not dimmed** — dim is card-aging's language                                                                                       | 80, 648–655      | filter; the cards are absent from the DOM                                                              |        |
| F9  | Column counts read the **same filtered call**, so they track only what is visible                                                                                  | 445, 648–655     | filter to one card; the Doing count reads 1, not the true total                                        |        |
| F10 | Persisted to `localStorage` under the key **`bounty:filters`** as `{tags:[],owners:[]}`                                                                            | 711–718          | read the key in devtools after a toggle                                                                |        |
| F11 | Persist is best-effort — **`catch {}`**: a private-mode or quota throw must never break the board                                                                  | 717              | stub `localStorage.setItem` to throw; toggling still filters                                           |        |
| F12 | Load on boot is best-effort — **`catch {}`** on both read and `JSON.parse`; a corrupt value leaves filters empty                                                   | 719–729          | write `bounty:filters = "{"` then reload; board is fine, no filters                                    |        |
| F13 | Load **validates shape**: only arrays are read, and only their `string` members survive                                                                            | 724–727          | write `{"tags":[1,"a"],"owners":"x"}`; only `a` becomes active                                         |        |
| F14 | Filters are **per-origin**, which includes the port — each board keeps its own                                                                                     | 708–710          | two boards on two ports; filters do not leak between them                                              |        |
| F15 | **View-only.** No filter ever touches the server; nothing is sent and no event is emitted                                                                          | 657–729          | `cli tail` while toggling every chip: zero frames                                                      |        |

## 5 · Columns and the add row

| ID  | Behaviour                                                                                                                                               | `template.html`   | Drive                                                                               | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- | ------ |
| C1  | Exactly four columns in this order with these labels: `todo`→"To do", `doing`→"Doing", `review`→"Review", `done`→"Done"                                 | 613–619           | visual                                                                              |        |
| C2  | Each column head shows its label and a count pill = the number of **visible** cards                                                                     | 443–446           | see F9                                                                              |        |
| C3  | Each column carries `data-status` and a distinct panel background for doing / review / done (todo uses the base panel)                                  | 135–137, 440      | visual                                                                              |        |
| C4  | Cards within a column render in **server order** — the daemon's `tasks` array order, never a client sort                                                | 448               | `cli add` three tasks; order matches `cli state`                                    |        |
| C5  | Each column has its own draft input bound to `drafts[status]`; **Enter** (default prevented) or the **Add** button submits                              | 526–534           | **type** per-key into Doing's input, press Enter                                    |        |
| C6  | `addTask` trims; an empty/whitespace title is a **silent no-op** (no frame, draft untouched)                                                            | 810–812           | press Enter on an empty input while tailing: zero frames                            |        |
| C7  | A successful add sends `task.add` with a client-minted id `u-` + 12 lowercase hex from `crypto.getRandomValues`, and clears **that** draft only         | 805–815           | add in Doing; the other three drafts keep their text                                |        |
| C8  | The new card appears only when the daemon echoes `task.add` — the surface never optimistically inserts                                                  | 813, 955–958      | block the socket, add: nothing appears                                              |        |
| C9  | The empty state shows iff **`tasks.length === 0`** — the _unfiltered_ count. Filtering every card away leaves four empty columns and **no** empty state | 343, 434, 539–542 | add one card, filter it out: columns are empty, the mascot copy does **not** appear |        |
| C10 | Empty-state copy: "No tasks yet — add one below, or wait for the agent to drop some in.", over `/assets/mascot-large.webp`                              | 539–542           | fresh board                                                                         |        |

## 6 · The card

| ID  | Behaviour                                                                                                                                                           | `template.html`    | Drive                                                                                       | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- | ------ |
| K1  | Card element carries `data-task-id` and `data-task-status`                                                                                                          | 452–453            | inspect the DOM                                                                             |        |
| K2  | **`blockedCount`** = ids in `blockedBy` that point at an **existing, not-done** task. A deleted or done blocker does not block. ⚠ MIRRORS `server.ts`'s `isBlocked` | 734–739            | `block a --on b`; move `b` to done → the cue clears                                         |        |
| K3  | Blocked card: a danger left rail + `opacity: .82` + a cue reading `⛔ blocked by N`. **Convention only — the card still moves** (no hard lock)                      | 200–205, 468–473   | block a card, then drag it: the move succeeds                                               |        |
| K4  | Title is `contenteditable`, `spellcheck="false"`. **`mousedown` sets the card's `draggable` to `"false"`** so a text selection is not a drag                        | 458–467            | press and drag _inside_ the title text: it selects text, the card does not move             |        |
| K5  | **Enter** in the title blurs (default prevented — no newline). **Escape** restores the original text, then blurs — no frame is sent                                 | 465–466            | type a change, press Escape while tailing: text reverts, zero frames                        |        |
| K6  | `onTitleBlur` restores `draggable="true"`, trims, and sends `task.edit {id,title}` **only when changed**                                                            | 842–854            | blur with no change: zero frames. Blur with a change: one `task.edit`                       |        |
| K7  | An **empty** title on blur reverts to the old text and sends nothing — the daemon would reject it and the visible text would diverge                                | 845–850            | select-all, delete, blur: old title returns, zero frames                                    |        |
| K8  | An empty title renders the placeholder `(empty — type a title)` in italic faint via `:empty::before`                                                                | 176–178            | requires an empty title in canonical state — daemon-rejected, so **markup-only**            |        |
| K9  | **`expectedMinutes`**: an `expect > 0` wins; else `size` maps `S:5 M:10 L:20`; else undefined (never aged). ⚠ MIRRORS `server.ts`                                   | 746–750            | `add x --size S --status doing`, wait 5 min (or inject `enteredStatusAt` in the past)       |        |
| K10 | **`staleInfo`**: doing **and** numeric `enteredStatusAt` **and** an expected time **and not blocked** **and** overdue ≥ 0. ⚠ MIRRORS `server.ts`'s `cardOverdue`    | 751–761            | an overdue sized doing card; then `block` it — the cue disappears                           |        |
| K11 | Stale card is dimmed to `.82` (**the same dim blocked uses**) with **no** rail, and shows `⏱ Doing Nm · Nm over`; both numbers are `max(1, round(ms/60000))`        | 210–215, 762–768   | overdue by 30 s → reads `1m over`, never `0m over`                                          |        |
| K12 | The stale cue **ticks live** off `now`, advanced by a 30 s interval — no user action needed                                                                         | 608, 636–639       | leave an overdue card on screen for 60 s; the minute count advances                         |        |
| K13 | **`ownersOverWip`**: owners with **≥ 2** cards in doing. Unowned doing cards are excluded and count toward nobody. ⚠ MIRRORS `server.ts`                            | 612, 775–785       | two owned doing cards for one owner → both cued; a third unowned doing card changes nothing |        |
| K14 | The wip cue shows **only on a doing card whose owner is over**; a todo/review/done card of the same owner never shows it                                            | 788–792            | give the same owner a todo card: no cue on it                                               |        |
| K15 | Wip label: `N in Doing — wrap one before pulling more`, where N counts **that owner's** doing cards (unfiltered by staleness or blocking)                           | 793–798            | three doing cards for one owner → `3 in Doing`                                              |        |
| K16 | Wip cue is a soft ice-blue line with a small dot, **no dim and no rail** — deliberately its own language, and it never blocks a move                                | 216–231            | visual; drag a cued card — it moves                                                         |        |
| K17 | Notes render **iff** `task.notes`; clamped to **2 lines**; `title` attribute "View / edit description"; **clicking the notes opens the detail modal**               | 232–240, 486–495   | click a 5-line note: the modal opens with the whole text                                    |        |
| K18 | Four status pills in `todo, doing, review, done` order; the current status pill is `.active` in its own colour                                                      | 497–504            | visual                                                                                      |        |
| K19 | Clicking a pill sends `task.toggle {id,status}`; clicking the **already-active** pill is a client-side **silent no-op** (no frame at all)                           | 816–819            | tail while clicking the active pill: zero frames                                            |        |
| K20 | The `⋯` detail button is **always present** and opens the modal even for a card with no notes                                                                       | 505–509            | a note-less card: `⋯` still opens the modal                                                 |        |
| K21 | `delete` sends `task.remove` **with no confirmation** — a single click destroys the card                                                                            | 510, 820–822       | click delete; the card is gone on the daemon's echo                                         |        |
| K22 | `delete` sits far right (`margin-left:auto`) and is the only action styled as a bare danger-hover text button                                                       | 254–259            | visual                                                                                      |        |
| K23 | Tags render **iff** `task.tags?.length`, as neutral chips, in the task's own tag order (**not** sorted), each a text node                                           | 512–519            | `add x --tag zebra,alpha`: chips read `zebra` then `alpha`                                  |        |
| K24 | Owner renders **iff** `task.owner`, as `@owner`, as plain metadata at the bottom — deliberately not a pill                                                          | 179–186, 520–522   | visual                                                                                      |        |
| K25 | Card body order is fixed: title, blocked cue, age cue, wip cue, notes, actions, tags, owner                                                                         | 458–522            | visual on a card with everything                                                            |        |
| K26 | Every user-supplied string on the card (title, notes, tags, owner) is a **text node**, never HTML                                                                   | 462, 487, 516, 521 | `add '<img src=x onerror=alert(1)>'`: renders literally                                     |        |

## 7 · Drag and drop ⚠ every row here is a pointer SEQUENCE

| ID  | Behaviour                                                                                                                                                                                                                                  | `template.html`     | Drive                                                                                                            | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | Every card is `draggable="true"` by default                                                                                                                                                                                                | 454                 | inspect                                                                                                          |        |
| D2  | `dragstart` **aborts** (`preventDefault`, no state) when the card's `draggable` attribute is not `"true"` — the K4 title-mousedown path                                                                                                    | 874–878             | **sequence**: mousedown inside the title, then drag: no `.dragging`, no move frame                               |        |
| D3  | A live drag adds `.dragging` (opacity .4, `cursor: grabbing`) to the source card                                                                                                                                                           | 163, 879            | **sequence**: hold mid-drag and inspect                                                                          |        |
| D4  | `dataTransfer.setData("text/plain", id)` is wrapped in **`try {} catch {}`** — a browser that refuses it still drags (the drop reads `this.dragId`, not the payload)                                                                       | 880                 | stub `setData` to throw; the drag still completes                                                                |        |
| D5  | `effectAllowed = "move"` on start, `dropEffect = "move"` on over                                                                                                                                                                           | 881, 892            | **sequence**; the cursor shows the move affordance                                                               |        |
| D6  | `dragover` is a **no-op unless a drag started in this page** (`if (!this.dragId) return`) — an external file drag is not previewed, and the drop is not prevented                                                                          | 889–890, 912–913    | drag a file from the desktop over a column: no `.drop-target`                                                    |        |
| D7  | On each `dragover`: **all** markers are cleared board-wide, then this column gets `.drop-target` (tinted bg + ice-blue border)                                                                                                             | 866–894             | **sequence**: move across two columns; only the one under the pointer is highlighted                             |        |
| D8  | The insertion marker is the **first non-dragging card whose vertical midpoint is below the pointer** → `.drop-before` (a 2 px top rule); if none and the column is non-empty, the **last** card gets `.drop-after`                         | 895–902             | **sequence**: hover the top half of card 2 → line above card 2; hover below the last card → line under it        |        |
| D9  | The dragged card itself is excluded from that computation (`:not(.dragging)`) — so a within-column drag indexes against the other cards only                                                                                               | 896, 916            | **sequence**: reorder within one column                                                                          |        |
| D10 | An empty column's list is an `empty-drop-zone` that grows a dashed ice-blue border **only while it is the drop target**                                                                                                                    | 167–168             | **sequence**: drag over an empty column                                                                          |        |
| D11 | `dragleave` clears this column's markers **only when `relatedTarget` is outside the column** — moving between two cards inside it does not flicker                                                                                         | 904–911             | **sequence**: move slowly across a card boundary; the highlight must not blink                                   |        |
| D12 | `drop` computes `index` = the first card index whose midpoint is below the pointer, else `cards.length` (append), and sends **one** `task.move {id,status,index}`                                                                          | 912–929             | **sequence** + tail: exactly one frame per drop                                                                  |        |
| D13 | `drop` clears every marker and `dragId` **before** sending                                                                                                                                                                                 | 926–928             | **sequence**: no marker survives the drop                                                                        |        |
| D14 | `dragend` clears `.dragging`, all markers, and `dragId` — including on an **aborted** drag (Escape, or a drop outside any column)                                                                                                          | 884–888             | **sequence**: start a drag, press Escape: card returns to normal, zero frames                                    |        |
| D15 | A drop **on the card's own slot** still sends `task.move`; the **daemon** suppresses it via `isNoOpMove` — no broadcast, no event                                                                                                          | 928 / server.ts 591 | **sequence** + tail: drop a card back on itself → a frame leaves the browser, **no** event on the tail           |        |
| D16 | A frame arriving **mid-drag** re-renders the list. The drop markers are imperative DOM classes on nodes the re-render may replace, so they can vanish under the pointer; `dragId` is component state and survives, so the drop still lands | 866–872, 941–968    | **sequence**: hold a drag and `cli add` from another shell; then complete the drop — it must still move the card |        |
| D17 | Nothing about a **blocked**, **stale** or **wip-cued** card prevents a drag                                                                                                                                                                | 199, 222            | **sequence**: drag a blocked card                                                                                |        |

## 8 · Detail modal

| ID  | Behaviour                                                                                                                                                                                              | `template.html`  | Drive                                                                                       | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------- | ------ |
| M1  | Opens from the `⋯` button **or** from clicking the notes; sets `detail = task` and buffers `detailNotes = task.notes ?? ""` (the task is not mutated)                                                  | 824–827          | open, type, cancel — the card's notes are unchanged                                         |        |
| M2  | Overlay + centred panel, `role="dialog"`, `aria-modal="true"`; the title is a **text node**                                                                                                            | 559–566          | inspect                                                                                     |        |
| M3  | The textarea **autofocuses** on the next tick, is `x-model`-bound, 7 rows, vertically resizable, placeholder "No description yet — add one…"                                                           | 284–290, 568–575 | open the modal and **type** immediately with no click — the keystrokes land in the textarea |        |
| M4  | Closes on **Cancel**, on **Escape** (a window-level listener), and on a click **on the overlay itself** — but not on a click inside the panel                                                          | 561–563, 577     | all three, plus a click on the panel that must _not_ close                                  |        |
| M5  | **Save** sends `task.edit {id, notes}` **only when the text changed**; `""` is a valid clear and IS sent when it differs                                                                               | 832–841          | save unchanged → zero frames; clear a note and save → one `task.edit` with `notes: ""`      |        |
| M6  | Cancel/Escape/overlay never send anything                                                                                                                                                              | 828–831          | tail while cancelling an edited buffer: zero frames                                         |        |
| M7  | `detail` holds the task object captured at open. `applyUpdate` **replaces** the array entry with a new object, so a concurrent update to the same task does **not** live-update the open modal's title | 832–841, 959–963 | open a modal, `cli update <id> --title new` from another shell: the modal title stays old   |        |
| M8  | Closing resets `detailNotes` to `""` — reopening always re-reads from the task                                                                                                                         | 828–831          | edit, cancel, reopen: the old text is back                                                  |        |

## 9 · Footer, toasts and session end

| ID  | Behaviour                                                                                                                                                  | `template.html`       | Drive                                                                             | Driven |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------- | ------ |
| T1  | Footer: an ambient 36 px `/assets/mascot.webp` at 35 % opacity on the left, a spacer, and a single primary **Close board** button on the right             | 314–335, 544–548      | visual                                                                            |        |
| T2  | **Close board** opens a native `confirm("Close this board? The agent can reopen it later from a snapshot.")`; only OK sends `{type:"close"}`               | 855–862               | cancel the dialog → zero frames; accept → one `close`                             |        |
| T3  | Toasts stack bottom-right, newest last, max-width 22 rem, fade-in; text is a **text node**                                                                 | 354–362, 550–554      | `cli message '<b>x</b>'` renders literally                                        |        |
| T4  | Each toast auto-dismisses after exactly **5000 ms**; there is **no** manual dismiss                                                                        | 932–938               | `cli message x`, time it                                                          |        |
| T5  | Toast ids come from a monotonic counter, so two identical texts are two toasts                                                                             | 932–937               | `cli message x` twice quickly: two toasts                                         |        |
| T6  | A `message` starting with `session ended:` sets `closedByServer` **and** `ended` — the board dims, goes `pointer-events: none`, **and stops reconnecting** | 969–972, 978–981, 995 | `cli close`: toast, dim, inert, and no reconnect attempts after the socket closes |        |
| T7  | The session-end toast is shown like any other toast — and then vanishes after 5 s, leaving only the dim as the explanation                                 | 994–995               | `cli close`, wait 6 s                                                             |        |

## 10 · Timers

| ID  | Behaviour                                                                                       | `template.html`  | Drive                                         | Driven |
| --- | ----------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------- | ------ |
| X1  | One 30 000 ms interval ticks `now` for the card-aging cues; cleared on teardown                 | 636–639, 644–646 | see K12                                       |        |
| X2  | One 5 000 ms timeout per toast                                                                  | 935–937          | see T4                                        |        |
| X3  | One 1 000 ms reconnect timeout per close, while `!closedByServer`                               | 980              | see W3                                        |        |
| X4  | **There is no polling.** No `fetch`, no `EventSource`, no visibility handler, no reload-on-hash | whole file       | watch the network panel for 60 s: only the WS |        |

## 11 · The b16 lockstep — mirrors that the rewrite must DELETE

`template.html` re-implements four tested `server.ts` helpers in Alpine because
an inline surface cannot import. **No test guards the drift.** The rewrite's job
is to import them from `plugins/spellbook/skills/bounty/shared/predicates.ts`,
not to port them.

| ID  | Mirror in `template.html`    | Canonical in `server.ts`                 | Guarded by                      | After the rewrite                             |
| --- | ---------------------------- | ---------------------------------------- | ------------------------------- | --------------------------------------------- |
| L1  | `cardPassesFilter` (698–706) | `cardPassesFilter` (205–212)             | `server.test.ts`                | imported from `shared/`                       |
| L2  | `staleInfo` (751–761)        | `cardOverdue` (183–204)                  | `server.test.ts`                | imported from `shared/`                       |
| L3  | `ownersOverWip` (775–785)    | `ownersOverWip` (275–289)                | `server.test.ts`                | imported from `shared/`                       |
| L4  | `expectedMinutes` (746–750)  | `expectedMinutes` (121–126)              | `server.test.ts`                | imported from `shared/`                       |
| L5  | `blockedCount` (734–739)     | `isBlocked` (133–139) — count vs boolean | `server.test.ts` (boolean only) | both from one `liveBlockerCount` in `shared/` |

## 12 · Silent branches — "this error is not shown" is a behaviour

| ID  | Silent branch                                                 | `template.html` | Row it belongs to |
| --- | ------------------------------------------------------------- | --------------- | ----------------- |
| Z1  | `dataTransfer.setData` throw swallowed                        | 880             | D4                |
| Z2  | `persistFilters` throw swallowed                              | 717             | F11               |
| Z3  | `loadFilters` read/parse throw swallowed                      | 728             | F12               |
| Z4  | malformed WS frame swallowed                                  | 985             | W5                |
| Z5  | `send()` while the socket is not OPEN — the action is dropped | 802             | W13               |
| Z6  | `applyUpdate` / `applyRemove` on an unknown id                | 960, 965        | W8, W9            |
| Z7  | `applyAdd` for an id already present                          | 956             | W7                |
| Z8  | unknown WS `type`                                             | 986–996         | W10               |
| Z9  | empty `addTask`                                               | 812             | C6                |
| Z10 | `toggle` to the current status                                | 817             | K19               |
| Z11 | `onDragOver` / `onDrop` with no `dragId`                      | 890, 913        | D6                |
| Z12 | `socket.onerror`                                              | 982             | W4                |
| Z13 | `saveDetail` with no change                                   | 837             | M5                |
| Z14 | `onTitleBlur` with no change, or an empty title               | 845–853         | K6, K7            |

---

## Deliberate departures from the old page

Recorded here so the verifier does not read them as regressions. Nothing else
may change.

| #   | Old                                                          | New                                                                                              | Why                                                                                                    |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 1   | `__WS_URL__` substituted into the page by the daemon         | derived in the browser as `ws://<location.host>/ws`                                              | a built `dist/index.html` is static; the daemon serves it verbatim (Contract 2). Same value.           |
| 2   | `__SESSION_ID__` substituted into the page                   | an additive `sessionId` field on the WS `init` frame                                             | same reason. `init` is already the frame that carries boot facts (b16's own argument).                 |
| 3   | `__TITLE__` substituted into `<title>`, seeding `this.title` | `<title>bounty</title>` in the built page; the `init` frame sets both state and `document.title` | same reason. The _only_ observable difference is the tab title for the few ms before the socket opens. |
| 4   | look: hand-rolled dark palette, custom pills/buttons/modal   | kit tokens + shadcn `base-nova` primitives                                                       | the fidelity ruling                                                                                    |

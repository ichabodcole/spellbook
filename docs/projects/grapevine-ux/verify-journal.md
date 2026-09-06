# Grapevine UX — the verify journal

**Status:** done · **Date:** 2026-09-06 · **Author:** the verify agent (Claude
Code, no stake — did not write the code) · **Branch:** `feat/grapevine-ux` at
`5fac515` (develop..HEAD = brief `024c613`, primitives + rules `c392f73`, the
six additions `19232fd`, records + wards `5fac515`)

A cold run of the branch's claims, a cold drive of the twelve new inventory rows
(plus the two rewritten ones and a fifteen-row sample of the old contract), the
same-state check CLI ⇄ UI, the race the author could not drive, and a read of
the diff — in the order it happened, for whoever verifies the next human-parity
branch (bounty, digestify). `✅` = the claim held when run; `⚠` = a finding;
`⛔` = something the author's records did not say and I needed.

**Verdict: ship with fixes.** Every one of the twelve new rows, R1 and C7 held
in both modes, by mouse and by keyboard; the human path and the agent path
landed in field-for-field the same state for all five verbs. The findings are
one record error that inverts a parity claim the branch and the backlog both
rest on (the CLI's `topic` verb does NOT refuse an archived channel), the race
landing a topic frame on an archived channel with focus lost afterwards, one
silent failure arm, one silent no-op, two small keyboard papercuts, and two
records that overstate. None is a regression a human hits on the happy path.

---

## 0. Orientation

Read in order: `brief.md` (the "Done means" list is the contract; Cole's rulings
inline), `decision-log.md`, `ux-journal.md`,
`sessions/2026-09-05-human-parity.md`, the amended
`grapevine-conversion/behaviour-inventory.md` (12 new L rows, R1 and C7
rewritten and marked),
`docs/backlog/2026-09-06-grapevine-lifecycle-route-gaps.md`, then the two
earlier verify journals for the method. Then the `shadcn` skill read from
`.claude/skills/shadcn/` directly (its probe still fails from the repo root;
`info` run from `src/grapevine/`).

Three daemons up that are not mine (23127, 66902, 99203); never touched, still
up at the end. My two daemons under `scratchpad/vfy/home-{rel,dev}` behind the
conversion verifier's `proxy.ts` on fixed ports 47141 (release) and 47142 (dev,
`SPELLBOOK_SURFACE_MODE=dev` exported before the first verb), from the first
load. Playwright MCP; `keyboard.type` / per-key `press` for every typed field;
`navigation[0].type` for every "real load" claim; `page.waitForRequest` around
every mutating act to read the body and status.

⛔ **Instrument notes the records do not carry.** (1) `page.on(...)` listeners
and `globalThis` state inside `browser_run_code_unsafe` crashed the MCP
connection twice ("Connection closed") — use `waitForRequest` per act and the
`browser_network_requests` tool instead. (2) Neither `URL` nor dynamic
`import()` exists inside `run_code` (the first threw `URL is not defined`, the
second `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`) — split strings by hand, and to
fire the agent's route mid-script use `page.request.post(<daemon port>/…)`,
which is the same route the CLI verb sends (`archive` is a bodiless POST; `open`
is `{name, explicit:true}`). (3) Playwright refuses to `click()` an
`aria-disabled` button ("element is not enabled") — pass `{ force: true }` to
prove the click is a no-op. (4) Tool calls in one response run one after
another, not in parallel, so a Bash `sleep N; cli archive` cannot race a
Playwright step that starts afterwards — see §3.

## 1. Pass 1 — the claims, run

- ✅ `bun run gate` unpiped, exit read from a file: **1640 pass / 0 fail / 129
  files, exit 0**, 198 s. The session record's numbers.
- ✅ `bun scripts/dist-check.ts`: "rebuild is a git no-op across every dist
  root", exit 0. `git status` clean afterwards (only the human's
  `skills-lock.json` and `.claude/skills/shadcn/`).
- ✅ `bunx --bun shadcn@latest info` from `src/grapevine/`: **Installed
  Components: alert-dialog, field, label, empty, tooltip, switch, dialog, badge,
  separator, button, textarea, input, context-menu** — thirteen, and nothing
  else under `surface/ui/`.
- ✅ **The four new ui files are the registry's.** `add <name> --view` captured
  from `src/grapevine/`, the box-drawing prefix stripped
  (`sed -n 's/^│ │ \{0,1\}//p'` — the `--view` output is a framed dry run, not
  raw source), biome-formatted with the repo config, diffed against the tree:
  `switch` identical; the other three differ only by biome's import sort and
  `import type * as React` (the registry writes `import * as React`), plus the
  export-list order. No recipe line moved; no variant added (none was needed —
  the four consume only names the shadcn branch aliased).
- ✅ `bun test src/grapevine`: 40 pass / 0 fail across 5 files, the 13 lifecycle
  cells among them. Read cell by cell — each asserts what its name claims:
  - `visibleChannels` "off hides archived rows EXCEPT the current channel; order
    kept": rows `[lobby, old✗, here✗, live]` with current `here` →
    `[lobby, here, live]` and `hiddenArchivedCount` 1. The exception is asserted
    on an archived current row, and a fifth cell pins that a non-archived
    current row is not special. Real.
  - `createOutcome` "409 archived → the unarchive offer":
    `409 + {error: "archived"}` → `{kind:"archived"}`;
    `400 + {error:"invalid channel name"}` → the message; `500 + null` →
    `HTTP 500`. Real. (A 409 with any other `error` string falls to the error
    arm — correct, since the daemon's only 409 on `POST /channels` is
    `archived`.)
  - `topicFrom`: joined alias trimmed, else the trimmed default, else null; a
    joined blank alias → null. `topicEditState`: archived beats "no signer".
    `takeIntent`: consumed even by the wrong channel, garbage swallowed.
    `loadShowArchived`: `"true"` is off (only `"1"` is on).
- ✅ **The kit-styling ward's regex change is correct and still bites.** The
  lookahead `(?![./-])` stops `\b` from matching the sentinel's stem when the
  registry's tooltip arrow continues it with `.5`. Planted
  `src/grapevine/surface/zz-plant.tsx` containing the bare sentinel (untracked —
  the walk is `ls-files -c -o`): the discrimination cell went **red naming that
  file** (8 pass / 1 fail); removed it: 9 pass / 0 fail. The gate above ran with
  the tooltip recipe in the tree and stayed green, so both halves of the
  author's claim held when run.
- ✅ gate-honesty's pins still reconcile: `wc -l` gives `styles.css` 108,
  `index.html` 24 (the L1 comment's roster line changed at the same line count).
  The dist-roster / drift ward printed its "7 of 8 spell folders" line in the
  gate log with mind-mapper the only undeclared one, as before.

## 2. Pass 2 — the drive

**Rows driven: the 12 new (L1, L1a, L1b, L2, L2a, L2b, L3, L3a, L3b, L4, L5,
L6), the 2 rewritten (R1, C7), and 15 old (C1–C8, C10–C12, C14, I1–I7, E4, T1,
T2).** Release unless noted; dev for L1, L1a, L2, L2a, L2b, L3, L4, D2, D5.

**Load, lurk, no identity (release, `#roundtable`).** Title
`grapevine · roundtable` (C2). Rail `other, roundtable` with the label
`Show archived (2 hidden)` — the two archived fixtures hidden by default (**L4**
✅, C7 amended ✅). The topic line `design review` carries
`aria-disabled="true"`; hover → tooltip
`join the channel (or set a default alias) to edit the topic` verbatim;
Shift+Tab onto it → the same tooltip opens on keyboard focus; a forced click
opens no input (**L3a** ✅ — `aria-disabled`, hoverable, Tab-reachable, inert).

**L4 ✅ all arms.** Click the switch → four rows (`archived-one🔒`,
`archived-two🔒` join the list),
`localStorage["grapevine:show-archived"] === "1"`, the `(N hidden)` suffix gone;
a real load (`?r=1`, `navigation.type === "navigate"`) keeps it on; Space on the
focused switch → off, key `null`, two rows. The switch's accessible name
resolves through `<label for>`: `Show archived (2 hidden)`. Later, with the
switch off and the current channel archived from the CLI, the rail read
`archived-two, fresh-one, other, roundtable🔒` with `(1 hidden)` — the current
row stayed, the other archived row did not (the current-channel exception,
live).

**L1 ✅ mouse and keyboard, both modes.** Right-click `other` → one
`role="menu"` with `Edit topic, Archive, Delete…`, one separator, `Delete…`
carrying `data-variant="destructive"`; Escape → 0 menus, focus on the `other`
link. Focus the `archived-one` link (switch on), **Shift+F10** → the same menu
reading `Unarchive` (the verb follows the row); the **ContextMenu key** opens it
too; ArrowUp from a freshly opened menu wraps to `Delete…`; Escape returns focus
to the link. ⚠ **ArrowDown does not wrap at the bottom**: from `Delete…` another
ArrowDown stays on `Delete…` (measured twice); ArrowUp from the top does wrap.
The inventory's "arrows move" is true; the journal's "arrows move and wrap" is
half true. Cosmetic.

**L1a ✅ CLI ⇄ UI.** UI _Archive_ on `other` (switch off):
`POST /channels/other/archive` 200, the row gone within the refresh, label
`(3 hidden)`, **focus on the switch** (the hand-off in the link's ref callback,
measured); `grapevine list` → `other … archived:true`. CLI `unarchive other` →
the row back within a poll. Keyboard _Unarchive_ on `archived-one` (Shift+F10,
ArrowDown ×2 to `Unarchive`, Enter) → `POST …/unarchive` 200, the 🔒 gone,
**focus on the `archived-one` link**, `list` agrees. Dev: Shift+F10 → ArrowDown
×2 → Enter archived `other`; row took 🔒, focus returned to its link.

**L1b ✅.** _Delete…_ from the menu → `role="alertdialog"`, title
`Close channel`, description
`Close channel "archived-two"? This deletes its message log and disconnects any subscribers. This cannot be undone.`
(C11 verbatim), initial focus on Cancel; Escape → 0 dialogs, 0 `DELETE`s, focus
back on the row's link; Cancel → same. Keyboard-only delete of a throwaway
`zz-kb`: Shift+F10 → ArrowUp (wraps to `Delete…`) → Enter → Tab
(`Close channel`) → Enter → `DELETE /channels/zz-kb`, row gone. ⚠ **After the
delete, focus is on a bare `SPAN`** (the row that owned it is gone and nothing
hands focus on). The archive path hands focus to the switch; the delete path
hands it to nowhere. Papercut; the inventory does not pin it.

**L2 ✅.** Enter on the focused `+` (`aria-label="New channel"`) →
`role="dialog"`, `DialogTitle` _New channel_, description
`Creates the channel, or opens it if it already exists.`, a `FieldGroup` of two
`Field`s, the Name input focused, Create disabled while blank. Whitespace name
(`   ` typed): Create stays disabled, Enter sends nothing and the dialog stays.
Escape → 0 dialogs, **focus on `+`** (`finalFocus` measured); reopen → the name
is reset to empty.

**L2a ✅.** Typed `fresh-one`, Tab, typed `made in the ui`, Enter from the topic
field → `POST /channels {"name":"fresh-one","topic":"made in the ui"}` — no
`explicit`, no `from` (lurking with no identity; the daemon signs `system`) →
`#fresh-one` with `navigation.type === "reload"`, title `grapevine · fresh-one`,
header `made in the ui`, one `system set topic` row; CLI `topic fresh-one` →
`made in the ui`. Dev: `dev-one` from the name field → `#dev-one`, reload.

**L2b ✅ both arms.** `bad name` → `FieldError`
`invalid channel name: "bad name"`, the Field `data-invalid`, the input
`aria-invalid="true"`, dialog open; one Backspace → both cleared. `archived-two`
→ `POST /channels` **409**, the Name field's description
`“archived-two” exists but is archived. Unarchive it instead?`, the footer
`Cancel | Unarchive instead` (no Create); one keystroke → back to
`Cancel | Create` with the description gone; _Unarchive instead_ →
`POST /channels/archived-two/unarchive` → `#archived-two`, reload, the row
without 🔒, no archived note. The 409 logs one browser network-layer line (not a
`pageerror`), as the row says.

- ⚠ **Creating an existing active channel with a topic silently drops the
  topic.** Name `roundtable` (the current channel, which already has a topic) +
  topic `clobber attempt` + Enter: the dialog closed, no navigation (the "just a
  refresh" arm), and the header still read `design review` — the daemon's
  `POST /channels` sets a topic only when `ch.topic === null`
  (`daemon.ts:626–628`), and the surface reports success. The dialog's own text
  ("or opens it if it already exists") covers the name; nothing says the topic
  was ignored. Minor; the `Set as <signer>.` hint under the topic field reads as
  a promise that was not kept.
- ⚠ **A failed _Unarchive instead_ closes the dialog with no message.** With
  `page.route` answering `…/unarchive` 500
  (`{"error":"unarchive failed — marker still present"}` — the daemon's own
  arm): the dialog closed, focus went to `+`, no `FieldError`, no navigation.
  `CreateChannelDialog.tsx:119–123` calls `change(false)` regardless of
  `onUnarchive`'s outcome, and `unarchiveAndGo` returns void. The create arm
  handles its errors; this arm does not. Minor (the 500 needs an unlinkable
  marker), but it is the one mutating call in the branch whose failure the human
  cannot see.

**L3 ✅.** Joined (alias typed, Enter, Join): the line's `title`
`Click to edit the topic (as <alias>)`, no `aria-disabled`. Click → `Input` with
the sr-only label _Topic_, focused, `value` = the topic, placeholder
`set a topic (as <alias>)…`. Typed ` escaped` + **Escape** → 0 `PUT`s, input
gone, **focus on the line**, text unchanged. Typed ` blurred` + click on the
`<h1>` → 0 `PUT`s, input gone, focus on `BODY` (a blur means focus already moved
— as designed). Typed `… edited` + **Enter** →
`PUT /channels/roundtable/topic {"topic":"…","from":"<alias>"}` 200, input gone,
focus on the line, header updated over the stream, a `<alias> set topic` row.
Dev: `PUT {"topic":"dev topic (dev)","from":"dev-cole"}` 200, header followed,
focus back on the line; CLI `topic roundtable` on the dev daemon →
`dev topic (dev)`.

**L3a ✅ the three signers.** No identity → disabled + tooltip (above).
`grapevine alias cole` on the CLI, a localStorage override `verifier`, a real
load (`?r=3`): **`/identity` was fetched** (R1 amended ✅), the You box read
`verifier` (the override wins ✅), and once lurking the line's title read
`(as cole)`, the editor's placeholder `set a topic (as cole)…`, and the commit
went out as `{"topic":"…","from":"cole"}` — a lurker's edit signed with the
persisted default while the box shows the override, exactly as ruled. Archived
(from the CLI) → `aria-disabled`, tooltip `archived — read-only`.

**Same shape, header and feed.** CLI
`topic roundtable "set from the cli" --from agent-z` and the UI's edit produced
rows with identical classes: outer `group my-2.5 max-w-[720px]`, card
`whitespace-pre-wrap break-words rounded-[10px] border border-dashed border-grape bg-transparent px-3.5 py-2.5 italic text-grape-soft`;
`agent-z set topic` / `cole set topic` the only difference.

**L3b ✅.** Menu → _Edit topic_ on the current row → the header input focused
with the topic as draft (menu closing did not win the focus race). On `other` →
`#other`, `navigation.type === "reload"`, title `grapevine · other`, the editor
open and focused with an empty draft (no topic yet) and the signer's
placeholder, `localStorage["grapevine:intent"]` `null` (consumed); mode
`Join channel` (I4 — join is per channel).

**L5 ✅ — same state, measured.** Joined on `roundtable`, one probe read after
each of the four acts (composer textarea count, archived-note count, `reply`
button count, 🔒 in the current row, the name span's class, the topic line's
`aria-disabled`, the toggle's label):

| act           | composer | note | reply | 🔒  | name class               | topic           | toggle |
| ------------- | -------- | ---- | ----- | --- | ------------------------ | --------------- | ------ |
| before        | 1        | 0    | 2     | 0   | `…truncate`              | enabled         | Joined |
| UI archive    | 0        | 1    | 0     | 1   | `…truncate text-ink-dim` | `aria-disabled` | Joined |
| CLI unarchive | 1        | 0    | 2     | 0   | `…truncate`              | enabled         | Joined |
| CLI archive   | 0        | 1    | 0     | 1   | `…truncate text-ink-dim` | `aria-disabled` | Joined |
| UI unarchive  | 1        | 0    | 2     | 0   | `…truncate`              | enabled         | Joined |

UI archive ≡ CLI archive and UI unarchive ≡ CLI unarchive, field for field; the
composer swapped for the note and back **without a page reload** (same
`navigation` entry throughout); the status bar read
`🔒 this channel is archived — read-only` in the archived rows. C12 / C14 (the
current row's name muted while highlighted) ✅ on the way.

**L6 ✅.** Tab cycle from the body (lurk, alias blank):
`Edit topic → New channel → switch → other → 🗑 → roundtable → 🗑 → <alias input> → wrap`
— the disabled Join is skipped, so the old floor (rows → alias → toggle) sits
under the three new stops. ⛔ Playwright's first Tab after
`document.body.focus()` landed on the alias input, not the topic line (the
sequential-focus start point was the last clicked element); read the _cycle_,
not the first stop.

**Delete the current channel from the menu ✅.** On `#other`: _Delete…_ → _Close
channel_ → `DELETE /channels/other` → `#lobby`, `reload`, title
`grapevine · lobby`, topic `no topic set`, `subscribed to lobby`, `Join channel`
(lurk — I4 per channel), the rail without `other`.

**Old rows, the sample.** C1 ✅ `/watch` and `/watch?x=1#` both →
`grapevine · lobby`. C3 ✅ every hash change above was a `reload`. C4 ✅ hrefs
`#<name>`. C5 ✅ only the current row carries `text-leaf-soft`. C6 ✅ a channel
created out-of-band after the first poll
(`POST /channels {name:"flashy3", explicit:true}` — the `open` route) showed
`animate-flash` at 1,146 ms and none 3.5 s later. C8 ✅ the current row's badge
read `1` while joined, `0` lurking. C10 ✅ both arms (above). I1/I3 ✅ override
wins; clearing the field + Tab → key removed, Join disabled (I5). **I2 ✅
typed**: five keys, `activeElement` INPUT after each, value grew per key,
storage `null` until Enter, then `typed`. I6 ✅ Join →
`tail?since=0&as=typed&human=1`. I7 ✅ `who` named the joined alias only; the
roster read `typed (you)`. E4/T2 ✅ proxy killed →
`disconnected — reconnecting…`, dot `rgb(240,178,101)`, retries every ~1 s with
`since=0` (the highest id on the empty lobby), the rail kept its rows (X1); a
CLI send during the gap; proxy back → `joined lobby as typed`, dot
`rgb(87,201,122)`, the gap row exactly once (F9). T1 ✅ `subscribed to lobby`
after load.

**Dev mode (47142).** `GET /` → `mode: dev` (D5); the page links
`/_bun/asset/<hash>.css` (D2); the switch is 14 px (`size="sm"` styled), the
menu and the dialog `rgb(26,34,25)` (`bg-popover` → `--color-surface-raised`);
L1, L1a, L2, L2a, L2b, L3, L4 as above. Console in dev: the 409 and the routed
500 as network-layer lines only.

**Console.** 0 `pageerror` in either mode in every state. Network-layer lines
only: the create dialog's 400/409, my routed 500, and E4's
`ERR_CONNECTION_REFUSED` per retry.

## 3. The race the author could not drive

Setup: joined on `roundtable`, the topic editor open with a draft typed
(`… raced`). The agent's archive fired out-of-band as the route the CLI verb
sends (`page.request.post(<daemon>/channels/roundtable/archive)` → 200 — a Bash
`cli archive` could not be interleaved: tool calls run one after another, so my
two attempts with `sleep 2` / `sleep 3` both archived _before_ the editor opened
and the line was already `aria-disabled` when the click arrived). 3.6 s later
(one poll): the rail row wore 🔒, the composer had become the archived note,
**and the editor was still open with the draft and focus intact**. Enter →
`PUT /channels/roundtable/topic {"topic":"… raced","from":"verifier"}` →
**200**; the header took the new text; a `verifier set topic` row appeared on
the read-only channel; the line rendered `aria-disabled`; **focus went to
`BODY`**.

Two things, one each side of the wire:

- ⚠ **The frame lands** (backlog finding 1, reproduced end to end). The
  surface's guard is `start()` only; `commit()` never re-reads
  `editState.disabled`. A one-line client guard
  (`if (editState.disabled) return close(true)` in `commit`) would close the
  human's window without a backend change; the daemon's missing check stays the
  real fix.
- ⚠ **Focus is lost after the keyboard close when the line has become disabled**
  — `Header.tsx:60–63` restores to `buttonRef`, but the disabled branch renders
  the Tooltip-wrapped button without that ref (`Header.tsx:110–127`), so
  `buttonRef.current` is `null` and nothing is focused. Same shape as
  fresh-agent finding 3, one branch over.

## 4. The backlog findings, reproduced

Against my release daemon (`:57309`, home `vfy/home-rel`):

1. **`PUT /channels/:name/topic` has no archived check** — ✅ real:
   `curl -X PUT …/channels/archived-two/topic {"topic":"written while archived","from":"curl"}`
   → **200**, and `GET …/messages` shows the `kind:"topic"` frame appended
   (id 2) to the archived log. **⚠ And the CLI verb does not refuse either.**
   `grapevine topic archived-two "via cli"` → `{"ok":true,…,"id":3}`, exit 0.
   `cli.ts:405` sends `POST /channels {name}` and **discards the response** —
   the 409 is answered and ignored; the PUT that follows lands. The backlog
   item, the ux-journal (§1 twice, §5), the decision log and the session record
   all state that the CLI refuses "through its `POST /channels` 409"; none of
   them ran it. The fresh-agent record even logs "set a topic on `archived-one`
   from the CLI" as part of its drive without noticing that this contradicts the
   claim. Consequence for the contract: the surface's L3a disables the edit on
   an archived channel, so **the human path is now stricter than the agent
   path** — parity in the brief's sense ("the same functionality an agent has")
   is not what shipped here; what shipped is what the agent _should_ have. The
   right fix is on the daemon (the guard `POST /messages` has), and the CLI verb
   should check the ensure's status; the backlog item needs rewording so the
   next reader does not inherit the inverted claim.
2. **Any non-explicit verb re-creates a deleted channel** — ✅ real:
   `open zz-del`; `curl -X DELETE …/channels/zz-del` → `{"ok":true}`, gone from
   `list`; `grapevine pull zz-del` → `{"ok":true,"messages":[],"cursor":0}` and
   the channel is back in `list` (`message_count:0`, a fresh `created_at`).
3. **Archive / unarchive emit no frame** — ✅ real:
   `curl -N …/channels/other/tail` held open across `POST …/archive` then
   `POST …/unarchive` saw only the `subscribed` frame and a heartbeat;
   `GET …/messages` before and after: `{"messages":[]}`.

**Severity call.** None of the three blocks the UX branch: the surface works
around 1 (and closes most of the window; the race in §3 is the residue), 2 and 3
are agent-side behaviours the branch did not change and the CLI shares. But **1
should land soon after, and its backlog text must be corrected before it
misleads the agent who fixes it** — as written it says the CLI is safe, and it
is not. If Cole wants one strict rule ("archived means no writes of any kind"),
the daemon guard on `PUT /topic` is a five-line change with the sibling as its
template, and it would make the surface's L3a disable a courtesy rather than the
only fence.

## 5. Pass 3 — the cold read

`git diff develop..HEAD -- src/grapevine plugins/spellbook/skills/grapevine grimoire docs/backlog`,
read against the brief's rules and the shadcn skill's Critical Rules.

- ✅ **No optimistic mutation.** `archiveChannel`, `unarchiveChannel`,
  `closeChannel` each `fetch` then `refreshChannels()`; `createChannel` sets the
  hash (a reload) or refreshes; `putTopic` returns `r.ok` and touches no state —
  the header follows the stream (`useGrapevine.ts:254–351`). `setShowArchived`
  writes local UI state only. The probe table in §2 is this rule measured.
- ✅ **Every mutating call is wrapped**; the arms are `catch {}` → refresh
  (archive/unarchive/close: the poll is the truth), `outcome = error` (create),
  `return false` (topic). ⚠ The one un-surfaced failure is `unarchiveAndGo` →
  dialog (§2, L2b) — the hook returns nothing to the dialog and the dialog
  closes on any outcome.
- ✅ **`from` for the topic PUT can never be empty**: `putTopic` returns `false`
  before fetching when `topicFrom` is null (`:337–338`); `topicFrom` trims and
  falls through to null (`lifecycle.ts:60–64`, cells pin it); the header's
  `editState` is computed from the same `topicFrom` so the editor cannot open
  without a signer. `createChannel` omits `from` when none resolves and the
  daemon signs `system` — matches L2a.
- ✅ **Titles.** `DialogTitle` _New channel_; `AlertDialogTitle` _Close channel_
  (unchanged). The context menu needs none.
- ⚠ **Colours/typography in `className`, house rule.**
  `FieldLabel className="text-xs font-normal text-ink-dim"`
  (`ChannelRail.tsx:138`) is decision-logged with the reason and is the only
  registry-component override. The two header `<button>`s are raw elements, not
  registry components, so their classes are layout of the spell's own, not
  overrides. The `+` uses `variant="ghost" size="icon-xs"` clean; the menu uses
  `variant="destructive"` for _Delete…_. Nothing new breaks the shadcn branch's
  boundary check.
- ✅ **`data-icon` on the `+`.** Absent, decision-logged: the button recipe's
  `has-data-[icon=…]` arms only adjust text-size padding, and an icon-only
  `size="icon-xs"` with a bare `<PlusIcon />` is the recipe's own shape. The
  skill's icon rule is written for an icon beside text. Agree.
- ✅ **R1 — `/identity` on every init.** One `GET /identity` per page load
  (`useGrapevine.ts:184–190`), awaited before the first `connect` as before, so
  the cost is one small JSON read of `config.json` per load and no extra latency
  class (the fetch was already on the critical path in the no-override case).
  Correct: the pre-fill rule is unchanged (`if (!a && d) a = d`), the default is
  kept apart in `identityAlias`, and the disabled state is knowable before any
  click. Measured (§2 L3a).
- ⚠ **`identityAlias` is captured, not ref'd**: `createChannel` and `putTopic`
  close over the `identityAlias` state (`:297`, `:337`) rather than a ref like
  `aliasRef`. Both callbacks list it in deps, so they are rebuilt when it
  changes, and it changes once (on init). Consistent enough; a comment saying
  why it is not a ref would spare the next reader the question.
- ✅ **SKILL.md V2.1 matches the surface.** Each of its four bullets was driven
  above: the menu's three verbs and its two keyboard openers; `+` with Enter,
  409 → _Unarchive instead_; click-to-edit with Enter/Escape/blur and the signer
  rule (joined alias, else `grapevine alias`, else disabled); archived hidden by
  default, the switch remembered, the current channel always shown. ⚠ The
  paragraph's "the same functionality an agent has" is true for four verbs and
  _stricter_ for the fifth (topic on archived, §4) — not wrong, but the record
  behind it is.
- ✅ **Wards.** The kit-styling ward's regex (§1); the decay-ledger row
  re-walked; gate-honesty's pins unchanged and reconciling; `styles.css` changed
  only the L1 roster comment (the diff is 2 lines). The drift ward's output in
  the gate log is the pre-branch picture.
- ⚠ **Record accuracy.** (a) "the CLI's `topic` verb refuses on an archived
  channel" — false, in five places (§4). (b) "arrows move and wrap" — ArrowUp
  wraps, ArrowDown does not (§2 L1). (c) The session record's `dist/` js size
  says `1,658,640` and the journal's §6 says `1,657,042` for the same "after";
  `wc -c` gives `1,658,640` — the session record is right and the journal's §6
  is the stale copy (cosmetic).

## 6. Findings by severity

1. **Record error that inverts a parity claim (fix the text before landing, or
   right after)** — `docs/backlog/2026-09-06-grapevine-lifecycle-route-gaps.md`
   §1, `ux-journal.md` §1/§5, `decision-log.md` (implementing agent, last
   bullet), `sessions/2026-09-05-human-parity.md`: the CLI `topic` verb does not
   refuse an archived channel (`cli.ts:405` ignores the ensure's 409). Repro:
   `grapevine archive x; grapevine topic x "t"` → `ok:true`. The surface is
   stricter than the CLI; the backlog item should say the verb AND the route are
   open.
2. **Race lands a topic frame on an archived channel, and focus is lost** —
   `Header.tsx:70–73` (no re-check at commit), `Header.tsx:60–63` + `110–127`
   (`buttonRef` absent on the disabled branch). Repro: §3. Client guard is one
   line; focus fix is attaching `buttonRef` to the disabled button too.
3. **Silent failure** — `CreateChannelDialog.tsx:119–123`: a failed _Unarchive
   instead_ closes the dialog with no message. Repro: route `…/unarchive` to
   500, click.
4. **Silent no-op** — creating an existing channel with a topic drops the topic
   (`daemon.ts:626`, surface reports success). Repro: `+`, the current channel's
   name, any topic, Enter.
5. **Keyboard papercuts** — focus after _Delete…_ completes is a bare `SPAN`
   (`ChannelRail.tsx:243–247` hands nothing on); ArrowDown does not wrap at the
   menu's bottom (Base UI default; `loop` is a prop if wanted).
6. **Records** — 5(b), 5(c) above; the fresh-agent record's drive line
   contradicts finding 1 without noticing.

**Claims that did not hold when run:** "the CLI's `topic` verb refuses on an
archived channel" (§4); "arrows move and wrap" (half). Every "Done means" claim
held; every driven row held.

## 7. Three things for the next verifier

1. **Run the parity claim on both sides before you believe the record.** Every
   "the CLI refuses …" sentence is a `bun cli.ts <verb>` away; here the one that
   anchored a backlog item and a design decision (`topicEditState`) had never
   been run, and the cold read's own drive log had already disproved it without
   anyone reading the two lines together.
2. **Race from inside the page, not from Bash.** Tool calls serialise, so the
   only way to interleave an agent act between "editor open" and "Enter" is
   `page.request.post(<daemon>/…)` inside one `run_code` — the same bytes the
   CLI sends. Then press the key and read the response status; the surface's
   guards are almost always at `start`, not at `commit`.
3. **Probe focus after every act's _unhappy_ branch.** The author fixed focus
   after archive, unarchive and the editor's close; the two places it still
   falls to `BODY`/`SPAN` are the branches that change the target's identity
   (the line becoming disabled, the row being deleted). Read `activeElement`
   after each act on the row that vanishes and on the control that changes state
   under you.

# Grapevine UX — the journal

**Status:** live · **Started:** 2026-09-05 · **Author:** the implementing agent
(Claude Code, session `session_01BiZGj5ZTDSZi1mB8YtuRcx`) · **Branch:**
`feat/grapevine-ux`

The process, in order, for the agent who adds human parity to bounty or
digestify next: what a "same as the agent" action needs from the daemon, how the
inventory was amended, and every gotcha with symptom and fix. `→` = what I ran
or read; `⚠` = a gotcha; `⛔` = something the brief did not say and I needed.

---

## 0. Orientation

Read in order: AGENTS.md → the brief (its "Done means" is the contract; Cole's
rulings inline) → the backlog item (the measured parity gap) → the shadcn
project's brief and both journals (the CLI must run from `src/grapevine/`; `add`
does not install cva; the skill's probe fails from the repo root) → the
conversion's inventory and verify journal (type, don't fill; fixed-port proxy
from the first load; scoped `GRAPEVINE_HOME`) → the surface as it stood → the
daemon's route header.

⛔ **The tree I inherited had nine primitives, not fifteen.** The shadcn
project's records describe fifteen; after its verify pass six were uninstalled
(the dead-sheet ruling), so `context-menu`, `dialog`, `switch` had to come back
by `add` here. The shadcn session record says so; the brief's "three new
primitives" is right and the older journal paragraphs are history.

**Baselines** (`dist/`, bytes): html 919 · js 1,314,605 · css 63,055; dead sheet
990 B (1.6 %). Three daemons up that are not mine (23127, 66902, 99203 — the
last is Cole's review daemon); never touched.

## 1. What a "same as the agent" action needs from the daemon

The whole branch is five routes the CLI already had, read from `daemon.ts`'s
header and then from the handlers, because the header is not the contract's fine
print:

| act       | route                            | what the surface had to know                                                                                                                                                                                                                                      |
| --------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create    | `POST /channels {name, topic?}`  | **409 `archived` only when `explicit` is absent** — the CLI's `open` sends `explicit: true` and auto-unarchives; every other verb sends the bare shape. The surface sends the bare shape so the 409 exists to offer a way out of                                  |
| topic     | `PUT /channels/:name/topic`      | `from` is optional and defaults to `system`; **no archived check** on the PUT — and none on the CLI's `topic` verb either, which `POST /channels {name}`s first and discards the 409 (the verify pass ran it; my first reading of `cli.ts` had it refusing — §11) |
| archive   | `POST /channels/:name/archive`   | idempotent, no body; the marker file is the truth, `GET /channels` reflects it on the next read                                                                                                                                                                   |
| unarchive | `POST /channels/:name/unarchive` | same; 500 only if the marker cannot be unlinked                                                                                                                                                                                                                   |
| delete    | `DELETE /channels/:name`         | already wired (C10)                                                                                                                                                                                                                                               |

The rule that made every one of these easy: **the rail poll is the source of
truth.** A mutating call is followed by `refreshChannels()` — the next poll
brought forward, not an optimistic write — so the human path lands in exactly
the state the agent path already landed in (C7, C12, P2, F6 were written for the
CLI-driven case and needed no change). The same-state check in §4 is that rule
measured.

## 2. The primitives — what `add` did this time

→
`cd src/grapevine && bunx --bun shadcn@latest add context-menu dialog switch tooltip --dry-run --yes`:
5 files, **1 overwrite — `button.tsx`**, because `dialog` depends on `button`
and the CLI treats a registry dependency as a file to write.

⚠ **`--yes` does not answer the overwrite prompt.** The real `add` stopped at
`The file button.tsx already exists. Would you like to overwrite? (y/N)` with
stdin closed, wrote `context-menu`, `switch`, `tooltip` — and **not `dialog`**.
Fix: back up `button.tsx` (it carries the spell's `accent`, `joined`,
`destructive-ghost` variants and the `inline` size),
`add dialog --overwrite --yes`, restore the backup, diff (identical). Then
`info` lists all thirteen. The shadcn journal's "`--diff` before the next `add`"
advice is right; the sharper version is _back the variant file up before any
`add` whose dry run says overwrite_.

`tooltip` was not in the brief's `add` line but the brief allows it "if the
disabled-topic hint needs one" — it does (L3a). Four files, zero recipe edits,
zero L1 growth: every colour name the four consume (`popover`, `accent`,
`foreground`, `input`, `border`, `destructive`, `muted`) was aliased on the
shadcn branch. Only the L1 comment's roster line changed, at the same line
count, so the gate-honesty pin (108) stands.

Biome on the four: 4 reflows, no lint (the `biome.json` override for
`src/*/surface/ui/**` from the shadcn branch covers them).

## 3. The build — one state module, three components, one hook

**`state/lifecycle.ts`** (13 tests): the archived key and its load/save (off
_removes_ the key, like the alias); `visibleChannels` + `hiddenArchivedCount`
(the filter with the current-channel exception — the unit test the brief asked
for); `createOutcome` (2xx / 409-archived / error-with-message);
`createArchivedText`; `topicFrom` (joined alias → `/identity` default → null);
`topicEditState` (archived wins over "no signer"); `parkIntent`/`takeIntent`
(below); `archiveLabel`.

**The hook** grew `identityAlias`, `showArchived`, `topicEditRequest`, and the
five callbacks. Two things it had to change in what existed:

- ⛔ **R1 amended.** `/identity` was fetched only when no localStorage alias
  existed. The lurker's topic edit signs with the `/identity` default _even
  when_ an override exists (Cole's ruling: joined alias, else the persisted
  default), and the disabled-with-tooltip state has to be known before any
  click, so the fetch is unconditional now and the pre-fill rule is unchanged.
  Inventory row rewritten, marked, driven both ways.
- **_Edit topic_ on a non-current row.** A channel switch is a reload (C3), so a
  React-state "open the editor" request dies with the page. The intent is parked
  in `localStorage["grapevine:intent"]` keyed by channel and taken once on init
  (a wrong channel consumes and ignores it, so a stale intent cannot fire
  later). One editor, one set of rules; the decision log has the alternatives.

**`Header.tsx`**: the topic line is a `<button aria-label="Edit topic">` in
three states — editable (click/Enter → `Input`), editing, and `aria-disabled` +
`Tooltip`. ⚠ **Do not use `disabled` for a control whose tooltip must explain
why** — a disabled button is unfocusable and takes no pointer events, so the
tooltip never opens. The shadcn docs' workaround (wrap in a
`<span tabIndex={0}>`) trips biome's `noNoninteractiveTabindex`. `aria-disabled`
on the button itself keeps it hoverable and in the Tab order, and its click is a
no-op. The editor takes focus on the next animation frame: when the context menu
raised the request, the menu is still closing and would otherwise win the focus
race (measured: `requestAnimationFrame` was enough; no timeout needed).

**`CreateChannelDialog.tsx`**: `Dialog` + `FieldGroup` of two `Field`s, a
`<form className="contents">` so Enter submits from either input; the 409 arm
swaps the footer's primary for _Unarchive instead_; any other error is a
`FieldError` under a `data-invalid` Field, cleared on the next keystroke. ⚠ The
dialog is opened by state (the `+` is a plain `Button`, not a `DialogTrigger`),
so Base UI has no trigger to return focus to on close — measured:
`activeElement` was `null` after Escape. `DialogContent` forwards `finalFocus`;
the rail passes the `+`'s ref. After: focus returns to `+`.

**`ChannelRail.tsx`**: each row is a `ContextMenuTrigger render={<div/>}` around
the existing link + 🗑; the menu is two `ContextMenuGroup`s and a separator;
_Delete…_ reuses the `AlertDialog` through the same `setPending`. The `+` and
the `Switch` (in a horizontal `Field` with a visible `FieldLabel`) sit above the
list.

⚠ **Shift+F10 fires no `contextmenu` event on macOS Chrome** (0 events through
Playwright with a document-level capture listener); the **ContextMenu key does**
(1 event, and Base UI opened on it, positioned at the row). Fix: a keydown
handler on the trigger that synthesises a `contextmenu` `MouseEvent` at the
row's rect on Shift+F10. Base UI's trigger accepted the synthetic event and
opened the same menu, keyboard-navigable, with focus returning to the row link
on Escape. Windows/Linux Chrome would have fired the native event and the
handler would double-fire — `preventDefault` on the keydown stops the native
one, so it is one menu everywhere.

## 4. The drive — both modes, mouse and keyboard, CLI ⇄ UI

**Instruments.** Two daemons of my own under the scratchpad (`ux/home-rel`
release, `ux/home-dev` with `SPELLBOOK_SURFACE_MODE=dev` exported before the
first verb), each behind the shadcn verifier's `proxy.ts` on a fixed port (47131
/ 47132) from the first load. Playwright MCP; `keyboard.type` with a per-key
delay for every typed field; `navigation[0].type` for every "real load" claim; a
`page.on("request")` recorder for every mutating call.

⛔ **Playwright's screenshot tool only writes inside the repo**
(`.playwright-mcp/` is the allowed root and is gitignored) — write there and
`mv` to the scratchpad afterwards. ⛔ `CSS.escape` is not defined inside
`browser_run_code_unsafe` (nor is `URL`, per the shadcn journal) — use
`getByLabel`. ⚠ A test that "blurs" by focusing the alias input while joined
does nothing: the input is disabled in join mode (I2), `focus()` is a no-op, and
the editor stays open — my flow bug, not the surface's; blur by clicking a
heading.

**What held** (the inventory's L rows carry the per-row evidence):

- L1 mouse and keyboard (right-click; menu key; Shift+F10; ArrowUp wraps at the
  top, ArrowDown stops at the bottom — Base UI's default, see §11; Enter; Escape
  returns focus to the row) in release and dev.
- L1a/L1b archive, unarchive, delete from the menu — each once from the UI and
  once from the CLI, comparing `list` after the UI act and the rail after the
  CLI act.
- L2 create (typed, Enter from the topic field), the 400 arm (`bad name` → the
  daemon's message), the 409 arm (→ _Unarchive instead_ → navigation with
  `type === "reload"`), Escape → focus on `+`.
- L3 edit in place (Enter → `PUT` with `from: verifier`; Escape and blur → 0
  `PUT`s), the menu's _Edit topic_ on the current row (input focused with the
  topic as draft) and on another row (intent through the reload: `#other`,
  editor open and focused, key consumed).
- L3a the three signers: no identity → `aria-disabled` + tooltip verbatim;
  `alias cole` on the CLI → a lurker's edit signed `cole` while the You box
  still read `verifier`; archived → `archived — read-only`.
- L4 default off, `(2 hidden)`, on by click and off by Space, storage `1` / key
  removed, a real load keeps it; the current archived channel stays listed.
- L5 the same-state check, release, one probe read after each act:

  | act           | composer | note  | reply | 🔒    | name class     | topic         |
  | ------------- | -------- | ----- | ----- | ----- | -------------- | ------------- |
  | UI archive    | false    | true  | 0     | true  | `text-ink-dim` | aria-disabled |
  | CLI archive   | false    | true  | 0     | true  | `text-ink-dim` | aria-disabled |
  | UI unarchive  | true     | false | 0     | false | —              | enabled       |
  | CLI unarchive | true     | false | 0     | false | —              | enabled       |

  Field-for-field identical. Header: a CLI `topic … --from agent-z` and a UI
  edit produced the same header text and the same dashed `kind:"topic"` row
  shape (`agent-z set topic` / `verifier set topic`).

- L6 fourteen Tabs from the body:
  `Edit topic, New channel, <switch>, <row>, 🗑 ×4, <alias>, wrap`. The old
  floor (rows → alias → toggle) sits under three new stops.
- Console: 0 page errors in either mode. One browser network-layer line —
  `Failed to load resource: 409 (Conflict)` — for the create dialog's 409 arm,
  the same class of entry E4 produces; not a `pageerror`.

**Screenshots** (`scratchpad/ux/shots/`, 1280×800): `01` lurk with archived
hidden · `02` disabled topic + tooltip · `03` switch on · `04` context menu
(mouse) · `05` context menu (keyboard, archived row) · `06` create error · `07`
create 409 · `08` create filled · `09` after create · `10` topic editing · `11`
topic committed · `12`/`12b` current channel archived from the UI / from the CLI
· `13` the current archived channel with the filter off · `14` the editor open
after the intent's reload · `15` topic set while lurking as the default alias ·
`16` _Delete…_'s confirm · `20`–`24` the dev-mode set.

## 5. Findings for the backend (reported, not worked around)

1. **`PUT /channels/:name/topic` has no archived check, and neither does the
   CLI's `topic` verb** (_corrected after verify — I had written that the verb
   refuses through its ensure's 409; `cli.ts:405` discards that response and the
   PUT lands; measured: `archive x; topic x "t"` → `ok:true`_). The surface
   disables the edit on an archived channel (L3a) and cancels an edit that an
   archive overtakes (L3c), so the human path is **stricter** than the agent
   path here — not parity, but what the agent path should be. The route and the
   verb are out of scope by ruling; filed.
2. **`POST /channels` creates on any non-explicit verb** — `topic`, `pull`,
   `tail`, `who` all auto-create a missing channel. Not a defect, but the reason
   "create" from the UI needed no new route.

## 6. Bundle

`dist/` bytes, before → after: html 919 → 919 · js 1,314,605 → 1,660,101 (**+345
KB**, source maps inline by ruling — `@base-ui/react` modules 121 → 246 for the
menu, dialog, tooltip and switch machinery, plus `@floating-ui/react-dom` for
the two positioned popups, plus 13 tree-shaken `lucide-react` modules for
`PlusIcon`, `XIcon`, `CheckIcon`, `ChevronRightIcon`) · css 63,055 → 75,064
(**+12 KB**, the four recipes' utilities, now all composed).

## 7. The gate — one red, two causes, neither in the new code

First full run: 1639 pass / **1 fail** —
`kit styling ward > the sentinel utility is genuinely kit-only`, naming two
files: `surface/ui/tooltip.tsx` and **the brief**.

- ⚠ **The brief spelled the sentinel.** The kit-styling ward walks every tracked
  text file, prose included (the shadcn verify journal hit this too), and
  `docs/projects/grapevine-ux/brief.md` named the class in its shadcn-rules
  parenthetical — so the branch's gate was red from the moment the brief was
  committed, before any code. Reworded to describe the class without writing it.
- ⚠ **`\b` over-matched the tooltip recipe.** The registry's tooltip arrow is
  the sentinel's stem followed by `.5` — a different utility — and `.` is a word
  boundary, so `\b<stem>\b` matched it. A registry file is not mine to edit and
  the class is not the sentinel, so the ward's regex gained a `(?![./-])`
  lookahead (a utility continues through `.`, `/` and `-`; it ends at
  whitespace, a quote or a bracket). Measured both ways: the tooltip recipe is
  clean, and a planted bare sentinel in a `.tsx` still registers. The ward's own
  header lists "use the sentinel outside `src/kit/`" as breakage route 5; this
  was route 5's false positive, and the comment above the regex now says so.

Second run: see the session record.

## 9. After the cold read — what a no-stake reader found, and what moved

The ward's fresh-agent re-run (a subagent given SKILL.md's watch text and the
live surface, nothing else; record in
`grimoire/fresh-agent/2026-09-05-grapevine-v2.1-watch-parity.md`): onboardable,
no blockers, and four things worth fixing before the branch is called done:

- **Who signs?** The You box read `verifier` while a lurker's edit was signed
  `cole` (Cole's rule, working as ruled) and nothing on the surface said so. The
  editor's placeholder and `title` now name the signer, the create dialog says
  `Set as <signer>.` once a topic is typed, and SKILL.md names the difference.
- **Focus after an act went to `body`** — after Enter/Escape in the editor, and
  after any menu item. The editor now restores focus to the topic line on a
  keyboard close only (a blur means focus already moved); a menu act refocuses
  the row's link. ⚠ **When the act hides the row** (archive with the filter off)
  the link still exists at the next frame and vanishes on the poll, so a
  `requestAnimationFrame` refocus lands and is then lost. The hand-off happens
  where the link leaves: the link's ref callback, on unmount, checks whether it
  was the active element and moves focus to the _Show archived_ switch — the
  control that brings the row back. Measured: `role=switch` active after the
  hidden archive; Space reveals the row; the next keyboard unarchive lands on
  the link.
- **The channel switch behind _Edit topic_ on another row** is now in SKILL.md.
- **The agent side**: create and topic edits look exactly like an agent's
  (`kind:"topic"`, the `from` is the tell); archive/unarchive emit no frame in
  either direction — parity, but silent — and `pull` on a deleted channel
  re-creates it. Backend, out of scope by ruling; filed as
  `docs/backlog/2026-09-06-grapevine-lifecycle-route-gaps.md` with the PUT
  `/topic` archived-check gap from §5.

One claim did not reproduce: "the switch has no accessible name" — the tree
reads `switch "Show archived (N hidden)"` through `<label for>`.

## 10. What I would tell the next agent (bounty, digestify)

1. **Read the handler, not the header.** `POST /channels`'s 409 is conditional
   on a body flag the header does not mention; `PUT /topic` has no archived
   refusal anywhere — not the daemon, and (the verify pass measured) not the CLI
   either — so run the claim before you build on it. The header is the map;
   parity is measured against the territory.
2. **Bring the poll forward; never write the state.** Every human action here is
   `fetch(...)` then `refreshChannels()`. The agent-driven rows were already
   written for "the poll says so", so the human path inherited them for free and
   the same-state check was a comparison, not a fix.
3. **Back up the variant file before `add`.** A registry dependency is a file
   the CLI wants to write, `--yes` does not answer the overwrite prompt, and a
   silent partial install (three of four files) is what you get.
4. **Keyboard menus: measure the event, not the key.** The menu key is native;
   Shift+F10 is not on macOS. Synthesize `contextmenu` from keydown and let the
   primitive do the rest.
5. **`aria-disabled` when the reason must be readable.** `disabled` kills the
   tooltip.
6. **Spend the cold read.** Five of the ten findings were things I could not see
   from inside the build (who signs, where focus goes after an act), and four
   were one edit each.

## 11. After verify — one inverted record, one landed race, and the fix chapter

The no-stake verify pass (`verify-journal.md`) came back "ship with fixes":

- ⛔ **The record error.** I had written, in five places, that the CLI's `topic`
  verb refuses an archived channel through its ensure's 409. It does not:
  `cli.ts:405` discards the ensure's response. I read the call and not the
  handling of its result; the verifier ran it. Every place now says what was
  measured, and the consequence is stated plainly: on topic-on-archived the
  surface is stricter than the agent path. The fresh-agent record had even
  logged "set a topic on `archived-one` from the CLI" without either of us
  reading those two lines together. Lesson, for the record: a parity claim about
  a verb is one `bun cli.ts <verb>` away from being a fact.
- ⚠ **The race lands.** Editor open → the agent archives → one poll → Enter: the
  PUT went out (200), a topic frame landed on the read-only channel, and focus
  fell to `body` because the disabled branch had no `buttonRef`. Fix: the editor
  cancels itself when the poll flips the channel to archived
  (`shouldCancelEdit`, a cell), `commit` re-reads the state and no-ops when
  disabled, and the disabled button carries the ref. Re-driven the verifier's
  way (the archive fired as `POST …/archive` from inside the script, between
  "editor open" and "Enter"): the editor closed on the poll with focus on the
  line, and Enter sent nothing — see the session record.
- **Silent failure → visible.** A failed _Unarchive instead_ now keeps the
  dialog open and puts the daemon's reason on the Name field; the hook returns
  the outcome instead of `void`.
- **Silent no-op → the promise kept.** A topic typed for a channel the rail
  already lists is followed by `PUT /topic` (the daemon's POST sets a topic only
  where none exists) — `createFollowUpTopic`, a cell; decision-logged with the
  alternative.
- **Focus after Close channel…** goes to `+` (the row is gone). ArrowDown at the
  menu's bottom does not wrap while ArrowUp at the top does — Base UI's default;
  the inventory row says so rather than fighting it.
- **One word for the act:** the menu item reads _Close channel…_, matching the
  dialog and the CLI's `close` (orchestrator's default, Cole may flip).

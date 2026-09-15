# Grapevine Conversion — the verify journal

**Status:** live · **Started:** 2026-09-05 · **Author:** the verify agent
(Claude Code, no stake — did not write the code) · **Branch:**
`feat/grapevine-conversion` at `81feb1a`

A cold drive of the behaviour inventory and a read of the diff, written in the
order it happened, for the agent who verifies the bounty or digestify conversion
next. What I ran, what I saw. `✅` = the claim held when run; `⚠` = a finding;
`⛔` = something the author's records did not say and I needed.

---

## 0. Orientation

Read, in order: `brief.md` (the "Done means" list is the contract),
`behaviour-inventory.md` (68 rows; author claims 52 browser / 9 test / 7 not),
`sessions/2026-09-05-the-rewrite.md`, `rewrite-journal.md`. Then
`git log --oneline develop..HEAD` — seven commits, five of them work.

Two daemons were running before I started and are not mine: pid 23127 (repo
checkout, non-tmp home) and pid 66902 (Cole's marketplace install). Every daemon
I spawn gets its own `GRAPEVINE_HOME=$(mktemp -d)`.

## 1. Pass 1 — run the claims

- ✅ `bun run gate` (backgrounded to a log, exit read from the log): **1627 pass
  / 0 fail / 4745 expect() / 128 files, exit 0** — matches the session record
  exactly. 192 s.
- ✅ `bun scripts/dist-check.ts`: 6 buildable spells, 20 tracked files, rebuild
  a git no-op (0 dirty paths). `git status --short` clean afterwards.
- ✅ `watch.html`: `git ls-files | grep -c watch.html` → 0; not on disk.
- ✅ No CDN: `grep -rniE "alpinejs|googleapis|cdn\.|unpkg|jsdelivr"` under the
  skill folder → no hits.
- ✅ Dist-roster claim: the skill's tracked files are SKILL.md,
  dist/{index.html, index-4kaadwkp.js, index-gkvapgeh.css},
  scripts/{cli,daemon,cli.test, release-serve.test}.ts. No `surface/`, no
  `bunfig.toml` on disk either.
- ✅ `DECLARED_BLIND` arithmetic, run rather than read: the object has 22
  entries summing to 3,723 (a one-line `bun -e` over the literal); the three
  grapevine files measure 74 / 23 / 2 with `wc -l`; the departed page was 1,000
  at `develop`. 4,624 + 99 − 1,000 = 3,723. The gate's own derivation cell
  agrees (it is in the 1627).

## 2. Pass 2 — the drive

**Instruments.** The Chrome extension was not connected in this session, so the
drive is Playwright MCP (the author's tool too). A daemon of my own:
`GRAPEVINE_HOME=<scratchpad>/home-rel`, `bun cli.ts open roundtable` → pid
26438, port 65505, `info` reports `mode: release`. A fixed-port proxy from the
first minute (`scratchpad/proxy.ts`, not committed — 40 lines, Bun.serve
pass-through that streams the SSE body, plus an `INJECT_BAD=1` switch that
prepends a malformed `subscribed` and `message` frame to every `/tail`), on
`127.0.0.1:47111`, so that every page load in this drive is on ONE origin and
E4/E6 need no second setup. ⛔ Neither record says: put the proxy in front from
the start, not when you reach E4 — the page keys `localStorage` per channel, not
per origin, but the EventSource reconnects to its own origin forever, so a drive
that starts on the daemon's port cannot drive E4 later without a fresh page.

**Load, lurk (release).** `/watch#roundtable` through the proxy: title
`grapevine · roundtable` (C2); requests in order `/watch`, the two hashed chunks
at the root (D1), `/identity` (R1 — no localStorage yet), then subscribers,
channels, `tail?since=0&lurk=1` (R2 lurk), then the 3 s polls (C13). The
original also awaited `/identity` before connecting — order kept. Status
`subscribed to roundtable` (E1), topic `design review` in the header (H2/H3 from
the `subscribed` event), one `system set topic` row with the dashed accent card
(F3 topic), roster `no one currently subscribed` (S1), `Join channel` disabled
with the alias blank (I5). Console: 0 errors, 0 warnings.

**⚠ FINDING 1 (severe) — the alias input cannot be typed into.**
`IdentityBox.tsx:25–33` commits on every `onChange` AND keys the `<Input>` by
the alias (`key={alias}` with `defaultValue`). Each keystroke changes `alias` →
changes the key → React unmounts and remounts the input → focus is lost after
the FIRST character. Run: click the box, `keyboard.type("cole", {delay: 60})` →
`activeElement` is `BODY`, the input's value is `c`, and
`localStorage["grapevine:alias"]` is `c`. Typing `co` + `le` + ` x` all end with
`c`. The original (`watch.html` 685–691) used `x-model` + `@change`, so it
committed once on blur/Enter and never remounted. Why the author did not see it:
Playwright's `fill()` fires ONE input event with the whole value, and the
`alias cole` CLI path pre-fills the box; neither types. Inventory I2 says
"`change` → I3", and the row is marked `both` — the row was driven by its
outcome (a stored alias), not by its mechanism. Fix shape (not applied — I
report): a controlled input (`value={alias}` — or local draft state) that
commits on `blur`/`change`, and no `key`.

**Join (release), via `fill()` — the author's path.** `fill("cole")` + blur →
`localStorage` `cole` (I3); Join enabled; click → status
`joined roundtable as cole` (E1), input disabled (I2), label
`Joined — click to lurk` (I5), composer with `message as cole…` (P1/P4), send
disabled on empty (P5), `grapevine:mode:roundtable = join` (I4/I6). CLI `who` →
`subscribers:["cole"], humans:["cole"]` (I7 join arm). ⚠ minor: the roster still
read `no one currently subscribed` 800 ms after the toggle — the immediate
`refreshSubscribers()` races the EventSource's registration (the original had
the same ordering, `connect(); refreshSubscribers()`); the 3 s poll fixed it.
S3's "without waiting" is true of the CALL, not reliably of the result, in both
pages.

**Feed (release).** Seeded from the CLI: a body with a newline, a 100-char body,
a reply to it, a reply to id 999 (no parent), an `announce`, and a
`tail --as agent-c` subscriber. All read from the DOM in one `evaluate`:

- F2 ✅ `white-space: pre-wrap`, body `hello\nworld`.
- F3 ✅ topic: dashed `border-grape`, italic, `system set topic`; announcement:
  `border-attention bg-announce-wash` wrapper, from reads `agent-a · announced`.
- F4 ✅ quote `↳ agent-a xxxx…`; **F8 driven in the browser**: the snippet is 81
  characters (80 + `…`) — the author marked F8 test-only.
- F5 ✅ the reply to 999 has `ml-6` and no quote.
- F6 ✅ reply buttons on every non-topic row in join mode.
- F7 ✅ `agent-a` is `rgb(232,125,184)` on both its rows; `agent-b` differs.
- S2 ✅ roster `agent-c`, `cole (you)` after the poll; C8 ✅ count badge 2.
- P3 ✅ banner `↳ replying to agent-a hello\nworld ✕`, textarea focused; ✕
  clears it. P4 ✅ `line1` Shift+Enter `line2` → draft `line1\nline2`, Enter
  sends. P6 ✅ draft and banner cleared; the row arrives over the stream as a
  reply (`ml-6`, quote), 7 rows. No optimistic insert (row count moved only
  after the stream delivered).
- E3 ✅ both arms, release: 20 CLI sends 150 ms apart → the feed followed (gap 1
  px at the end); `scrollTop = 0` then one send → `scrollTop` stayed 0 and the
  row was appended. (The burst quirk the author recorded was not re-run; it is
  documented as shared with the original.)

**Reconnect cluster (release, proxy).** `kill <proxy>` with the page joined:

- T2 ✅ dot `bg-attention` = rgb(240,178,101), text
  `disconnected — reconnecting…`.
- X1 ✅ rail (`roundtable 2`) and roster (`agent-c`, `cole (you)`) kept their
  last values while every poll was `ERR_CONNECTION_REFUSED`. Console: 30 errors,
  ALL `Failed to load resource: net::…` — no JS exception anywhere.
- N2 ✅ every retry carried `since=28` (the highest id at the cut); retries ~1 s
  apart (17 attempts over the outage).
- Two sends straight to the daemon's port during the gap (ids 29, 30); proxy
  restarted → E4/F9 ✅ both arrived exactly once, in order, after
  `after scroll-up`; 30 rows, no duplicates; status back to
  `joined roundtable as cole`, dot leaf rgb(87,201,122).
- ⛔ Note for the next verifier: the first `tail` after Join is
  `since=<highest at join>`, not `since=0` — the feed is not reset on a mode
  toggle, only on a reload. Same as the original; do not read it as a bug.

**Rail, toggles, archive (release).**

- C6 ✅ `open other` + `open grapevine-v1.7` while the page was up: a 40 ms poll
  of the rail caught BOTH new rows with `animate-flash`; `roundtable` (seen on
  the first poll) did not flash. C4 ✅ hrefs `#other`, `#grapevine-v1.7`; C5 ✅
  only the current row carries the active classes.
- E5 ✅ six Join/lurk clicks 30 ms apart → exactly six new `tail` requests, ends
  joined; one CLI send afterwards → exactly one new row (31); `who --all` → 2
  connections (agent-c + cole), so one stream alive.
- C7 ✅ `archive other` → 🔒 with title `archived — read-only`, name muted
  (`text-ink-dim`) within a poll.
- **P6 failure arm / X2 — driven** (the author marked both `not`): with the
  reply banner up and a draft filled, a Playwright `page.route` answered the
  POST with **409** → draft AND banner kept; then `route.abort()` (the thrown
  arm) → draft and banner kept again. The daemon's own arm shown with curl:
  `POST /channels/roundtable/messages` on the archived channel → 409
  `{"error":"archived"}`. ⛔ The REAL race (archive between typing and Enter,
  inside the 3 s poll window) is not reachable with sequential tool calls — the
  bash archive lands before the browser's next step; `require` is not available
  inside `browser_run_code_unsafe`, so the CLI cannot be called from inside the
  page script either. `page.route` is the instrument.
- C12 / P2 / F6-absent ✅ `archive roundtable` (the current channel): within a
  poll the composer is gone, the note `🔒 this channel is archived — read-only`
  is at the foot, 0 reply buttons on 32 rows, the rail row shows the lock. Mode
  is still `join` (status unchanged) — as the original.
- R7 — sharpened, not driven: the daemon's channel grammar is
  `^[a-zA-Z0-9_-]([a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?$` (`daemon.ts:192`), and
  every character in it is URL-unreserved, so `encodeURIComponent` is a no-op
  for every name the daemon will accept (`open "odd name"` →
  `invalid channel name`). The row cannot be driven on the wire by construction;
  the unit cells are the right home. The inventory's reason ("no odd channel
  name") understates this — it is not that one was not tried.
- C10 / C11 / R5 ✅ non-current: hover reveals 🗑 with title
  `Close channel “grapevine-v1.7” (deletes message log)`; the AlertDialog
  carries the original's confirm text verbatim; Cancel → dialog gone, row stays;
  confirm → `DELETE /channels/grapevine-v1.7` 200, row gone, `list` no longer
  has it.
- **C10 current-channel arm — driven** (the author did not): close `roundtable`
  from inside it → `#lobby`, `navigation[0].type === "reload"` (C3 ✅ — the hash
  change is a real reload), title `grapevine · lobby` (C1 ✅ the `lobby` default
  lands), `subscribed to lobby`, topic `no topic set` (H2 ✅ placeholder), feed
  `🌿 Waiting for messages on this channel…` (F1 ✅), toggle `Join channel` (I4
  ✅ — join was remembered for roundtable, NOT for lobby), alias box `cole` with
  NO `/identity` fetch (I1/R1 ✅ the localStorage override wins and the fetch is
  skipped).
- ⛔ Observed in passing: 1.5 s after that reload the rail listed only `other` —
  the first `/channels` poll ran before the subscribe had auto-created `lobby`.
  So C9's "window shorter than one poll" is not true in general: with a HOME
  that has zero channels, the first paint SHOULD show `no channels yet` for up
  to 3 s. Driven below on the dev daemon.
- R1 ✅ `alias verifier` on the CLI, `localStorage.removeItem`, a REAL load
  (`?fresh=1#lobby` — the query string changes so it is a navigation, per the
  author's gotcha) → `/identity` fetched, box `verifier`, Join enabled.
- I3 ✅ `fill("")` + blur → localStorage key REMOVED (null, not ""), Join
  disabled (I5 blank arm); `fill("override-me")` + blur → stored; next real load
  → box `override-me` and NO `/identity` fetch (I1 ✅ override wins).
- C1 ✅ all three arms in the browser: `/watch` (no hash) and `/watch#` (bare)
  both title `grapevine · lobby` — the author had the bare `#` arm test-only.
- ⛔ `pull <name>` and `open` both CREATE the channel; `info` and `list` do not
  spawn a daemon. To get a daemon with ZERO channels for C9: `pull zzz` then
  `close zzz`. (`watch` would spawn too but opens a browser.)

**Dev mode.**
`SPELLBOOK_SURFACE_MODE=dev GRAPEVINE_HOME=<fresh> bun cli.ts pull zzz` spawns
the daemon (`lsof -d cwd` → `src/grapevine`, Contract 5 via the CLI's
`daemonCwd()`), `GET /` → `mode: dev` (D5 ✅). `close zzz` → zero channels.

- **C9 — driven** (the author marked `not`): first paint of `/watch#lobby` on
  the empty HOME, rail sampled every 30 ms: `no channels yet` from 46 ms until
  3,062 ms, then `lobby 0`. The window is a full poll, not "shorter than one
  poll" — the first `/channels` fetch goes out BEFORE the tail's subscribe
  auto-creates `lobby`, and the next poll is 3 s away.
- D2 ✅ the page links `/_bun/asset/<hash>.css`; header channel span
  rgb(166,226,183) = `--color-leaf-soft`; body rgb(14,20,16) = `--color-bg`.
- Join / Shift+Enter / send ✅ in dev (`joined lobby as dev-cole`, draft
  `dev a\ndev b`, row arrived, draft cleared). Console clean.
- T2 in dev ✅ `kill <dev pid>` → attention dot +
  `disconnected — reconnecting…`. (A respawned daemon gets a NEW port, so
  "reconnect after restart" is only drivable through the proxy — release did it
  above.)

**E6 — driven** (the author marked `not: no emitter`). The proxy's
`INJECT_BAD=1` prepends `event: subscribed\ndata: {this is not json` and
`event: message\ndata: <<<garbage>>>` to every `/tail` body (verified with
`curl -N`). Fresh load through it: status `subscribed to roundtable` (the real
`subscribed` frame after the bad one landed), 0 rows (garbage never rendered),
topic placeholder intact, dot leaf, console **0 errors** — the parse failures
are caught. A CLI send afterwards rendered (`stream survived`), so the bad
frames did not break the stream. E7 ✅ 10.5 s idle on the same page: status, row
count and dot unchanged (the `: hb` comments are invisible). I7 lurk arm ✅ that
send reported `0 recipient(s)` while the page lurked; `who` shows only `bob`.

- S2 ✅ `tail --human --as bob` → roster `bob (human)`.
- **H3 poll source — isolated** (the author: "the poll source not isolated"):
  `page.route("**/tail**", abort)` + a proxy cycle to drop the live stream → the
  page sits in `disconnected — reconnecting…` while its 3 s polls still reach
  the daemon; `topic roundtable "poll only"` on the CLI → the header read
  `poll only` (non-italic) with ZERO rows added (no topic message could arrive).
  `unroute` → reconnect `since=1`, the topic row replays. Three sources, all
  three now driven.
- ⛔ Instrument note: `page.route` blocks only NEW requests; an open EventSource
  keeps streaming. To isolate a poll from the stream, route first, THEN cut the
  stream (proxy cycle or daemon kill).

**Not driven by me:** E3's burst quirk (documented as shared with the original,
not re-measured); D3/D4/X3 (test-only by nature — a copied tree without source;
the cells are in `release-serve.test.ts` and ran green in the gate); P7 (a no-op
guard, covered by P1/P5); R7 (unreachable on the wire, see above). The real-time
409 race for P6 (archive between typing and Enter) — the client arm was driven
with `page.route`, the daemon arm with curl; the two halves were not driven as
one act.

**Drive tally.** Of the 52 rows the author marked browser-driven I re-drove 41
in release and 6 of those again in dev; of the 7 marked `not`, I drove C9, E6,
F8, P6-failure, X2 and C10's current-channel arm — 6 of 7; the seventh (R7) is
undrivable by construction. H3's un-isolated poll source and C1's bare-`#` arm
were also driven.

## 3. Pass 3 — the cold read of the diff

`git diff develop..HEAD -- src/grapevine plugins/spellbook/skills/grapevine grimoire scripts`,
read against `git show develop:…/watch.html`.

Checked and held:

- `styles.css` opens `@import "tailwindcss" source(none)` / kit `base.css` /
  `@source "./"` — literal, as the scope ward wants. L1 aliases are `var()` onto
  tokens; L2 is the eleven `:root` properties by role plus three the page had
  inline. The only raw hex outside `@theme` is the pre-boot
  `background-color: #0e1410` in `index.html:13` (a copy of `--color-bg`, in a
  declared-blind file, with a comment saying why; it will drift silently if the
  token ever changes — minor).
- `cn()` is the kit's (`../../../kit/lib/cn`) in every component and every
  vendored primitive; no local copy.
- Primitives: Button (with `primary`/`accent`/`joined` variants), Badge
  (`count`), Input, Textarea, AlertDialog on `@base-ui/react`. The reply
  banner's ✕, the rail's 🗑, the reply button, send, the toggle — all `Button`.
  No hand-rolled button/input/dialog. The rail rows are `<a>` (as the original).
  The AlertDialog replaces `window.confirm` with the same text
  (decision-logged).
- Daemon: `resolveMode()` on the FILE `dist/index.html`; env override wins; dev
  is a dynamic string-literal import (the one pinned specifier, and
  `import-boundary-wards` gained the triple); release `/watch` →
  `serveDist("index.html")` else a 500 JSON naming the path; the root
  fall-through is release-only and refuses `/` and `..`. Neither-resolves: no
  dist → mode dev → the import throws before `ensureDirs()` → no port/pid files
  (the forced-dev cell asserts exactly that). Loud, not blank.
- `cli.ts` `daemonCwd()` is glamour's shape; the existsSync guard fires before
  spawn with a message naming the missing cwd.
- `tsc -p . --noEmit` → 435 error lines, 0 TS2307 — the author's numbers.
- Tests that assert less than their name claims: ONE.
  `release-serve.test.ts:211–228` "daemonCwd() picks the skill root in release
  and src/grapevine in dev" — the third assertion is
  `expect(daemonCwd()).toBe(existsSync(dist) ? SKILL_SRC : daemonCwd())`, whose
  else-branch compares a value to itself. The forced arms above it are real; the
  unforced arm is vacuous when `dist/` is absent. Minor. `dev-styled.test.ts`'s
  positive control is a genuine control.

**Behaviour in the old page with a different home or no home:**

1. **Alias commit semantics** — the old `@change` committed once, on blur/Enter;
   the new `onChange` commits per keystroke AND remounts the input (Finding 1,
   severe, reproduced above). `IdentityBox.tsx:25–33`.
2. `.row.archived .name` was muted whether or not the row was active; the new
   rail mutes only `!active` (`ChannelRail.tsx:62`). Cosmetic, under the restyle
   ruling, but it is a behaviour the inventory (C7) does not pin either way.
3. The composer textarea kept `max-height: 160px` with `rows="1"` and no
   auto-grow in the old page; the new one has `max-h-40` — same. No gap.
4. `word-wrap: break-word` on the body → `break-words`. Same.

**Inventory gap analysis — behaviours in `watch.html` without a row:**

- **I2 is under-specified**: "`change` → I3" does not say _only on change_, and
  "driven" was judged by the stored value, not by typing. That is the gap
  Finding 1 walked through. A row should read: "alias commits on blur/Enter,
  never per keystroke; the field keeps focus while typing."
- The message key `m.id ?? idx` (line 579) — a message without a numeric id is
  keyed by index (E2 covers `highest`, not rendering). Test-covered in
  `feed.test.ts` incidentally; no row.
- The initial `document.title` is the static `grapevine` before `init()` sets it
  (C2 covers the final value only).
- The composer's `Enter` handler is keydown-only, so IME composition is not
  handled (neither page does) — no row, and none needed unless a CJK alias ever
  types here.
- The archived-row active/muted interaction (item 2 above).
- `refreshSubscribers()` immediately after a toggle can race the stream's
  registration (S3, noted in §2) — the row says "without waiting", the original
  did not guarantee it either. Worth a caveat on the row.

**Session-record claims that did not hold when run:**

- "52 rows driven in a browser" — I2's drive did not exercise typing; the row's
  `both` masks a regression. Every other row I re-drove held.
- "SKILL.md unchanged — behaviour is the same" — true of SKILL.md, but
  `docs/PROJECT-SUMMARY.md:261` ("Alpine-CDN (bounty, digestify, grapevine
  watch)") is still stale after the wards commit that said it fixed the three
  listings (Finding 2, minor; `.anthill/dev/circe.md` and the seat README carry
  the same phrase, which is seat-doc territory).
- The `not` reasons for C9, E6, P6/X2, F8, C10-current: all five were drivable
  with the instruments above; only R7's is sound (and for a stronger reason than
  the row gives).

## 4. Verdict, and what to keep

**Ship with fixes.** One behavioural regression (Finding 1) that a human at the
keyboard hits on the first use of the You box; one stale listing. Every route,
event, timer, persisted key, silent branch and visible state otherwise matched
the original when run.

Three things the next verifier should take from this file:

1. **Type, don't fill.** `fill()` is one input event; `keyboard.type()` is the
   human. A controlled-input regression is invisible to `fill()`.
2. **Put the fixed-port proxy in front from the first load** and give it an
   injector switch; it drives E4, E6, X1, N2, F9 and H3 without a second setup.
   `page.route` handles the failure arms (409/abort) and stream isolation;
   `require` is not available inside `run_code`.
3. **A `not: <why>` row is a claim to run.** Five of seven fell to one poll of
   the rail, one injected frame, one routed 409, one 100-char message and one
   click on the current channel's 🗑.

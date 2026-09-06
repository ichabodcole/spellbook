# Grapevine watch surface — behaviour inventory

**Created:** 2026-09-05 · **Extracted from:**
`plugins/spellbook/skills/grapevine/scripts/watch.html` at `0bceaf6` (1,000
lines; markup 515–706, script 707–998) · **Purpose:** the oracle for the React
rewrite at `src/grapevine/surface/`. One row per observable behaviour, with the
line range that implements it and how to drive it against a real daemon.

The **Driven** column is filled by the implementing agent (dev + release) and
re-filled by a verify agent who did not write the code. Values: `dev`,
`release`, `both`, `test` (covered by an automated cell — name it), or
`not: <why>`.

## How to drive it

```sh
# a scoped daemon, so a live ~/.grapevine daemon is never touched
export GRAPEVINE_HOME=$(mktemp -d)
CLI=plugins/spellbook/skills/grapevine/scripts/cli.ts
bun $CLI open roundtable                           # creates the channel
bun $CLI topic roundtable "design review"          # sets its topic
bun $CLI watch roundtable                          # opens http://127.0.0.1:<port>/watch#roundtable
bun $CLI send roundtable --from agent-a "hello"    # a message
bun $CLI send roundtable --from agent-b --in-reply-to 1 "hi back"   # a threaded reply
bun $CLI tail roundtable --as agent-c              # a named subscriber in the roster
bun $CLI archive roundtable                        # the archived state
bun $CLI alias cole                                # the /identity default
```

Mode: the daemon's `GET /` reports `mode`; release iff
`plugins/spellbook/skills/grapevine/dist/index.html` exists, else dev; the env
`SPELLBOOK_SURFACE_MODE=dev|release` overrides. To drive **dev** in a checkout
that has a committed `dist/`, export the override before the first verb that
spawns the daemon.

## Routes the surface calls

| ID  | Behaviour                                                                                                              | `watch.html`            | Drive                                                           | Driven |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- | ------ |
| R1  | `GET /identity` on init, **only when** no `localStorage["grapevine:alias"]`; `j.alias` (if truthy) pre-fills the alias | 751–757                 | `alias cole`, clear localStorage, reload → You box shows `cole` |        |
| R2  | `GET /channels/<c>/tail?since=<highest>` + `&as=<alias>&human=1` (join) or `&lurk=1` (lurk); an `EventSource`          | 818–824                 | Network tab on load (lurk) and after Join (as+human)            |        |
| R3  | `GET /channels/<c>/subscribers` → `subscribers[]`, `humans[]`, `topic`                                                 | 868–878                 | roster changes within 3 s of a `tail --as`                      |        |
| R4  | `GET /channels` → channel list (`name`, `subscribers`, `archived`)                                                     | 880–903                 | `open other` → appears within 3 s                               |        |
| R5  | `DELETE /channels/<name>` from the close button                                                                        | 905–921                 | close a channel; `list` no longer shows it                      |        |
| R6  | `POST /channels/<c>/messages` `{from, text, in_reply_to?}` with `content-type: application/json`                       | 972–995                 | join, send; `tail` sees it                                      |        |
| R7  | Channel name is `encodeURIComponent`-ed in every route above                                                           | 549, 822, 871, 911, 979 | a channel with a `.` or unicode name; routes still resolve      |        |

## SSE events consumed

| ID  | Behaviour                                                                                                                                                                                            | `watch.html`                 | Drive                                                                                | Driven |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ------ |
| E1  | `subscribed` → if `d.topic !== undefined` set topic; status text becomes `joined <c> as <alias>` (join) or `subscribed to <c>` (lurk)                                                                | 825–835                      | load page → status bar text; topic header fills                                      |        |
| E2  | `message` → parse; `highest = max(highest, m.id)` (numeric ids only); push to list; index by id; `kind === "topic"` also sets the header topic                                                       | 836–850                      | `send` → row appears; `topic` verb → header updates                                  |        |
| E3  | Auto-scroll after append **only if** the viewport was within 80 px of the bottom before the push; reading history is never interrupted                                                               | 842–854                      | scroll up, `send` → no jump; scroll to bottom, `send` → follows                      |        |
| E4  | `error` → `disconnected = true`; status `disconnected — reconnecting…`; close the stream; reconnect after 1 s with `since=highest` (so nothing sent during the gap is lost)                          | 857–865                      | `stop` the daemon → status turns warn; run any verb to respawn → reconnects, backlog |        |
| E5  | **Generation guard**: every handler ignores events whose stream generation is not the current one, so a superseded `EventSource` (after toggle or reconnect) can neither render nor double-reconnect | 743, 806, 826, 837, 858, 863 | toggle join/lurk rapidly → exactly one stream alive, no duplicate rows               |        |
| E6  | Malformed event data is swallowed (`try/catch {}`), never rendered, never breaks the stream                                                                                                          | 827–834, 838–855             | `test`-only (no CLI path emits malformed frames)                                     |        |
| E7  | The daemon's `: hb` comment frames are ignored (standard `EventSource` behaviour; no client code)                                                                                                    | —                            | idle 10 s → no rows, no status change                                                |        |

## Channel selection and the rail

| ID  | Behaviour                                                                                                                                                                                                               | `watch.html`              | Drive                                                                                  | Driven |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- | ------ |
| C1  | Channel = `decodeURIComponent((location.hash \|\| "#lobby").slice(1)) \|\| "lobby"` — no hash and `#` alone both mean `lobby`                                                                                           | 712–713                   | `/watch`, `/watch#`, `/watch#roundtable`                                               |        |
| C2  | `document.title = "grapevine · <channel>"`                                                                                                                                                                              | 746                       | tab title                                                                              |        |
| C3  | `hashchange` → `location.reload()` — switching channels is a full reload (stream + list reset)                                                                                                                          | 774–777                   | click another channel in the rail → page reloads on the new channel                    |        |
| C4  | Rail rows are links to `#<encodeURIComponent(name)>`                                                                                                                                                                    | 549                       | hover a row; click → C3                                                                |        |
| C5  | Active row (name === current channel) highlighted                                                                                                                                                                       | 547, 150–152, 170–173     | current channel reads as selected                                                      |        |
| C6  | A channel that first appears on a poll **after** the first one flashes (`isNew`); the first poll never flashes                                                                                                          | 884–896, 153–155, 214–222 | `open other` while the page is up → row flashes once                                   |        |
| C7  | Archived channel: 🔒 with title `archived — read-only`, muted name                                                                                                                                                      | 552–557, 416–418          | `archive other` → lock appears within 3 s                                              |        |
| C8  | Subscriber count badge = `c.subscribers ?? 0`                                                                                                                                                                           | 558, 181–195              | `tail --as x` → count ticks                                                            |        |
| C9  | Empty rail: italic `no channels yet`                                                                                                                                                                                    | 537–542                   | fresh `GRAPEVINE_HOME`, load `/watch` before lobby is opened — brief window; or `test` |        |
| C10 | Close button (🗑, hover-reveal, title `Close channel “<name>” (deletes message log)`): confirm → `DELETE`; forget it from the seen set; refresh; if it was the current channel, `location.hash = "lobby"` (→ C3 reload) | 561–567, 905–921          | close a non-current channel → gone; close the current one → lands on lobby             |        |
| C11 | Confirm text: `Close channel "<name>"? This deletes its message log and disconnects any subscribers. This cannot be undone.`; cancel does nothing                                                                       | 906–909                   | cancel → channel remains                                                               |        |
| C12 | `channelArchived` is derived from the channel list for the current channel each poll; gates the composer (P1/P2) and the reply button (F6)                                                                              | 897–900                   | `archive` the current channel → composer disappears within 3 s                         |        |
| C13 | Rail and roster re-poll every 3 s (two independent intervals), plus once on init                                                                                                                                        | 766–773                   | timing of C6/C7/C8/S3                                                                  |        |

## Header and topic

| ID  | Behaviour                                                                                                | `watch.html`   | Drive                                                 | Driven |
| --- | -------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------- | ------ |
| H1  | Header: 🌿, `grapevine · <channel>`                                                                      | 516–522        | visual                                                |        |
| H2  | Topic line: the topic, or italic placeholder `no topic set`                                              | 523–529, 85–87 | fresh channel → placeholder; `topic` verb → text      |        |
| H3  | Topic has three sources, last write wins: `subscribed` event, subscribers poll, a `kind:"topic"` message | 829, 850, 876  | set via CLI while page is up → updates without reload |        |

## Message feed

| ID  | Behaviour                                                                                                                                                                                                          | `watch.html`      | Drive                                      | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------ | ------ |
| F1  | Empty feed: 🌿 + `Waiting for messages on this channel…` while `messages.length === 0`                                                                                                                             | 575–578           | fresh channel                              |        |
| F2  | Row: `from` in the alias colour, timestamp `HH:MM:SS` (locale, 2-digit), body in a card with `white-space: pre-wrap`                                                                                               | 599–614, 790–797  | `send` with a newline in the text          |        |
| F3  | `kind` styling: `message` = card; `topic` = dashed accent border, italic, and `from` reads `<from> set topic`; `announcement` = warn left border and `from` suffixed ` · announced`; `status` = no special styling | 582, 603, 261–281 | `topic` verb, `announce` verb              |        |
| F4  | Threaded reply with a resolvable parent (`msgById(in_reply_to)`): quote line `↳ <parent.from> <snippet>` above the row                                                                                             | 585–598, 370–384  | send a reply to id 1                       |        |
| F5  | Any row with `in_reply_to != null` is indented (`is-reply`) — even if the parent is not in the list                                                                                                                | 582, 367–369      | reply to an id outside the loaded backlog  |        |
| F6  | Reply button (hover-reveal) on a row iff `mode === "join"` and `kind !== "topic"` and channel not archived; click → P3 and focus the composer                                                                      | 606–612, 941–944  | lurk → no button; join → button            |        |
| F7  | Alias colour is deterministic: `hsl(hash(alias) mod 360, 70%, 70%)` — same alias, same hue, in the feed, the roster, the quote and the reply banner                                                                | 781–789           | two messages from one alias share a colour |        |
| F8  | Snippet = first 80 chars + `…` when longer                                                                                                                                                                         | 938–940           | reply to a long message                    |        |
| F9  | Backlog on connect: `since=0` on first load renders the whole log; `since=highest` on reconnect renders only what was missed                                                                                       | 822, 840–841      | reload → full history; E4 → only the gap   |        |

## Composer (join mode only)

| ID  | Behaviour                                                                                                                                                                                      | `watch.html`     | Drive                                                             | Driven |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- | ------ |
| P1  | Composer visible iff `mode === "join"` and channel not archived; sticky to the bottom of the feed                                                                                              | 620, 320–326     | lurk → hidden; join → shown                                       |        |
| P2  | Archived channel: `🔒 this channel is archived — read-only` note instead (in either mode)                                                                                                      | 617–619, 419–428 | `archive` current channel                                         |        |
| P3  | Reply banner above the box while `replyingTo`: `↳ replying to <from> <snippet>` and a ✕ (`aria-label="Cancel reply"`) that clears it                                                           | 621–641          | click reply; click ✕                                              |        |
| P4  | Textarea placeholder `message as <alias>…`; **Enter sends, Shift+Enter inserts a newline**; the form's submit also sends                                                                       | 642–655          | type, Enter → sent; Shift+Enter → newline                         |        |
| P5  | Send button disabled while `draft.trim()` is empty                                                                                                                                             | 656–660          | empty/whitespace draft                                            |        |
| P6  | Send: `POST` R6 with `in_reply_to` when replying; **on `r.ok` only** clear the draft and the reply state; on failure the draft is kept; no optimistic insert — the row arrives over the stream | 972–995          | send → row arrives via SSE; `archive` then send → 409, draft kept |        |
| P7  | Send is a no-op unless join mode and non-empty text                                                                                                                                            | 973–974          | covered by P1/P5                                                  |        |

## Roster ("On the line")

| ID  | Behaviour                                                                                                                 | `watch.html`     | Drive                                                                    | Driven |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ | ------ |
| S1  | Empty: italic `no one currently subscribed`                                                                               | 670–675          | lurking alone (lurkers are never counted)                                |        |
| S2  | Entry: a dot + label in the alias colour; label is `<a> (you)` if `a === alias`, `<a> (human)` if in `humans`, else `<a>` | 676–679, 927–931 | join → `you`; `tail --human --as bob` → `(human)`; `tail --as x` → plain |        |
| S3  | Refreshed by the 3 s poll, on init, and immediately after a join/lurk toggle                                              | 766, 772, 969    | toggle → roster updates without waiting                                  |        |

## Identity and lurk / join

| ID  | Behaviour                                                                                                                                                                                      | `watch.html`     | Drive                                                        | Driven |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------ | ------ |
| I1  | Alias initial value: `localStorage["grapevine:alias"]`, else R1's `/identity`, else empty                                                                                                      | 736, 751–757     | R1                                                           |        |
| I2  | Alias input (`placeholder="set an alias"`) is **disabled in join mode**; `change` → I3                                                                                                         | 685–691          | join → input greyed                                          |        |
| I3  | `setAlias`: trim; non-empty → `localStorage.setItem("grapevine:alias")`; empty → `removeItem` (so the next load falls back to `/identity`)                                                     | 946–952          | clear the field, reload → `/identity` value returns          |        |
| I4  | Mode defaults to **lurk**; restored to join iff `localStorage["grapevine:mode:<channel>"] === "join"` **and** an alias resolved — per channel                                                  | 761–764          | join, reload → still joined; switch channel → lurk           |        |
| I5  | Toggle button label: `Join channel` (lurk) / `Joined — click to lurk` (join); disabled in lurk while the alias is blank; "joined" styling when joined                                          | 692–698, 490–512 | blank alias → disabled                                       |        |
| I6  | `toggleMode`: lurk→join requires a non-blank alias (commits it via I3); join→lurk; persists the choice for this channel; **reconnects the stream** (R2 params change) and refreshes the roster | 954–970          | toggle → new tail request in Network; roster shows/hides you |        |
| I7  | In join mode the stream registers named + human presence; in lurk it registers **no** presence — lurking is invisible to `who` and to the count badge                                          | 818–821          | lurk → `who` shows nobody; join → shows you                  |        |

## Status bar and connection

| ID  | Behaviour                                                                                                                        | `watch.html`               | Drive | Driven |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- | ------ |
| T1  | Sticky bottom bar: pulsing green dot + text; initial `connecting…` → `connecting to <c>…` on connect → E1's text on `subscribed` | 703–705, 715, 809, 293–310 | load  |        |
| T2  | Disconnected: dot turns warn colour, text `disconnected — reconnecting…`                                                         | 311–313, 859–860           | E4    |        |
| N1  | `connect()` closes any prior stream first, bumps the generation, clears `disconnected`                                           | 803–810                    | E5    |        |
| N2  | Every (re)connect passes `since=highest`                                                                                         | 822                        | F9    |        |

## Error handling (what is deliberately silent)

| ID  | Behaviour                                                                                                                                                         | `watch.html`            | Drive                                                         | Driven |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------- | ------ |
| X1  | Every `fetch` (`/identity`, subscribers, channels, close, send) swallows its error; the only visible failure state is T2                                          | 756, 877, 902, 914, 994 | kill the daemon → polls fail silently, lists keep last values |        |
| X2  | A failed send (non-2xx or thrown) keeps the draft and the reply state                                                                                             | 990–994                 | P6                                                            |        |
| X3  | **Daemon side:** `GET /watch` returns `500` JSON `{error:"watch.html missing", details}` when the file is absent — replaced by dev/release resolution (see below) | daemon.ts 490–505       | `test`                                                        |        |

## Route contract after the port (new rows, daemon side)

| ID  | Behaviour                                                                                                                                 | Drive                                                                  | Driven |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| D1  | Release (`dist/index.html` present): `GET /watch` serves `dist/index.html`; its hashed `./index-<hash>.{js,css}` resolve at the root      | copied tracked subtree with a `dist/`; browser renders                 |        |
| D2  | Dev: `GET /watch` is Bun's HTML bundle of `src/grapevine/surface/index.html`, styled (Tailwind via `bunfig.toml` in cwd `src/grapevine/`) | `SPELLBOOK_SURFACE_MODE=dev`; the stylesheet carries a surface utility |        |
| D3  | Forced dev with no surface source dies loud naming `src/grapevine/surface/index.html`, before writing the port/pid files                  | `test`                                                                 |        |
| D4  | Nested paths and unknown bare filenames 404 from the static fall-through; existing JSON routes are untouched                              | `test`                                                                 |        |
| D5  | `GET /` carries `mode`, and the boot line names it                                                                                        | `info` verb / stderr                                                   |        |

## Visible states — a checklist for the verify agent

- empty rail (C9) · empty feed (F1) · empty roster (S1)
- topic placeholder (H2) vs topic (H3)
- lurk (P1 hidden, I2 enabled, I5 `Join channel`) vs join (composer, `(you)`, I2
  disabled)
- archived channel (C7 in the rail, P2 in the feed, F6 absent)
- reply banner (P3) and a threaded row (F4, F5)
- new-channel flash (C6)
- connected (T1) vs disconnected (T2) vs reconnected with the gap replayed (E4,
  F9)
- topic / announcement / status message kinds (F3)

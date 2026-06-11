# Grapevine V1.7 — Human as First-Class Participant

**Status:** Draft **Created:** 2026-05-27 **Author:** Cole

---

## Overview

V1.7 promotes the human from "observer who can't write" to a first-class
participant in the grapevine channel. The watch surface evolves from a read-only
chat-bubble view into a real control plane: send messages, join under a real
alias, choose between lurking and participating, address individual agents
directly, and archive channels without losing their history.

The unifying theme is **closing the participation gap**. In V1.5/V1.6 the human
had two modes: watch from the browser (read-only) or open a terminal and pretend
to be an agent. V1.7 makes the human a real participant in the channel — visible
to agents, addressable, and able to steer without context-switching.

A bigger scope than V1.6 by design. V1.6 was three additive tweaks; V1.7
introduces new concepts (identity, lurk-vs-join, direct addressing, archive vs
close) that need a coherent design pass before code.

## Problem Statement

Several friction points all share the same root cause — the human can't fully
participate from the surface they're already in (the watch UI):

- **Read-only watch UI.** To answer a question or steer direction, the human has
  to context-switch to a terminal, remember the CLI flags, and send. This breaks
  flow and makes them less likely to step in for small things.
- **Identity ambiguity.** Agents currently see "another anonymous subscriber"
  when the human's watch tab connects. They have no way to know whether the
  human is actively engaged, lurking, or has stepped away. From the agent side,
  "is the human still here?" is unanswerable. From the human side, "are the
  agents addressing me?" relies on guesswork.
- **All-broadcast messaging.** Every message goes to everyone on the channel,
  even when the human (or an agent) wants to ask one specific agent something
  without inviting the others' attention. The workaround is to open a
  sub-channel, which is heavy for a one-off question.
- **`close` is destructive.** When a multi-day collaboration finishes, the only
  options are leave it lying open (clutters `list`, ghosts in `who`) or delete
  it (loses the full history). There's no "I'm done with this, preserve the
  record but don't let anything new happen" state.
- **Threading drift.** As channels pass ~20 messages, "which message am I
  responding to" starts loading on memory + ordering (raised in #129). The lack
  of `in_reply_to` is a paper cut today; it'll be a problem when V1.7 unlocks
  longer-lived denser channels.

Each problem can be solved separately, but they share a design axis: how does
the human and their identity sit inside the channel? Solving the participation
problem properly forces the identity question, which forces the visibility/lurk
question, which dovetails with the V2 emissary spike. Better to handle them as
one coherent V1.7 design than piecemeal.

## Proposed Solution

> **Resolved decisions (2026-06-11), from live V1.6 friction.** Building V1.7
> phase 1 ("human as participant") surfaced two refinements that **override the
> sketch below**:
>
> 1. **Human gets a marker, not symmetric identity.** The sketch (feature #1)
>    said "no special 'human' type — channels stay symmetric." Reversed:
>    presence carries an optional `role`, so `who` / the watch / agent tail can
>    show `cole (human)`. The live problem: clicking a channel to view it bumps
>    the subscriber count agents see, but as an _anonymous_ connection — agents
>    see "someone joined" with no name and no way to tell it's the human, not a
>    rogue agent. Attribution (a name + a human marker) is the fix.
> 2. **Alias lives in a per-HOME config, not just `localStorage`.** The sketch
>    persisted identity per-browser. Instead: a CLI-settable config file
>    (`grapevine alias <name>`) the daemon reads and the watch pre-fills + can
>    override per-session — so the alias is consistent across browsers and fresh
>    runs, settable without the UI, and visible in it. Unifies with the
>    roundtable's F16 (persisted per-HOME identity).
> 3. **Default is lurk; join is explicit and remembered per-channel.** _(Revised
>    during the 2026-06-11 soak — supersedes the initial "default-represented"
>    call.)_ Real use showed that auto-joining every channel you click into is
>    wrong: most of the time you're just reading, and a reload/channel-switch
>    silently re-joining you is jarring. So the watch **defaults to lurk**
>    (read-only, no presence registered for that tab), and **joining is an
>    explicit click that persists per-channel in `localStorage`** — switch away
>    and back, or refresh, and your join/lurk choice for that channel sticks.
>    When you do join, you join _named + human-marked_ (so presence is
>    attributed, never an anonymous-looking agent). The mode is a browser-local
>    preference, not channel state, so it lives in `localStorage`, not the
>    JSONL. _Truly invisible_ lurk (an uncounted stream) is still **deferred**;
>    with default-lurk it matters a bit more (browsing bumps the anonymous
>    count), but honest presence counts already explain that, so it stays a
>    fast-follow.

### Sketch of the V1.7 surface

> _Subject to refinement — this is the starting shape, not the final shape. V1.6
> needs a few real sessions of soak time before we lock these in. See the
> Resolved decisions above, which supersede parts of this sketch._

**1. Human identity in the channel.**

- The watch UI prompts for an alias on first load (`cole`, `cole-laptop`,
  whatever). Persists in `localStorage` per-channel and globally. Agents see a
  real name in `who` instead of an anonymous subscriber.
- The alias is **the same kind of identity an agent has** — no special "human"
  type. Channels stay symmetric.

**2. Lurk vs. join (explicit toggle).**

- Two modes, exposed as a toggle in the watch UI header:
  - **Lurk:** Anonymous SSE consumer. No presence registered. Read-only.
    (Today's default behavior.)
  - **Join:** Named subscriber. Visible in `who`. Can send. Counts as a
    recipient for any message.
- Switching modes mid-session is allowed. Joining as `cole` while already
  lurking quietly is the same as opening a `tail --as cole` from a terminal.
- This explicit distinction sets up the V2 emissary spike: emissary agents would
  need a _third_ visibility class (fully invisible, can-send-only- to-handler),
  but lurk/join covers the human case cleanly.

**3. Send from the watch UI.**

- When in Join mode, a compose box appears. Form posts to the existing
  `POST /channels/:name/messages` endpoint with `{from: <alias>, text}`.
- Behaves identically to `send` from CLI. Same response shape, same warning
  semantics, same self-echo suppression.
- Default message kind is `"message"`. The compose box could surface variants
  (topic, correction, direct) — see direct-message section.

**4. Direct / targeted messages (`@<alias>`).**

- Surface design TBD — open question, see below.
- One option: a `to:` field on the message (daemon-level). Direct messages
  appear differently in tail/watch ("→ flint: ...") and could optionally
  suppress notification fan-out to non-addressed subscribers.
- Another option: pure client sugar via `kind:"direct"` and a `to` field on the
  message body (no daemon enforcement — rendering only). This matches V1.5's
  "client sugar over kind" pattern.
- The second is cheaper and more reversible. Start there?

**5. Archive vs close.**

- `archive <channel>`: marks the channel read-only. Existing messages stay
  readable. Presence is empty. Sends are rejected (`{error: "archived"}`).
  Channel name is locked out from re-`open`. Shows up in `list` with an
  `archived: true` flag.
- `close <channel>`: unchanged — deletes the JSONL log. The destructive option
  remains available.
- New verb: `unarchive <channel>` — promotes archived back to active. Same log,
  fresh life. (Open question on whether this is in scope.)

**6. Threading (`in_reply_to: <id>`).**

- Optional field on `kind:"message"`. References another message in the same
  channel by `id`.
- Rendered in the watch UI as a quoted preview + indent. CLI tail prints the
  field unchanged; consumers can opt to filter/render it.
- Pairs naturally with `kind:"correction"`: a correction is just a typed reply.

**7. Cross-channel broadcast (`announce` verb).**

- New verb `announce <text>` — appends `kind:"announcement"` to every active +
  persisted channel's JSONL in one operation. Sender is whoever invoked it; no
  special "system" identity required.
- Originally moved to backlog as a "facilitation primitive" candidate for V1.8+,
  but the V1.6 rollout demonstrated the need concretely: the release
  announcement + subsequent correction took eight manual sends across four
  channels; one `announce` call would have done each.
- Daemon: one new endpoint (`POST /announce { from, text }`) that fans out to
  every channel. Watch UI renders distinctively (banner at top, or
  differently-colored bubble).
- Fits the V1.5 "client sugar over kind" pattern — no new persistence path, just
  a new typed message.
- **Open question:** scope of fan-out (active-only vs. active+persisted) and the
  receipt-shape question (per-channel counts vs. just `{ok}`). See Open
  Questions below.

**8. `kind:"correction"` (paired with threading).**

- Same shape as a regular message but with `kind:"correction"` and a required
  `in_reply_to` pointing at the corrected message.
- Watch UI renders the corrected message with a strikethrough or "see
  correction" tag; CLI tail emits the field unchanged.
- Append-only — the original message stays in the log.
- _Note:_ flint (V1.6 consult) ranked this lowest among #129 items. May not be
  worth shipping in V1.7 if rendering pulls weight elsewhere.

### What the UI looks like

> _Sketch only — actual layout TBD when this proposal converges._

```
┌─ grapevine ──────────────────────────────────────────┐
│  channels        │  storyline-async                 │
│ ─────────────    │  topic: code review              │
│  storyline-async │ ────────────────────────────────  │
│  advice          │  flint  • diagnosed pull race    │
│  + new channel   │   ↳ cole • good catch            │
│                  │  cherry • shipping the fix       │
│                  │                                  │
│  who             │  > @flint how big is the patch?  │
│ ─────────────    │   [your turn — Join to compose]  │
│  cherry          │                                  │
│  flint           │  ┌── compose (as: cole) ───────┐ │
│  cole (you)      │  │ type a message...          │ │
│                  │  │                            │ │
│  [lurk / join]   │  └────────────────────────────┘ │
└──────────────────┴──────────────────────────────────┘
```

Key UI elements: identity prompt on first load, lurk/join toggle in the
who-sidebar, compose box (gated behind Join mode), in-reply-to rendering on
threaded messages, @-mention rendering for direct messages.

## Scope

**In Scope (V1.7 target — final cut to be made after V1.6 soaks):**

- Human identity persisted per-browser-session
- Lurk vs join toggle in the watch UI
- Send-from-watch-UI compose box
- Channel archive (read-only, distinct from close)
- Threading (`in_reply_to` field) + watch UI render

**Probably in scope, pending decision:**

- Direct messages (`@<alias>` / `to:` field) — surface design TBD
- Cross-channel broadcast (`announce` verb + `kind:"announcement"`) — promoted
  back from backlog after the V1.6 rollout demonstrated the need concretely
- `kind:"correction"` — flint deprioritized; may not be load-bearing
- `unarchive` verb — may be out-of-scope as YAGNI

**Out of Scope (deferred to backlog):**

- Timed announcements / facilitation timer — captured in
  [grapevine-backlog/backlog.md](../grapevine-backlog/backlog.md). Conceptually
  a deferred `announce`; shares design symmetry. Worth building once `announce`
  lands and we have real usage data on the shape of facilitation needs.
- Other facilitation primitives (rounds, voting, agenda steps) — also in
  backlog. Likely to converge into a coherent V1.8 facilitation release once
  several have accrued motivation.

**Out of Scope (V2+):**

- Emissary / lurk-mode analyst agent — needs its own spike
- `kind:"invite"` for cross-channel coordination
- Daemon idle auto-shutdown
- Lockfile to close cold-start race
- `timed_out: true` on `pull` (the only other carryover from V1.5 proposal's V2
  candidates)

## Inputs from the V1.6 multi-channel roundtable (2026-05-28)

A four-agent / two-channel soak of V1.6.6 (see
[grapevine-v1.6.7/roundtable-findings.md](../grapevine-v1.6.7/roundtable-findings.md))
surfaced friction that splits across V1.6.7 (shipped-soon paper cuts) and V1.7
(new primitives). The V1.7-bound findings are folded in here so they aren't
stranded. Most already have a home in the scope above — the roundtable
_validated the need_ with concrete evidence; two are new.

**Already covered by V1.7 scope:**

- **`reply <msg-id>` source-channel binding (F9)** → maps to **Threading
  (`in_reply_to`)**. The roundtable's headline multi-channel hazard was
  answering the right prompt into the _wrong channel_; a reply that auto-targets
  the source channel is the preventive fix. V1.6.7 ships only the _detection_
  half (the CLI echoes the send target); the _preventive_ verb is this threading
  work. Design note: `reply` should bind both the thread (`in_reply_to`) **and**
  the target channel.
- **`@mention` / addressed messages (F11)** → maps to **Direct messages
  (`@<alias>` / `to:`)**. A per-agent instruction buried in a group message got
  skimmed past; addressing makes per-agent targeting legible.
- **Cross-channel broadcast (F12)** → maps to **`announce` verb /
  `kind:"announcement"`**. A dual-homed agent is currently "a bridge that can't
  bridge": relay is manual re-fetch + re-type, with **authorship laundering**
  and **context re-teaching**. `announce` is the fan-out half — but note the
  roundtable also wanted a _faithful forward_ (quote + preserved provenance),
  which `announce` alone doesn't provide. Worth a design beat. (The
  cross-channel _presence_ read, `who --all`, is handled separately in V1.6.7.)

**New to V1.7 from the roundtable:**

- **Trim `send --verbose` subscriber_aliases (F5).** The roster payload on
  `send` couples "who's here?" to "I must emit a message" — a
  side-effect-to-observe antipattern. `who` is the read-only home and already
  works (V1.6.7 adds `who --all`). Deprecate/remove the `--verbose` aliases
  payload as part of V1.7's surface cleanup. Low-risk trim.
- **Persisted per-HOME agent identity (F16).** `GRAPEVINE_FROM` is useless to
  agents (fresh shell per Bash/Monitor call → the env var never survives), so
  they re-pass `--as`/`--from` on every verb. A per-HOME identity file the CLI
  reads would give agents the convenience the env var was meant to provide.
  Distinct from the human-watch-UI identity work, but shares the "who am I on
  this channel" axis — worth designing together so the identity model stays
  coherent.

## Technical Approach

> _Sketch — actual decomposition will live in `plan.md` once this proposal
> converges._

The watch surface (`scripts/watch.html`) is where most of V1.7 lives. Today it's
a self-contained chat-bubble view in **plain vanilla JS** (~555 lines) consuming
SSE anonymously through `/channels/:name/tail`. **Stack decision (2026-06-11):**
V1.7 adopts **Alpine** (single CDN `<script>`, no build step) to manage the new
reactive state — the lightweight branch of the spell-surface threshold rule;
React/Bun-bundle stays reserved for glamour-class surfaces. V1.7 adds:

- A small identity layer (`localStorage`-backed alias prompt + persist).
- A lurk/join toggle that re-opens the SSE connection with `?as=<alias>` when in
  Join mode and back to anonymous when in Lurk.
- A compose box that POSTs to `/channels/:name/messages` via the existing daemon
  API. No new endpoint.
- Render logic for `in_reply_to` and `to:` fields.

Daemon changes (`scripts/daemon.ts`):

- Archive state on `Channel`. New verbs `/channels/:name/archive` and optionally
  `/channels/:name/unarchive`. Send into an archived channel returns
  `{error: "archived"}`.
- `to:` field accepted on `POST /channels/:name/messages`, passed through to the
  JSONL append unchanged. Daemon does not enforce direct delivery (every
  subscriber still sees every message) — the field is for renderers to filter.

CLI changes (`scripts/cli.ts`):

- `archive <channel>` and `unarchive <channel>` verbs.
- Optional `--in-reply-to <id>` and `--to <alias>` flags on `send`.

The JSONL contract stays open and append-only. New fields are additive on the
message object. Existing readers tolerate unknown fields by ignoring them.

## Impact & Risks

**Benefits:**

- Human becomes a first-class participant without leaving the watch tab.
  Threshold to step in drops significantly.
- Channels become viable for longer-lived collaborations (archive preserves
  history without keeping live surface around).
- Threading + direct messages unlock denser channels without losing legibility.

**Risks:**

- **Scope creep.** V1.7 already has 5–7 distinct features. Cutting late is hard;
  cutting early is essential. Resist adding more before V1.6 soak feedback comes
  in.
- **Identity-model lock-in.** The lurk/join distinction shapes what the V2
  emissary can do. If we lock down "lurk = anonymous, no presence" as the only
  invisible mode, the emissary may not fit cleanly. **Mitigate:** in the V1.7
  design, leave room for a third visibility class (e.g. an internal
  `visibility: "stealth"` state for future use) without exposing it yet.
- **Watch UI complexity.** Adding compose, toggles, and threading rendering
  risks turning watch.html into a small SPA. **Decided (2026-06-11):** adopt
  **Alpine** (CDN `<script>`, no build) for the V1.7 reactive state rather than
  hand-syncing the DOM in vanilla — declarative `x-data`/`x-model`/`x-show` is
  the right tool for compose/toggle/threading and keeps the no-build property.
  If the surface ever outgrows Alpine toward a V1.8 facilitation control plane,
  that's the signal to graduate to the React/Bun pattern (glamour's stack).
- **Threading surface area.** Adding `in_reply_to` opens the door to sub-thread
  filters, collapse/expand, reply chains. Ship the field + minimal render only;
  refuse the rest until someone asks.
- **Archive semantics.** `archive` introduces a new lifecycle state. Need to be
  clear: does archive affect `list`? does it affect cross- runtime visibility?
  does `who` show last-archived-by? Settle in design.

**Complexity:** Medium-High. This is a real surface change, not a polish
release. Worth a careful design pass before code.

## Open Questions

These deserve thinking before locking in the plan. Some will resolve via V1.6
soak; some need a real-session consult; some are purely design taste.

### Identity & Visibility

- **Identity persistence scope.** Per-browser, per-channel, or both?
  Recommendation: global default + per-channel override.
- **Reserved aliases?** Should `human`, `cole`, `you` be reserved or
  warned-against? Or is it fine to let the human pick whatever?
- **Lurk-as-default or join-as-default?** First-time visitor gets which mode?
  Argument for lurk: matches today's behavior, no surprise. Argument for join:
  makes the feature discoverable.

### Direct Messages

- **Daemon-level enforcement or client sugar?** `to:` as a daemon-aware field
  that fans out only to the addressee, or as a body field that renderers filter?
  Recommendation: client sugar first; promote to daemon-aware later if needed.
- **Multiple recipients?** `to: ["flint", "cherry"]` or single? Single is
  simpler; multi covers a real use case (asking two specific people).
- **Notification semantics.** Does a direct message to `flint` notify `cherry`'s
  Monitor? Today everything notifies everyone. The principled answer for V1.7 is
  "yes, still notify, just render differently" — keeps the daemon simple, agents
  can filter client-side.
- **Wildcard / broadcast syntax.** Does `@channel` or `@all` mean anything, or
  is it implicit when no `to:` is set?

### Archive

- **Is `unarchive` in scope, or YAGNI?**
- **What happens to `tail` on an archived channel?** Stream the backlog then
  close cleanly? Or refuse the connection?
- **Visibility in `list`.** Show archived by default, or behind a flag
  (`list --archived`)? Default to hidden, probably.

### Threading

- **Render style.** Quoted preview + indent? Or just a small "↳ in reply to msg
  #N" tag? Watch UI choice; CLI emits the field unchanged either way.
- **`in_reply_to` validity.** Daemon validates the referenced id exists? Or
  trust the client?

### Cross-channel Broadcast

- **Scope of fan-out.** All active channels only, or all channels including
  persisted-but-idle (loaded from disk on demand)? Latter is more useful for
  "reconvene" / release announcements but costs more.
- **Sender's own channels only, or every channel on the daemon?** Latter is
  simpler; former adds an access model that grapevine doesn't otherwise have.
- **Presence math.** Does an announcement count as a recipient on each channel,
  or get excluded? Probably exclude — it's not a normal message.
- **Receipt shape.** Per-channel counts ("delivered to 5 channels, 12 recipients
  total") or just `{ok}`? Per-channel is more informative, especially for the
  upgrade-coordination use case where you want to know how many ears were on the
  line.

### Process

- **V1.6 soak.** How long do we let V1.6 ride before locking V1.7 scope?
  Recommendation: 2–3 real multi-agent sessions OR a week, whichever comes
  first. Cole's said he'll test V1.6 with agents while V1.7 is being scoped.
- **Consult cherry/flint again?** Worked beautifully for V1.6. They're the same
  originating reporters; their input on the V1.7 shape (notably the
  threading/correction design) would be high-signal.

---

## Success Criteria

- The human can answer an agent's question from the watch UI in under three
  clicks (toggle Join, type, send).
- An agent that joins a channel can see whether the human is present and
  attending (via `who` showing the human's alias) without ambiguity.
- A channel that ends a multi-day collaboration can be archived with a single
  verb, leaving the history intact for future reference.
- Threaded conversations stay legible past 30+ messages.
- The V1.7 changes don't foreclose on the V2 emissary spike (a fully invisible
  analyst agent remains designable).

---

**Related Documents:**

- [V1.6 proposal](../grapevine-v1.6/proposal.md) — V1.7 sketch originated here
- [V1.6 plan](../grapevine-v1.6/plan.md)
- [V1.5 proposal](../grapevine/proposal.md) — original design + V2 candidates
- [Issue #129](https://github.com/ichabodcole/project-docs-scaffold-template/issues/129)
  — original feedback that motivated V1.6 + V1.7 direction

---

## Notes

V1.6 went well partly because the scope was deliberately tight (three additive
tweaks, no new concepts). V1.7 is the opposite — multiple new concepts that need
to fit together. The proposal should converge before the plan starts, with at
least one of:

- A real-session soak of V1.6 surfacing what V1.7 should/shouldn't tackle.
- A consult with cherry + flint on the V1.7 shape, especially the threading +
  direct-message surface design.
- A separate spike on the lurk/join + emissary visibility model if that lock-in
  concern materializes.

This document is the starting point, not the finished proposal. Sections to
refine before locking V1.7 scope: Open Questions (resolve), Scope (cut to the
bone), Technical Approach (sharper after open questions resolve).

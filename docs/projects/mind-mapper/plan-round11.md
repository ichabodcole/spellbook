# Round 11 plan — the message surface (collapse the capture layers)

**Source:** [`proposal-message-surface.md`](./proposal-message-surface.md), from
drive #9 (`drive9-findings.md` F1–F3). **Branch:**
`feature/mind-mapper-round11`, cut off `develop` — **R8+R9+R10 are MERGED**
(Cole chose migration option (a): merge-then-refactor, "we can always revert
back to the panels if we realize they were a good idea"). **Seats:** prospero
(lead), daedalus (engine — the channel/provenance wire), circe (surface — the
collapse), cassandra (cold gate). Subagent mode.

> **Framing.** R8→R10 grew one capture panel per input mode. Drive #9's verdict:
> over-engineered — they all reduce to "how do I send the agent a message and
> see it's being worked on." R11 collapses the **input** side to ONE primitive
> (a message with provenance) while leaving the **artifacts** (graph, docs)
> alone. The north star is Cole's: send from anywhere → agent gets it → I can
> see it's being worked — with no management overhead on either side.

## Cole's rulings (settled before planning — do not re-litigate)

1. **Remove BOTH panels from the surface** — `JobsSidebar.tsx` and
   `IngestionTray.tsx` and their toggles. **The engine primitives STAY
   untouched** (`jobs` table + `/jobs` routes + `job` CLI verb; `/ingest`
   route + `ingest` CLI verb) — they become agent-only, unused by the surface,
   and are the seed of multi-agent work distribution.
2. **F3 (activity legibility) is IN SCOPE.** Removing the panels without making
   "the agent is working on this" unmissable would leave Cole with _less_
   visibility than before — a regression. This is what makes the collapse a net
   win.
3. **Migration = option (a), already executed** — the stack is merged; R11 is an
   honest "we learned better" delta on top.

## Lead rulings (falsifiable by the owning seat — say so if wrong)

- **L1 — the freeform sketch is the ONLY human-authoring path that changes.**
  The right-click freeform "sketch an idea" box (`App.tsx` `proposeAsUser`, the
  node case) becomes a **message**, because a ramble is intent. But the
  **drag-two-nodes-to-connect** act (`App.tsx:946–956`, the propose-batch
  node+edge path) is **STRUCTURED, not freeform** — the human is naming a
  specific relation between two specific nodes. It **STAYS** a user-authored
  proposal. Cole's complaint was precisely about the freeform box being
  "somewhere in between"; a drag-connect is not in between. **Falsify if** circe
  finds the two paths share code such that splitting them is worse than a flag.
  - **↑ PARTIALLY FALSIFIED by circe (ruling survives, citation was wrong).**
    `App.tsx:946–956` is **not** the drag-two-nodes act — it's the **dead-drag**
    (drag a handle onto empty pane), a **hybrid**: structured edge + _freeform_
    new-node text, sharing the ramble's box. The purely structured act is
    `onConnect` (node→node, no text), ~line 1529. **Both stay user proposals:**
    a message cannot hold an edge, and in the dead-drag the human explicitly
    named a relation to an existing node (the text is that node's title, not a
    ramble). The split rides an already-present `connectFrom` flag, so there was
    no code-sharing objection. Both branches now carry **different copy** so one
    box no longer looks like it does one thing.
- **L2 — no auto-ingest; the daemon stays dumb.** A canvas-channel message does
  NOT auto-become a doc. The agent reads it and decides whether it's source
  material (then calls `/ingest`). Contract 8's dumb-daemon clause governs.
- **L3 — no new human create-node UI this round.** F1 named a structured
  create-node affordance (title/labels/properties) as a _separate future_ thing.
  Explicitly out of scope; do not sneak one in.

## Shared interfaces — ratify on the vine, then fill

### SEAM 1 — the channel + provenance wire `(CLAIM — awaiting daedalus)`

**Claim: the primitive already largely EXISTS and this is mostly a vocabulary +
validation change, not a schema change.** Messages are already
`{id, seq, role, kind, text, ground: string[]|null, ts}` (Contract 9) where:

- **`kind`** already defaults to `"turn"` and is a free-form string on the wire
  → it can carry the **channel**: `"turn"` (typed in chat) | `"canvas"` (the
  right-click ramble) | future `"pin"`, `"doc"`. No new column.
- **`ground`** already carries attached refs with a ratified grammar (bare id =
  node ref, `doc:<id>` = doc ref, unknown prefixes tolerated-and-dropped — R2
  Claim A). It is ALREADY the "click a node then chat attaches its context"
  mechanism Cole identified as the seed pattern.

**daedalus rules:**

1. **Is `kind` the channel, or does channel want its own field?** Reusing `kind`
   is zero-migration but conflates "what sort of message" with "how it arrived."
   If they're genuinely orthogonal (e.g. a `canvas`-channel message that is also
   a `question`), we need `channel` separately (additive nullable TEXT per the
   ratified migration doctrine). **Lead lean: reuse `kind` as the channel** — we
   have no second axis in evidence yet, and Contract 9 already ships `kind`
   unvalidated. State the ruling either way.
2. **Name the channel vocabulary** and whether it's **validated server-side** (a
   closed set → 400 on unknown) or **open** (tolerated, like the ground-ref
   grammar). Contract 9 precedent leans tolerant; F5's grounding-line lesson
   leans "make the set visible." Rule it.
3. **Does canvas position need to ride?** A canvas ramble happens _somewhere_ on
   the board. Is `{x,y}` worth carrying (a `canvasPos` in ground's grammar, or
   dropped as noise)? **Lead lean: drop it** — the human's position while
   rambling carries little intent and we have no consumer. Falsify if circe
   wants it to place the resulting nodes.
4. **`--inbound` must admit the new channel messages** — they're
   `message.posted[role=user]`, so Contract 10's predicate already covers them
   for free. **Confirm** this, and confirm the R11 change does NOT widen or
   break `isInboundEvent`. (This is the "R10 was the seed" claim made concrete.)

### SEAM 2 — activity tied to a specific message (F3) `(CLAIM — awaiting daedalus + circe, shared)`

**Claim:** today `agent.activity {state:"received"|"thinking"|"idle"}` is
**project-scoped with no message ref**, and `/send` already auto-flips to
`received` when a human message lands with an agent tailing (server.ts:1137). To
render "**this** message is being worked on," the surface must know WHICH
message. Two cuts:

- **(A) Surface infers** — "the latest `role:user` message" owns the current
  activity state. Zero wire change; wrong the moment the human sends two
  messages or the agent works an older one.
- **(B) `agent.activity` gains an additive `messageId`** — the auto-flip stamps
  the message that triggered it; an explicit `POST /activity` may name one.
  Honest and precise; touches the event payload (additive-optional, per
  doctrine).

**daedalus rules A vs B** (lead lean: **B** — A's failure mode is exactly the
"the human can't tell what's happening" bug we're fixing, and the auto-flip
already HAS the message in hand at the emit site). **circe then owns** what
"received → working → done" looks like on the message: a state on the bubble,
not a separate panel. **Name the terminal state** — is "done" a real third state
or just the absence of activity (idle)? Today there is no `done`; an agent send
resolves to idle. Rule whether F3 needs a real completion signal or whether the
agent's reply IS the completion signal (**lead lean: the reply IS completion** —
one fewer primitive, and it's true).

### SEAM 3 — chat rendering: channel-distinct, collapsed, filterable `(CLAIM — awaiting circe)`

**Claim:** `MessageBubble.tsx` + `ConversationPanel.tsx` gain channel-awareness:
non-`turn` messages render **recognizably different and collapsed by default**
(Cole already knows their content — they must not eat chat real estate),
**expandable**, and the panel gains a **filter by channel**. `FilterControl.tsx`
already exists as a surface filter idiom — reuse or mirror it rather than
inventing a second filter language. **circe rules:** the collapsed affordance
(one-line summary + expand? a distinct tinted bubble?), whether ALL messages
become collapsible (Cole said "maybe"), and whether the filter is a control or
just a visual distinction in V1. **Falsify if** collapsing hides so much that
the log stops reading as a conversation.

### SEAM 4 — the freeform ramble becomes a message `(CLAIM — awaiting circe)`

**Claim:** the right-click "sketch an idea" input stops calling `proposeAsUser`
and instead POSTs `/send` with `{role:"user", kind:"<canvas channel>", text}` (+
`ground` if a node was selected). **No canvas node is minted** (drive-9 F1: "it
has to be cleaned up later by you"). Per **L1**, drag-connect stays a proposal.
**circe rules** the feedback the human sees at the moment of sending (the
message appearing in chat may be sufficient — it's the one place things go now)
and whether the right-click entry point stays a modal/input or becomes something
lighter. **Falsify if** the zone-scoping behavior (Z3: a sketch made on a zone
board lands in that zone) carries meaning that a message can't — a message has
no zone. **Name what happens to that.**

### SEAM 5 — remove the two panels `(CLAIM — awaiting circe, mechanical but wide)`

**Claim:** delete `JobsSidebar.tsx` + `IngestionTray.tsx` and their toggles from
`App.tsx`, plus now-dead surface state (`state/jobs.ts`,
`state/ingestionQueue.ts` and their tests) — **but ONLY the surface**. The
engine `jobs`/`/ingest` slices and their tests stay green and untouched (Cole's
ruling 1). **circe rules:** what, if anything, replaces the ingest tray's
_signal_ — the tray was how a human saw "a doc is being made." If the answer is
"the chat says so," good; if a doc landing needs a visible artifact cue, name it
(the docs rail / `ContextRail.tsx` may already carry it). **Falsify if**
removing `state/ingestionQueue.ts` orphans something the reducer needs.

### SEAM 6 — docs + canon `(prospero owns; thoth consulted)`

Contract 11 in `seams.md` (the channel/provenance wire + the activity-message
tie), the casting-draft update (the agent's loop changes: read channel-tagged
messages, decide what's source material), and — if the paradigm holds —
**`grimoire/house-style.md` gains the message-surface convention** as a
house-wide standard (the drive's biggest claim; thoth owns the canon file). Lead
writes Contract 11 AFTER daedalus rules SEAM 1/2, never before.

## Build order

1. **daedalus** — rule SEAM 1 + SEAM 2's wire half, write the Contract 11
   amendment, then build: channel vocabulary + validation, `agent.activity`
   messageId (if B), `--inbound` confirmation test. Engine tests green.
2. **circe** — SEAMs 3/4/5 + SEAM 2's render half, in parallel where possible
   (SEAM 5 is independent of the wire; SEAMs 2/3/4 consume daedalus's ruling, so
   circe should rule its own halves first and build against the ratified wire).
3. **lead** — SEAM 6 docs; atomic land; stamp dist; cassandra cold-gates.

## Verification gate (cassandra — ISOLATED)

**Hard constraint (unchanged, load-bearing):** cold drive on an **isolated
scratch daemon** — fresh `MIND_MAPPER_HOME`, `SPELLBOOK_SURFACE_MODE=dev`, a
**non-60700 port**, **exact-PID teardown**. **NEVER touch :60700 or Cole's real
store.** Do NOT rebuild dist (a land-time lead act).

Exercise: (1) right-click ramble → **no canvas node appears**, a channel-tagged
message lands in chat, visually distinct + collapsed. (2) The agent-side view:
`tail --inbound` shows it (Contract 10 still covers it). (3) Activity: send as
human with an agent tailing → the **specific message** shows received/working;
the agent's reply resolves it. (4) Drag-connect two nodes → still a user
proposal in the review queue (L1 didn't regress). (5) Jobs + ingest **CLI verbs
still work** end-to-end with no surface panel (engine untouched). (6) No dead
imports / no orphaned toggle. Full suite green + biome clean.

## What's ABSENT (assert the mirrors)

- **No structured human create-node UI** (L3) — named future work, not silent.
- **No engine deletion** — jobs and ingest survive as agent primitives; this
  round only removes their _surface panels_.
- **No auto-ingest** (L2) — the daemon stays dumb; the agent decides.
- **No multi-agent routing built** — SEAM 1 must leave the door open (channel as
  a filterable predicate, per Contract 10's mechanism) but R11 builds no router.
- **No `proposal.added[author=user]` removal** — drag-connect still emits it, so
  Contract 10's admitted set is unchanged.
- **No merge.** R11 lands on its own branch pending Cole's drive + sign-off.

---

## Ratified outcomes (filled in at land, R11)

**All seams ratified; three falsifications, all improvements.** Contract 11 +
the R11 surface convention are in `.anthill/dev/seams.md` (single-sourced by the
lead from both seats' returns).

- **SEAM 1 — RATIFIED with a sharpened premise.** The lead pre-ruling (channel
  on `kind`, value `"canvas"`) **stands**, but the plan's justification was
  wrong: the surface **already ships `kind:"analyze"`** (docs-rail Analyze,
  Claim G), so `kind` was ALREADY the arrival-affordance discriminator — this
  round **names as-built** rather than designing. That discovery also
  **falsified server-side validation**: a closed vocabulary would have 400'd a
  live shipped affordance. Result: known-but-open set, unknown channels stored
  verbatim + advisory `warning`. Canvas position dropped (no consumer) with a
  test-pinned extension point. `--inbound` confirmed unwidened — it keys on
  `role`, never `kind`.
- **SEAM 2 — RATIFIED as (B), sharpened.** `messageId` belongs to the **open
  activity ladder**, not to an individual emit — per-emit stamping would have
  silently half-broken F3 for every already-shipped agent (the casting agent's
  next act is `activity thinking` with no id, which would evaporate the tie).
  Auto-flip stamps → later states inherit → explicit posts override → `idle`
  carries out then clears. **No `done` state** (the reply IS completion).
  daedalus added `/state.activity` unasked and correctly: an event-only signal
  is missable by one browser refresh, and F3 requires _unmissable_.
- **SEAM 3 — RATIFIED, one falsification.** "Possibly ALL messages collapsible"
  is **FALSIFIED**: collapse gates on `human ∧ side-channel ∧ ≥90 chars`. Cole's
  reason ("I already know the content") is false of **agent replies** — that's
  the half of the log he hasn't read, and collapsing it is exactly the "stops
  reading as a conversation" failure the seam warned about. Filter is a real
  control reusing `FilterControl`'s exported `FacetChip`/`FacetGroup` (sharing
  enforces "don't invent a second filter language"), rendered present-only at 2+
  channels.
- **SEAM 4 — RATIFIED; Z3 solved without a wire change.** The zone question had
  a real answer: "I was working in _this_ sandbox" **is** provenance, so it
  rides as a **`zone:<id>` ground ref** under Contract 9's tolerated-prefix
  grammar (engine stores ground byte-verbatim; daedalus test-pinned it). Renders
  as a "from: <Zone>" chip; degrades to invisible for any consumer that doesn't
  know it. The modal **stays** (dictation wants a textarea) but now states where
  the text is going **before** you commit — feedback ex ante beats a toast ex
  post.
- **SEAM 5 — RATIFIED, extended by circe, ratified by the lead.** Beyond the two
  panels + their state modules, circe also removed the reducer's `job.*` cases,
  `ProjectState.jobs`, and the `Job` type. **Lead ruling: keep the removal** —
  an unread mirror of engine state is precisely the drift this round exists to
  delete; the engine remains the single source of truth; Cole framed the whole
  round as revertable. No replacement cue was needed for the ingest tray: raw
  user proposals essentially stop existing (only drag-connects remain, already
  counted by `review · n`), and a landing doc already appears live in
  `ContextRail`.
- **SEAM 6 — lead-owned.** Contract 11 + the R11 surface convention landed in
  `seams.md`; `casting-draft.md` updated for the new agent loop.
  **`house-style.md` deliberately NOT touched** — see below.

### Also discovered (not in the plan)

**circe self-corrected a V1-era latent bug:** the display `Message` type had
been **flattening the channel away since V1** — `toDisplayMessage` collapsed the
wire's free-form `kind` into `"info"|"result"`, so the channel died one line
before render. Fixed by carrying `channel: string` beside `kind` (display axis
vs provenance axis; conflating them makes every bubble branch on a string that
means two things). Without this, the entire round would have rendered nothing.

### Deliberately deferred

**The house-wide paradigm is NOT canonized yet.** `grimoire/house-style.md`
stays untouched: the message-surface paradigm has been validated by exactly one
build round and **zero human drives**. Canonizing a house-wide standard before
Cole has driven it once would be the same over-confidence that produced the
panels. thoth gets it after the drive, if it holds.

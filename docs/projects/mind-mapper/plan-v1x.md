# Mind Mapper V1.x — Track A build plan (skeleton)

**Lead:** prospero · **Seats:** daedalus (engine), circe (surface), cassandra
(gate) **Source:** `drive-findings.md` Track A triage (drive #1, 2026-07-17).
Branch: `feature/mind-mapper-v1x`. **Method:** light-feature collapse — one plan
file, seam claims ratified inline, owner lanes as sections below.

## How this plan is authored

Prospero owns the skeleton, the seam claims, and the gate definition. Each owner
ratifies/falsifies the claims its boundary touches BEFORE building, then authors
its own lane section here. Ratified load-bearing contracts promote to
`.anthill/dev/seams.md` (as amendments to Contract 9, its natural home).

## Integration / dependency order

- **P1 (parallel):**
  - **P1e — engine wire** (daedalus): tail hardening, doc delete, doc marks,
    presence, proposal `author`, conversation evidence. All additive to
    Contract 9.
  - **P1s — surface-independent items** (circe): disconnect banner + composer
    disable, project-in-URL, search icon. Zero new wire; can land before P1e.
- **P2 — surface consumes the new wire** (circe): doc context menu
  (Delete/Analyze), doc-status badges, presence dot + activity indicator, human
  node/edge creation, conversation-evidence rendering.
- **P3 — gate** (cassandra): cold-agent drive against the updated
  `casting-draft.md` (which P1e/P2 owners amend as they land verbs). Gate is the
  precondition for dogfood drive #2, not a replacement for it.

## Shared interfaces — ratify, then build

All claims are **additive-optional diffs against Contract 9** (the ratified V1
wire). Marker flips to RATIFIED as owners speak.

### Claim A — Doc deletion (findings 3) — (RATIFIED, both owners)

**Surface flow (circe):** the unforced DELETE is never fired from the raw icon
click — context-menu Delete → stage-1 confirm → unforced DELETE → 200 ends it,
409 escalates the SAME dialog to a provenance stage rendering `citedBy` counts →
force re-issue (no dry-run endpoint needed). Vendored layer grows a
shadcn-ported `alert-dialog.tsx` on Base UI (grow-with-use). Reducer filters
`docs[]` on `doc.deleted`; App closes an open viewer for the deleted doc;
surviving nodes' stale source refs are already tolerated by NodeDetail (find
miss → renders nothing) — no refetch required.

`DELETE /doc/:id?project=` (slug-guarded; non-slug id 404s first) → without
`?force`: if cited, **409** `{error:"cited", citedBy:{nodes:n, proposals:m}}`
where `nodes` = distinct node_ids in `sources` and `proposals` counts
**pending** proposals with that `evidence_doc_id`. With `?force=1` (or uncited):
delete the doc file, the docs row, its `docs_fts` row, its `sources` rows, **and
NULL the evidence columns on pending proposals citing it** (they become
evidence-less proposals — still rulable; ratify's existing "no evidence doc to
edit" guard then holds, closing the zombie-write hole where ratifying a citing
proposal would recreate the deleted file). Ratified proposals keep
`evidence_doc_id` as historical record — consumers tolerate a docId absent from
`docs[]`. Nodes SURVIVE (map-as-view: deleting a source doesn't un-ratify the
claim). Emits `doc.deleted {id}` (thin). The 409 is a thrown typed error
(`CitedError`) caught explicitly — the first non-uniform error in server.ts,
deliberate. CLI: `doc delete <id> [--force]`. Surface confirm renders the 409's
counts.

### Claim B — Doc status marks (finding 6) — (RATIFIED, both owners; both independently ruled full-mark-inline)

New table `doc_marks {id, doc_id, author, note, status, doc_mtime, ts}` —
append-only trail, latest-per-doc is the live mark. Loose vocabulary: `status`
is freeform text (`analyzed`, `read`, `skimmed`…), `note` carries the judgment
incl. null results. `doc_mtime` snapshots the doc file's mtime at mark time so
staleness = current mtime > marked mtime (the Operator `indexedAt`
partial-index-trust principle). Verbs: `mark <docId> --status <s> [--note <t>]`;
`/state.docs[]` gains optional `mark: {author, note, status, stale, ts}`
(latest, with `stale` computed server-side from the doc file's mtime vs the
mark's `doc_mtime`; missing file → stale). **Ruled (daedalus): `doc.marked`
carries the full mark inline** `{docId, mark:{author, note, status, ts}}` —
marks are small and append-only; thin-refetch is for mutable entities. `stale`
is read-time-computed, `/state`-only, never in the event. `mark` validates the
doc exists at intake. New tables are additive by construction
(`CREATE TABLE IF NOT EXISTS`) — no column-migration machinery involved.
Surface: small badge on context-rail cards (status text + stale tint); agent
reads marks from `/state` (one-call re-grounding).

### Claim C — Presence + activity (findings 7, 14) — (RATIFIED, both owners — with the ephemeral-cursor clause)

**Circe's load-bearing correction — the ephemeral-event cursor clause:** every
`bus.emit()` consumes a seq, fire-once signals included. The hook's current
`look.here` handling early-returns BEFORE `applyEvent`, so the cursor never
advances — latent for rare look.here, fatal for `agent.activity` (2–3× per turn
= a wholesale-refetch storm). Contract: ephemeral kinds route through
`applyEvent` (default case advances cursor); the hook surfaces the signal
separately via the `{payload, seq}` idiom — never early-return around the
reducer. Fix the existing look.here path in the same change.

**Ruled (circe): presence is agents-only.** The human's own connectivity is
layer 1 (`ConnStatus` — their socket is the measurement instrument); counting
the browser WS would collapse layers 1 and 2 and resurrect exactly the ambiguity
finding 7 kills. A `humans` count is additive later if wanted.

**Scoping edge (both briefs):** the browser WS connects WITHOUT `?project=` on
first mount (projectId resolves from `/state`) — the daemon must attribute that
connection to the resolved default project or project-scoped `presence.changed`
fan-out misses it.

**Thinking-indicator clear:** on `agent.activity {state:"idle"}`, on any agent
`message.posted` (reply = done), plus a client-side ~60s TTL backstop.

**Mechanics pinned (daedalus):** the bus's listener set is transport-blind, so
the agent counter lives at the SSE subscription site (per-project map entry),
incremented/decremented in `sseResponse` start/cancel. **Coupling: presence
accuracy is bounded by Claim F's keepalive** — a dead SSE socket only cancels
when a write fails, so F's server half builds before (or with) C. Activity TTL =
one per-project timer reset per POST, emitting synthetic
`agent.activity {state:"idle"}` on fire (~60s).

Two layers, both derived server-side from live event-stream subscriptions
(grapevine `who` model — presence = who is receiving):

- **Standing presence:** the daemon tracks open WS/SSE subscriptions per project
  (the connection already carries `?project=`). `/state` gains
  `presence: {agents: n}` (agent = SSE tail subscriber; the browser WS is the
  human side and needn't be counted for this affordance). Events
  `presence.changed {agents}` on subscribe/unsubscribe, project-scoped.
- **Active attention:** cheap agent-emitted signal
  `POST /activity {state: "received"|"thinking"|"idle"}` → event
  `agent.activity {state}` (fire-and-forget, no table, no persistence — like
  look.here). The casting loop posts `received` on message arrival and
  `thinking` when it starts composing; `idle` (or a server-side TTL ~60s)
  clears.

Surface: status dot = 3-state (daemon unreachable / connected-no-agent /
agent-on-this-project) + ActivityIndicator-style "thinking…" in the conversation
panel on `agent.activity`. Casting-draft gains the two POSTs.

### Claim D — Proposal `author` (finding 9) — (RATIFIED, both owners)

**Surface sharpenings (circe):** the ReviewQueue split is asymmetric BY DESIGN —
user-authored rows are a waiting state ("yours — awaiting a doc home", no tier
keystrokes, reject-as-withdraw only); agent-authored rows keep the one-keystroke
ruling UI. Canvas: `nodesConnectable` on + `onConnect` → propose-edge;
`zoomOnDoubleClick` off for the double-click form; the pending overlay renders
the sketch for free on the `proposal.added` round-trip. **Placement honesty:**
the schema carries no positions, so a double-clicked node lands where layout
puts it, not where the human clicked — stated here so drive #2 doesn't file it
as a bug (re-sharpens the persisted-view-state candidate). Fold-in: pass `nodes`
to ReviewQueue so edge rows resolve titles instead of raw ids.

Additive column `proposals.author TEXT` — **nullable, no default** (the
migration mechanism's load-bearing invariant is fresh-install shape ≡ migrated
shape, and `ADD COLUMN` is nullable-TEXT-only; a `NOT NULL DEFAULT` in CREATE
TABLE would diverge). Propose writes `'user'`/`'agent'` explicitly on every new
row (defaulting `'agent'` when the POST omits it); **null normalizes to
`"agent"` in `readState`** (pre-column rows are historically agent proposals);
the wire always carries `author: "user"|"agent"`, never null. `POST /propose`
accepts optional `author`; the surface's double-click node form and drag-connect
edge POST to the SAME endpoint with `author:"user"`. ReviewQueue splits: "yours
awaiting a doc home" (author=user) vs "mine awaiting your ruling"
(author=agent). Ratify path unchanged — human sketches, agent drafts the
doc-home sentence via the normal `--doc-edit` flow (the staging INVERSION from
finding 9; no new machinery).

### Claim E — Conversation evidence (finding 10) — (RATIFIED, both owners)

**Surface additions (circe):** `SourceRef` becomes a proper either-shape
(exactly one of docId/messageId — invariant stated in types). ReviewQueue
grouping must NOT dump message-grounded proposals in the "ungrounded" bucket —
new "from conversation" bucket. The conversation panel needs message anchors
(`data-message-id`), a `scrollRequest {messageId, seq}` imperative-request prop,
flash-highlight, and the unconditional autoscroll-to-bottom must yield while a
scroll request is serviced.

**Decision holds:** messages become anchorable directly — no fragment-minting.
**Mechanism corrected:** `sources.doc_id` is `NOT NULL` and SQLite cannot relax
it additively (`ALTER … DROP NOT NULL` doesn't exist — a nullable-column plan
ships green on fresh stores and explodes on real ones; the sources table isn't
covered by the pinning test). So: `sources` is **untouched**; new sibling table
`message_sources {node_id, message_id, span}` (additive by construction).
`proposals` gains nullable `evidence_message_id` (via `ADDITIVE_COLUMNS`, same
mechanism as Claim D). Propose rejects both-set; `SLUG_RE` guards `docId` only
(a messageId is a UUID that never touches the filesystem); propose validates the
messageId **exists in `messages`** at intake. Ratify with message evidence:
`--doc-edit` is INVALID (the existing "no evidence doc to edit" guard holds,
message sharpened); accept inserts a `message_sources` row. Wire:
`node.sources[]` becomes the union `{docId, span} | {messageId, span}` —
existing doc entries byte-identical (additive for the surface); `readState`
merges both tables. The pinning test extension hand-mints a previous-shape
`proposals` table and re-opens. Surface: clicking a message-evidence source
scrolls the conversation panel to that message and flash-highlights it (span
matching per Contract 6 within the message text).

### Claim F — Tail hardening (findings 2, 11) — (CORRECTED per daedalus; RATIFIED as corrected)

Engine-internal. **Mechanism corrected:** `AbortSignal.timeout` fires from
signal _creation_ and fetch takes one signal for the stream's life — there is no
per-read signal; the claimed mechanism would kill every healthy tail. The real
fix: **server** — `sseResponse` gains a per-connection 15s timer enqueueing
`: keepalive\n\n` (cleared on cancel; an enqueue throw on a dead controller
triggers unsubscribe — which is also what bounds Claim C's presence decrement).
**cli tail** — one `AbortController` per connection attempt plus a **rolling
idle watchdog**: a ~45s timer (≈3 missed keepalives) reset on every received
_raw chunk before frame parsing_ (keepalive comments must feed the watchdog even
though the data-line filter discards them); on fire, `controller.abort()` →
reconnect with last-seen seq. On reconnect with a different epoch: reset cursor
to 0 and emit a **CLI-synthesized** `{kind:"epoch.changed", epoch}` stdout line
(not a bus event — the browser WS never sees it). No wire change visible to the
surface beyond comment frames.

### Claim G — Analyze action (findings 4, 5) — (RATIFIED, both owners — ground-ref grammar fixed)

**Rendering rule (circe):** ground refs are a prefixed grammar — bare id = node
ref (resolve against `nodes[]`, tier chip, today's behavior); `doc:<id>` = doc
ref (strip prefix, resolve against `docs[]`, render with the ContextRail
doc-kind tint vocabulary); unresolvable refs drop silently (today's
`.filter(Boolean)` behavior, kept). MessageBubble gains a `docs` prop.
`kind:"analyze"` renders as a plain user message in V1.

**Confirmed (daedalus):** `ground` is opaque end-to-end in the engine (stored
and returned verbatim, no node-id resolution anywhere server-side) — zero engine
change needed. The surface-side rendering rule is circe's to ack: unprefixed =
node id, `doc:`-prefixed = doc ref, unknown prefix tolerated (render as text,
never crash).

No new wire machinery (conversation-primary): the doc card context menu's
**Analyze** posts a normal message via `POST /send` with
`{role:"user", kind:"analyze", text:"Analyze: <title>", ground:["doc:<id>"]}` —
the ONE wire clause to ratify is the `doc:` prefix convention in `ground`
(Contract 9 says ground = node ids; this adds a prefixed doc-ref variant rather
than a new field). Casting-draft: `kind:"analyze"` is explicit intent — extract
from the grounded doc. Drop stays ambient (no behavior on `doc.added` beyond
acknowledgment) — already ruled, restated here because it governs the gate.

### Absent by design

- No pipeline enum for doc status — marks are freeform stigmergic trail (ruled).
- No auto-extraction on drop or on Analyze-less doc.added (ruled, gate-checked).
- No multi-agent claim mechanic (Track D), no image intake (Track C), no
  force-layout animation (Track D).
- No new tables beyond `doc_marks` and `message_sources` (amended per Claim E
  correction); no daemon LLM calls (Contract 8 holds).
- No migration beyond Contract 9's additive mechanism.

## Slices

- **daedalus — P1e:** all engine claims above + tests per verb + casting-draft
  amendments for new verbs (mark, doc delete, activity, epoch.changed).
- **circe — P1s then P2:** disconnect banner/composer-disable, project-in-URL
  (URL param > localStorage fallback), search icon; then context menu (Delete
  confirm w/ citedBy, Analyze), mark badges, presence dot + activity indicator,
  double-click node + drag-connect edge authoring (author:"user"), ReviewQueue
  split, message-evidence navigation.
- **cassandra — P3:** cold drive of the full loop against updated
  casting-draft.md; explicit checks: ambient-drop non-extraction, Analyze
  intent, mark round-trip, presence/activity visible, human proposal → agent
  doc-home draft → accept, tail survives daemon restart mid-tail.

## Verification gate

`bun test` green (whole repo); cassandra P3 drive report with zero wire-guess
failures; casting-draft.md accurate to shipped verbs. Human gate (dogfood drive
#2) is Cole's, after merge-to-develop sign-off.

## Ratified decisions & edge cases

- **F-before-C build order is load-bearing** — presence decrement accuracy is
  bounded by the keepalive flushing dead sockets (daedalus lane encodes it).
- `doc.marked` carries the full mark inline (daedalus ruling; small, append-only
  — thin-refetch is for mutable entities). `stale` never in events.
- New-event payloads stated at the seam (promoted to Contract 9 amendment at
  build): `doc.deleted {id}`, `doc.marked {docId, mark}`,
  `presence.changed {agents}`, `agent.activity {state}`; `epoch.changed` is
  CLI-synthesized only.
- Migration doctrine clarified: new tables via `CREATE TABLE IF NOT EXISTS`;
  `ADD COLUMN` nullable-TEXT-only; "NOT NULL DEFAULT" intent expressed as
  null-normalized-at-read; pinning tests hand-mint the previous shape.
- Deleted-doc tolerance: ratified proposals/history may cite a docId absent from
  `docs[]`; consumers tolerate, never crash. A post-delete pending proposal has
  NULLed evidence — ReviewQueue already tolerates empty evidence (finding 10
  proved it live).
- `doc delete <id>` CLI overloads the `doc` verb's positional — a doc literally
  slugged `delete` is unaddressable; accepted for the record.

## Lanes (owner-authored at ratify, integrated by the lead)

### daedalus — P1e (build order; F-before-C encoded)

- T1 schema: `doc_marks` + `message_sources` tables; `author` +
  `evidence_message_id` in `ADDITIVE_COLUMNS.proposals`; pinning test hand-mints
  previous-shape proposals table; fresh-store table assertions.
- T2 SSE keepalive: per-connection 15s timer (injectable); enqueue-throw →
  unsubscribe + timer clear; tests on a shortened tick.
- T3 tail watchdog: rolling ~45s idle watchdog on raw chunks → abort → reconnect
  with last seq; epoch mismatch → cursor 0 + synthesized `epoch.changed` line;
  tests against a scripted fake SSE server.
- T4 proposal author: propose/state/server/cli; null→"agent" normalization
  tests.
- T5 message evidence: propose mutual-exclusion + message-existence validation;
  ratify message_sources insert + sharpened error; state sources merge; tests.
- T6 doc marks: `marks.ts` (pure latest+stale given mtime);
  `POST /doc/:id/mark`; `docs[].mark` in state; full-inline `doc.marked`; cli
  `mark`; tests.
- T7 doc delete: `CitedError` + DELETE handler (409/force cascade incl.
  pending-evidence NULLing, unlink, fts+sources cleanup); `doc.deleted`; cli
  `doc delete`; tests incl. post-delete ratify of a formerly-citing proposal.
- T8 presence + activity: SSE-site agent counter (default-project attribution
  for unscoped connections); `presence.changed`; `/state.presence`;
  `POST /activity` + TTL idle; cli `activity`; tests reuse T2 rig.
- T9 casting-draft amendments + Contract 9 amendment text to prospero. Also:
  grow `events.ts` `EventKind` union with ALL kinds incl. the missing
  `look.here` (circe-caught drift).

### circe — P1s (independent, lands first)

- T1 disconnect banner + composer disable (wears the already-returned `status`);
  live-verified.
- T2 project-in-URL: URL `?project=` > localStorage > daemon default; pure
  `resolveInitialProject` tested; mirror effect must not override an explicit
  URL param.
- T3 search icon summoning the existing palette; a11y label.

### circe — P2 (consumes P1e wire)

- T4 types + reducer growth first: new event kinds, `presence`, `mark?`,
  `author`, evidence either-shape; ephemeral kinds through `applyEvent` with the
  look.here cursor-skip regression-fixed and tested.
- T5 vendored `alert-dialog.tsx` + doc context menu + two-stage delete flow.
- T6 Analyze action + ground-ref prefix grammar in MessageBubble.
- T7 mark badges on ContextRail cards.
- T8 presence dot (`dotState` pure, tested) + tokens-adapted ActivityIndicator
  (ported from glamour, retinted, never imported).
- T9 human node/edge authoring (double-click form, drag-connect, author:user).
- T10 ReviewQueue author partition (asymmetric affordances) + title resolution.
- T11 message-evidence navigation (anchors, scrollRequest, flash, autoscroll
  yield, "from conversation" bucket).

## Open questions

_None — both ratify-round questions ruled (full-mark-inline; agents-only
presence)._

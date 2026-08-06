# mind-mapper Round 4 — plan skeleton (action slots + drive-3 fixes)

**Status: RATIFIED 2026-07-19 — all claims ruled; see "Ratified decisions & lead
rulings" (the claims below stand as originally hypothesized; the rulings section
is the authoritative delta).** Lead: prospero. Seats: daedalus (engine), circe
(surface), cassandra (gate). Source: `drive3-findings.md` round-4 triage (Cole's
rulings inline). Branch: `feature/mind-mapper-round4`, cut from develop @
a0c6f2a.

## How this plan is authored

Prospero owns this skeleton, the seam claims, and the gate framing. Each owner
ratifies-or-falsifies the claims touching its seat **before** moving its first
card to doing, then authors its own lane against the ratified contracts. Claims
are hypotheses — falsify with evidence, don't accommodate.

## Scope (build items only)

Six drive-3 findings, two ruled by Cole on the spot. The design items
(data-adjustment taxonomy, node-anchored submaps, OKF adapter) are NOT this
round — they need a proposal pass first.

1. **Action slots + ratify-anywhere** (#7, RULED) — the headline.
2. **Selection→ground on send** (#2).
3. **Automated activity ladder** (#4, presence-gated + stall escalation).
4. **Doc kind honesty** (#1).
5. **Build staleness guard** (#3).
6. **Always-open search input** (#8, RULED; surface P1).

## Integration order

P1 engine substrate (A1 actions store + ACT1 automation + K1 kind + B1 stamp)
alongside surface P1s (S1 search input, G1 ground bundling — G1 has no engine
dependency; the wire slot exists) → P2 surface consumption of the new engine
wire (action slots UI, ratify-anywhere menus, activity states, kind
badge/classify flow, build stamp footer) → P3 cold-agent gate (cassandra) off
the amended casting draft.

## Shared interfaces — ratify on the vine, then fill

### Claim A1 — per-node action slots (CLAIM — awaiting daedalus + circe)

Engine stores agent-authored actions as node-scoped metadata (the lens
precedent: agent-writable, not staged, not ratified). New verb
`actions <nodeId> --set <json> | --clear` (CLI) over `PUT /nodes/:id/actions`.
Wire shape, an array replacing wholesale:

```json
[
  {
    "id": "jungian",
    "label": "Explore Jungian archetypes",
    "seed": "Explore Jungian archetypes for this figure — "
  }
]
```

`state.nodes[].actions` carries it (absent/empty = none). Events: a
`node.actions` bus event on set/clear (ambient metadata, but the set is an agent
intent — one event per write, payload = full new array). Surface renders actions
in the node context menu under the standard verbs; click seeds the composer with
`seed` + the node as ground (never auto-sends); visually marked as
agent-suggested. Constraint asserted: actions apply to **ratified nodes AND
pending proposals** (Cole met the want on proposals).

### Claim R1 — ratify-anywhere (CLAIM — awaiting circe; engine asserts no change)

Pure surface: card grid + canvas context menus gain Ratify / Reject wired to the
SAME endpoints the ReviewQueue uses (no new engine surface; daedalus ratifies
the no-change assertion). Zone-scoped proposals still refuse ratify (promote
first) — the menu must surface that refusal honestly, not hide the verb.

### Claim ACT1 — automated activity (CLAIM — awaiting daedalus + circe)

Daemon auto-flips: `role:"user"` message.posted while ≥1 agent tail connected →
`agent.activity {state:"received"}` (no agent connected → no flip; the presence
dot already says nobody's home). Any subsequent agent-authored write (send,
propose, ratify, mark, activity) resolves to `idle` unless the agent explicitly
set a state after the flip. Stall escalation: `received` older than 60s →
`agent.activity {state:"stalled"}` (new vocab word, Contract 9 amendment);
surface renders "agent may be stuck". Explicit `activity` verb remains as
override. Ephemeral-cursor clause holds: every auto-emit consumes a seq through
applyEvent.

### Claim K1 — doc kind honesty (CLAIM — awaiting daedalus + circe)

Ingest defaults dropped (`story`/`ramble` die). `docs.kind` becomes nullable;
existing rows keep their stored kind (additive migration — no rewrite). New verb
`doc kind <docId> <kind> [--clear]` sets it, recorded with author (agent|user) —
the badge renders only when kind is set, styled as asserted-by-author vs
agent-set. `doc.added` payload: `kind: null` for untyped. Surface: no badge when
null (not an "unclassified" badge — absence, per the game-board honesty rule).

### Claim B1 — build stamp + staleness guard (CLAIM — awaiting daedalus)

`build.ts` cleans `dist/` before writing and emits `dist/build.json`
`{commit, builtAt}`. Server boot: in release mode, log the stamp; if any
`src/mind-mapper/surface/**` source is newer than `builtAt` AND the src tree
exists (dev checkout), print a STALE DIST warning to stderr and include
`buildInfo` (with `stale: true`) in `/state`. Surface: footer shows short
commit + age. Release installs without src/ never warn.

### Claim G1 — selection→ground on send (CLAIM — awaiting circe; engine asserts no change)

Surface bundles the live selection (context-rail doc selections as `doc:<id>`,
canvas/grid node+proposal selections as bare ids) into the send payload's
existing `ground` field. Engine change: none (daedalus ratifies). Canvas
selection already rides; the fix is the context-rail path and any multi-select
union.

### Claim S1 — always-open search (CLAIM — awaiting circe)

Surface-only: the search/filter input renders permanently in the toolbar; the
open/close toggle dies. Keyboard summon keeps its clickable twin.

## Slices

- **daedalus** — A1 store+verb+event, ACT1 automation, K1 nullable kind + verb,
  B1 stamp+guard; Contract 9 amendments for all of it. Lane:
  `plan/daedalus-r4.md` (owner-authored after ratify).
- **circe** — S1, G1 (P1); A1 menu+composer seeding, R1 menus, ACT1
  stalled-state rendering, K1 badge, B1 footer (P2). Lane: `plan/circe-r4.md`.
- **cassandra** — P3 cold drive off the amended casting draft: action-slot loop
  (agent sets action → human clicks → composer seeds), ratify-anywhere incl.
  zone refusal, auto-activity observation, kind verb, stale-dist warning repro.
  Two-round gate shape stands (fail → rework → cold re-drive by cassandra).

## Verification gate

920+ tests stay green; mind-mapper tsc-clean; every new wire shape lands in
Contract 9 BEFORE P2 consumes it (the zero-wire-guess bar from R3);
casting-draft.md amended for action slots + auto-activity so the gate drives off
the doc, not tribal knowledge.

## Asserted ABSENT

No submaps, no data-adjustment verbs, no OKF parsing, no derive layer this
round. No new persistence beyond `docs.kind` nullability + node actions storage.
No bus-scoping changes (zones stay payload-tagged, inclusive `/state`). Ratify
mechanics untouched (R1 is menu wiring only).

## Ratified decisions & lead rulings

Both owners ratified independently (daedalus w/ measured SQLite repros, scratch
`2026-07-19-r4-ratify-repro.ts`). Rulings, single-sourced here; Contract 9
amendments are daedalus's to write as each item lands:

- **A1 AMENDED (falsified as drafted — both owners converged on the same hole:
  proposals live in `state.proposals[]`, so `PUT /nodes/:id/actions` could not
  carry Cole's proposals-get-actions constraint).** Adopted: target-keyed
  `node_actions` table (`target_id` = node id OR pending proposal id, disjoint
  UUIDs; `CREATE TABLE IF NOT EXISTS` doctrine); `PUT /actions/:targetId` (array
  body, shape-validated, 404 unknown target) + `DELETE` to clear;
  `actions.set {targetId, actions}` event (full-array payload, new EventKind
  union member); wire rides BOTH `state.nodes[].actions?` and
  `state.proposals[].actions?`. Lifecycle: **ratify re-homes** actions onto the
  minted node id (the stigmergy payoff — dying at ratification would gut it);
  reject + zone-delete cascade clean their rows; promote is a no-op. Cap: soft —
  advisory `warning` past 4 entries (edgeDraftWarning mechanism), 16KB byte-cap
  on the json, surface shows 4 + scroll (cap the visible, never the list).
- **R1 RATIFIED zero-engine-change, plus one small additive ask I'm granting:**
  the in-zone ratify refusal becomes a typed 409 `{error:"zoned", zoneId}`
  (CitedError family) so menus distinguish it without string-matching. Surface:
  extract `IdeaNode`'s menu into a shared `NodeContextMenu` (CardGrid cards get
  it too — same chassis A1 needs, build once); ratify-from-menu = accept at
  `suggestedTier` (look up the proposal row by synthetic id); mirror the queue's
  Claim-D asymmetry (user-authored sketches offer withdraw only); `ruleProposal`
  parses `body.error` verbatim into the notice bar (promoteProposal precedent).
- **ACT1 RATIFIED w/ corrections.** This **supersedes Contract 9 Claim C's TTL
  clause**: `received → (TTL ~60s) → stalled` (persists until an agent write or
  explicit set resolves it); `thinking → (TTL) → idle` unchanged. `stalled` is
  daemon-synthesized vocabulary only — `POST /activity` rejects it
  (epoch.changed asymmetry precedent). `activitySource: "auto"|"explicit"` on
  ProjectEntry (in-memory, restart-clears); agent writes resolve auto-state;
  explicit states stand until set idle or TTL. Auto-flip site: `/send` handler,
  `entry.agents >= 1`, emit after message.posted. Drive-3's "liveness ping" is
  formally dropped — SSE has no ack transport; timer escalation is the honest
  reduction (don't re-propose). Surface: `stalled` gets its own STATIC
  attention-tinted branch — it must NOT wear the thinking pulse
  (false-liveness), and the client THINKING_TTL backstop must not clear it to
  blank.
- **K1 AMENDED (mechanism falsified — SQLite cannot drop NOT NULL; a
  fresh-vs-migrated schema fork violates the migration doctrine).** Adopted:
  `kind` stays NOT NULL at rest, untyped = `''`, **null-normalized at read**
  (existing doctrine); intake defaults die;
  `ADDITIVE_COLUMNS.docs = ["kind_author"]` (nullable; legacy rows = honestly
  unattributed); `POST /doc/:id/kind {kind, author}` (mark route family),
  `doc.kind` event; **`kindAuthor` rides `state.docs[]`** (circe's wire flag —
  without it the surface can't style asserted-vs-agent). Surface: null kind = NO
  badge (absence) — and guard the lookups: `KIND_ICON[null]` crashes the rail
  today. `readDoc` envelope type loosens to `string|null`. Node kind (ratify.ts
  draft.kind) is unrelated — don't sweep it.
- **B1 RATIFIED w/ placement:** clean → build → stamp order in build.ts (rm dist
  first — fixes the chunk-accumulation sub-finding);
  `dist/build.json {commit, builtAt}`; server reads once at boot in release mode
  (boot-time staleness is honest — routes bake at boot); src-tree walk guarded
  by existsSync (release installs never warn); `/state.buildInfo` spread at the
  handler NOT through readState (daemon-level, presence precedent; ProjectState
  under-reports the wire again — Contract 9 as-built note gets a sibling). Boot
  stdout gains buildInfo additively.
- **G1 RATIFIED zero-engine-change, one falsified sub-claim:** doc "selection"
  state does not exist — the honest mapping is **open doc = rail selection**.
  Bundle `doc:<openDocId>` ∪ selected node/proposal ids at the single choke
  point (App onSend), via a small pure tested `state/groundBundle.ts`.
  Canvas/grid node+proposal selection verified riding today. Contract 9 grammar
  footnote: bare ground id = node OR pending-proposal ref (no `proposal:` prefix
  minted).
- **S1 RATIFIED:** kill the `open` flag, palette input renders permanently at
  its perch; ⌘K + "/" focus it (the always-present input is its own clickable
  twin); Escape clears/blurs instead of closing; `palette` memo drops its
  open-gate; keep the FocusBar top-14 dodge.
- **Open questions closed:** agent send while `thinking` → resolves to `idle`
  (both owners independently: a reply is the turn's terminal act; re-set
  thinking explicitly for send-then-more-work). Action cap → soft advisory as
  above.
- **Plan errata:** presence lives in `server.ts` (`adjustAgents` +
  `ProjectEntry.agents`), not a `presence.ts`; `ComposerSeed` lives in
  `ConversationPanel.tsx`, not a `composerSeed.ts` module.

## Build order (post-ratify)

- **daedalus P1:** K1 → A1 → ACT1 → B1 (+ R1's typed zoned 409), Contract 9
  amendment accreting per item, landed BEFORE circe P2 contact (the
  zero-wire-guess bar). The one existing test this round _changes_ (not
  extends): presence.test.ts's TTL rig (received→stalled).
- **circe P1 (parallel, no engine dependency):** S1 → G1 (groundBundle helper +
  onSend union + tests).
- **circe P2 (after daedalus lands):** R1 menu chassis (shared NodeContextMenu +
  CardGrid wrap + ruleProposal error parse) → A1 slots in the chassis → ACT1
  stalled branch → K1 badge guards → B1 footer.
- **cassandra P3:** cold drive off the amended casting draft; two-round shape.

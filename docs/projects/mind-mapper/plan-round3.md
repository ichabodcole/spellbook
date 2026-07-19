# Mind Mapper Round 3 — zones + drive-2 build plan (skeleton)

**Lead:** prospero · **Seats:** daedalus (engine), circe (surface), cassandra
(gate) · **Branch:** `feature/mind-mapper-zones` (cut at convene, off develop @
db321c2). **Source:** `drive2-findings.md` triage. **Method:** light-feature
collapse, seam claims ratified inline before build (the Track A pattern — 4/7
claims falsified pre-build last round; ratify runtime-behavior claims only with
a measured repro, per anthill #46).

## Integration / dependency order

- **P1e — engine** (daedalus): zones schema + verbs + promotion, pending search,
  `open --project` + project lifecycle, `send` body resolution.
- **P1s — surface-independent** (circe, parallel with P1e): theme toggle,
  markdown chat rendering, CTA-seeds-composer.
- **P2 — surface consumes zone/search wire** (circe): zone UI, card grid view,
  doc-lens, pending search palette.
- **P3 — gate** (cassandra): cold drive incl. the full zone loop (create →
  explore messy → promote → rule in main queue) + casting-draft accuracy. Gate
  precedes dogfood drive #3.

## Shared interfaces — ratify, then build

All additive to Contract 9 unless stated.

### Claim Z1 — Zones: additive scope on staging (findings 3/8/10) — (CLAIM — awaiting daedalus, circe)

New table `zones {id, project_id?, name, ts}` (id slug-or-uuid — owners rule).
`proposals` gains nullable `zone_id` (via `ADDITIVE_COLUMNS`). The main graph is
`zone_id IS NULL` — untouched semantics, all existing rows unaffected. **Zone
contents are proposals only** (nodes/edges never carry zone_id): a zone is a
place where everything is staging and mess is licensed; the map-as-view litmus
applies only at the promotion boundary. Verbs: `zone create <name>`,
`zone list`, `zone delete <id>` (deletes its proposals wholesale — the
disposable-sandbox property; confirm flag), and propose verbs gain
`--zone <id>`. `/state` gains `zones[]`; `?zone=<id>` filters `proposals[]`
(main-state responses exclude zoned proposals by default — the don't-contaminate
property). Events: `zone.created {id, name}`, `zone.deleted {id}`, and
`proposal.added` payloads carry `zoneId` when zoned.

### Claim Z2 — Promotion (finding 10) — (CLAIM — awaiting daedalus, circe)

`promote <proposalId>` clears `zone_id` (UPDATE, provenance/evidence rows
untouched) → the proposal appears in the main review queue as a normal pending
item; event `proposal.promoted {id}`. Open sub-question for owners:
duplicate-vs-move — the claim says MOVE (Cole named both; move is simpler and
the zone keeps no tombstone). Edges whose endpoints are zoned proposals may only
promote after (or with) their endpoints — same resolve-order rule as ratify;
error names the unpromoted endpoint. Ratify of a still-zoned proposal is an
error ("promote first") — ratification is a main-graph act.

### Claim Z3 — Zone surface (finding 10) — (CLAIM — awaiting circe; daedalus for wire fit)

Zone switcher in the header (main + zone tabs; create/delete affordances).
Inside a zone view: the SAME GraphCanvas fed zone-filtered proposals, rendered
**un-dashed** (full-strength visuals — staging styling exists to mark
not-yet-canon against ratified neighbors; inside a zone everything is staging,
so the mark carries no information). Node/edge context menu gains Promote (with
the endpoint-order rule surfaced). The agent's lens/look-here apply within the
active zone view. Equal-capabilities: zone create/switch is also conversational
(agent can mint and reference zones).

### Claim S1 — Pending-proposal search (finding 9) — (CLAIM — awaiting daedalus, circe)

`/search` gains `kind:"proposal"` hits (pending only; title+synopsis from
draft_json; zoned proposals tagged with their zone). Palette renders them with
the pending visual vocabulary; a hit focuses the pending element on canvas (zone
hits switch to the zone view first). No-results state says what was searched and
shows non-node hits instead of bare "empty".

### Claim P1 — Project lifecycle (finding 1) — (CLAIM — awaiting daedalus, circe; Cole reviews at drive #3)

`open --project <id>` appends `?project=` to printed URL and spawned browser.
The "Default" project stops being auto-minted for NEW stores: a store with no
projects boots empty, `/state` without `?project=` returns
`{projects: [...]}`-shaped 409/redirect… — stated as the claim: **unscoped
`/state` on a projectless store returns a `needs-project` marker; the surface
renders pick-or-create instead of a board**. Existing stores keep their Default
project (it's just a project named Default — no migration). Unscoped event
connections attribute to… nothing: presence attribution's default-project clause
narrows to "the daemon-resolved default IF one exists"; the surface always
reconnects scoped once a project is picked (circe verifies the WS lifecycle).
This is the riskiest claim — falsify freely; the mechanical `--project` half
ships regardless.

### Claim C1 — send body resolution (finding 12) — (CLAIM — awaiting daedalus)

`send` adopts grapevine's body-resolution chain, precedence order:
`--body-file <path>`, then `--stdin`, then positional text, then piped-stdin as
the default when no inline text. Multi-paragraph bodies land verbatim (newlines
preserved on the wire — already true; verify). `mark --note` stays flag-sized;
only send carries prose.

### Claim C2 — Markdown chat (finding 15) — (CLAIM — awaiting circe)

Agent bubbles render markdown (headings, lists, bold/italic, inline code, fenced
code; links open in new tab); user bubbles render plain text with preserved line
breaks. Span flash-highlight (Contract 6) must compose with rendered markdown —
matching runs against the message's PLAIN text and the highlight targets the
rendered DOM (circe owns the mechanism; whitespace- tolerant matching already
handles reflow). Renderer choice is circe's (house constraint: bundled, no CDN).

### Claim C3 — CTA seeds the composer (finding 14) — (CLAIM — awaiting circe)

The node ask-the-map verbs (Explain / Questions / Subtopics) stop sending
directly: they seed the chat composer with the structured act — the verb label
plus the node title as text, plus the ground chip — and focus it; the human
appends intent or presses Enter to send as-is. Analyze (doc menu) keeps
direct-send (it IS the intent). Codify as the house rule: structured verbs seed,
they don't send.

### Claim V1 — Card grid view (finding 6) — (CLAIM — awaiting circe)

A view toggle (map / grid) beside the layout toggle. Grid = plain HTML (not
canvas): cards grouped by tier (then kind within), reusing the node-card
vocabulary; pending proposals included wearing staging styling; search/filter
and doc-lens apply to the grid identically (equal-capabilities: the lens shapes
both views). Clicking a card opens NodeDetail; grid state is view-local (not in
the store, not synced — it's a rendering, per finding 6).

### Claim V2 — Doc-lens (finding 5) — (CLAIM — awaiting daedalus, circe)

`lens` gains a doc mode: `lens set --doc <docId>` (persisted like node lens;
`lens.set` payload gains the doc variant). View shows nodes with a source in
that doc (+ their edges); marks-but-no-nodes renders honestly empty. Surface
shortcuts: context-rail card click or menu item "Show extracted nodes".
Node-lens and doc-lens are mutually exclusive (one lens row).

### Claim T1 — Theme toggle (finding 2) — (CLAIM — awaiting circe)

Dark/light toggle in the header; tokens already semantic so the work is the
second palette + persistence (localStorage) + honoring prefers-color-scheme as
the default. Any raw-palette stragglers found while doing it get fixed to tokens
(the forcing function doing its job).

### Absent by design

- No derive layer / embeddings this round (behind zones, ruled).
- No cross-PROJECT promotion (zones are within-project; the portal paradigm
  stays parked per finding 10's resolution).
- No Operator importer this round (deferred; the bulk-export ask goes to the
  operator-doc-linking channel separately).
- No force-layout changes, no image intake, no multi-agent mechanics.
- Contract 8 holds: the daemon stays dumb — zones/promotion are storage moves.

## Slices

- **daedalus:** Z1, Z2, S1 (engine half), P1, C1, V2 (engine half) + tests +
  casting-draft amendments (zone loop, promote, send body chain, doc-lens).
- **circe P1s:** T1, C2, C3. **circe P2:** Z3, V1, S1 (palette), V2 (surface).
- **cassandra:** cold gate incl. zone loop end-to-end, promotion ordering
  errors, pick-or-create landing (fresh store), markdown rendering + span flash
  compose, casting-draft accuracy.

## Verification gate

Full `bun test` green; cassandra cold drive zero wire-guess failures;
casting-draft accurate. Human gate: dogfood drive #3.

## Ratify round — verdicts, corrections, and lead rulings (2026-07-18)

All claims RATIFIED as corrected below; both owners' full verdicts are in the
session record. Deltas from the skeleton:

**Z1 corrected + RULED (the round's would-have-shipped-broken bug, caught
independently by both owners from opposite sides):** events are project-scoped
and can never be zone-scoped (one bus per project, Contract 8); a zoned
`proposal.added` reaches every subscriber. So **payload-tagging is the mechanism
and consumer-side filtering is load-bearing**: `Proposal` wire type gains
`zoneId: string | null` (tags events for free — propose emits the full object).
**Lead ruling on the snapshot half:** `/state.proposals[]` INCLUDES zoned rows
(tagged) — no default exclusion; snapshot merge and event ingestion then obey
ONE rule (circe's reducer-coherence requirement), zone-switch is free, one
cursor, tab badges computable. `?zone=<id>` remains as a narrowing convenience
for focused agent reads. Main view = `zoneId == null` at render.
`zone.created {id,name}` / `zone.deleted {id}` thin; on zone.deleted consumers
drop that zone's proposals locally (scoped drop ≠ wholesale replace). Zone ids
are SLUGS derived from name (conversational referenceability); no rename.

**Z2 ratified:** move-not-duplicate confirmed. Route
`POST /proposals/:id/promote`, CLI `promote <id>`, thin `proposal.promoted {id}`
(consumers with the inclusive store clear `zoneId` locally). Guards:
ratify-of-zoned errors "promote first" (in ratify() intake); promote's edge
endpoint-order mirror names the unpromoted endpoint; promote pending-only.
Unclaimed edge flagged for dogfood: reject-in-zone (zone delete is the only
disposal this round).

**P1 falsified → corrected:** Default is minted LAZILY on every unscoped request
(not boot), and auto-mint carries a demo-seed path (`seedDefaultProject`) the
skeleton never mentioned. Mechanism: `resolveProject(home, undefined)` returns
default iff its dir exists (legacy stores unchanged), else **409
`{error:"needs-project", projects:[...]}`** from every scoped endpoint — SSE
refused pre-stream, WS upgrade refused (so presence attribution needs only the
two-word "if one exists" narrowing). 409-not-200-marker (a fake ProjectState
lies to consumers; one fetch branch is honest) — daedalus's shape adopted over
the 200-marker alternative. **Lead ruling: the demo seed DROPS** — a projectless
store booting empty IS the feature (Cole's stated design position; flagged for
his drive-3 review). Surface half (circe): needs-project status in the hook, WS
gated on resolved scope, pick-or-create landing re-homing ProjectPicker,
stale-stored-id degrades to landing + clears storage (never the error screen).

**C1 ratified + measured correction:** adopt grapevine's body chain +
leaked-invocation guard (verb narrowed to `send`) + shell-risky warning —
behavior, not parser. **Measured (repro'd): the piped-stdin default HANGS
FOREVER under agent shells** (`isTTY` null, no EOF) — grapevine ships this today
(house-wide finding → Track B). Guards: empty resolved body = usage error exit
2; casting draft states the sharp edge; newline round-trip pinned by test. No
read timeout (breaks slow pipes).

**S1 ratified + ranking:** `kind:"proposal"` hits, pending-only, matched in JS
over parsed draft_json (SQL LIKE over raw JSON matches keys/escapes), score =
node formula ×9 (match quality dominates tier; equal-match → ratified node
first), hits carry `zoneId`. Palette: kinds survive the memo, pending
vocabulary, zone hits switch view first, honest no-results.

**V2 ratified + shapes:** `lens.doc_id` via new `ADDITIVE_COLUMNS.lens` entry;
XOR by construction (upsert writes all columns); POST validates nodeId XOR
docId, depth only with node, docId slug+exists; `lens.set` payload carries
`docId` always (additive-optional — circe acked by lane). **Card-click falsified
(circe):** single-click keeps meaning open-doc-viewer; doc-lens shortcuts =
context-menu "Show extracted nodes" + hover crosshair icon twin. FocusBar doc
pill hides depth controls.

**C2 ruled (circe): micromark, bundled** — safe-by-default (HTML-encodes raw
HTML), no sanitizer dep, CommonMark core only; root package.json dep
(shared-file flag: approved by lead at ratify). Span-flash × markdown: match
against rendered DOM textContent (spans quote prose); highlight by TreeWalker
text-node walking with a pure tested offset-mapper; never surroundContents;
no-match degrades to bubble-level flash. User bubbles: plain +
whitespace-pre-wrap.

**C3 ratified:** verbs live in BOTH IdeaNode context menu and NodeDetail buttons
— both switch to seeding a `composerSeed {text, seq}` prop; seeding sets
selection to the node (chips = ground preview, rides onSend). Analyze stays
direct-send. Focus stays a command.

**Z3/V1/T1 ratified + circe's layout ruling:** header stays lean (theme toggle
joins the right cluster); **zone tab strip is a second row rendered only when
zones exist** (`main | tabs | + zone`; delete via tab context menu

- AlertDialog); view segmented control `map | grid` lives in the canvas Panel
  top-right, tree|physics toggle shows only in map view. Grid consumes
  `visibleMap` + `matches` (equal-capabilities free by construction); card click
  = select (NodeDetail opens via existing derivation). Theme: alias tokens
  restructure to var-refs (else the light palette is written twice), light
  palette = `[data-theme=light]` custom-property override, pre-paint inline
  script, `mind-mapper:theme` localStorage, prefers-color-scheme default. React
  Flow chrome in light mode is the expected seam — verify with pixels.
  Lens/look-here targeting a zoned element: switch to its zone, then focus
  (co-presence over view-stickiness; no engine change — lens has no zone
  dimension).

## Open questions

_None blocking — reject-in-zone and the demo-seed drop are flagged for Cole at
drive #3._

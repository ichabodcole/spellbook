# circe's lane — mind-mapper V1 surface

Authored against the seams ratified on the `spellbook` vine (msgs 3–4): Claim A,
the wire-schema addendum (per-entity WS patches through `applyNodeChanges`,
snapshot-refetch on gap/first-mount), the review-queue contract, and the intake
contract. Integration order follows `plan.md`'s P1–P4; tasks below are grouped
the same way. All paths are under `src/mind-mapper/surface/` unless noted.

## P1 — real state (live-state rewiring + project picker stretch)

**Goal:** replace the spike's one-shot `fetch("/state")` with real state: a
typed reducer that applies daemon events, a WS connection that feeds it, and a
snapshot-refetch fallback on gap or first mount. `App.tsx` currently does
`useState<StubMap | null>` + a bare `useEffect` fetch (`App.tsx:57,84-89`) —
this becomes a hook, not inline effect soup, so the reducer is unit-testable
apart from React.

1. **`types.ts`** — extend the wire types per the ratified schema:
   `ProjectState = { project, docs[], nodes[], edges[], proposals[], conversation[], lens, cursor }`;
   `ServerEvent = { seq, kind, payload }` with a kind union
   (`doc.added | node.ratified | proposal.added | message.posted | lens.set`,
   extend as daedalus's verb set lands);
   `Proposal = { id, kind: "node"|"edge", draft, evidence: {docId, span}, suggestedTier, status }`.
   No placeholder fields — only what daedalus's ratified wire actually emits;
   extend this file again if the verb set grows before P1 closes.
2. **`state/reducer.ts` (new)** — pure function
   `applyEvent(state: ProjectState, event: ServerEvent): ProjectState`.
   Per-entity patch semantics only (the wire-schema addendum): `doc.added`
   appends to `docs`, `node.ratified`/`proposal.added` upsert by id,
   `message.posted` appends to `conversation`, `lens.set` replaces `lens`. Never
   a wholesale array replace — this is the function that has to feed React
   Flow's `applyNodeChanges` path downstream, so it must describe _changes_, not
   new arrays wholesale, even though the state shape itself is plain objects.
   - TDD: `state/reducer.test.ts` — one test per event kind
     (append/upsert/replace semantics), plus an out-of-order-seq case (event
     with `seq <= state.cursor` is a no-op — the dedupe an SSE/WS resume needs)
     and an unknown-kind case (ignored, not thrown — matches the "peripheral
     failure never takes the board down" reflex in my seat doc).
3. **`state/useProjectState.ts` (new hook)** — owns the full lifecycle:
   `GET /state` on mount → seed reducer state; open `WS /events?since=cursor`;
   each frame → `applyEvent`; on socket error/ close or a detected seq gap
   (`event.seq !== cursor + 1`), refetch `/state` wholesale and reseed (the
   documented fallback, not a bug path). Returns `{ state, error }`. This
   replaces `App.tsx`'s inline fetch effect; `App`'s `map` local state and its
   `error` state both come from this hook now.
   - TDD: the gap-detection predicate (`isGap(cursor, event.seq)`) is pure —
     test it directly. The socket lifecycle itself is DOM/network and gets a
     live verify pass (daemon up, kill mid- session, confirm resnapshot), not a
     unit test — matches the fileIntake precedent (imago: `centeredLayerBox`
     unit-tested, the DOM-touching functions verified live).
4. **`App.tsx` rewire** — swap `useState<StubMap|null>` + the fetch effect for
   `useProjectState()`; `map` becomes `state?.project ? state : null` shaped
   access (docs/nodes/edges read the same way downstream, so
   `ContextRail`/`GraphCanvas`/etc. props don't change shape here — only where
   the data originates). `lens` moves from local `useState` to daemon-owned
   state (`state.lens`) with a local-optimistic apply on send, since P1's gate
   is read-path; write-path (agent lens writes) lands with P3's lens/look-here
   work below.
5. **Project picker (P1, firmed up from stretch).** Daedalus added
   `projects [--create]` (list/create) to the CLI verb set specifically to
   unblock this — my open question is resolved, no longer a maybe. A minimal
   picker: a header dropdown next to the doc/node/edge counts in `App.tsx`
   (`App.tsx:174-179`), backed by the corresponding `GET /projects` read;
   selecting a project re-mounts `useProjectState` with a new project id.
   Creating one from the picker calls the create half of the same verb.

**Gate (per plan.md):** the spike surface renders a real persisted project;
kill/restart the daemon loses nothing ratified. My side of that gate:
`useProjectState`'s reseed-on-reconnect path, verified live against a real
daemon restart.

## P2 — ingest + conversation + staging

1. **`state/intake.ts` (new)** — port the imago/glamour `fileIntake` shape
   (`imago/surface/state/ fileIntake.ts` is the reference), not its
   image-specific bodies: drag/drop + file-pick handlers that read `File[]` and
   call a `send`/`post` callback, all converging on `POST /ingest` (multipart
   for file drops, JSON for brain-dump text and "+ new document"). Three entry
   points, one wire call — `ingestFiles(files, post)`,
   `ingestText(title, text, post)`, `ingestBlank(title, post)` — matching the
   CLI verb's own three-shape `ingest` (`--file` / `--stdin` / bare title).
   - TDD: any pure piece (payload shaping — e.g. a
     `buildIngestPayload(kind, ...)` that returns the multipart/JSON body shape)
     gets `state/intake.test.ts`. The actual `File`/`FormData`/fetch glue is
     DOM-only and gets a live verify pass, same split as imago's
     `fileIntake.test.ts`.
2. **`ContextRail.tsx` intake affordances** — add a drop zone (whole rail,
   matching imago's canvas- as-drop-target precedent) and a "+ new document"
   button (imago's `ContextLibrary.tsx` is the sibling to mine, not copy). Both
   call into `state/intake.ts`; the rail itself stays a dumb list renderer plus
   these two new entry points — no ingest logic inline in the component.
3. **`ConversationPanel.tsx` against the real bus** — `onSend` currently appends
   a local-only `Message` (`App.tsx:131-132`, `say()`). Rewire: `onSend` posts
   to the daemon's `send` verb; `messages` comes from `state.conversation` (via
   `useProjectState`) rather than local `useState`. The seed message ("No agent
   behind the board…", `App.tsx:46-54`) drops — there IS an agent now.
   `MessageBubble` and the tier-chip selection UI are unaffected (they render
   `Message`/`MapNode` shapes that don't change).
4. **Pending overlay is live, not synthetic.** The spike's `pending?: boolean`
   on nodes/edges (`types.ts:33,65`) was hand-authored in stub data; P2 it
   reflects real `proposal.added` events via the reducer. No new component —
   `GraphCanvas`'s existing pending styling is reused; only the data source
   changes. Verify: cassandra's P2 gate (a real brain-dump → pending overlay,
   end-to-end).

**Gate (per plan.md, cassandra):** a real brain-dump becomes a pending map with
provenance, driven end-to-end by a cold agent. My side: intake reaches
`/ingest`, conversation reaches `/send`, pending nodes/edges render from real
`proposal.added` events — no stub data left in the P2 path.

## P3 — ratification + search + lens verbs

1. **`ReviewQueue.tsx` (new)** — the review-queue contract: renders
   `state.proposals` grouped by `evidence.docId` (batch-by-source, per bobbin's
   spec), one row per proposal showing the agent-drafted `draft` (never a
   compose-in-UI form — ruling = accept/reject the draft as-is). One-keystroke
   rulings (`accept` →
   `POST /proposals/:id/ruling {ruling: "canon"|"thread"| "story-local"}`,
   `reject` → same endpoint, no justification required, matching the contract).
   Placement: a rail/panel toggled from the header (mirrors `ContextRail`'s
   aside pattern) — exact chrome decided when P3 starts, since the spike never
   built one to adapt from.
   - TDD: the grouping function
     `groupProposalsByDoc(proposals): Map<docId, Proposal[]>` is pure —
     `state/reviewQueue.test.ts`. Keystroke → verb-call wiring is a live verify
     item (cassandra's P3 gate exercises the full ratify loop anyway).
2. **`SearchPalette.tsx` backend wiring** — today `App.tsx`'s `matches` memo
   does client-side substring filtering over `map.nodes` (`App.tsx:97-105`); P3
   swaps this for the daemon's `search` verb (FTS5). `SearchPalette` itself is
   unchanged (it already takes `matches`/`query`/`onQuery` as props — "V1 swaps
   the guts for hybrid search behind the same contract" per its own header
   comment). New: a debounced query effect in `App.tsx` (or a
   `state/useSearch.ts` hook if the debounce logic grows) that calls
   `GET /search?q=` and sets `matches` from the response instead of the local
   filter.
   - TDD: the debounce timing itself isn't worth unit-testing (timer-based,
     flaky); if a query-normalization step exists (trim/lowercase/minimum-length
     gate before firing), that pure predicate gets a test.
3. **Agent-lens / look-here rendering** — the human half of the lens
   (`FocusBar.tsx`, `App.tsx`'s `lens` state) already exists from the spike; P3
   adds the agent half the spike's own comment flagged as unwired ("V1 gives the
   agent write access… the spike only wires the human trigger",
   `types.ts:38-40`, `FocusBar.tsx:1-5`). Concretely: `lens.set` events (via the
   P1 reducer) update `state.lens` with `owner: "agent"`, and `FocusBar`'s
   existing agent tint (`FocusBar.tsx:26-29`, already coded, never exercised)
   finally renders. `focusRequest` (`App.tsx:68`, currently only set by the
   human search-palette pick) also becomes agent-settable via the same event,
   driving `GraphCanvas`'s existing `focusRequest` prop — no new canvas
   plumbing, just a second event source feeding props that already exist.
   - Verify: live, with cassandra — an agent-issued `look-here` visibly moves
     the human's viewport. This is the two-way attention contract from my seat
     doc's Candidates section closing out.

**Gate (per plan.md, cassandra):** the full loop — ingest → map → converse →
ratify → doc holds the sentence → restart → still true. My side: review queue
rulings actually post, search hits the real backend, agent lens events actually
move the canvas.

## P4 — hardening + experiments

1. **Force-layout toggle** (parked spike card, now unparked) — a togglable
   physics-based layout beside the default dagre static layout in
   `GraphCanvas.tsx`. Candidate: d3-force driving React Flow node positions, per
   my seat doc's Candidates note (Cole wants physics-as-structure-
   communication, not decoration — a toggle, not a replacement). Scoped as its
   own card; not gating the P3 acceptance test.
2. **Release-mode serve** is daedalus's (Contract 1/2) — my only P4 obligation
   there is making sure nothing in the surface reads dev-only paths (already
   true; the surface never imports server-side modules per my seat doc's
   boundary line).

## Deliberately out of this lane

- Card view (V2, per proposal.md's Future Considerations).
- Sub-maps, versioned-file diffing — explicitly out of V1 scope (proposal.md
  `Out of Scope`).
- Multi-project canon sync / Operator context ingestion — V2.
- Anything under daedalus's Boundaries line in my seat doc (daemons, CLIs,
  endpoints, serve/build modes) — I consume the served wire only, per the seams.

## Self-review against the ratified seams

- Claim A: every task above is render + a `send`/`post`/`fetch` call into a
  CLI-backed verb; no intelligence lives in any surface file listed. Holds.
- Wire-schema addendum: the reducer (P1.2) is explicitly per-entity/upsert,
  never a replace; feeds `GraphCanvas`'s existing `applyNodeChanges`-based
  semi-controlled pattern unchanged.
- Review-queue contract: `ReviewQueue.tsx` renders `draft` verbatim, no
  compose-in-UI, reject needs no reason — matches P3.1 as written.
- Intake contract: three intake shapes converge on one `POST /ingest`, matching
  P2.1 as written.

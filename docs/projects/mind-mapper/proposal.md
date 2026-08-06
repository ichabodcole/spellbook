# Mind Mapper — map your thinking into a shared, source-traceable board

**Status:** Draft **Created:** 2026-06-30 **Updated:** 2026-07-16 (absorbed the
collaborative-knowledge brain dump + landscape analysis) **Author:** Cole Reed
(brainstormed with Claude)

> Working handle is **"mind mapper."** The spell's real name + kind reserve at
> coalescence per `grimoire/trigger-registry.md`, not here.

---

## Overview

A spell that ingests source material — a freeform brain-dump or a set of context
files — and turns it into an **interactive, source-traceable map of the ideas
within it**, then becomes a co-presence **game board** where the human and agent
explore, dig into, and refine those ideas (and the content tied to them)
together.

It's **digestify's inverse**: where digestify pushes structured content _to_ the
human to consume, the mind mapper captures _from_ the human and structures it —
the artifact _is_ the capture. Concept consolidated from two fragments
(`docs/fragments/2026-06-30-mind-mapper-spell-concept.md`), and re-consolidated
2026-07-16 with the collaborative-knowledge brain dump (Operator:
`fragments/mind-mapper-spell-concept` v4 is the canonical precursor). That brain
dump widened the destination — a persistent, multi-session canon-and-capture
loop with an agent team (see "V2 vision" under Future Considerations) — while V1
deliberately stays the tight slice below.

## Problem Statement

Raw thinking — especially dictated brain-dumps — is messy and hard to see whole.
Even well-formed documents hide their own structure: a polished story or
world-building doc is a web of concepts and relationships not visible on the
surface. In both cases the author ends up with material that doesn't reveal its
key claims, how the pieces relate, or where the gaps are.

**Field-tested precedent (not hypothetical):** Cole already does a version of
this in consulting — a client-session transcript is fed to an agent that pulls
out **claims**, notes who **confirmed/denied** them, points each back to its
**source** in the transcript, and diagrams the systems with mermaid. This spell
generalizes that proven workflow into a re-castable surface.

## Proposed Solution

A standing co-presence board (the imago/glamour model — asymmetric but
equally-useful views, shared context). Core loop: **provide context → agent
analyzes → first map → converse to refine.**

**The opening:** a freeform **text box** (brain-dump; the human dictates with
their own speech-to-text, so the spell only ever sees text) **+ drag-and-drop
for context files.** Submit → the agent ingests everything and renders the first
map. (It may optionally open by asking a few clarifying questions from the
context; default is analyze-then-converse.)

**The surfaces:**

- **Map canvas** — the interactive graph of ideas (nodes + relationships).
- **Context canvas** — read an individual source item: click a context item to
  make it the main view, or a split view (map ⇆ context). Parity for the human
  (the agent already has the content).
- **Node detail** — click a node to see/edit what's "stored" there, including
  its source-doc provenance links (node → doc click-through; nodes are
  claims-within-docs, so entity nodes may have a ~1:1 home doc while claim nodes
  anchor to spans).
- **Context rail** — a persistent list/card view of every source doc in the
  session; click-through in both directions (doc ⇆ nodes). For Operator-backed
  corpora the session holds read-only snapshots (fetched over MCP, `updatedAt`
  as staleness anchor); edits flow back only via ratification. _(Spike drive,
  2026-07-16: confirmed load-bearing — "it should be really easy to pull up a
  document within this surface and read it.")_
- **Chat sidebar + selection-as-context** — select a node or context item and
  message; the agent gets that selection as the focus. Framing ruling (spike
  drive): this is a **conversation** — working through what exists _and what
  doesn't_, deciding where to go — not a query box over existing context. A
  sidebar (not a bottom bar) so message history has real estate.
- **Canvas search (find-a-node)** — search box + keyboard summon over the map:
  typeahead results (tier-badged), live highlight/dim of matches while typing,
  select → pan/zoom + open detail. The **equal-capabilities counterpart of the
  agent's search verbs** — the human must be able to summon a node by typing as
  surely as the agent can by querying (spike: client-side over titles/synopses;
  V1: the same box fronts hybrid lexical+semantic search across docs). Composes
  with the lens: find answers "where is it," focus answers "let me work here."
- **Focus mode (lens)** — focus a node + its direct connections; the rest
  recedes; zoom back out to the whole map. Implemented as **addressable
  view-state** (a named lens object), because the lens is writable from _both
  sides_: the human clicks to focus, and the agent can set the lens from
  conversation ("let's focus on X") — agent-driven attention-steering as the
  reciprocal of selection-as-context. (Spike: human trigger; V1: agent verb.
  Aligns with the landscape's local-over-global-views finding.)

**Capture flows — two entry paths, one lifecycle (ruled 2026-07-16):** new
material enters either **ambiently through chat** (the conversation transcript
is itself a source doc; the agent extracts claims as the human talks, which
surface as _pending_ staging-overlay nodes with spans back into the transcript —
possibly unconnected at first, which is legal) or **deliberately via in-surface
doc creation** (a "+ new document" affordance in the context rail: title it,
dictate/type into it, and it becomes a source doc the agent analyzes into
pending nodes). The **bridge** between them is agent-proposed: when a chat
thread coheres into a thing ("this looks like it wants to be a character — mint
a doc from this thread?"), ratification mints the stub doc (the Operator
create-stub-and-link primitive), writes the accumulated ratified claims into it
as prose, and wires its links. Rule of thumb: **chat for thinking, documents for
things** — and talk transforms into graph objects only through ratification,
never silently.

**The artifact is map _and_ content.** Conversing refines the map _and_ the
content tied to nodes — producing revised or new content over time (full file
versioning/generation is a later boundary; see Scope).

**Delivered in two phases** (a deliberate spike-then-V1 split — see Scope),
because the mind-mapping UI is the load-bearing uncertainty and is best
de-risked before committing a V1.

## Scope

**Phase 0 — Spike (de-risk; no end-user value required):**

- Stand the spell skeleton up on the house **React + Bun + Tailwind** scaffold
  (this doubles as the second real exercise of the unified spell-surface
  scaffold the astrolabe re-home started extracting —
  `docs/backlog/2026-06-30-react-scaffold-as-default-investigation.md`).
- Prototype the **mind-mapping UI with throwaway/stub data** (a hand-fed map):
  graph render + interaction (pan/zoom, node → detail), and the **game-board
  layout** (map ⇆ context canvas, chat bar, selection-as-context).
- **Success = "a surface I'd actually want to think in."** Disposable is fine.

**In Scope (V1 — the full trip, real value):**

- Ingest (brain-dump text + dropped files) → agent analyzes → first map →
  converse to refine → walk away with a **saved, navigable, source-traceable
  map** built _with_ the agent, plus **editable node-detail content**, **source
  provenance** (claim ↔ source span), and the **context-viewing** surface.
- Value boundary ≈ **"C"** from the brainstorm: editable node-detail content +
  provenance + context-viewing, **without** a heavy file-versioning/diff engine.

**Out of Scope (initially):**

- A full content-file **versioning/diff/generation engine**.
- **Live audio transcription / STT** in-spell (the human dictates externally;
  the spell sees text).
- Multi-agent orchestration **if** a single-agent core proves sufficient (open).

**Future Considerations — the V2 vision (from the 2026-07-16 brain dump):**

The larger destination is a **persistent, multi-session collaborative knowledge
tool** — primary driving use case: story development & world-building; siblings:
app ideation, dream analysis, life planning. Its elements, all deliberately out
of V1:

- **Canon capture loop** — new ideas developed in a session become part of the
  canonical context, recognizable in future sessions. The map is a growing
  knowledge base, not a one-off artifact.
- **Context ingestion & sync** — project bibles, Operator docs, and _references_
  (a repo/local project an agent explores and returns from with a synthesized
  context doc); re-sync when source context changes between sessions; Operator
  integration.
- **Consulting-team agent model** — a lead liaison converses with the human;
  background agents listen and independently maintain the graph, analyze, and
  synthesize **intermediate knowledge documents** (fuzzy, cyclical layers:
  background context → intermediate synthesis → new artifacts).
- **Canon-contradiction checking** — automatically flag when a new idea
  conflicts with existing canon. Landscape analysis found _no surveyed tool
  automates this_ (NovelCrafter/Sudowrite punt to manual review) — a real
  differentiator candidate.
- **Card view** as a second lens for rapid ideation (same data, different
  presentation), plus first-class **search** across all context for human and
  agent alike.

Plus the previously noted items:

- Content/file **versioning + generation** (the produce-half, fully realized).
- **Sub-maps** (a node descends into its own map).
- **Mermaid** system/relationship diagrams as an output mode.
- **Force-directed layout mode** (spike drive, 2026-07-16): a togglable
  physics-based layout alongside the default — "the physics of the graph also
  help show how things relate." Candidate: d3-force driving node positions.
- Domain tuning vs. domain-agnostic (current instinct: one tool, many use cases
  — the domain lives in the context, not the tool).

## Technical Approach

House spell pattern: a **standing daemon conjuration** — a Bun daemon holds
canonical state (map, nodes, edges, context items, node content), driven by a
thin `cli.ts` over HTTP; a React surface over WebSocket. Built on the emerging
**React + Bun + Tailwind v4** scaffold (the astrolabe-pilot direction), so this
project both _uses_ and _stress-tests_ that scaffold.

**The new, spell-specific bits** (vs. existing spells):

- **The mind-mapping UI** — real graph rendering + interaction. The crux;
  answered by prototyping + landscape analysis, not specced up front.
- **Context ingestion + source-span provenance** — anchoring distilled
  claims/cards back to spans in the source. Reliable anchoring likely needs an
  **append-only, line-addressable source log**; this is the load-bearing
  technical piece.
- **The dual map + content model.**

**Data model (high-level, to firm up):** _context items_ (sources — viewable,
provenance origin) · _nodes_ (ideas/claims: title, synopsis, detail/content,
source-span links) · _edges_ (relationships) · the _conversation_. Outputs: the
map + node-tied content (later: versioned files).

**Edge directionality (ruled 2026-07-16, spike drive 3):** edges are **directed
claims** — each perspective of a relationship is its own claim with its own
label and its own home doc ("Elspeth: rival of Maren" / "Maren: barely notices
Elspeth" — the asymmetry is signal, not redundancy; per the state-once-per-claim
discipline these are different claims, not mirror prose). Three renderable
cases: one-way, reverse pair (offset curves, both arrowheads), and **symmetric**
(one mutual claim — "old friends" — flagged undirected, single line). The
hand-drawn Hollowbrook Mermaid map already uses this exact vocabulary; the spell
inherits it.

**Edge provenance — two classes, never blurred (2026-07-16):** every edge is
either **asserted** (a human or agent explicitly stated the relationship, with
reason + author — canon, durable) or **derived** (computed by an automated
process — embeddings similarity, co-occurrence, entity extraction — cheap,
recomputable, suggestion-tier). Derived edges can be **promoted** to asserted on
human/agent confirmation; that promotion loop is the automate-then-refine
mechanic. (Precedent: InfraNodus's detected layer overlaid on explicit links —
enrich, don't replace.)

**Search & retrieval stack (V1-lean, one SQLite file):** hybrid search = SQLite
**FTS5** (lexical) + **sqlite-vec** (vector) in the daemon's `bun:sqlite` store,
merged by rank fusion; embeddings from a small local model (`transformers.js` /
`fastembed`, pluggable for a hosted embedder later). Ingest: chunk → embed →
index; nearest-neighbor pairs above threshold surface as derived edges.

**Agent navigation (query surface, not context):** agents hold a **skeleton
graph** (IDs, titles, types, degree) and pull on demand via `cli.ts` daemon
queries — `search` (hybrid), `neighbors` (local hood + edge reasons), `similar`
(vector neighbors; implements the "does anything in canon relate to this new
idea?" check), `path`/`subgraph`. As density grows: graphology Louvain
communities become **summarization units** with agent-written cluster summaries
(the GraphRAG pattern, borrowed not adopted) — orient by summaries, descend into
one cluster at a time. This is the context-budgeting constraint made concrete.

**Schema stance (post-landscape, 2026-07-16):** start with a **loose, emergent
schema** — no fixed node/edge taxonomy in V1; structure emerges from the
material as we iterate. The landscape's patterns are held as **background
signal, not up-front commitments** — adopt them as our own when we see the same
shapes emerging in use:

- **Selection-as-context, node-anchored AI extension** — peer-review validated
  (Sensecape, UIST 2023: ~3× concepts explored vs. linear chat); its Explain /
  Questions / Subtopics verbs are a candidate node-action vocabulary for the
  spike.
- **Structural gap detection** (InfraNodus) — derive follow-up questions from
  unconnected graph clusters rather than LLM free-association; exposed as an
  agent-callable API/MCP if we'd rather borrow than build.
- **Context budgeting** — transitive relation-following into prompts is a
  _documented_ failure mode (NovelCrafter's cascade bloat / information
  overload); agents should pull a skeleton graph and budget context
  deliberately.
- **Local over global views** — practitioners report whole-graph vistas go
  decorative at scale; favor focus+context navigation.

Full findings: `landscape-analysis.md` (this folder).

**Substrate stance (2026-07-16):** the knowledge graph is a **plain property
graph we own** — nodes/edges/props as JSON-serializable data held by the Bun
daemon — not a graph database and not a formal ontology (RDF/OWL would fight the
loose-schema stance). Concretely: **graphology** as the in-memory graph
structure + algorithms layer (Louvain community detection and centrality give us
InfraNodus-style gap detection locally), persistence via JSON files or
`bun:sqlite` (built into the house runtime) at V1 scale, and the rendering layer
chosen in the spike (React Flow vs. sigma.js vs. Cytoscape.js — React Flow is
the interaction-first candidate for the game board; sigma pairs natively with
graphology for bigger graphs). Embedded graph DBs (e.g. Kuzu) only if
multi-session canon scale ever demands one.

**Component library (ruled 2026-07-16, spike drive 2):** shadcn-style
**vendored** components on Base UI accessible primitives — copied source, not a
dependency, so spells stay self-contained (seams Contract 2 unaffected);
shadcn's CSS variables map onto the house semantic-token layer. Reference
config: media-buffet `alb-frontend/components.json`. Adopt-as-consumed (no
wholesale import); first consumer is the node right-click **context menu**
(Focus + the Sensecape verbs, born plural for future agent actions). Feeds the
unified-scaffold thread.

**Key dependencies:** the React/Bun/Tailwind scaffold; **@xyflow/react** (the
spike's render-lib pick) + **@dagrejs/dagre** (static opening layout);
graphology for graph structure + analysis (V1); the provenance source-log; Base
UI + lucide (root deps) for the vendored component layer.

## Impact & Risks

**Benefits:** closes the **produce** half of the digestify pair with a legible
identity; a proven-valuable provenance mechanic; a natural **upstream feeder
into the brainstorming → proposal pipeline** (warmer project cold-starts); a
co-presence board in the manifesto's sense, and a concrete instance of its open
familiar/liaison thread.

**Risks:**

- _The map UI is the big unknown_ → **mitigate: spike-first + a landscape
  analysis** of existing mind-mapping tools to find what feels idiomatic.
- _Provenance/source-anchoring is non-trivial_ → scope as V1-or-fast-follow;
  validate the source-log approach early.
- _Multi-agent could over-complicate the MVP_ → single-agent core first.
- _Scope creep into a full document-versioning tool_ → hold the ≈C boundary.

**Complexity: High** — a novel graph UI, the provenance layer, and the dual
map+content model. The spike-then-V1 phasing is the primary mitigation.

## Open Questions

- ~~**Map-as-view vs. map-as-store**~~ — **RESOLVED 2026-07-16 (Cole):
  map-as-view with a staging lifecycle.** The store never holds _canon_; it
  holds work-in-progress. Three layers, one arrow of truth:
  1. **Source layer** — rambles/transcripts/imported files as immutable,
     append-only docs; the provenance anchor (this absorbs the proposal's
     source-log idea).
  2. **Staging layer** (the daemon's working store — the legitimate intermediate
     cache): extracted claims ("cards"), proposed edges, view-state (layout,
     lassos). Persistent per-project, visible on the map as a pending overlay,
     never authoritative; everything is eventually **promoted or expired**.
  3. **Knowledge layer** — ratified claims as prose + wikilinks in docs; the
     only home of canon; the graph derives from it (rot-proof; delete the daemon
     and you lose only unratified WIP and layout).

  Nodes map to **claims-within-docs (doc + anchor), not one file per claim** —
  promotion granularity follows the corpus (a ramble's claims → one story-seed
  doc; a claim about an existing entity → a sentence in its canon doc or a
  Threads entry). Ratification is batch, agent-drafts-the-doc-edit, human
  approves; solo-brainstorm mode gets bulk-accept ("keep all as a seed doc"),
  canon-maintenance mode gets the per-claim ruling vocabulary. See
  `user-research-story-loom.md` (headline + parting notes) for the interview
  that forced the fork.

- **Single- vs multi-agent** for V1 (liaison + documenter vs. single-agent
  core).
- **Provenance mechanism** — the append-only line-addressable source log: MVP or
  fast-follow, and exact anchoring.
- **Supporting structures** alongside the map (cards / summaries / lists) —
  which matter most (a prototyping question).
- **Sub-maps** — when does a node warrant its own map; navigating between
  levels.
- **Follow-up questions** — embedded inside nodes vs. a separate map layer.
- **Opening behavior** — agent asks clarifying questions first, or
  analyze-then-converse by default.
- **The content boundary** — how far "refine the content tied to nodes" goes in
  V1 (the A/B/C line), and how versioning eventually works.
- **The map UI itself** — auto-layout vs. manual, node/edge semantics,
  interaction — to be answered by prototyping + landscape analysis.
- **Name & kind** — conjuration assumed; reserve the name at coalescence.

## Phase 0 Spike — Findings (CLOSED 2026-07-16)

The spike ran as a one-day anthill session (prospero lead, circe surface,
daedalus engine; branch `feature/mind-mapper-spike`) through **four
drive-feedback rounds with Cole**. Verdict: **passed** — "proved out a lot of
things"; closed by Cole's ruling, V1 planning is next.

**What the spike settled (was uncertain this morning, is ruled now):**

- **React Flow works** as the canvas — pan/zoom, drag, custom edge rendering,
  focus fitView all landed without fighting it; the canvas stayed a swappable
  component and never needed swapping.
- **The game-board layout reads**: map canvas + node detail + context rail +
  conversation sidebar; tiers/provenance/pending distinctions self-teach with a
  map key.
- **Rulings produced by driving** (none were in the plan that morning): chat is
  a _conversation sidebar_, not a bottom query bar; the **context rail +
  in-surface doc viewer with span-highlight click-through** is load-bearing;
  **focus lens** (addressable `{owner, nodeId, depth}` — agent-writable in V1);
  node **right-click context menu**; **canvas search** with live highlight/dim
  (equal-capabilities counterpart of the agent's search verbs); **edge grammar**
  (directed claims + reverse pairs with distinct labels + symmetric
  `direction:"both"`); **shadcn/Base UI vendored component layer** (three
  retrofit ports, principled skips recorded).
- **Two agent-side primitives fell out of human UX work for free**: the lens and
  `focusRequest {nodeId, seq}` — the V1 agent's "look here" verbs already have
  landing pads. Equal-capabilities proved generative, not just fair.
- **Session scars worth keeping** (also in seat docs): span anchoring must be
  whitespace-tolerant (formatters reflow committed markdown); daemon routes bake
  at boot while data reads live (restart on server change); shadcn-on-Base-UI is
  a port, not a copy; a dep-free `cn()` means variants replace recipes, never
  fight them.

**What the spike deliberately did not touch** (V1's uncertainty budget): a real
agent behind the conversation; ingest → claim extraction; persistence + the
staging store; ratification; drag-drop intake; force-directed layout (its own
bounded experiment); Operator link-index consumption (substrate shipped same day
— see `user-research-story-loom.md` and channel `operator-doc-linking`).

**Roadmap out of the spike:** V1 planning via `anthill:plan` — phases ≈ (a) real
backend (persistence, ingest, extraction, FTS5 search, agent CLI verbs); (b)
live conversation + ratification v1; (c) context intake UX + map-as-view derive
layer; (d) bounded experiments (force layout, Operator index); then **dogfood
rounds as a first-class phase** (a real brain-dump session; Hollowbrook with
bobbin) before coalescence (name + kind).

## Success Criteria

- **Spike:** the map + game-board reads as idiomatic and fluid to think in (on
  stub data) — "a surface I'd want to use."
- **V1:** a real brain-dump / document set goes in, and the human walks away
  with a saved, navigable, **source-traceable** map built _with_ the agent — a
  materially better starting point for the next step (a proposal, a build) than
  the raw material was.

## Next steps when resumed (explicit)

1. ~~**Landscape analysis**~~ — **done 2026-07-16** → `landscape-analysis.md`
   (pattern-level; the hands-on look at commercial canvases / graph-rendering
   libraries folds into the spike). Note: coverage gap on commercial AI canvases
   — tldraw's agent starter kit is the flagged follow-up.
2. **UI prototyping spike** (the map + game-board, throwaway data) on the house
   scaffold.
3. **Firm up the data model + the open questions** from what the prototype +
   landscape teach.
4. **Dev plan for V1** (`/project-docs:generate-dev-plan mind-mapper`).

---

**Related Documents:**

- `landscape-analysis.md` (this folder) — verified landscape findings
  (2026-07-16)
- Operator `fragments/mind-mapper-spell-concept` (v4) — canonical consolidated
  precursor; `fragments/collaborative-knowledge-story-mapping-spell.md` — the
  raw 2026-07-16 brain dump it absorbed
- `docs/fragments/2026-06-30-mind-mapper-spell-concept.md` — consolidated
  concept (best-of merge)
- `docs/fragments/2026-06-20-structured-capture-spell.md` — origin spark
  (provenance/consulting precedent)
- `docs/backlog/2026-06-30-react-scaffold-as-default-investigation.md` — the
  scaffold this builds on
- Kin spells: `plugins/spellbook/skills/{imago,glamour,digestify,bounty}`
- `docs/PROJECT_MANIFESTO.md` — co-presence (board, not form); the open
  familiar/liaison thread

---

## Notes

Brainstormed 2026-06-30. Forks settled in that session: input mode (ingest
provided text + files; no in-spell STT; conversation is first-class refinement,
not live capture); the surfaces (map / context / node-detail / chat +
selection-as-context); the spike → V1 phasing; the V1 value boundary ≈ C.
Remaining forks are deliberately deferred to the prototyping +
landscape-analysis phase (above) — the proposal documents the path, it doesn't
pretend the UI is designed.

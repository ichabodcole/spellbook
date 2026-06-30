# Mind Mapper — map your thinking into a shared, source-traceable board

**Status:** Draft **Created:** 2026-06-30 **Author:** Cole Reed (brainstormed
with Claude)

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
(`docs/fragments/2026-06-30-mind-mapper-spell-concept.md`).

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
- **Node detail** — click a node to see/edit what's "stored" there.
- **Chat bar + selection-as-context** — select a node or context item and
  message; the agent gets that selection as the focus.

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

**Future Considerations:**

- Content/file **versioning + generation** (the produce-half, fully realized).
- **Sub-maps** (a node descends into its own map).
- **Multi-agent** liaison + documenter split (a conversational "therapist"
  agent + documenter agents building cards/diagrams in parallel) —
  grapevine-adjacent.
- **Mermaid** system/relationship diagrams as an output mode.
- Domain tuning vs. domain-agnostic (spell concepts, app ideas, stories,
  world-building, …).

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

**Key dependencies:** the React/Bun/Tailwind scaffold; a graph/diagramming
approach (TBD via landscape analysis); the provenance source-log.

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

## Success Criteria

- **Spike:** the map + game-board reads as idiomatic and fluid to think in (on
  stub data) — "a surface I'd want to use."
- **V1:** a real brain-dump / document set goes in, and the human walks away
  with a saved, navigable, **source-traceable** map built _with_ the agent — a
  materially better starting point for the next step (a proposal, a build) than
  the raw material was.

## Next steps when resumed (explicit)

1. **Landscape analysis** of existing mind-mapping software / interfaces — what
   feels idiomatic (interaction, layout, node/detail UX). → an investigation or
   a doc in this project folder.
2. **UI prototyping spike** (the map + game-board, throwaway data) on the house
   scaffold.
3. **Firm up the data model + the open questions** from what the prototype +
   landscape teach.
4. **Dev plan for V1** (`/project-docs:generate-dev-plan mind-mapper`).

---

**Related Documents:**

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

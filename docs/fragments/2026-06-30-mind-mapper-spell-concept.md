_Consolidated **best-of** concept for the "mind mapper" spell — merged from two
fragments captured at different times, each carrying things the other lacked:
the Operator precursor `mind-mapper-spell-concept` (graph/artifact framing) and
the earlier local spark `2026-06-20-structured-capture-spell.md`
(digestify-inverse identity + the source-provenance mechanic + the field-tested
consulting precedent). Same concept, two articulations — this is the union, not
a replacement of one by the other. Local is now canonical; keep in lockstep with
the Operator copy if it's still edited there. Synced/merged 2026-06-30._

# Mind Mapper — Spell Precursor (consolidated)

---

## 1. Concept

A working-handle spell ("mind mapper") that ingests source material — a messy
brain dump, a polished document, or a collection of context files — and
transforms it into an **interactive map of the ideas within it**, so the human
and agent can explore, dig into, and refine those ideas together on a shared
surface.

Framed another way, it is **digestify's inverse**: where digestify pushes
structured content _to_ the human to consume (read + answer inline), the mind
mapper captures _from_ the human (or their material) and structures it. Same
spirit — a co-presence surface for shared understanding — opposite direction of
flow.

---

## 2. The conversation

The conversation is about an idea — taking something raw and half-formed and
talking it into shape, or taking something already articulated and mapping its
structure. The human brings the material; the agent maps what it finds; and then
both parties move through that map together, identifying what's clear, what's
underdeveloped, what connects to what, and where to go next. The surface is
where that conversation happens: selecting a node is a conversational act, a
question is a conversational act, extending the map is a conversational act. The
subject can be anything — a spell concept, a story, a world-building document,
an app idea — but the conversation is always about the ideas themselves and how
they relate.

---

## 3. The problem

Raw thinking — especially speech-to-text brain dumps — is messy and hard to see
whole. But even well-formed documents have the same problem from a different
angle: a polished story or world-building doc contains a web of concepts,
characters, and relationships that isn't visible on the surface. In either case
the author ends up with material that doesn't reveal its own structure — no easy
way to look at it and understand what the key claims are, how the pieces relate,
or where the gaps are.

**Field-tested precedent (not hypothetical).** Cole already does a version of
this in consulting work: a Zoom transcript of a client session (e.g. an HR team
explaining their process) gets fed to an agent → the agent pulls out **claims**
("so-and-so said X about this system"), notes who **confirmed / denied** them,
points each one **back to its source** in the transcript, and diagrams the
systems/relationships with mermaid. This spell generalizes that proven workflow
into a re-castable surface.

---

## 4. Surface-fit

The output of the analysis isn't a reply — it's a navigable artifact. You need a
surface because the map has to be interactive: nodes to click, a sidebar to
open, sub-maps to descend into, selections that carry context into the next
exchange. Plain chat can't hold a graph you move around in, and the
collaboration depends on shared spatial context — which node is selected, which
edge is being examined — that a chat thread doesn't provide.

---

## 5. What the human gets

The human provides the source material (a brain dump, a document, or multiple
context files). They then see:

- An **interactive mind map** — a graph of the ideas and how they relate, with
  nodes they can click to get a deeper dive in a sidebar.
- **Evidence-linked cards.** The material distils into cards — a claim, an
  insight, a takeaway — each with a short synopsis **and a pointer back to the
  source span it came from** (sentence / line-range reference). Every distilled
  claim is traceable to "here's where you said it"; where it applies, the card
  also tracks **confirmed / denied**. _(This provenance mechanic is the
  load-bearing idea from the consulting workflow — carried over from the
  structured-capture spark.)_
- Potentially **supporting structures** alongside the map — cards, bullet-point
  summaries, lists of key ideas — though which matter most is still open.
- **Follow-up questions** surfaced at nodes (or embedded within them), flagging
  what's underdeveloped or unresolved.
- The ability to **select a node** to direct the next round of conversation —
  the selection signals to the agent what to dig into.
- Potentially **sub-maps** for areas that warrant their own detailed mapping (a
  flow within the idea, a set of characters in a story).
- Optionally a **mermaid relationship diagram** — text-driven, re-readable by
  the agent — for mapping systems/relationships (or even the conversation
  itself).

The artifact produced is the map itself — a synthesised, navigable view of the
original material that becomes the foundation for further building or
refinement. Because the map is a **saved, stateful project**, the human can
return to it, bring in new material, and have it incorporated into the existing
understanding over time.

---

## 6. What the agent does underneath

The agent (or agents) ingest the source material and:

- Identify the claims, ideas, and concepts within it.
- Map the relationships between them into a graph structure.
- **Anchor each claim/card back to its source span** (the provenance mechanic),
  and track **confirmed / denied** where relevant.
- Surface follow-up questions where things are undefined or underdeveloped.
- Respond to node selections by providing deeper context and extending the map.
- Incorporate new material brought in across sessions, updating the map rather
  than starting over.

There is likely a **multi-agent team underneath**, modelled on a consulting
team: one agent as a conversational **liaison** ("therapist") running the
conversation and probing; one or two **documenter** agents watching and building
the cards / notes / diagrams in parallel. The human mostly dumps; capture
happens alongside, not after. Exact orchestration is undefined and flagged as a
real fork (it lands near grapevine territory).

---

## 7. First slice

Build the **interactive mind map** first — just the graph interface, with
clickable nodes that open a sidebar with more detail. Get that working and
validate the map as the core artifact before adding supporting structures
(cards, lists, sub-maps) or the full provenance/source-anchoring layer. Then
figure out what else the conversation needs around it.

---

## 8. Open threads (the forks to settle at brainstorm time)

- **Input mode** — live conversation (agent probes in real time) vs.
  paste-a-transcript/document-and-analyse vs. both. The biggest fork; changes
  everything downstream. Also: one document at a time, or several at once?
- **Single vs. multi-agent** — the liaison + documenter split is elegant but
  lands on grapevine territory. Is it MVP, or a later evolution over a
  single-agent core?
- **Provenance mechanism** — anchoring cards to source spans reliably needs an
  **append-only, line-addressable transcript/source log**. This is the
  load-bearing technical bit, and whether it's MVP or a fast-follow is open.
- **Supporting structures** — cards / summaries / bullet lists alongside the
  map: which matter most? (Prototype to find out.)
- **Sub-maps** — when does a node warrant its own map? How do you navigate
  between the top-level map and sub-maps?
- **Follow-up questions** — embedded inside nodes, or shown as a separate layer
  on the map?
- **Iterative rounds** — the loop is input → map → review → dig in → extend →
  bring in new material; the on-surface mechanics aren't defined. In particular,
  how does adding a new document to an existing map feel different from starting
  fresh?
- **Surface shape** — graph + sidebar (+ mermaid?) on the house surface stack
  (Bun daemon + React); relationship to grapevine for the multi-agent layer.
- **Breadth of application** — domain-agnostic vs. tuned to specific use cases
  (spell concepts, app ideas, stories, world-building, …).
- **Name & type** — both explicitly deferred. Reserve the name at coalescence
  per `grimoire/trigger-registry.md`, not before.

---

## 9. Kin

- **imago** (conversation about generating/editing a specific image) and
  **glamour** (conversation about image style) — surfaces that exist because the
  conversation has a specific _subject_. Here the subject is **ideas
  themselves**: their structure, gaps, connections — rather than a visual
  artifact.
- **digestify** — this is its **inverse** (produce-from-the-human vs.
  consume-to-the-human); a clean, legible identity that doesn't duplicate any
  existing spell.
- **bounty** — the stateful, accumulating nature (a conjuration you return to,
  holding work-in-progress that grows over time) puts it in the same family.

---

## Feeds forward

The map is a launchpad: far easier to turn a captured-and-mapped dump into a
proposal or project than to start cold. A natural **upstream feeder into the
brainstorming → proposal pipeline** — it makes a project's cold-start warmer.
(And the multi-agent liaison + documenter split is a concrete instance of the
manifesto's still-open familiar/liaison thread.)

---

_Source fragments merged here: the Operator precursor
`mind-mapper-spell-concept` (graph/artifact/stateful framing, broad inputs) +
`2026-06-20-structured-capture-spell.md` (digestify-inverse identity,
source-provenance mechanic, consulting field-precedent, feeds-forward).
Project-shaped, not backlog-shaped — it wants a brainstorm/design pass on the
forks above before (or as) it promotes to a `docs/projects/<name>/` proposal._

# Mind Mapper — Landscape Analysis

**Status:** Complete **Created:** 2026-07-16 **Method:** deep-research workflow
(5 search angles, 24 sources fetched, 119 claims extracted, 25 adversarially
verified: 23 confirmed / 2 refuted)

Answers the landscape-analysis step from `proposal.md` ("Next steps when
resumed" #1) and the open call in the consolidated precursor (Operator:
`fragments/mind-mapper-spell-concept`, v4). Surveys three clusters: (a)
AI-integrated knowledge-graph/mind-map tools, (b) story-bible/world-building
canon tools, (c) AI-collaborative ideation canvases — for schema rigidity,
context ingestion/canon sync, and human+AI interaction patterns.

---

## TL;DR — transferable lessons

1. **Let graph structure emerge from the documents; don't impose a rigid
   taxonomy up front.** The surveyed field spans a spectrum — InfraNodus (fully
   emergent, schema-free co-occurrence graph) ↔ NovelCrafter (flexible untyped
   relations) ↔ Sudowrite (fixed named-field schema with an explicit dependency
   graph). The fuzzy knowledge layers in our precursor are consistent with what
   works; over-formalizing fights the material.
2. **Structural gap detection is the standout agent primitive.** InfraNodus's
   core move — find topical clusters that _aren't_ connected and hand those gaps
   to the LLM as specific, structure-grounded targets — is exposed as an
   agent-callable API and is their stated answer to "LLMs asked directly for
   gaps produce generic results." This maps directly onto our "follow-up
   questions surfaced at nodes" feature: derive the questions from graph
   structure, not from LLM free-association.
3. **Anchor AI extension to selected nodes.** Sensecape (UIST 2023,
   peer-reviewed) implements exactly our selection-as-context pattern —
   selecting a node exposes Prompt/Explain/Questions/Subtopics actions whose
   output streams into child nodes — and its study found users explored ~3× more
   concepts than in linear chat (M=68.3 vs 22.8, p=.01).
4. **Budget context injection aggressively — transitive inclusion is a
   documented failure mode.** NovelCrafter's own docs warn that over-linked
   relations "trigger an unwanted cascade that pulls irrelevant entries into
   your prompt," and that attaching too many entries makes the AI ignore
   important details. Their only mitigation is human selectivity. Our "skeleton
   graph + explore on demand" agent-ergonomics instinct is the right defense;
   naive relation-following is the known trap.
5. **Canon-contradiction detection is an unsolved differentiator.** No surveyed
   tool automates it — NovelCrafter and Sudowrite both punt to manual review
   ("clarify which source takes precedence and edit accordingly"). An agent team
   that _checks new ideas against existing canon_ would be doing something the
   field doesn't do.
6. **Provenance/replay makes the process itself an artifact.** ImaginationVellum
   (UIST 2025, honorable mention) pairs canvas-as-prompt (spatial arrangement
   steers generation) with temporal replay + provenance visualization. Supports
   the proposal's source-traceability bet.

---

## Cluster findings

### (a) Knowledge-graph / mind-mapping tools with AI

**InfraNodus** (the cluster's only survivor through verification; all
high-confidence):

- **Emergent schema:** words/notes become nodes, co-occurrences become edges;
  the graph is generated automatically from free text, no user-defined taxonomy
  (grounded in the peer-reviewed WWW'19 text-network paper). Nuance: its
  ontology workflows use a _fixed set_ of predefined relation types — users
  can't define custom ones.
- **Gap detection as the core interaction:** graph analysis finds unconnected
  topical clusters ("blind spots") and feeds them to an LLM to generate bridging
  questions/facts/ideas.
- **Agent-callable:** exposed via Graph RAG API, documented CrewAI integration,
  and an MCP server — agents send text, get back the highest-gap clusters.
  Directly reusable pattern (or even a candidate dependency) for our background
  agents.
- **Dual-layer overlay for existing corpora:** the user's explicit backlinks
  _plus_ an algorithmically detected co-occurrence layer revealing relationships
  manual links don't capture — enrich human structure, don't replace it.
  (Caveat: the "AI-detected" layer is statistical co-occurrence, not LLM
  inference.)

### (b) Story-bible / world-building canon tools

**NovelCrafter codex** (high confidence, vendor docs):

- Flexible, _untyped_ relations between entries — explicitly not parent-child,
  no fixed relation taxonomy.
- Relations drive automatic, **recursive/transitive context ingestion**:
  reference entry A in text and its related entries (and theirs) are pulled into
  the AI prompt.
- **Failure modes (vendor-admitted):** cascade bloat (irrelevant entries pulled
  in via over-linking) and information overload (AI ignores important details
  when too much is attached). Official fix in both cases: human selectivity —
  "only attach entries that provide crucial context."
- **No automated canon consistency:** contradictions between scene content and
  codex entries are resolved by manual review.

**Sudowrite Story Bible** (high/medium confidence):

- A single centralized canon store, framed verbatim as "a source of truth that
  both you and the AI can refer back to" — the shared-canon mechanism, serving
  human organization and AI grounding simultaneously.
- Fixed top-level schema (Braindump, Genre, Style, Synopsis, Characters,
  Worldbuilding, Outline, Scenes & Draft) with an **explicit dependency graph
  governing context injection** (Braindump→Synopsis→{Characters, Worldbuilding,
  Outline, Scenes}→Draft). "Rigid" drew a 2-1 verification split: top-level
  taxonomy is fixed, sub-field content is extensible.

### (c) AI-collaborative ideation canvases

Commercial canvases (Miro AI, FigJam AI, Whimsical, tldraw computer) did **not**
survive verification — see caveats. The peer-reviewed systems did:

**Sensecape** (UIST 2023, N=12 within-subject study):

- Spatial canvas + hierarchy over an LLM; node-anchored actions
  (Prompt/Explain/Questions/Subtopics) stream output into new child nodes;
  includes LLM-generated follow-up questions for users unsure where to go.
- Significantly more concepts explored vs. linear chat (M=68.3 vs 22.8, p=.01).
  **Honest caveats:** high variance (SD=49.1), 6/12 participants preferred the
  chat baseline overall, and the hierarchy-depth/revisit statistics were refuted
  (0-3) in verification — the quantitative win is narrower than the paper's full
  pitch.

**ImaginationVellum** (UIST 2025):

- Canvas-as-prompt: spatial arrangement, proximity, and composition of mixed
  elements directly steer generative output — layout _is_ the context-selection
  mechanism.
- Temporal replay + provenance visualization turn the ideation trajectory into
  an inspectable artifact (design rationale, not an empirical result).

---

## What this changes for the proposal

- **Data model:** supports the emergent/flexible end of the schema spectrum for
  the idea graph, possibly hybridized with a small fixed dependency layer
  (Sudowrite-style) for the _knowledge layers_ (context → synthesis → artifact).
  The precursor's "taxonomy rigidity" open question now has an evidence-backed
  default: start loose.
- **Selection-as-context is validated** by peer review — keep it central, and
  consider Sensecape's concrete action verbs (Explain / Questions / Subtopics)
  as the node-action vocabulary for the first slice.
- **Context budgeting becomes a named design constraint** (new): the agent side
  needs deliberate retrieval/budgeting, not relation-following. This strengthens
  the skeleton-graph agent-ergonomics idea in the precursor.
- **Canon-contradiction checking is a differentiator candidate** (new): worth
  naming in the proposal as a future capability with real moat — nobody
  automates it. InfraNodus-style structural analysis repurposed for
  contradictions-instead-of-gaps is one concrete direction.
- **Whole-graph view skepticism** (weaker signal, from the practitioner-
  critique angle; unverified): PKM practitioners widely report global graph
  views become decorative/unintelligible at scale. Design for local,
  focus+context views rather than betting on the whole-graph vista.

## Caveats (from the verification pass)

- **Coverage is much narrower than the question.** Only five systems survived
  verification (InfraNodus, NovelCrafter, Sudowrite, Sensecape,
  ImaginationVellum). Nothing survived for Obsidian AI plugins, Heptabase,
  TheBrain, Tana, World Anvil, Campfire, Plottr, Scrivener, Miro/FigJam/
  Whimsical AI, or tldraw computer — a verification-pipeline artifact, _not_
  evidence those tools lack relevant patterns. Cluster (c)'s commercial state of
  the art is effectively uncharacterized.
- Vendor-doc skew: InfraNodus/NovelCrafter/Sudowrite findings rest on vendor
  docs — fine for mechanics and self-admitted failure modes; efficacy claims
  (e.g., "avoids LLM bias") are unbenchmarked vendor rationale.
- Fresh as of 2026-07-16; AI surfaces in these products change fast.

## Open questions the research surfaced

1. How do commercial AI canvases actually implement selection-as-context and AI
   map extension? (Unverified — could be a targeted follow-up, e.g. hands-on
   with tldraw's agent starter kit, which per fetch-stage extracts gives agents
   multi-channel canvas perception: selection history, viewport screenshots,
   simplified shape data, off-viewport clusters.)
2. Can structural graph analysis be repurposed from gap-finding to
   contradiction-finding?
3. What retrieval/relevance mechanism beats naive transitive relation-following
   for context injection?
4. Does emergent co-occurrence schema transfer to narrative canon, where typed
   relationships (allegiance, kinship, causality) carry meaning untyped edges
   can't express — or does story work need a hybrid?

---

**Full verified report with citations:** deep-research run `wf_317542ee-32e`
(session task `w03ffh52y`). Key sources: InfraNodus docs + WWW'19 paper
(dl.acm.org/doi/10.1145/3308558.3314123), NovelCrafter codex docs, Sudowrite
Story Bible docs, Sensecape (dl.acm.org/doi/10.1145/3586183.3606756),
ImaginationVellum (dl.acm.org/doi/10.1145/3746059.3747631).

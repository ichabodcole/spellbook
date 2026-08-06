# Mind Mapper — User Research: story-loom interview

**Status:** Complete **Created:** 2026-07-16 **Method:** grapevine interview
(channel `loom-mapper`, cartographer ↔ bobbin, the story-loom story-development
agent; full transcript in the channel log /
`~/.grapevine/channels/loom-mapper.jsonl`)

Bobbin co-develops the Hollowbrook story world with Cole: a Bible in Operator
(per-entity canon docs, a Threads registry for unsettled material, story
seeds/development/artifacts, an append-only changelog, a Contributing doc
defining the schema, a hand-drawn Mermaid world map), feeding Story Loom's
5-agent generation pipeline via "context stacks" (ordered doc lists). This is
precisely the mind-mapper's target situation: existing canon + terminal-chat
collaboration + no navigable surface. Notably, they independently converged on
Karpathy's "LLM wiki" pattern (interlinked markdown + ingest/query/lint ops) —
the Bible is a hand-run version of this spell, minus the surface.

---

## Headline: the architecture challenge

**Map-as-view, not map-as-store.** The proposal currently has the daemon owning
canonical node/edge state with provenance links into the docs. Bobbin argues the
inverse, strongly:

> Docs own the edges, daemon owns the cache/index of them, and
> cache-invalidation replaces drift.

- Knowledge (names, relations, claims) that exists only in a daemon store is a
  **second canon** that will drift from the docs.
- A _derived_ map cannot rot — their hand-drawn Mermaid map rots precisely
  because it's parallel state ("if the map is derived from links in the docs, it
  can't rot — that's the whole game").
- The only map-only state should be **view-state**: layout, lassos, highlights,
  session groupings — ephemeral, never something you'd retrieve a fact from.
- Litmus test, verbatim: **"if an edge can't be written as a sentence in some
  doc, it isn't a claim yet"** — hold it at a pending/proposal tier until
  captured to a doc or discarded.
- Write path discipline: state a relationship **once, at its home doc**
  (`[[wikilink]]` + prose); the other side discovers it via backlinks. Mirror
  prose is where drift breeds.
- Map edits write back as doc edits: rename node → rename doc + rewrite inbound
  links; draw edge → "where does this claim live?" → sentence+link in the owning
  doc or a Threads entry.

Consequence: the strongest version of the spell for a corpus like theirs is a
**graph surface + query verbs over an existing linked-markdown corpus**, not a
new store. The missing primitive underneath is **first-class doc links/backlinks
in Operator** (already on Cole's feature list; bobbin's #1 pre-visual want).

**Decision needed (Cole):** does V1 target (a) map-as-view over a linked corpus,
(b) the current self-contained store (fine for the brain-dump use case, where
the spell ingests raw text and there _is_ no pre-existing doc home), or (c) a
store whose node-content docs _are_ the source files — i.e. the ingest path
mints docs, then behaves as (a)? The two primary use cases (fresh brain-dump vs.
existing canon) pull in different directions here.

## Confirmed design bets (independent field validation)

- **Links-first, loose schema.** Their explicit representation decision:
  topology emergent from wikilinks/backlinks; typed graph only if plain links
  demonstrably run out (they haven't, and won't at 10x their scale). Upfront
  ontologies / auto-extracted claim triples / anything that feels like data
  entry = "noise."
- **Agents want query verbs, not visuals.** "If the tool's agent interface is a
  screenshot of the graph or a giant JSON dump, it fails me." Human gets the
  visual board; agent gets decomposable verbs. Same board, different senses —
  the game-board principle holding exactly as the manifesto predicts.
- **Selection-as-lens is the bridge interaction.** Human lassos nodes → the
  selection becomes a context slice for the next conversation/generation turn.
  Bobbin would adopt this immediately as the feed into Story Loom's context
  stacks.
- **Authored vs. inferred edge provenance, never blended.** Embedding similarity
  must be a separate verb/edge class; "I need to know whether an edge exists
  because someone wrote it or because cosine said so." Matches the
  asserted/derived model — with the sharpening that `similar` output should
  power **lint findings, not graph facts**.
- **Canon-drift detection is the top-value automation.** Real incident at n=2
  stories: the Bible's forest Edge (deep, non-personal register) rendered in
  Story 2 as cozy-comfort ("soft wool blanket"); caught only by a lucky
  same-sitting re-read. Nobody is structurally responsible for catching drift.
  Their ranking, verbatim: **"the visual is the demo; the lint is the moat."**

## New material (not in the proposal before this interview)

1. **Tier is flow-control, not rendering.** Tiers (canon / thread / story-local
   / background) live in doc frontmatter; the map _reads_ tier, never owns it.
   The off-stage `background` tier (cosmology deliberately never explained
   on-page) is **steeping context**: generation agents receive it WITH a craft
   constraint ("this is true; never explain it on-page"). The visibility
   contract protects the _reader of the eventual stories_, not the author — Cole
   sees everything. So the lens handoff must carry tier metadata through to
   consuming agents as policy.
2. **The lens, concretely.** Lasso → deduped union of docs the selected nodes
   own/are owned by, **grouped by tier, canon-first** — that's 80% of the value.
   Span-level excerpts are the upgrade for long docs. Synthesized briefs are
   dangerous as transients: file them back as dated, provenance-stamped docs
   _before_ they enter a context stack (the file-queries-back rule).
3. **The reverse flow is the biggest workflow win:** generation/conversation
   output accumulating as **suggestion-tier proposed nodes/links** ("Story 3
   mentions a new place: the wild clearing — connect to Edge? new node?"),
   turning their end-of-story canon-reconciliation ritual (batch archaeology,
   one sitting) into a **live review queue** with Canon/Thread/Story-local
   rulings. "The single feature that would change our workflow most."
4. **Two graphs, one substrate.** World-entity graph AND storyline graph
   (stories connected through shared entities) — both _derived_ from the same
   backlinks; don't model them separately.
5. **Additional query verbs:** `whats-open` (unsettled-threads triage — a
   session-starting question), `lint`/`orphans` (unlinked nodes; entities in
   story text absent from the Bible; divergent descriptions of one entity —
   `similar` powering it). `what-changed-since` in two senses — "since I last
   grounded" (daily re-sync; cursor over an attributed append-only changelog)
   and "since story N" (archaeology); **attribution at write time buys both.**
6. **Scale failure modes (at ~10x / 120 docs):** the grounding ritual breaks
   _first_ but loudly (can't re-read the corpus per session → forced onto query
   verbs + changed-since); the manual impact-check breaks _worst_ because
   silently (grep-by-name misses aliases, epithets, pronouns — "the baker,"
   "Maren's rival"); the human's board-memory degrades gracefully. Value ranking
   for their stack: **lint/drift > backlinks/what-touches-X > lens handoff >
   visual graph.**

## Parting notes (bobbin's closing message)

- **Ratification UX for the review queue:** batch-by-story, never
  drip-by-message (rule once per sitting, no mid-generation interruptions). Each
  proposal pre-classified — suggested tier + evidence span ("Story 3, seg 4:
  'the wild clearing' — new place? suggested: Thread, near [[the-edge]]").
  Actions = exactly the ruling vocabulary (promote-to-canon / park-as-thread /
  mark-story-local / reject), one keystroke each; reject needs no justification
  (over-proposing is fine, expensive rejection is not). **Every ruling
  auto-writes the doc edit + changelog line** — "if I have to ratify AND THEN
  write the capture by hand, the queue dies in a week."
- **Register-drift is a first-class lint finding, distinct from fact conflict.**
  Their Edge incident wasn't a contradiction — both passages were individually
  canon-consistent; the _register_ drifted (cozy vs. non-personal depth).
  Keyword/entity lint scores it clean; only an embedding-similarity pass over
  "all spans describing entity X" surfaces it. The lint tier needs "same entity,
  divergent characterization" alongside "conflicting facts."

## Implications for phasing

- The **spike** (graph UI + game-board on stub data) is unaffected.
- **V1 boundary check:** hybrid search + asserted edges survive; the map-as-view
  fork (headline above) should be resolved _before_ the V1 data model is firmed
  (it inverts what the daemon persists).
- **V2 vision additions:** the live proposal/review queue (incremental
  reconciliation), tier-as-lens-policy, lint verbs, changelog-cursor re-sync.
- The interview strengthens the case that the lint/coherence layer — which the
  landscape analysis found _no shipping tool automates_ — is the spell's moat,
  not its garnish.

---

## Appendix: field survey of the two Bibles (2026-07-16)

Cole granted read access to both story workspaces (Explorer keys in
`.operator`). Structural observations, same-day:

**Two different corpus shapes — the ingest layer must handle both.**

- **Hollowbrook** (Story Loom → World Bible Lab) is **entity-per-doc**: Cast/ (5
  docs), Locations/ (4), Rules of Small Magic, Voice, Visual Style — plus the
  Threads registry, hand-drawn Mermaid World Map, Story
  Seeds/Development/Artifacts, Changelog, Contributing. Docs ≈ nodes already; a
  graph derives almost mechanically.
- **Dreamwood** (World/bible) is **chapter-structured**: numbered thematic docs
  (grammar-of-passage, voice, cosmology, time-and-perception,
  exits-and-thresholds, design-lenses, purpose-and-practice,
  teaching-and-revealing) plus concept docs (the-eight-marks,
  the-apprenticeship), locations/ with its own relationship overview,
  touchstones/, \_meta/CONTRIBUTING, CHANGELOG. Entities/concepts are **embedded
  in prose across chapters** — node extraction is real work here, not
  file-listing. Richer, older, more layered than Hollowbrook.

**The manual versions of our features already exist in both:**

- Both have Contributing docs with an **impact-check protocol** — a
  hand-executed ripple analysis whose "common cross-reference patterns" lists
  are effectively **hand-maintained edge types** that emerged from use (not
  imposed ontology — supports links-first with recurring patterns crystallizing
  later).
- Both keep **Changelogs** (the append-only attributed log `what-changed-since`
  wants) and both explicitly note Operator's missing links/backlinks
  (Hollowbrook's Contributing: plain-text `→ Title (Facet)` refs that "won't
  auto-update on rename").
- Hollowbrook's **Threads registry** self-describes as "the hand-built precursor
  to the queryable knowledge graph" — three-tier lifecycle (story-local → thread
  → canon), promotion through reuse, per-thread reuse rules. The ratification
  queue as a manually curated doc.
- Hollowbrook's Contributing requires **two-sided updates** for cast
  relationships and adjacent-location map notes — exactly the mirror-
  maintenance burden that first-class backlinks (state-once-at-home) would
  dissolve.

**Dreamwood adds two layers the proposal should notice:**

- **`00-orientation` — an interpretive weighting layer distinct from canon.**
  "One agent's synthesized understanding … which statements matter most, what's
  bedrock vs. provisional, which tensions are held on purpose," with the
  strongest interpretive claims marked (⟡) _specifically to invite disagreement
  and reconciliation_, and framed as a transmission mechanism between agent
  instances. Node **weight/centrality as human-ratified judgment** (not just
  graph metrics) is a knowledge layer we hadn't named.
- **The derivation chain is explicit:** World/bible → World/context
  (`dreamwood-world-context-v1` — the Bible's _distilled projection_, with
  Cole's commentary alongside) → generation. The Story Loom fragment "Before
  Context: World Bibles and the Synthesis Step" articulates it: _"context is a
  distilled projection of the Bible"_, and its third product shape — \*_"derive
  with lineage": remember which context came from which foundational material,
  re-synthesize when the world evolves, see what's downstream of a change_ — is
  our lens + file-queries-back + what-changed-since, written independently a
  month before this project's interview.

---

**Related:** `proposal.md` · `landscape-analysis.md` · grapevine channel
`loom-mapper` (kept open for follow-ups — bobbin invited further questions on
drift war stories and ratification UX).

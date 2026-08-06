# Dogfood drive #3 — findings (2026-07-19)

## Round-4 triage (added at drive close)

Cole closed the drive with "we have enough updates… start the next phase." Drive
#3 stands as the **human gate for `feature/mind-mapper-zones`** (grid + search
verdicts, zones/promote exercised, landing walked) → merge to develop.

**Round-4 build items** (in rough priority order):

- **Action slots** (#7, RULED): per-node agent-authored CTAs, composer- seeding,
  visibly derived; **ratify-anywhere** (card + canvas context menus) as the
  first standard action.
- **Selection→ground on send** (#2): bundle the live context-rail selection into
  `ground`; canvas selection already works.
- **Automated activity ladder** (#4): user message auto-flips `received`
  (presence-gated: only when ≥1 agent tail connected); agent send resolves; ~60s
  timeout → daemon liveness ping → "agent may be stuck" surface state. Also a
  Track B chat-pattern export.
- **Doc kind honesty** (#1): drop the `story`/`ramble` intake defaults; docs
  land untyped; kind becomes an agent-proposed / author-asserted field.
- **Build staleness guard** (#3): stamp bundle w/ commit+time, surface it; warn
  on stale dist at boot; build cleans old hashed chunks.
- **Always-open search input** (#8, RULED): remove the click-to-expand.

**Design items** (need a proposal pass before building):

- **Data adjustment + content-creation taxonomy** (#5): derived docs w/
  supersede-with-pointer; reorganize / whole-cloth / synthesis moves.
- **Node-anchored submaps** (#6): recurred from drive 2; zones-vs-submaps axes;
  "does a ratified zone become a submap?"
- **OKF boundary adapter** (#9): converges with the Operator importer if Cole's
  OKF adoption lands; watch spec maturity.

**Carried deferrals**: derive layer + embeddings; Track B house extraction.

---

Casting agent: prospero. Build under test: Round 3, `feature/mind-mapper-zones`
(zones + promote, pick-or-create lifecycle, pending search, doc-lens, card grid,
theme toggle, markdown chat, CTA-seeds-composer, send body chain). Board:
`session-3-dream-exploration`. Findings accrete here during the drive; triage
header added at wrap.

## Verdicts (features Cole signed off during the drive)

- Card grid view — "looks great" (tested post-rebuild, real bundle)
- Search / filter incl. pending proposals — "looks great" (post-rebuild)
- Pick-or-create landing, zone tab strip, markdown chat, activity ladder,
  Analyze flow — exercised live this drive (see findings for caveats)

## 1. Doc kind badge is a hardcoded intake default masquerading as an assertion

Cole dragged a dream-log doc in and it appeared wearing a "story" badge he never
chose and wouldn't have chosen. Source: `ingest.ts` defaults — file ingest
stamps `kind = "story"`, text ingest stamps `kind = "ramble"` (spike-era stubs,
never revisited). Cole's ruling-shaped instinct: automated typing at drop is
**premature** — classifying a doc is an act of judgment that belongs to an agent
_after_ it has analyzed the content, not to the intake path. As built, the badge
reads as asserted provenance while actually being a default — the exact
asserted-vs-derived confusion the provenance rule exists to prevent. Candidate
shape: docs land untyped/"unclassified"; doc kind becomes an agent-proposed,
reviewable classification post-Analyze (or renders visibly derived until
confirmed).

## 2. UI selection doesn't ride along on sent messages (`ground` arrives null)

Cole selected the dropped doc in the context rail, then sent a chat message
about it — the message arrived with `ground: null`. His principle (stated
unprompted, matches the spike-era selection-as-lens ruling): on the shared game
board, an intentional UI selection at send time is context the agent should
_receive_ — not necessarily read, but know about, so "what do you think of
this?" is answerable. The wire slot already exists (`ground` on every message;
CLI `--ground` flag) — the surface just never populates it from the current
selection. Fix shape: send bundles the live selection (doc ids / node ids /
zone) into `ground` automatically; the agent decides whether to pull content.
Ambient-vs-intent note: the selection riding on a _sent message_ is
intent-attached context, so pushing it on the bus is coherent with the
ambient/intent split.

## 3. Stale-dist trap: release mode silently serves an old surface

Cole reported the doc right-click Analyze menu missing; root cause was not the
menu (it's in `ContextRail.tsx`) but the daemon serving a **Jul 17 dist bundle**
— predating every Round 3 surface commit. `resolveMode()` picks release whenever
`dist/index.html` exists, with no staleness signal, so a branch-driven drive
silently exercises the previous build's UI (drive #3 started on a V1.x-era
surface). Recovered by rebuilding (`bun run src/mind-mapper/build.ts`) + hard
refresh. Candidate fixes: stamp the bundle with commit/build-time and surface it
(footer + `open` output); warn at daemon boot when dist mtime predates newest
surface source; or make drives explicitly `SPELLBOOK_SURFACE_MODE=dev`. Also
relevant to the Spell Surface Pipeline proposal (release-cut hygiene).
Sub-finding: stale hashed chunks accumulate in `dist/` (old `index-*.js` left
beside new) — build should clean.

## 4. Thinking indicator must be automated, not agent-remembered

Cole sent messages and saw no thinking animation. Cause: the Track A activity
ladder (`activity <received|thinking|idle>`) is an explicit agent verb — and the
casting agent (me) forgot to call it for the entire first hour of the drive.
Cole's ruling: a received/thinking signal that depends on agent discipline
decays; it must be **daemon-automated** — a `role:"user"` `message.posted` flips
activity to `received` automatically, and the agent's next send (or first
subsequent action) resolves it back. Explicit `activity` calls remain only as an
_override_ for long silent work (e.g. `thinking` during a big analysis).
Cross-app note from Cole: this is a general chat- experience pattern ("same
patterns across apps") — route into the Track B chat-window house extraction,
not just a mind-mapper fix.

Refinement (Cole): automation risks **false liveness** — an auto-thinking
animation with no agent listening lies to the user. Design: (a) presence-gate
the auto-flip (only flip to `received` when ≥1 agent tail is connected — the
daemon already tracks this); (b) timeout escalation — activity stuck at
`received` past ~60s triggers a daemon liveness ping to the agent; no response
surfaces an "agent may be stuck" state to the human. Presence answers "is anyone
there"; the timeout answers "are they actually on it". Both halves are the
cross-app pattern.

Positive observation alongside #2: the **Analyze CTA does populate `ground`**
(`["doc:<id>"]` arrived on the wire) — the gap is only the free-text send path
not bundling the live selection.

## 5. "Data adjustment": optional agent tidy-pass on messy input, with supersede semantics

Cole (after dropping a raw dream-log brain dump and watching the analysis):
messy captures might warrant an optional pre-map step where the agent _rewrites
the doc into organized/hierarchical markdown first_, then maps from the refined
version — better anchors for map→doc references than spans into rambling
transcript. Requirements as stated: strictly **optional** (agent-judged, never
forced); the original is **never removed** — the refined doc
supersedes-with-a-pointer ("this came from that; reference this one unless you
need the original"). Architecture fit: this is the source→staging→knowledge
layering already ruled at V1 — the adjustment doc is an agent-authored _derived
doc_ with a derived-from link. Open questions logged: whether existing evidence
spans re-anchor into the refined doc or stay on the original (lean: stay —
evidence is historical; new work prefers the refined doc); supersede UX
(original demoted but one click away); versioning vs new-doc mechanics.
Skill-level touchpoint: "messy input? consider offering a tidy pass."
Cross-links: Operator's supersede concept in agent-bridge; drive-2 finding 4
(intake shouldn't transit agent context) — adjustment output is agent-authored
so it naturally lives daemon-side. Live-drive observation supporting it: all 24
evidence spans anchored fine into the raw transcript (whitespace-tolerant
matching held), but the anchors are long ugly run-on quotes.

Extension (Cole): adjustment is one member of a **content-creation taxonomy** —
(a) _reorganize_: one doc refined, superseded-by pointing back; (b)
_whole-cloth_: a brand-new doc minted into the context list (the existing
chat→doc bridge is this move); (c) _synthesis_: multiple messy inputs → one
reference doc superseding all of them. Shared spine: doc-level provenance —
every created doc records what it derives from (zero, one, or many sources), and
superseded means demoted-but-reachable. This is asserted-vs-derived provenance
lifted from edges to docs.

## 6. Submaps wanted again — now with a sharper shape (node-anchored subgraph)

Cole, looking at the Portland-candidates zone: "Did we add the ability to create
sub-graphs yet? …could be under the art warehouse node." The drive-2 deferral
(finding 8, submap idioms) just recurred unprompted in real use — the promotion
signal for round 4. Refinement captured this time: what Cole wants is a
**node-anchored** subgraph (a contained graph living _under_ a node,
enter-and-exit), which is a different axis from zones (flat sibling scopes whose
meaning is provenance quarantine). A submap could contain a zone. Interim idioms
offered: promote-then-edge into the anchor node's neighborhood, or lens-scoped
viewing — both approximations, neither the contained place. Design question
flagged: when a zone's contents ratify, does the zone want to _become_ a submap
under its anchor?

## 7. Ratify is queue-only (equal-capabilities violation) + agent-authored per-node CTAs

Cole, mid-drive with 29 pending proposals: cards wear the "proposed" badge in
grid/canvas but offer **no way to ratify from where you meet them** — the act
lives only in the review queue. That breaks the equal-capabilities house rule
(the act should be available wherever the thing is encountered). Fix:
Ratify/Reject in card + canvas context menus, same mechanics as the queue.

Second half, Cole's proposal: let the agent attach **custom CTAs to specific
nodes**, augmenting the fixed verb set (Explain/Questions/Subtopics) — e.g.
"Explore Jungian Archetypes" on the caretaker node. Design constraints agreed on
the board: custom CTAs seed the composer like all verbs (never auto-fire —
conversation shortcuts per the conversation-primary rule); visibly
agent-suggested (derived, ignorable, deletable); stored as per-node
agent-writable metadata like the lens. Stigmergy payoff: suggested moves left on
pieces persist for future agent sessions. **RULED (Cole: "Let's add it" / "I
meant add it to round 4")**: goes on round 4 as one item — per-node action
slots, with ratify-anywhere as the first standard action.

## 8. Small UI tweak: search/filter input always open

Cole: the node search/filter input is compact enough to live permanently in the
toolbar — remove the click-to-open/close toggle (it costs a click and hides
state for no space saving). Round-4 P1-sized tweak.

## 9. OKF (Open Knowledge Format) — no internally, adapter at the boundary

Cole asked whether Google's OKF (v0.1, 2026-06-12: LLM-wiki as a directory of
markdown files w/ YAML frontmatter + markdown links, vendor-neutral) should
shape our node/doc metadata. Triage (Cole's guess confirmed): **not internally**
— the loose-emergent-schema ruling stands, and staging
(proposals/evidence/zones) has no OKF analog. **Promising at the boundary**: (a)
OKF import adapter — frontmatter `type` = doc kind _actually asserted by the
author_ (the honest version of finding #1's badge for OKF sources); markdown
links = edge scaffolding w/ asserted provenance = automated ingest/node
creation; the entity-per-doc corpus shape ingest already favors. (b) OKF export
of the ratified knowledge layer as an interchange bundle. (c) Slots into the
round-4 Operator pass-through importer if Operator docs adopt OKF frontmatter.
Revisit as the spec matures past v0.1. Sources: cloud.google.com blog on OKF;
heise.de "AI Knowledge as Markdown Files".

Weight update (Cole): he is actively looking at adopting OKF as a standard
across his apps (Operator etc.) — if that lands, the Operator importer and the
OKF adapter converge into one piece of work, and the mapper's extract_links ask
to Operator may become an OKF-links ask.

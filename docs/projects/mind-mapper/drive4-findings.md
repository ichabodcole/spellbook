# Dogfood drive #4 — findings (2026-07-19+)

## Triage (at wrap — Cole closed the drive, "Sounds right!")

Drive #4 was the **human gate for `feature/mind-mapper-round4`** — passed (live
confirmations below; two known-minor items ride into round 5). 11 findings.

**Round-5 build cluster** (approved — build together, subgraphs first so Cole
can test it): subgraphs / node-anchored submaps (design in #10 tail);
select-connected (#3); shared-connection **spotlight lens** (#4, RULED); the one
**intent-composer** pattern powering zone-create + human-add-node (#5) +
drag-connect (#6) (#8); **ESC-bug** fix (#11); CLI **batch-propose** +
message-read verbs (#10); activity **stall-window** widening (#2).

**Sequenced as their own later proposals** (bigger than a shared round):
media/images (#1), live **force view** (#7 — reference impl assessed), the
**multi-agent runtime** (#9).

**Carried**: derive layer + embeddings (now with #4 as first consumer),
OKF/Operator importer, data-adjustment/content-creation taxonomy.

---

Casting agent: prospero. Build under test: Round 4, `feature/mind-mapper-round4`
(action slots + ratify-anywhere, automated activity ladder, doc-kind honesty,
build stamp, always-open search, selection→ground). Board: `movies-session-04`
(Who Framed Roger Rabbit × Life Is Beautiful — film graph, 21 nodes / 24 edges
cast off two whole-cloth context docs). Findings accrete here; triage header at
wrap.

## Live Round 4 confirmations (working in the wild)

- **Doc-kind honesty**: both context docs ingested `kind:null, kindAuthor:null`
  — no premature badge (finding #1 from drive 3, now fixed and observed clean).
- **Automated activity**: Cole's board message auto-flipped activity to
  `received` with no agent call (presence-gated, tail connected) — the finding-4
  automation working live.
- **Build-staleness guard**: fired on the first Round 4 boot (mtime false
  positive from cassandra's gate touch) — caught it exactly as designed; rebuild
  cleared it. The finding-3 mechanism earning its keep on its first real boot.

## 1. Media / image support: import images as context, show them as nodes or in context details

Cole: the app has no media support; wants to **import images as context items**
and **display them as nodes or in the context detail pane** — and notes we can
**borrow from other spells that already handle image context**. This was parked
in drive-1's Track C (multimodal images, research). Now a concrete want against
a real corpus (movie posters, stills, portraits would enrich the film graph).

**Where the house already has parts** (Cole's instinct is right):

- **magpie** (rebuild in flight): image intake + an editable co-presence bbox
  canvas; `bbox = source-px, canvas = fraction`; rembg for cutouts. The bbox
  work is the load-bearing borrow.
- **media-buffet**: ships a media UI as a Spellbook spell (the media-as-context
  pattern).

**Architecture fit / the elegant parallel**: an image is a _source_ like a doc,
so it lives in the same source→staging→knowledge layering — but binary. The
mapper's evidence grammar is `span` into a doc (a text region); the image
analogue is a **bbox region into an image** (magpie's exact primitive). So:
`text span : doc :: bbox : image` — a node could be grounded in a _region of an
image_ (a face in a cast photo grounds the actor node) the same way it's
grounded in a text span today. That makes images a natural extension of the
evidence model, not a bolt-on.

**Design questions for the round-5/media proposal**:

- Storage: docs are text/markdown today; images need an assets dir + binary
  serving. Doc-kind `image` (ties into the K1 kind work) or a distinct asset
  type?
- Display: image _node_ (thumbnail on the canvas, React Flow custom node) vs
  image shown in the _context detail_ pane vs both (Cole said "or").
- Evidence: adopt magpie's bbox as the image-region evidence primitive
  (region-of-image grounds a node); whole-image evidence as the degenerate case.
- Intake: drag-drop into the context rail (mirrors doc drop), paste, or file
  verb.
- Cross-spell: pull magpie's bbox canvas component + rembg optionality; check
  media-buffet's media-UI-as-spell shape. (Ties to the Track B house extraction
  — a shared image-context component would be a fifth pillar.)

Scope: this is a **proposal-pass design item** (like data-adjustment, submaps,
OKF), not a same-round build — it needs a real design doc and a borrow-audit of
magpie/media-buffet before it enters a build round.

## 2. Auto-stall false-positived on legitimate long agent work (thinking emitted too late)

Live during finding #1: Cole's message auto-set `received` (seq 62); I then
spent >60s writing the finding doc + composing the reply BEFORE emitting any
activity signal, so the daemon escalated `received → stalled` (seq 63) — Cole
briefly saw "agent may be stuck". My subsequent `thinking`/send/`idle` (seq
64–67) cleared it. The automation behaved exactly as specified — the gap is
**casting discipline**: an agent that will do long silent work must emit
`thinking` as its FIRST act on receiving a message, not after the work. Captured
two ways: (a) casting-draft should state this explicitly ("on a message you'll
work on, set `thinking` before any long research/authoring, or auto-`received`
will escalate to `stalled`"); (b) possible refinement to weigh — should the
stall timer only start once the agent has NOT set `thinking`, i.e. is
auto-`received`'s 60s window too tight for a research agent's first token?
Leaning (a) is sufficient (discipline, one verb) and (b) risks masking real
stalls — but worth Cole's read since it's a UX honesty call. NOT a code bug; the
feature is working.

## 3. "Select connected" — select a node + its direct neighbors from the context menu

Cole (grounded on the Life Is Beautiful node): wants a **"Select connected"**
node context-menu action that selects the node plus all its directly-connected
neighbors, so a parent+children cluster can be moved around the canvas as a unit
— a reorganization convenience. Clean fit and cheaply built: the shared
`NodeContextMenu` chassis (R1) is the home; the engine already exposes a
`neighbors` query (depth 1); selection is the existing `selectedIds` set. So
it's surface-only — add the menu item, resolve depth-1 neighbor ids, union them
into `selectedIds`. Open sub-questions: include the connecting edges in the
selection (for visual clarity while dragging) or just the nodes; depth-1 only vs
a submenu for depth-N (ties loosely to the submap idea — a node's neighborhood
IS its de-facto subgraph). Round-5 surface item, small.

## 4. Shared-connection / intersection view — "which nodes connect to BOTH of these?"

Cole (grounded on the Life Is Beautiful node): with a dense graph, connection
lines alone can't answer "which nodes connected to node A are ALSO connected to
node B (or to all others) — where's the intersection?" Wants an idiomatic
affordance; open to suggestions. This is the _derived_ twin of the "Overlap:"
nodes I hand-authored — he wants the structural intersection computed and
highlighted from the edges, not manually asserted.

**RULED (Cole: "the spotlight lens works for me"): build the spotlight lens
(depth-1 shared-neighbor spotlight); heat mode + promote-to-overlap-node are
follow-ons.**

**Recommended shape — a "shared connections" spotlight lens** (fits the existing
lens algebra alongside doc-lens / node-lens):

- Select 2+ nodes → context-menu / toolbar action "Highlight shared
  connections."
- Canvas **dims** everything to low opacity EXCEPT the selected nodes, their
  common neighbors, and the edges joining them (dim, don't hide — keep spatial
  context). This is a focus lens, not a filter.
- N≥3 selected: strict intersection (connected to ALL) by default; a secondary
  "≥2 of them" partial-overlap mode.
- Small readout: "3 shared: comedy-darkness, fantasy, Disney-umbrella."

**Alternative / complement — overlap heat**: when 2+ nodes are selected,
color/size every other node by HOW MANY of the selection it connects to (heat
scale). Answers "where's the multiple intersection across the whole graph" at a
glance rather than pairwise.

**The payoff loop (why this is more than a view)**: the intersection lens
_reveals_ structural overlaps the user never authored; the meaningful ones get
**promoted into an asserted "Overlap:" node** — derived→asserted, the same
promotion gesture as zones. This is also the seed of the deferred **derive
layer** (InfraNodus-style structural detection from the landscape research):
shared-neighbor / structural-gap detection is exactly what a derive pass would
surface as suggestions. So finding #4 is a UX affordance now AND a first
concrete consumer of the derive layer later.

Scope: the spotlight lens is a round-5 surface item (lens machinery + a
neighbors-intersection query the daemon can compute); the heat mode and the
promote-to-overlap-node loop are follow-ons.

## 5. Human-initiated nodes: raw natural-language add, agent structures it

Cole (grounded on the Life Is Beautiful doc — note: `doc:` ground rode the
message, confirming Round 4 G1 works for docs, drive-3 finding #2 FIXED and
observed live): human should add nodes by **right-click canvas → "Add node" → a
free-text modal** where they type OR dictate whatever they want, unstructured —
explicitly NOT a title/synopsis/tier form. The agent then **analyzes the raw
blob, cleans it up, labels/structures it, and figures out how it fits** (propose
connecting edges), followed by discussion or ratify. It's the inverse of the
default flow (agent proposes → human ratifies): here human dumps raw → agent
refines → human ratifies. Speech-to-text is the intended primary input, so the
no-form point is load-bearing.

**Architecture fit** (this is the staging-inversion from Track A, sharpened, +
the data-adjustment principle at node scale):

- The raw dump lands **immediately** as a human-authored pending node proposal
  at the click position (author:user), rendered at once so the human sees their
  node appear — marked "raw / awaiting refinement."
- The raw text IS a source: capture it (a note/message) and **ground the node in
  it** (messageId evidence) so provenance survives the cleanup — the human's own
  words remain the evidence behind the polished node.
- **Agent refinement pass** (new agent behavior): read the blob → rewrite draft
  into a clean title + synopsis (edit the proposal in place, don't mint a
  second), assign a suggestedTier, and propose edges connecting it to existing
  nodes it fits. Then it's a normal pending proposal the human ratifies — with
  the raw→structured diff visible so the cleanup is reviewable, not silent.
- Mixed authorship (human-initiated, agent-refined) is the interesting new
  provenance case — the node "opacity bounds what you reject, not what you say"
  applied to human input: accept the blob, agent adds structure.

Open questions: refine-in-place vs supersede-the-raw (lean: in place, raw text
preserved as evidence); does the agent auto-refine on submit or wait for an
explicit "refine this" (lean: auto, it's the whole point); how the raw→clean
diff renders at ratify. Ties to: Track A human canvas authoring, drive-2 #5
data-adjustment/content-creation taxonomy (this is the node-scale member),
finding #1 (dictation → same speech-first intake). Round-5 build item (surface
modal + the agent-refine-a-human-node behavior + a small provenance clause);
medium size.

## 6. Drag-to-connect-and-create: dead drag affordance → node creation carrying edge intent

Cole: you can currently drag a connection line out of a node, but releasing it
does nothing — a **dead affordance**. He wants release-on-empty-canvas to open
the same Add-node flow (finding #5), with the new node **born already connected
to the source node**. The payoff he names: the human-drawn edge is an explicit
connection the agent no longer has to infer — "an additional level of intent."
He reaffirms both entry points coexist: right-click-create (agent infers all
connections, #5) AND drag-create (human asserts the one edge, agent infers the
rest).

**The elegant division this gives us**: the human supplies **topology** (this
node connects to that one, in this direction — the drag encodes source→target),
the agent supplies **semantics** (what the connection IS — proposes the edge
label during refinement, since it knows both endpoints). Human-drawn edge =
**asserted** provenance (human intent); agent-inferred edges from #5 = agent
proposals. So drag-create yields an asserted edge for free.

Shape: React Flow onConnectEnd over the pane → open the Add-node modal → on
create, mint the raw human node proposal (finding #5 flow) AND a human-authored
edge proposal source→newNode (unlabeled; agent proposes the label at
refinement). Both ratify together or as a pair. Also fixes the dead drag (today
the connection start has no release handler). Round-5 build item, bundles
naturally with #5 (same modal, same refine pass) — build them together.

## 7. Force view: want a LIVE physics simulation, not a static clustering layout

Cole on the current "physics" mode: the clustering it produces is interesting,
but it's a **static one-shot layout** (computed then frozen) — it lacks the
live, interactive, dynamic quality he actually wanted: a real force simulation
you can grab, perturb, and watch settle while it maintains relational
clustering. To run real physics you render **less per node**: circles/dots + a
short label + the edges, with full details on click (the node detail pane we
already have). Unsure whether it replaces the current mode.

**Diagnosis**: React Flow (our board canvas) is not a physics engine — it's a
positioned-card surface. A live force graph is a fundamentally different render:
d3-force running continuously (react-force-graph is the natural fit — d3-force
under the hood, canvas/WebGL, drag-to-perturb, minimal nodes built in). So this
is a **distinct view mode**, not a tweak to the current one.

**Replace or add? Add — they serve different densities** (this answers Cole's
"not sure if it replaces"):

- **Board view** (React Flow cards): the working game-board — rich cards, action
  slots, ratify-anywhere, context menus. High-info per node, best at low count /
  focused work.
- **Force view** (live sim, circles+labels): structural overview — see the shape
  of the whole graph, its clusters and density, at scale. Low-info per node,
  best at high count / "what's the shape of this."
- (Grid view already exists as the third.) So: board = work, grid = content
  columns, force = structure. Three lenses on one graph.

**Free tie-in to finding #4**: a live force sim naturally pulls
shared-connection nodes into visible clusters — so the intersection question
partly answers itself visually in force view (nodes connected to both films
drift between them). Force view + the spotlight lens are complementary
structural tools.

**The example (needs a look)**: Cole has an example he likes — a graph built by
a Claude instance visualizing Operator's new relative links/backlinks. Same
"derive a graph from links" pattern as ours; likely react-force-graph or
similar. NEED THE URL/PATH from Cole to actually assess it (asked on the board)
— don't assume the approach sight-unseen. History: the spike parked
"force-layout mode" as an experiment card; this is Cole sharpening it into a
real requirement.

Scope: round-5+ item, and larger than the others — a new render mode (new dep
like react-force-graph, a minimal-node component, mode toggle). Worth its own
mini-proposal, and worth studying the Operator-backlinks example first.

### Finding #7 addendum — assessed Cole's example (`dreamwood-graph_1.html`)

Read it. It's a self-contained **D3 v7 force sim rendered on a 2D canvas** (not
SVG), and it IS exactly the live view Cole wants — validates #7 concretely:

- Full stack: forceSimulation + forceLink/forceManyBody/forceCenter/forceCollide
  /forceX/forceY; "start clustered then let it breathe" intro animation.
- Canvas 2D + custom hit-testing (no DOM per node) — the right call for scale
  and the "show less per node" requirement (circles = "lights" + short labels +
  line edges).
- Interactions already present: **drag to pull a node loose** (fx/fy pin),
  **hover to trace its paths** (adjacency highlight — `neighborsOf`), **click a
  kind to dim it** (filter by node kind), a hover/click **focus readout** side
  panel (= our node-detail pane).
- Polished themed aesthetic via CSS vars (parchment/gold/mist) — already
  "house-token" shaped.

**Why it matters for our build path**: it proves the **raw-D3-on-canvas**
approach (vs adopting react-force-graph) is compact (~480 lines incl. heavy
styling) and gives full aesthetic control. Either works; the example is a ready
template. Integration notes: our surface bundles via Bun (no CDN — CSP + the
Tailwind-CDN lesson), so we'd bundle `d3-force`/`d3-selection` from npm, not
CDN-load d3.min. Data feeds trivially from `/state` (nodes + edges → the
example's NODES/EDGES-with-s/t shape). **Bonus**: its hover-neighbors-highlight
is the interactive seed of finding #4's spotlight lens — building force view
delivers part of #4 for free in that mode; and "click a kind to dim" is the
node-kind filter we'd want anyway.

**Verdict**: strongly applicable; use it as the reference implementation for the
force-view mode. Still a round-5+ mini-proposal (new render mode + d3-force dep

- mode toggle), now with a concrete template to port.

## 8. Asymmetrical parity: human affordances as agent-intent composers (+ zone-create gap)

Direct answers Cole asked for: **subgraphs/submaps — NOT built** (deferred
design item, drive-2 #8 / drive-3 #6). **Zones — built (Round 3) but no human
creation affordance** (the first-zone-is-agent-only gap, known since drive #3).

The valuable part is the principle Cole articulated, which unifies findings
#5/#6 and the zone gap: **equal capability does NOT require identical
mechanics.** The human's way of creating a thing can be **asymmetrical** to the
agent's — simpler, collaborative — and the UI affordance can bottom out in
**"compose a structured intent and send it to the agent,"** who does the
structured work. Add-node (#5) is his exemplar: the human doesn't fill a node
form, they speak → the agent structures it. He explicitly notes all of this is
doable via chat already, but the **discoverable UI affordance has value even
when it just sends the agent a message.**

**This collapses a whole class of round-5 UI findings into ONE mechanism**: a UI
gesture → a structured agent intent → agent executes → human ratifies.

- **Create zone** (the gap): select nodes on canvas → "Group into exploration
  zone" → sends the agent the intent → agent creates the zone + moves those
  proposals in. Human gestures; agent does the structured op.
- **Add node** (#5): speak → agent structures the node.
- **Drag-to-connect** (#6): draw the edge → agent labels + refines.
- **Custom actions** (drive-3 #7): already this shape (CTA seeds a message).

**Why this is architecturally right, not a shortcut**: it's the Contract-8
dumb-daemon / conversation-primary / CTA-seeds-composer principle generalized —
the UI and daemon stay dumb, the intelligence stays in the agent. The affordance
buys **discoverability + lower friction** over free-form chat; it does NOT need
a parallel structured backend path. So the round-5 "human affordances" work is
mostly **one intent-composer pattern** reused, not N independent features — a
big simplification. Equal-capabilities house rule gains a clause: _the human's
affordance may be an asymmetrical, agent-mediated on-ramp, not a mirror of the
agent's operation._

Zone-create affordance specifics (smallest concrete instance to build first):
canvas multi-select → context/toolbar "Group into zone (name…)" → intent to
agent → agent `zone create` + `promote`/move the selected proposals in. Also
needs: a human "new empty zone" path for the from-scratch case. Round-5; build
the intent-composer pattern once, apply to zone-create + add-node + drag-connect
together.

## 9. Multi-agent runtime: liaison + background transformation agents (the app runs as an anthill team)

Cole sketches the V2 multi-agent vision concretely: one human + a **liaison
agent** (my role — facilitates, chats, holds judgment, routes) + **additional
background agents** doing **transformation/grunt tasks** (e.g. the #5 raw-speech
→ clean node cleanup could be a WORKER agent, not the liaison). "More a
consulting team than a single agent responsible for everything." Earns its keep
"when there's enough work" that the liaison must stay focused on the human while
workers do grunt work in parallel. He flags the load-bearing complication:
**different event channels** — not every agent needs the same stream.

**The convergence to name**: this IS the anthill pattern — lead/liaison + seat
agents coordinating over grapevine + a bounty work-board. And we are ALREADY
using it: Round 4 was BUILT by an anthill team (prospero-liaison +
daedalus/circe/cassandra seats). Cole is proposing the app _run_ as one. **The
build-time team shape becomes the runtime team shape** — same substrate
(grapevine channels + a work queue + a shared stigmergic board), pointed at the
app's own content instead of its code.

**Role map**:

- **Liaison** (human-facing): on the conversation bus, product judgment,
  routing, ratify-facilitation. Stays responsive to the human.
- **Transformation workers** (background): raw-node cleanup, edge inference,
  derive-layer passes (finding #4's structural detection), bulk import (OKF /
  Operator), research. Driven by a **work queue**, not the human chat — they
  consume board state + tasks, emit proposals.

**Channels (Cole's point, and it's right)**: the one-bus-per-project design
needs to grow **role-scoped channels** — human↔liaison conversation is one
stream; liaison↔workers coordination is another (workers don't need the human
chat, the human doesn't need worker chatter). This is the ambient/intent split
(board = ambient shared state all agents pull; events = intent, but now
role-partitioned) taken multi-consumer. Ties to memories:
[[surface-as-shared-state-board]], [[co-presence-ambient-vs-intent]],
[[agent-co-presence-retrofit]], [[multi-agent-route-through-lead]].

**Scope/trigger**: V2 architecture, NOT now. At current single-agent scale (me
doing everything) it's fine and simpler. It earns its keep when transformation
work would block human collaboration — a big derive pass, bulk import, many
concurrent node-cleanups. Would need: a worker-agent role + a bounty-shaped work
queue in the daemon + channel scoping + (already have) the board as shared
state. Recursion worth savoring: the consulting team that BUILDS the tool is the
same shape as the consulting team that would OPERATE inside it.

## 10. Casting-agent tooling feedback (prospero's own experience this drive)

Cole invited my experience-of-the-tooling feedback (the finalize reflective
touchpoint). Genuine friction, most-impactful first:

1. **No bulk/batch propose — the standout friction.** Casting the movie graph
   (21 nodes + 24 edges) meant writing a throwaway TS script that spawns N
   individual `propose-node/--stdin` subprocesses and threads returned ids into
   edge proposals. Every real casting pass has needed this (drives 3 AND 4). A
   **batch propose** — one stdin call taking an array of nodes+edges, with local
   ref-keys resolved server-side (propose "n1" and an edge n1→n2 in the same
   payload) — would transform casting from "write a script" to "one call." This
   ALSO directly serves the finding-#9 worker agents and the finding-#4 derive
   layer (both emit many proposals at once). Highest-value CLI add.
2. **No message-read verb.** Tail notifications truncate, so every turn I
   `grep '"seq":N,'` the raw Monitor output file to read Cole's full message.
   grapevine already has `read <id>`; mind-mapper's CLI should too
   (`message <id>` / `read <id>`) so the agent isn't scraping a log file.
3. **Activity-thinking ergonomics.** Even with Round-4 auto-`received`, I still
   hand-bracket every long op with `activity thinking` / `activity idle`, and
   false-stalled once (finding #2) when I authored before signaling. Options: a
   `--thinking` flag on long-running verbs, or the CLI auto-emits thinking for
   the duration of a propose/ingest batch — structurally preventing the
   false-stall instead of relying on discipline.

Positives worth recording (the build FELT right in use): docs landing untyped
(K1) removed the drive-3 badge friction; auto-`received` fired correctly on
every human message; the build-staleness guard caught a real stale bundle on
boot; evidence spans anchored first-try into authored docs. The loop
(send→bus→tail) stayed healthy across a daemon restart + project switch.

## Round-5 build scope (Cole closing drive #4 → implement)

Cole: close the drive and **implement what we captured, INCLUDING subgraphs**
(he wants it built + testable now — pulling it from deferred into scope).

**Subgraphs / node-anchored submaps — design shape to build** (drive-2 #8,
drive-3 #6, now GO):

- A **submap** is a graph nested _under_ an anchor node — enter it and the
  canvas scopes to that node's contained subgraph, breadcrumb back up. Distinct
  axis from zones (flat provenance sandboxes): submap = containment/place.
- Engine: a node gains an optional `parentNodeId` (nesting); `/state` scoped by
  anchor; the submap view = nodes whose anchor is X + their edges. A submap can
  contain a zone (orthogonal). Additive column, doctrine-safe.
- Surface: "Enter submap" (double-click or context menu) → scoped canvas +
  breadcrumb; add nodes into a submap (human via the #8 intent-composer, or
  agent). The anchor node reads as a "folder."
- Resolves drive-3's open question: a ratified zone can be _promoted into_ a
  submap under an anchor.

**Tractable round-5 cluster** (buildable now): subgraphs; select-connected (#3);
shared-connection **spotlight lens** (#4, RULED); the **intent-composer
pattern** (#8) applied to zone-create + human-add-node (#5) + drag-connect (#6).
Plus CLI adds from #10 (batch propose, message-read verb).

**Sequenced as their own proposals (bigger, later rounds)**: media/images (#1),
live force view (#7, has a reference impl), multi-agent runtime (#9). Carried:
derive layer + embeddings (now with #4 as its first consumer), OKF/Operator
importer, data-adjustment taxonomy.

## 11. BUG: search/filter ESC button + Escape key do nothing

Cole: the node search/filter shows a little "ESC" button; clicking it does
nothing, and pressing Escape also does nothing. Real bug (not design) in the
Round-4 always-open search (S1). When S1 killed the open/close toggle, Escape
was respec'd to "clear query + blur" instead of "close" — but the wiring looks
broken: the visible ESC affordance isn't bound to that handler, and/or the
keydown Escape handler regressed when the toggle was removed. Fix in round 5
(small): bind both the ESC button onClick and the Escape keydown to
clear-query+blur; if the query is already empty, either no-op or blur. Confirmed
via Cole's live use on the Round-4 build. (Cross-check circe's S1 lane
`circe-r4.md` — the Escape behavior was specified there; the button binding is
the likely miss.)

### Finding #2 reinforced — second false-stall, same drive

It happened AGAIN on the ESC-bug exchange: `received` (Cole's message) sat past
the 60s TTL before my resolving write, so `stalled` fired a second time even
though I was actively working. This upgrades finding #2's recommendation: the
"just set `thinking` first" discipline is HARD to guarantee, because an agent's
first act on a message is often deliberation (reading the full message,
composing the response) BEFORE its first tool call — and that deliberation can
itself exceed 60s. So option (b) is now the stronger lean: **the auto-`received`
→ `stalled` grace window is too tight for a deliberating agent** (default 60s).
Fix candidates: (i) lengthen the auto-`received` grace before escalation (e.g.
120–180s) while keeping the _explicit_ stall path tight; (ii) treat the agent's
very next bus read/connection heartbeat as liveness (the tail IS connected — the
agent isn't gone, it's thinking); (iii) both. The current behavior cries "stuck"
during normal work twice in one drive — that's a false-positive rate a human
will learn to ignore, which defeats the signal. NOT a code correctness bug; a
tuning/UX call — but now clearly worth a real adjustment, not just casting
discipline.

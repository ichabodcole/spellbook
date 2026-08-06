# Dogfood drive #5 — findings (2026-07-22)

## Triage (at wrap — Cole "Sounds good")

Drive #5 was the **human gate for `feature/mind-mapper-round5`** — subgraphs
proven end-to-end (Carlos Niño discography submap, live); Round 5 → merge. 10
findings.

**Round 6 build cluster** (the drive-5 findings):

- **Bugs (fix first):** #8 ratify orphans pending edges (surface must keep a
  pending edge attached when its endpoint node ratifies — re-point via
  `node.ratified` proposalId→nodeId); #5 canvas batch-add render glitch (older
  nodes vanish after a `propose-batch` burst; grid-toggle recovers); #3
  rejected-proposal lingers on the canvas + long-title context-menu spans full
  width.
- **Casting/CLI tooling:** #10 **`ratify-batch`** (the standout — the twin of
  propose-batch; ratify a node+edge set in dependency order, resolve minted ids,
  return old→new map) + `ratify --anchor`; **node deletion** (#7, human + agent,
  emits a delete event, provenance-aware like doc-delete).
- **UX/features:** #1 add-node **processing phase** (raw → curated in place, no
  lingering full-text node; the free-text box is a command channel) + #4
  **ingestion queue** (a processing tray, decoupled from the board; designed as
  the work-list a future agent fleet drains); #6 **human submap-create
  affordance** (select nodes → group-under-X; the zone-gap pattern via the
  intent-composer); #2 context-doc **facilitator touchpoint** (skill guidance).
- **Parked (HOLD):** #1-ext analyze-vs-just-add toggle (Cole: don't build yet).

**Round 7 = images** (#9) — its own proposal (written at this wrap) + build +
dogfood drive. Recurring ask every drive → top post-round-6 priority.

**Carried:** derive layer + embeddings (spotlight lens = first consumer),
OKF/Operator importer, force view (#7 drive-4), multi-agent runtime (drive-4 #9
— the ingestion queue is its first concrete use case), data-adjustment taxonomy.

---

Casting agent: prospero. Build under test: Round 5, `feature/mind-mapper-round5`
(subgraphs, spotlight lens, select-connected, right-click add-node,
drag-to-connect, UI zone-create, batch-propose, message-read, split
stall-window). Board: `music-session-5` (Carlos Niño / LA spiritual-jazz
exploration). Findings accrete here; triage at wrap.

## Live Round 5 confirmations (working in the wild)

- **Right-click add-node (IC-a)**: Cole created a node by speech-to-text — it
  landed as an `author:"user"` pending proposal (finding-#5 flow live).
- **propose-batch (CLI1)**: the Carlos Niño artist node + 11 starter threads +
  12 edges cast in ONE `propose-batch --stdin` call with local refs — the
  N-subprocess casting script is dead. Worked first try.
- **message-read (CLI1)**: read Cole's full (truncated-in-tail) message via
  `read <id>` instead of scraping the Monitor log.
- **Untyped docs (K1)**: the context doc ingested `kind:null`.
- **Reject ruling**: `ratify <id> --ruling reject` cleanly rejected the raw
  instruction-node.

## 1. Add-node needs a processing/ingestion phase, not instant node creation

Cole (speech-to-text): the raw dictation became the node's TITLE (the whole
paragraph) and the node rendered instantly as a finished canvas node. He wants
an **ingestion phase**: create-node → the raw ramble enters a "processing" state
(a thinking animation, like chat) → the agent analyzes and takes over → a
**curated** node appears. The raw input should NOT instantly BE the node.

This is finding-#5's refine flow, but Cole sharpened the UX gap: the pending
`author:"user"` node currently shows as a finished full-text node rather than a
visible "agent is curating this" state. Load-bearing sub-insight surfaced live:
**the add-node free-text box gets used as a COMMAND/intent channel**, not just
node content — Cole's first "node" was actually an instruction ("research Carlos
Niño, make a context file + node + starter threads"). So the agent's "refine" is
sometimes "EXECUTE this request", and the raw instruction-node must not persist
as a node. I handled it by rejecting the raw node + producing the curated
structure — but the RIGHT UX is that happening **in place** with a processing
state, not a reject-then-re-propose. Design shape: add-node creates a
"raw/processing" pending item (distinct rendering — spinner/thinking, raw text
shown as provisional), the agent's refinement replaces it in place with the
curated node (title/synopsis/tier/edges), and if the input was a command, the
"node" resolves into whatever the command produced (doc + nodes + threads)
rather than a single node. Ties to: the automated-activity work (the processing
state IS a per-node thinking indicator) and the data-adjustment/content-creation
taxonomy (drive-2 #5).

## 2. Add-node ↔ context-doc coupling: node as a reference to a fuller research doc

Cole: when a node is created, should the agent (always? optionally?) also create
a **background-research context doc**, so the node is a _reference point_ to the
fuller thing? Where's the dividing line — does every node need a matching doc,
or just some? Does the research live IN the node or get extracted to a separate
doc the node references?

Enacted answer (I did exactly this for Carlos Niño): made a **context doc** (the
background research) and the artist **node references it** via evidence-span
grounding. So "node-as-reference-to-a-fuller-doc" is already the architecture —
the node holds a tight synopsis, the doc holds the research, the evidence link
binds them. Ruling-shaped position on the dividing line: **doc is optional,
agent-judged, and scales with research depth** — a _subject_ node (the artist)
earns a context doc; _thread/facet_ nodes (a label, an album, a collaborator
like Laraaji) just ground in that same doc or stand alone; don't mint a doc per
node. This is the same asserted-vs-derived provenance discipline: the doc is the
source, the node's synopsis is a claim grounded in it. Open sub-question worth a
round: a UI affordance to see/expand a node's backing doc from the node (node →
its context doc, one click) — the inverse of the evidence-span jump.

### Finding #1 extension — rejected/processed raw node lingers on the canvas + the analyze-vs-just-add question

Cole expected his raw instruction-node to be GONE after I processed it; it's
still on his canvas. Diagnosed live: the reject worked (`status:"rejected"` in
`/state.proposals`), but rejected proposals stay in `/state` AND the surface's
pending overlay still renders them — so a rejected node lingers visibly.
**Finding:** rejected proposals should leave the canvas (exclude `status` !=
pending from the visible map, or emit a reject event the reducer removes on;
today reject appears to not clear the canvas). Also: the CLI has no hard-delete
(only `ratify --ruling reject`), so once the processing-phase flow (finding #1)
replaces-in-place there's no stray to reject at all — the two fixes compound.

Cole's parked open question (explicitly "let's NOT do anything there for now"):
should add-node offer an explicit **"analyze this" vs "just add it straight"**
choice? The just-add case = a human adding a short, self-evident node that needs
no agent extrapolation (the agent still gets the "user created a node" signal,
just without the "extrapolate from this" intent). Cole wants to first learn
whether always-mediating simple additions hampers the human before building a
toggle. HOLD — do not build; revisit after more drive data.

### Finding #2 extension — context-doc decision as a skill touchpoint (agent-as-facilitator)

Cole: bake into the skill (whenever it's written) explicit **guidance** that on
node creation the agent decides — as facilitator — whether to create a
background-research context doc (possibly multiple), as an _optional choice but
a choice to be made_. Not a mechanical rule; a judgment touchpoint. Confirms the
finding-#2 position (doc optional/agent-judged) and asks for it to be codified
as casting/skill guidance, not left implicit.

## 3. BUG: long-title node context menu spans the full UI width

Cole's raw instruction-node has a paragraph-length title; right-clicking it
opens a NodeContextMenu that stretches across the ENTIRE page width because the
title/label isn't wrapped or truncated (no max-width / word-break / line-clamp
on the menu label, which echoes the node title). Real bug, independent of the
long-title cause. Fix: clamp the context-menu width (max-w + truncate/line-clamp
the title in the menu header) and truncate long titles on the node card itself.
Note (ties to #1): a paragraph-length "title" is itself a signal the input
wanted the processing phase — but the menu must be robust to long titles
regardless (a legitimately long-ish title shouldn't blow out the menu).

## 4. Add-node ingestion QUEUE — a visible processing tray, decoupled from the board

Cole: the human will often add several nodes in quick succession without waiting
for each to finish processing. Need a **queue / processing tray** that
visualizes "these raw entries are created and being INGESTED by the agent — not
on the board yet; when done they'll appear." The human fires-and-forgets into
the queue; a single agent drains it serially; the curated results land on the
board and leave the queue as each completes. Ingestion time varies (instant for
a simple node, long for a complex research add), so blocking the human on one
completion before the next add is wrong.

This is finding #1 (the per-item processing phase) scaled to N-in-flight: one
"processing" state → an aggregated tray of them, decoupled from the board.
Architecturally it's an **ingestion work-queue** — the mind-mapper growing the
same shape anthill's bounty board has. And Cole named the payoff himself: **this
is the concrete use case for the multi-agent runtime (drive-4 #9)** — a single
agent drains the queue serially; an agent TEAM drains it in parallel (research
workers creating nodes, then reconciling overlap/dedup), with a coordination
system for who-does-what. So the queue is the _seam_ that makes multi-agent a
drop-in later: build the queue now (single-agent serial drain), and the worker
fleet plugs into the same queue when it exists. Cole parks the multi-agent half
("not something we have to worry about right now") — but the queue should be
designed as the work-list a fleet could later drain, not a single-agent-only
construct.

Live signal: I processed Cole's two adds (Carlos Niño, then Photay) serially,
and he watched each complete before the next — exactly the wait the queue
removes. Ties: [[surface-as-shared-state-board]] (the queue is a shared
work-list / stigmergy), drive-4 #9 (multi-agent), finding #1 (per-item state).

## 5. BUG: canvas shows only the most-recently-added nodes; earlier nodes vanish from view

Cole: after the Photay `propose-batch`, the canvas shows ONLY the two newest
threads (Photay, An Offering); the earlier 12 (Carlos Niño + 11 threads)
disappeared from view. **Data is intact** — verified all 14 node proposals in
`/state.proposals` (pending, zoneId null, no anchor); this is a surface
render/filter bug, NOT data loss. Round-5 regression suspect (the submap-view
derive SG2, the batch reducer, or layout). Candidate causes to check: (a)
submapView filter `n.anchorNodeId === activeAnchor` mishandling pending
synthetics whose anchorNodeId is `undefined` vs `null` at top-level (would
wrongly exclude — but 2 nodes DO show, so partial); (b) a batch of
`proposal.added` events resetting rather than appending the pending overlay; (c)
layout placing older nodes off-viewport while new ones land in view. Repro:
batch-add nodes to a board that already has pending nodes; observe whether
earlier ones survive in the visible map. Ask Cole: does a hard refresh restore
all 14 (→ reducer/transient) or not (→ deterministic filter/layout)? Potentially
MERGE-BLOCKING for Round 5 — get circe on it. This is the gate earning its keep
on a real display regression.

### Finding #5 narrowed — canvas-only, likely a batch-burst layout race (grid was fine)

Cole recovered it: switching to **grid** view showed all 14 nodes, then
switching back to node/canvas view restored them all. This ISOLATES the bug to
the **React Flow canvas render**, NOT the shared visibleMap derive (grid
consumes the same derive and showed everything) and NOT the data. Refined
hypothesis: `propose-batch` delivers a BURST of `proposal.added` events in quick
succession (new in Round 5 — the canvas never faced a rapid multi-node add
before), and the canvas layout/positioning effect appears to keep only the
last-arriving nodes positioned/visible, dropping earlier ones until a remount
(the view toggle) forces a full re-derive. So: a **batch-add × canvas-layout
race** — likely a layout effect with a stale closure or a dependency that
doesn't re-run over the full node set on each pending change. Intermittent
(Cole: "maybe a glitch"), but reproducible-class. Workaround: toggle grid↔node.
For circe: make the canvas layout re-run deterministically on the full visible
node set; test with a batch-add onto a populated canvas. The propose-batch
feature (Round 5) is the likely trigger, so this pairs with it for the fix.

## 6. No human affordance to CREATE a submap (agent-anchor-only) — the zone-gap pattern again

Cole: "have we added subgraph capabilities? I don't see any UI for creating
those." They ARE built (SG1/SG2), but submap creation is **agent-side only**
(`node anchor`), post-ratify — so with nothing anchored yet, there were no
folder badges / no submaps to enter, hence no visible subgraph UI. This mirrors
the drive-3 zone-create gap exactly: the capability exists, the human create-
affordance doesn't. Per drive-4 #8 (asymmetric parity / intent-composer), the
human affordance should be: select nodes → "group under <node> as a submap" (or
"anchor these under X") → agent issues the anchors. Demonstrated live this drive
by anchoring 4 Carlos Niño albums under the artist via CLI so Cole could test
the drill-in. Round-5-follow-on / next-round: the human submap-create affordance
(the intent-composer covers it, same as it should cover zone-create).

## 7. No node deletion — human (or agent) can't remove a node; reject lingers

Cole: no way for a human to delete/remove a node — clicking one offers no
delete. He wants it, notably to clear the lingering raw speech-to-text
instruction-nodes (finding #3). Requirements he stated: (a) a human delete
affordance (right-click → Delete); (b) deleting **emits a signal/event to the
agent** — a human delete is meaningful intent the agent should know about; (c)
equal-capabilities — the agent should be able to delete too (today the agent
only has `ratify --ruling reject`, which LINGERS, and there is NO delete for a
ratified node or a hard-delete for a proposal). Gap confirmed in the CLI: verbs
are propose/zone/anchor/promote/ratify/mark — no `delete` for nodes/proposals
(docs DO have `doc delete` with a CitedError provenance guard — the precedent).
Fix cluster (pairs with #3): a real delete for proposals AND ratified nodes,
removed from the board, emitting a `node.deleted`/`proposal.deleted` event the
reducer + agent consume, provenance-aware (deleting an anchor node with a
submap, or an edge-cited node — mirror doc-delete's CitedError: warn/guard on
children + citations). Equal-capabilities: human delete + agent delete, both as
intent events.

## 8. Ratifying a node orphans its still-pending edges (they dangle → vanish from the board)

Triggered live: I ratified 5 nodes (artist + 4 albums) but not their edges; Cole
then saw the whole graph disconnected (only Photay→Laraaji survived — because
BOTH its endpoints were still pending). Root cause: ratifying a node mints a NEW
node id; the still-pending edge proposals still reference the node's OLD
proposal id, which no longer renders as a board node → the edges dangle and
disappear. So a partial ratify (nodes before their edges) silently strips the
visible connections. **Finding:** the surface should keep a pending edge
attached when its endpoint node ratifies — re-point the edge's endpoint to the
minted node id via the `node.ratified {proposalId → nodeId}` mapping the reducer
already receives, so the edge renders as a pending edge to a now-real node
rather than vanishing. (Engine already resolves this correctly at EDGE-ratify
time via result_node_id; the gap is purely the pending-edge RENDER across a node
ratify.) Alt/additional: ratifying a node could offer to bring its pending edges
along. This is alarming as a user (looks like data loss — it isn't; the edges
are intact as pending proposals). Reconnected Cole's submap by ratifying the
ensemble + the 5 internal edges. NOTE: partly workflow-induced (I should ratify
node+edges together, or use the edge-follows-node behavior once built) — but the
vanishing-edge render is a real gap. Merge-relevant for Round 5.

## 9. Images / media — asked again; confirm it's the deferred drive-4 #1 (own proposal)

Cole: "have we added the ability to bring in images yet?" No — media/images is
**drive-4 finding #1**, explicitly deferred to its OWN proposal (not in the
Round-5 cluster). Recurring ask = rising priority. The architecture is already
sketched (image as a source like a doc; a bbox region grounds a node the way a
text span does — `span:doc :: bbox:image`; borrow magpie's bbox canvas +
media-buffet's media-UI-as-spell). Real corpus want here: album covers, artist
photos would enrich the music map. Elevate media to the next proposal after the
Round-5 follow-ups.

## 10. Casting-agent experience (prospero's own friction this drive)

Cole invited agent-side friction signals. Genuine, most-impactful first:

1. **Batch-RATIFY is the missing twin of batch-propose — the standout
   friction.** Building the subgraph demo required a fiddly multi-step dance:
   ratify a node → PARSE the minted nodeId out of the response → `node anchor`
   it → then, to reconnect edges, pull full `/state`, filter pending edges whose
   BOTH endpoints are in the ratified-old-proposal-id set, and ratify each one.
   That's the exact N-operations + id-threading pain `propose-batch` fixed on
   the propose side, now on the ratify side — and it's WORSE because ratify
   mints new ids that anchors + edges must chase. Ask: **`ratify-batch`**
   accepting a set of proposal ids (nodes + their edges), ratifying in
   dependency order (nodes first, edges resolve to the minted ids
   automatically), optionally anchoring, returning the old→new id map. Would
   collapse the whole reconnect script into one call. Also pairs with finding #8
   (edges-follow-node-ratify).
2. **`ratify --anchor <parent>`** (ratify-and-anchor in one) would remove the
   parse-nodeId-then-anchor two-step for building submaps.
3. **No agent-side delete to clean my own litter.** I rejected two raw
   instruction-nodes; they linger (finding #3/#7). When I mis-propose or want to
   retract, reject-that-lingers is my only tool — I can't tidy. A real delete
   (finding #7) serves the agent as much as the human.
4. **Pending-edge triage needs `/state` scraping.** To find which edges connect
   a set of nodes I filtered raw `/state.proposals` by source/target;
   `neighbors` is ratified-only. A pending-aware neighbor/edge query would help
   (minor).

Wins to record (the build helped): **`propose-batch`** turned graph-casting from
an N-subprocess script into one call (used twice this drive, flawless);
**`read <id>`** killed the tail-log scraping from drive #4; the **150s stall
window** meant zero false-stalls this drive despite long research beats. The
round-5 casting ergonomics are markedly better — ratify-side is the remaining
gap.

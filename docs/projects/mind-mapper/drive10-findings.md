# Drive #10 findings — session-9 (R11 build), 2026-07-26

Return-drive of the **R11 message-surface refactor** on a fresh music map (Rich
Ruth → fourth world). Captured live via the `--inbound` co-presence loop.
**R11's own verdict: PASSED** — see V0. The drive then produced a feature round,
three fixes, an agent-DX list, and three practice rules.

---

## V0 — R11 PASSED its drive (the round's own bet)

**The bet:** removing the jobs + ingest panels is only a net win if "the agent
is working on this" becomes unmissable. Cole, unprompted, seq 6:

> "I could tell that you were working on something mainly because I see, you
> know, like there's a little animation that shows that."

The activity pulse carried the load with no panel to check. The channel
distinction also worked in practice — his canvas rambles arrived
`kind:"canvas"`, his typed messages `kind:"turn"`, and **no node was minted** by
a ramble at any point in the drive (F1 from drive #9 is fixed in the human's
hands, not just in tests).

---

## F1 — FEATURE: pin nodes + frames (authored spatial state) `own round`

**Source:** Cole, seq 12/14/18. The largest item; recommend its own round.

**The ask:** (a) **pin** nodes so `tidy` doesn't move them; (b) **frames** —
draw a rectangle around nodes, move the frame and the members move; pin a frame
and nothing inside moves. Explicitly ComfyUI-style frames, _not_ groups. The
agent must be able to create them too.

**The structural finding that reframes it:** **node positions are not persisted
anywhere.** The layout is _computed_ every render (dagre or force — see
`GraphCanvas.tsx`); there is no position column in `db.ts`. Tidy isn't
overriding an arrangement, it's recomputing the only layout that has ever
existed. So pin/frames are **the first authored spatial state in the map** — the
map stops being a pure view of the graph and part of the layout becomes data.
That's an architectural step, not a flag, and should be taken deliberately.

**Ratified design (Cole + prospero, seq 12–18):**

- **Frames are NOT zones.** Zones are proposal-staging sandboxes and it is
  ratified (Contract 9, R3) that they hold **proposals only, never nodes**.
  Frames are the opposite axis: spatial groupings of **ratified nodes**. Do not
  overload zones for this — it would fight a ratified contract for rounds.
- **Membership is explicit node ids, geometrically edited.** The human draws a
  rect (geometric); the agent can't think in pixels and names node sets. So the
  frame **stores node ids**, the human edits that set by dragging in/out, and an
  agent-created frame names members and lets the surface compute the rect. This
  is the first feature where human and agent have genuinely different natural
  interfaces to the same object.
- **Pin persists a POSITION**, not just a tidy-exemption ("don't move it" is
  meaningless without knowing where it was).
- **Pinning a frame pins the frame AND its members.**
- **No nesting in V1.**
- **Deleting a member leaves the rect alone.** An explicit right-click **"shrink
  to nodes"** refits the rect on demand.
- **PRINCIPLE (settles the edge cases we haven't thought of yet): a frame's
  geometry is AUTHORED, never reactive.** The system never silently redraws the
  human's rectangle — not on delete, not on move. "Shrink to nodes" being
  _invoked_ is what makes the frame a thing the human drew and controls, rather
  than a computed hull that twitches whenever the graph changes.

**OPEN (Cole, seq 18 — the last question of the drive):** what does **tidy** do
to an **unpinned frame**? His instinct: it should tidy somehow, but framed nodes
"sort of acting as one giant node" makes the mechanics unclear. **prospero's
answer (for the round to ratify): treat the frame as a COMPOUND NODE — i.e. a
cluster.** dagre already supports compound/cluster graphs, so tidy lays frames
out as units relative to each other and tidies members _within_ each frame,
preserving the grouping without freezing it. That gives "acts as one giant node"
a real implementation rather than a special case. Falsify if dagre's cluster
support proves too weak in practice (ELK is the fallback).

---

## F2 — No node edit: a ratified node can never gain a description

`node` supports only `anchor` and `delete` — there is **no edit route**. A node
ratified from a thin draft is permanently stuck with an empty `synopsis`; the
only recovery is delete + re-propose + re-ratify, which destroys the human's
ratification act. Observed live: Cole's five canon nodes (Rich Ruth, Time Wharp,
Kaitlyn Aurelia Smith, Michel Banabila, Nala Sinephro) cannot be given
descriptions. Tags _can_ be set on live nodes; prose cannot.

From the agent's side this reads as **"the agent is not allowed to learn more
about something later,"** which is a strange thing for a knowledge tool to
forbid. Cole's call at the time: leave those five bare, fix it in code later.

---

## F3 — The agent→human status channel (the mirror of R11)

**Source:** Cole, seq 6. For long multi-step work he wants lightweight "here's
what I'm doing next" pings — _"maybe it's just a toast versus an actual chat
message"_ — explicitly to recover the honest half of what the jobs queue was
reaching for ("what's going on"), **without adding overhead** to the agent.
Agent's discretion, not mandatory.

**This is R11 pointed backwards.** R11 gave the human channels for talking to
the agent; this is the agent→human equivalent. **The wire already supports it:**
Contract 11 deliberately left the channel vocabulary OPEN, so
`send --kind status` works today — **only the rendering is missing** (a quiet
inline/toast line instead of a full chat bubble). Genuinely small round.

---

## F4 — Orphan detection: a canon node with no edges is invisible-by-default

**Source:** Cole, seq 8 — he noticed by eye that none of his ratified nodes were
connected and asked whether it was intentional or a bug.

**Cause was prospero's error, not a tool bug** (see the practice rules below) —
but the finding underneath is real: **ratifying a node without its edges leaves
a node that looks fine in isolation and is silently disconnected, and nothing in
the interface says so.** The human had to catch by eye something the map knew.
An orphaned canon node is nearly always a mistake; the board could mark it
quietly (a dim marker, or a count).

---

## F5 — Agent-experience (DX) friction, ranked by "caused a real error today"

Cole explicitly asked for this (seq 10): _"if there's anything that you're
feeling like you're doing or like the tooling we have… that is confusing or that
leads you to make mistakes."_

1. **Proposals have no batch identity — this caused the orphaning bug.**
   `propose-batch` returns a `refToId` map and the batch then dissolves; the
   proposals carry no shared marker. After a PARTIAL ratification the agent
   cannot ask "what else came from that call?" or "what pending edges point at
   this node?" — it must hold it in memory. A `batchId` on each proposal turns
   reconciliation into a query and would have made the bug structurally hard to
   write.
2. **Edges to ALREADY-EXISTING nodes are hand-wired every time.** Local refs
   inside a batch are excellent; an edge to a ratified node needs the real uuid,
   so the agent must fetch `/state`, build a title→id map, and generate the
   batch via a bespoke script. **Done four times in one drive**, and the second
   time is exactly where the edges got dropped. Endpoint-resolution by title (or
   a `--by-title` flag) would delete a whole category of scripting and of
   mistakes.
3. **No "what changed" query.** The biggest _recurring_ cost. The agent is
   deliberately blind to ratifications (the actor-tagging deferral), and the
   only recovery is a full `/state` refetch plus a manual diff. A
   `state --since <seq>` or any delta view turns "re-read the world and compare"
   into "read what moved." The honest-but-expensive full refetch is easy to skip
   mid-thought — and skipping it is how the agent got out of sync this drive.
4. **`ratify-batch` exists; the inverse does not.** Clearing 44 stale proposals
   was 44 individual HTTP deletes in a loop. A `delete-batch`/`reject-batch`
   matching the existing verb's shape would make "clean up my own mess" one
   reversible act instead of a 44-step one.
5. **Errors mostly name the fix — except when they don't.** The edge-endpoint
   error (_"ratify node proposal <id> first"_) is the best error in the system
   and is the model. By contrast `PUT /tags/:id` 400s with nothing about the
   expected body (it wants a **bare array**, not `{tags:[...]}`) — cost a probe
   to discover.
6. **Praise worth copying:** the `--inbound` grounding line's **`notWatching`**
   list is excellent agent-facing design — it names blind spots explicitly
   instead of letting the agent assume coverage. **Interfaces that state what
   they DON'T cover are worth more than more capability.**

---

## Practice rules for the skill write-up (not code — methodology)

Cole flagged these as skill-shaped himself (_"especially when we start writing
the skill up"_).

- **P1 — Tag and describe every node.** Both capabilities already existed
  (`synopsis` is a node draft field, rendered in the detail pane and searchable;
  `tags` shipped in R7 and ride the propose call) and the agent **wasn't using
  them** — 20 title-only nodes went up before Cole asked. The schema _affords_
  richness; the methodology must **require** it. Especially for nodes the human
  didn't ask for: a bare "Fourth world" label produces "what even is this?",
  which is the question the map should have pre-empted.
- **P2 — Reconcile after a PARTIAL ratification, and never delete pending work
  without checking what it holds together.** The orphaning bug in full: the
  agent proposed nodes+edges; Cole ratified the five **nodes**; the agent later
  cleared its stale pending proposals — **deleting the edges that connected
  them** — and then re-proposed while omitting edges to the now-real nodes. The
  question not asked was _"I removed these nodes from the batch, so what
  happened to their edges?"_ Pairs with F5.1 (a `batchId` would make this
  mechanical).
- **P3 — Announce long background work.** When about to do several things that
  take minutes, say so first. Costs one line and no state; pairs with F3.

---

## Priority for the next round(s)

1. **F5 agent-DX + F2 node edit + F4 orphan detection** — small, they compound,
   and F5.1/F5.2 directly prevent the class of bug that hit this drive.
2. **F3 status channel** — small; rendering only, the wire is done.
3. **F1 pin + frames** — its own round; the first authored spatial state, with
   the tidy/compound-node question to ratify first.

Cole's own sequencing (seq 18): merge R11, then _"get to work on the issues and
refinements we worked through in this session,"_ returning to the music map
later — he notes it's getting large enough that **frames/pinning is what it now
needs**.

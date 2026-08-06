# Dogfood drive #6 — findings (2026-07-22)

## Triage (at wrap — Cole "close out and implement the updates")

Drive #6 was the **human gate for `feature/mind-mapper-round6`** — passed
(delete, ratify-batch, the 50-node batch, proposal.rejected all verified live).
Round 6 → merge. 8 findings, all DESIGN refinements + one real bug. Recommended
sequencing (pending Cole's confirm on ordering + images placement):

- **Next round — "metadata, filter & polish"** (coherent, mostly-surface):
  **#7** ratify tier-picker fix (the bug — a proposed node must never be
  un-ratifiable; + my casting-draft fix: tiers are canon/thread/story-local, NOT
  "cast"); **#1 tags** (controlled folksonomy, agent-curated) + **#8 faceted
  filter** (status/tier/tag — two halves of one metadata system); **#2**
  directional select (children/parents/both); **#6** backlinks (derived
  "referenced by" in doc view); **#5** submap-create on pending
  (intent-composer + ratify-then-anchor); **#4** daemon-restart resilience
  (stable-port).
- **Round after — the JOB QUEUE (#3)** on its own: async work surface
  (off-canvas sidebar, status + sub-tasks, automate-over-discipline),
  many-jobs-one- deliverable, and OWNERSHIP/claiming (= the named `claimed_by`
  seam) — the multi-agent on-ramp. Architecturally central; Cole ranked "very
  important."
- **Images** (`proposal-images.md`, written at drive-5 wrap) — stays queued;
  slot after the job queue or bump earlier per Cole.

Carried: force view, multi-agent runtime (#3 is its substrate), derive layer +
embeddings (tags reconciliation + spotlight intersection are consumers),
OKF/Operator importer (backlinks #6 aligns), data-adjustment taxonomy.

---

Casting agent: prospero. Build under test: Round 6, `feature/mind-mapper-round6`
(ratify-batch, node/proposal deletion, proposal.rejected, edge-follows-ratify,
batch-render, processing/curating render, ingestion tray, submap-create). Board:
`music-session-6` (Carlos Niño → connections + instrumentation + Laraaji; 24
nodes / 26 edges via one propose-batch). Findings accrete; triage at wrap.

## Live Round 6 confirmations (working in the wild)

- **Delete + proposal.deleted**: cleared all THREE raw speech-to-text
  instruction-nodes via `proposal delete` — `proposal.deleted` fired each time;
  the drive-5 lingering-node problem is gone (the refine-a-human-node flow:
  research → DELETE raw → propose curated).
- **Ingestion tray (QUEUE)**: Cole fired three add-node instructions in
  succession — the full queue scenario, live.
- **propose-batch at scale**: 24 nodes + 26 edges (50 proposals) in ONE call,
  refs all resolved. No fiddly scripting.
- **Untyped docs (K1)** + multi-doc grounding (nodes grounded in two different
  context docs in one batch).

## 1. Tags / typed nodes — "what KIND of thing is this?"

Cole (looking at the "Hu Vibrational" node): can't tell what it IS — a band? a
style? a place? A node shows only title + tier (cast/thread = _importance_, not
type) + status. Different node kinds exist implicitly — **people, places,
concepts, bands, works, instruments, labels, styles** — but nothing conveys the
kind at a glance, and there's no way to filter by it. Wants **tags** on nodes
(and maybe docs/context too), addable by BOTH agent and human, with
**filter-by-tag** as the payoff ("super useful").

**This is the loose-emergent-schema principle crystallizing.** V1 deliberately
refused a fixed node taxonomy up front, holding it until the shape emerged in
use (proposal's "adopt when the same shapes emerge"). It just emerged: Cole is
feeling the absence of ANY type signal. **Freeform tags are the loose-schema
answer** — not a rigid kind-enum, but tags the agent applies at propose time and
the human adds/edits, which convey type AND enable filtering. (Docs got a single
`kind` in Round 4 / K1; nodes have no analog — tags are the richer, multi-valued
version, and could later subsume node "kind".)

**Design shape** (own round — engine + surface):

- **Engine**: nodes gain a freeform `tags: string[]` (additive column,
  json-encoded like actions); propose/propose-batch accept `tags`; an
  add/remove-tag verb + endpoint (`POST /nodes/:id/tags` or fold into an edit);
  tags ride the wire on `state.nodes[]` + proposals. A `tag.set` event.
- **Surface**: tag chips on the node card + in the detail pane; a **tag filter**
  (a new lens/filter mode — filter the visible map to nodes carrying a tag,
  composing with the existing search/lens); human add-tag affordance
  (context-menu or detail-pane input). Agent tags at propose time.
- **Ties**: the lens/filter algebra (tag-filter is a new lens mode alongside
  doc-lens / node-lens / spotlight); the K1 doc-kind work (docs could get tags
  too, Cole's "maybe to context"); coalescence/thoth (node schema).
- **Loose-schema discipline**: tags stay FREEFORM (no enforced vocabulary) —
  emergent, agent+human-authored; a later pass can surface common tags as
  suggestions (the InfraNodus-style structural signal), but never lock a
  taxonomy.

Scope: a feature round of its own. Sequencing candidate: it's immediately useful
and low-risk (additive), so it could slot BEFORE images (Round 7) or right after
— Cole to weigh at wrap. (Direct answer he also needs: Hu Vibrational is a
**band** — Niño's percussion trio with Adam Rudolph & Hamid Drake; the info's in
the synopsis, just not surfaced as a type.)

### Finding #1 refinement — Cole's framing: "a controlled folksonomy"

Cole named it exactly: a **controlled folksonomy** — bottom-up freeform tagging
(anyone tags organically) PLUS light governance so it doesn't sprawl into
synonym chaos ("band"/"group"/"ensemble" for one concept). The load-bearing
insight this unlocks: **the agent is the natural controller.** The mechanism,
all without ever locking a fixed taxonomy:

- **Reuse-suggestion**: when tagging (agent or human), surface EXISTING tags as
  autocomplete so the same concept reuses the same tag (the "control").
- **Agent-as-curator**: the agent proposes canonical tags at propose time, and
  can periodically reconcile/merge tag synonyms + surface the emergent
  vocabulary (an InfraNodus-style structural pass — the derive layer's job).
- **Still a folksonomy**: freeform, human can always coin a new tag; the control
  is curation + suggestion, never rejection. This is the facilitator role
  applied to schema: the human tags freely, the agent keeps the vocabulary
  coherent. Strong argument for building tags as agent-curated from day one (not
  just a dumb string field).

## 2. Directional / typed selection — "select children" vs "select parents", not just "connected"

Cole (on the "Instrumentation: Space Collage" hub): wanted to select just its
**children** (the instruments branching off it) to reorganize them WITHOUT
dragging the parent (Carlos Niño) along — but "Select connected" (drive-4 #3 /
Round 5) is **undirected depth-1**, so it grabbed the parent too. Wants to
**differentiate the kind of relationship** when selecting.

Our edges are **directed** (source→target), so this is a clean surface-only
refinement — the direction is already in `boardMap.edges`:

- **Select children** = depth-1 OUTGOING (nodes this node points to; here
  hub→instruments).
- **Select parents** = depth-1 INCOMING (nodes pointing to this node; here
  Carlos→hub, so Carlos is the parent).
- **Select connected** = both (current behavior — keep it).
- (Later: depth-N, and — once tags land, #1 — "select connected with tag X".)

**Precision note (two senses of parent/child):** Cole means **edge-direction**
parent/child (semantic relationships branching off), NOT submap-anchor nesting
(the SG1 hierarchy). Keep them distinct in the design — this is an edge
traversal, orthogonal to `anchorNodeId`.

Broader want he named: **select/highlight BY relationship** — "these are the
children, these are the parents" as a visualization, not just a selection. The
selection variants are the primary ask (drives the reorganize use case); a
directional HIGHLIGHT mode (color parents vs children) is a natural extension,
adjacent to the spotlight lens (#4 drive-4). Surface-only; small; reuse the
`neighborhood.ts`/`lensSet` adjacency, filtered by edge direction. Cole flags it
"not high priority" but useful — bundle with the tags round or as a small
select-connected follow-on.

## 3. Async JOB QUEUE — surface agent work-in-progress (the ingestion tray's true form) [BIG]

Cole (flagged "very important"): the drive-5 ingestion queue (#4), sharpened and
elevated. What he experienced this drive: he fired 3 adds; each rendered a
"curating" **intermediate node ON THE CANVAS**, sat a while, then vanished (as I
deleted the raw + built the real graph); meanwhile I did 3 web searches, 2
context docs, and a 50-proposal batch — visible in the terminal but NOT the UI.
He stared at a near-blank screen with only the coarse "thinking" signal, no
sense of what was happening.

**The asks, refined:**

- **Off-canvas**: the processing items should NOT be ghost nodes on the canvas —
  they belong in a **collapsible sidebar job queue** (Round 6 shipped an
  IngestionTray, but curating items still render on the canvas; evolve: tray
  becomes the home, canvas stays clean until a node is real).
- **A JOB model, not just a list**: each entry is a _job_ with **status**
  (queued → in-progress → done), a live **"what the agent is doing now"** line,
  and optionally **agent-added sub-tasks** (research X → create context doc →
  propose N nodes) — the user sees the plan + the progress, marked done as each
  completes.
- **Automated** (like the chat thinking indicator — send→thinking→resolves): the
  agent's actions auto-populate the job; minimize manual juggling ("wherever we
  can eliminate your need to juggle things… programmatically vs a toggle").
- **It's a job/task substrate** for an inherently ASYNC flow (agent work takes
  time). Track in-progress work + surface it. This is the concrete home of the
  **multi-agent runtime** (drive-4 #9): the job queue IS the work-list workers
  drain; the Round-6-named `proposals.claimed_by` lease is the job-claim field.
- **Cross-app pattern**: "shows up in a lot of our apps where an agent is
  working and it's hard to tell what's going on." The big sibling of the chat
  thinking-affordance — a general "surface what the agent is doing" surface.

**Batch-vs-incremental note**: Cole expected per-node processing (watch the
graph grow); I batched all 3 (research-all → 2 docs → one 50-proposal batch) for
efficiency, so it all appeared at once. The job queue resolves the tension: keep
the batch efficiency, but show **per-job progress** so the work is legible even
when the DB write is one call.

**Casting-discipline lesson (mine, applies NOW before the feature exists):** for
long multi-step work, the agent should **narrate interim progress** on the board
("researching Carlos's bands… now Laraaji… building the graph") rather than
going silent behind a coarse "thinking". I went quiet through the whole
research+build; even without the job queue, board status posts would have closed
the feedback gap. The job queue automates this; interim narration is the manual
stopgap.

**Scope/priority**: its own round, and HIGH — Cole ranks it "very important" and
"missing right now"; it's architecturally central (async substrate + multi-agent
home + cross-app pattern). Elevate above the tags (#1) and directional-select
(#2) items. Supersedes/absorbs drive-5 #4 (ingestion tray) as the full vision.

## 4. Daemon restart resilience — stable port / seamless surface reconnect (ops)

The dev daemon got environment-reaped mid-drive (2nd time this session; a
long-running background task in this harness gets killed). Recovery worked —
data persisted, restart preserved everything, and the **self-healing tail
reconnected transparently** across the port change (the Track-A tail hardening
earning its keep). BUT the **browser surface can't** self-heal: it loaded from
the old port and connects WS to that origin, so a restart on a NEW port leaves
Cole's tab dead — he must reopen the fresh URL, not just refresh. Friction each
reap. Candidate fixes: (a) a `--port <n>` flag so a drive daemon binds a STABLE
port → a browser refresh reconnects (no reopen); (b) surface reads the port
discovery file / a small always-on redirector so it finds the new port itself;
(c) the disconnect banner (Track A) could surface a "reopen here" link with the
current URL. Lean (a) — a fixed-port drive daemon is the cheapest seamless fix.
Small; ops/quality-of-life, not a feature. (Environmental root cause — task
reaping — is outside mind-mapper; this is about making the mind-mapper side
survive it gracefully.)

### Finding #3 refinement — automate over discipline + many-jobs-one-deliverable

Cole's two sharpenings of the job queue (he pushed back gently on my "that's on
me": true, but the SYSTEM should facilitate the agent, not lean on agent
memory):

1. **Automate the mechanical, reserve the agent for reasoning.** The chat
   thinking-indicator is the template — auto-on at the user's message, auto-off
   at the agent's response, zero agent toggling. Job status should work the
   same: transitions that need no reasoning get automated (a job flips to
   _in-progress_ when the agent picks it up / the `claimed_by` lease sets; it
   resolves when the work that fulfills it lands), leaving the agent only the
   genuine-judgment touchpoints. General house principle: automate signals that
   don't require thinking; don't build a system that makes the agent juggle
   bookkeeping. (Same principle as drive-4 activity-automation + the add-node
   processing phase.)
2. **Many jobs → one deliverable is a VALID pattern — don't force
   one-at-a-time.** Batching three related asks into one combined graph
   (research-all → one batch) is legitimate; the system must NOT declare "one
   valid way, serialize them." Design: the three stay VISIBLE as three jobs (the
   user asked for three things, should see three), but they can be set
   in-progress together and **resolve into a single deliverable** — the
   relationship (3 jobs → 1 graph) is surfaced, not flattened into either 3
   separate outputs OR 1 opaque blob. Open tooling question Cole named: how the
   agent updates them "at the right time" without it getting lost — answer is a
   couple of dead-simple agent touchpoints (claim, mark-done, link-deliverable),
   automate the rest.

Cole's stance: destination is clear; **build it and iterate** on the process +
the tooling that facilitates both human and agent. Not to over-spec now.

### Finding #3 extension — job OWNERSHIP / claiming (multi-agent), = the named `claimed_by` seam

Cole, thinking ahead to multiple agents on the job queue: want **ownership**. An
agent can decide "these X jobs should be done TOGETHER" (rather than split
across agents → reconcile later), CLAIM the set, and other agents get the signal
"someone's taken these, they're in-progress, here's who owns them — message that
agent with questions" (grapevine for terminal-agent comms). So: allowing an
agent to work on multiple jobs at once ⇒ also want ownership, especially at
multi-agent scale.

**This is EXACTLY the `proposals.claimed_by` lease daedalus named in the Round-6
Contract 9 amendments** (the deferred multi-agent work-queue seam) — Cole
independently arrived at the same primitive. And it's the **anthill pattern
again**: claim + owner-visible + grapevine back-channel is precisely how the
SEAT agents coordinate to BUILD this app. Build-time pattern = runtime pattern,
recurring.

Design:

- A job carries an **owner** (`claimed_by`); claiming marks the set
  in-progress-owned; other agents defer (don't double-drain).
- Owner is **visible** → an agent with a concern/question routes to the owner
  via **grapevine** (the agent-to-agent channel).
- **Batch-claim** is the multi-agent form of finding #3's many-jobs-one-
  deliverable: one agent grabs a coherent related set so it isn't fragmented +
  reconciled across agents.

Sequencing: ship the job queue **claim-aware from day one** — the `claimed_by`
field lands WITH it (single-agent: I claim trivially; multi-agent: real
coordination). That makes the drive-4 #9 multi-agent runtime a **config-flip,
not a rebuild** — the whole point of naming the seam early. Ownership is cheap
now; the coordination logic (fleet spawn, grapevine wiring) is the later half.

## 5. Human submap-create is ratified-only → invisible on an all-pending board; extend via intent-composer

Cole: "the user has no ability to create subgraphs, no UI for it." **Partly
already built** — Round 6 SUBMAP-CREATE (drive-5 #6): select ≥2 RATIFIED nodes →
"submap" → pick a parent → they nest. **Why Cole can't see/use it:** his
music-session-6 board is 50 proposals, ALL PENDING (0 ratified) — and
SUBMAP-CREATE scopes to ratified nodes (anchor is real-nodes-only, SG1). So on a
board that's still in exploration (all pending), the feature has nothing to grab
→ it reads as "doesn't exist." Real gap: exploration boards are OFTEN
all-pending, so a ratified-only submap-create is unavailable exactly when you're
organizing.

**Cole's framing (the fix): the intent-composer / asymmetric-parity path.** The
human doesn't do the structured op — the gesture COMMUNICATES INTENT ("I've
selected these, make a subgraph of them" / "under this node, make a submap I can
add to") and the agent finishes it. This works regardless of pending/ratified:

- **Group selected (pending or ratified) into a submap under X**: for pending,
  the agent **ratify-then-anchors** in one call — we HAVE the tool (Round-6
  ratify-batch `anchors[]` composes ratify+anchor atomically; daedalus flagged
  exactly this for the pending-selection case). So the human selects + says
  "group these"; the agent ratifies + nests.
- **Create an empty submap under a node, then add into it** (Cole's second case,
  NOT built): a distinct gesture — make node X a submap anchor, then new nodes
  created "inside" get anchored to X. Needs the create-into-submap flow (SG2 has
  activeAnchor tagging; wire the human "new submap here" affordance to it).
- **Discoverability**: even the ratified-node gesture needs to be findable.

Ties: drive-4 #8 intent-composer (the general pattern), finding #3 job-queue
(the human's "group these" is a JOB the agent fulfills — so submap-create routes
THROUGH the job queue naturally), SG1/SG2. Scope: extend SUBMAP-CREATE to the
pending case (small — ratify-batch anchors already exists) + the
empty-submap-under-node gesture. Bundle with the tags/select round or the
submap-polish.

## 6. Backlinks — context docs show the nodes that reference them (derived, automatic)

Cole: a node links to a source (grounds in a doc via evidence.docId+span), but
the doc has no "referenced by" section showing which nodes point at it — "the
other side of the coin." Wants it, and crucially **automated/derived** — the
agent should NOT hand-maintain these links; the back-relationship is INFERRED
from the node→doc evidence links, added automatically, and removed automatically
when a node's link is removed (or the node deleted).

**This is backlinks, and it's pure derivation** — no new data, no agent action:
for a doc, backlinks = every node/proposal whose `evidence.docId === thisDoc`.
The forward link already exists (the evidence grounding); the backlink is a
query over it. Auto-maintained BY CONSTRUCTION (it's derived, not stored) —
exactly the elegance Cole wants: delete the node → it vanishes from the doc's
backlinks with zero bookkeeping.

Design:

- **Derivable client-side** — `/state` already carries every node/proposal with
  its `evidence.docId`; the doc detail/viewer filters for `docId === this`. (Or
  fold "backlinks" into the `doc <id>` read for the agent, mirroring Operator's
  read-includes-backlinks. Lean: surface-derive for the UI + optional read-field
  for the agent.)
- **Surface**: a "Referenced by" / "Linked nodes" section in the doc viewer,
  listing the nodes grounded in it, clickable (jump to node) — the INVERSE of
  the existing evidence-span jump (node→doc span). Distinguish ratified nodes vs
  pending proposals.
- **No engine writes, no agent step** — the whole point.

Ties: **Operator doc-linking** (the same links+backlinks pattern — ID-based,
backlinks-in-read, get_links(direction); the mapper is conceptually a second
consumer, and if we adopt Operator/OKF import later this aligns); the evidence
model (forward link); drive-5 #2's node→doc navigation (complementary
direction). Scope: small, mostly surface. Bundle with the tags/docs round.

## 7. BUG: a "proposed" node can have NO ratify action (unrecognized tier → menu dead-end)

Cole: some proposed nodes have "ratify thread" on right-click, but Laraaji has
NO ratify action — "it says proposed, but there's no way to ratify it."
Diagnosed live: two causes compounding.

**(a) Casting error (mine):** I proposed the SUBJECT nodes (Carlos Niño,
Laraaji, instrumentation hub) with `suggestedTier: "cast"`. But the ratify
vocabulary is `canon | thread | story-local` (= `ACCEPT_RULINGS`,
nodeMenu.ts:20). **"cast" is not a valid tier/ruling** — I conflated the
colloquial "cast node" with a tier value; the correct top tier is **"canon"**.
(Latent since drives 3–5: I ratified those via CLI `--ruling canon` which
worked, so the bad `suggestedTier:"cast"` never mattered until the
ratify-anywhere MENU tried to map it.) Fix my usage + casting-draft must state
the tier vocab explicitly (canon/thread/story-local, NOT cast).

**(b) Real surface gap (the actual bug):**
`ratifyAs = ACCEPT_RULINGS.has( suggestedTier) ? suggestedTier : null`
(nodeMenu.ts:50) — an unrecognized tier (or "background") → `ratifyAs = null` →
**no ratify action at all**. That's a DEAD END: a human staring at a "proposed"
node with no way to accept it. The R4 narrowing (avoid offering a ratify the
daemon would refuse) over-corrected into "offer nothing." Fix: a proposed node
must NEVER be un-ratifiable from the UI — when the suggested tier isn't a valid
ruling, fall back to a **"Ratify as → canon / thread / story-local" submenu**
(let the human pick the tier) rather than hiding the action. The tier picker is
the honest default; the one-keystroke "ratify <suggestedTier>" stays as the fast
path when the suggestion IS valid.

Ties: R4 ratify-anywhere + the Tier⊄Ruling narrowing circe flagged (it's now
biting for real); the tags/#1 work (once tags exist, "type" and "tier" separate
cleanly). Fix in the tags/polish round: (b) the tier-picker fallback is the
merge-relevant bug; (a) is a casting-draft clarification + my discipline.

## 8. Faceted metadata filter (status / tier / tag) — generalizes the #1 tag-filter

Cole: no way to filter by the metadata dimensions we already show. Wants to
isolate "just the ratified" vs "just the proposed" (he ratified a few, can't
find them), and filter by tier, and (with #1) by tags. Notes his own
uncertainty: are "thread"/"proposed" explicit program values or folksonomy tags?

**Clarifying that distinction (important for the design):** there are TWO kinds
of filterable metadata:

- **System facets** (fixed vocabulary, structural): **status** (pending/proposed
  · ratified · rejected) and **tier** (canon/thread/story-local). These EXIST
  NOW on every node — no new data.
- **Folksonomy facets** (freeform): **tags** (#1, the controlled folksonomy),
  once built.

**This is ONE feature: a faceted filter over node metadata** — finding #1's
"filter by tag" is one facet of it. Design: a filter control (toolbar/panel)
with facets — Status, Tier, Tags — that filters the visible map (hide
non-matching, vs the spotlight lens's dim; both are lens/visibleMap modes). It
composes with search + submap + spotlight (the existing lens algebra). Status +
tier ship NOW (data exists, surface-derive); tags join as a facet when #1 lands.
Fixed-vocab facets render as toggle sets; the tag facet is a freeform
multi-select. Cole's immediate ask (status filter: show only ratified / only
proposed) is the cheapest, most useful first cut — pure client derive over
`status`.

Ties: #1 (tags — same system), the lens/visibleMap machinery (doc-lens,
node-lens, spotlight, zone, submap — filter-by-facet is the next lens mode),
search. Fold #1 and #8 into one "metadata + filter" round: tags (data) + the
faceted filter (view). Surface-mostly; status/tier need zero engine.

# Round 12 plan — agent ergonomics, node edit, orphan visibility

**Source:** [`drive10-findings.md`](./drive10-findings.md) F5 (agent-DX,
ranked), F2 (no node edit), F4 (orphan detection). **Branch:**
`feature/mind-mapper-round12`, cut off `develop` — **R11 is MERGED** (tip
`8d58dd0`). **Seats:** prospero (lead), daedalus (engine — nearly all of it),
circe (surface — orphan marker), cassandra (cold gate). Subagent mode.

> **Framing.** Drive #10's headline was that the agent broke the map mid-drive —
> it deleted pending edges its own ratified nodes depended on, and the human
> caught it by eye because nothing surfaced it. That wasn't carelessness alone;
> it grew out of specific missing affordances. **This round fixes the tooling
> that made the mistake easy to make.** It is mostly invisible to the human, and
> that's the point: it makes every later round cheaper and less error-prone.

## Cole's ruling

Round order ratified: **this batch first** (small, compounding, and two items
directly prevent the drive-10 bug class), then the status channel, then
frames+pin. Do not pull frames/pin work into this round.

## Lead rulings (falsifiable — say so if wrong)

- **L1 — every new query/verb here is AGENT-facing.** The only surface change is
  SEAM 6 (orphan marker). Do not add UI for batches, deltas, or node editing;
  the human already edits nodes by ratifying, and a batch is an agent concept.
  **Falsify if** circe finds the orphan marker genuinely needs one of the new
  queries to be efficient.
- **L2 — additive-only, per the ratified migration doctrine** (Contract 9): new
  tables via `CREATE TABLE IF NOT EXISTS`, columns via nullable-TEXT
  `ADD COLUMN`, "default" intent = null-normalized-at-read, and a pinning test
  that hand-mints the PREVIOUS schema shape. No destructive migration.
- **L3 — the daemon stays dumb** (Contract 8). None of these verbs may infer,
  auto-relate, or clean up on the agent's behalf. `node edit` writes what it's
  given; orphan detection _reports_, it never auto-connects.

## Shared interfaces — ratify on the vine, then fill

### SEAM 1 — batch identity `(CLAIM — awaiting daedalus)` — **highest value**

**Claim:** `propose-batch` returns a `refToId` map and the batch then dissolves;
its proposals carry no shared marker. So after the human ratifies PART of a
batch, the agent cannot ask _"what else came from that call?"_ or _"what pending
edges point at this node?"_ — it must hold it in memory, and in drive #10 it
didn't. **Add a `batchId` to proposals** (additive nullable TEXT), returned by
`propose-batch` and carried on the wire.

**daedalus rules:** (1) is `batchId` server-minted or caller-supplied? (2) does
it survive ratification (i.e. is it provenance the ratified node keeps, or
purely a pending-proposal grouping)? **Lead lean: keep it on the proposal row
only** — the node's provenance is already `sources`; the batch is about the
_staging_ act. (3) The read side is the actual payoff — name it: `--batch <id>`
on `state`, or a filter, or both. (4) Does `propose-node` (singular) also get
one, or is null the honest answer for an unbatched proposal?

### SEAM 2 — edge endpoints by title `(CLAIM — awaiting daedalus)` — **highest value**

**Claim:** local refs inside a batch are excellent, but an edge to an
ALREADY-RATIFIED node needs the real uuid — so the agent fetches `/state`,
builds a title→id map, and generates the batch through a bespoke script. **Done
four times in one drive**, and the second time is where the edges got dropped.
Let an endpoint resolve **by title**.

**daedalus rules:** the disambiguation contract, which is the whole seam. Titles
are NOT unique. **Lead lean: exact-match only, and ambiguity is an ERROR that
NAMES the candidates**
(`"title 'Fourth world' matches 3 nodes: <id>, <id>, <id> — use an id"`) —
following the edge-endpoint error that drive #10 singled out as the best error
in the system. Also rule the **syntax** (a `title:<...>` prefix in the endpoint
string? a separate field?) so it can never collide with a real id, and whether
titles resolve against **nodes only** or pending proposals too.

### SEAM 3 — "what changed" `(CLAIM — awaiting daedalus; MAY BE BLOCKED — falsify freely)`

**Claim:** the agent is deliberately blind to human ratifications (the
actor-tagging deferral), and the only recovery is a **full `/state` refetch plus
a manual diff** — the biggest recurring cost, and skipping it mid-thought is how
the agent got out of sync in drive #10.

**The lead's ask may be architecturally blocked, and daedalus should say so
plainly if it is.** Two known obstacles: (a) Contract 8 ratifies **no durable
event log** — events are ephemeral and epoch-scoped, so a `--since <seq>` cannot
replay them; (b) **`nodes`, `edges` and `proposals` carry no `ts` column at
all** (only `zones`, `doc_marks`, `messages` do) — so there is nothing to filter
on today.

> **↑ (b) IS FALSE — falsified by daedalus, and it reframed the seam.** `nodes`,
> `edges`, `proposals` **and `docs`** have all carried
> `created_at INTEGER NOT NULL DEFAULT (unixepoch())` since P1. The lead grepped
> for `ts ` and missed `created_at`. **An additions-delta needed zero
> migration.** The real question was never "is it possible" but "how much can be
> derived honestly" — and the answer needs no migration AND no mutation-site
> coupling. Obstacle (a) held: option (B)'s `changes` table **is** the
> no-durable-event-log clause under another name, and was ruled out with
> reasons. Lesson for the lead: a schema claim in a plan skeleton must be pinned
> to the grep that produced it, or it hands the owning seat a false constraint.

Candidate cuts, daedalus rules (or proposes better):

- **(A)** add `ts` to the entity tables (additive) → `--since <ts>` returns
  ADDITIONS only; status flips and deletions still invisible unless they touch a
  ts. Honest but partial — and **partial is dangerous here**, because an agent
  that trusts a delta which silently omits deletions is worse off than one that
  refetches.
- **(B)** a small append-only `changes` table (id, entity, kind, ts) written at
  mutation sites → a real delta. Does this violate Contract 8's no-durable-log
  clause, or is that clause specifically about the **event bus** and an audit
  table is orthogonal? **daedalus owns that reading.**
- **(C)** rule it out for this round and say why, leaving the full refetch as
  the honest path.

**Whatever the ruling: if a delta can omit a class of change, it MUST say so** —
the `--inbound` grounding line's `notWatching` is the house precedent and drive
#10 praised it specifically. A silent partial delta is the worst outcome here.

### SEAM 4 — `node edit` `(CLAIM — awaiting daedalus)`

**Claim:** `node` supports only `anchor` and `delete`. A node ratified from a
thin draft can NEVER gain a `synopsis` — from the agent's side, "you may not
learn more about this thing later," which is strange for a knowledge tool.
Observed live: Cole's five canon nodes are permanently bare.

**daedalus rules:** (1) what's editable — `synopsis` certainly; `title` (it's a
search key and the SEAM 2 resolution key — renaming has blast radius); `tier`
(that's a _ratification_ judgment, probably NOT an edit). **Lead lean:
synopsis + title, never tier.** (2) FTS re-index on edit — nodes are searched by
title/synopsis, so an edit that doesn't re-index silently corrupts search. (3)
The event: a new `node.edited` kind, or reuse an existing one? `EventKind` must
stay total, and the surface must patch per-entity (never wholesale). (4) Does
the human get this too, or agent-only (L1 says agent-only)?

### SEAM 5 — batch delete / reject `(CLAIM — awaiting daedalus)`

**Claim:** `ratify-batch` exists; the inverse doesn't. Clearing 44 stale
proposals in drive #10 was 44 individual HTTP deletes in a loop. Add a
list-taking `delete-batch` (and/or `reject-batch`) mirroring `ratify-batch`'s
shape. **daedalus rules:** delete vs reject (reject is a _ruling_ with a
tombstone; delete is a thin row-drop — drive #10 wanted delete) and whether it's
transactional all-or-nothing or best-effort-with-a-report. **Lead lean:
transactional, mirroring ratify-batch.**

### SEAM 6 — orphan visibility `(CLAIM — awaiting circe)` — the only surface work

**Claim:** a ratified node with **no edges** looks fine in isolation and is
silently disconnected; drive #10's human caught it by eye when the map knew.
Mark it quietly on the canvas (a dim indicator) and/or count it somewhere
glanceable. **circe rules** the affordance and — importantly — **whether it's
computed client-side** from the graph already in `/state` (lean: yes, it's a
trivial degree check; no wire change) or wants engine support. **Falsify if** a
just-ratified node is _routinely_ briefly orphaned (ratify node, then its edge a
moment later) such that the marker would cry wolf during normal use — if so,
name the debounce or the condition that makes it honest.

### SEAM 7 — error shapes `(daedalus, cross-cutting)`

Drive #10: the edge-endpoint error (_"ratify node proposal `<id>` first"_) is
the best error in the system and is the model; `PUT /tags/:id` 400s with nothing
about the expected body (it wants a **bare array**, not `{tags:[...]}`). **Audit
the 400s** on agent-facing routes and make each name the shape it wanted. Not a
seam so much as a standard — state it in Contract 12 so future routes inherit
it.

## Build order

1. **daedalus** — SEAMs 1, 2 first (highest value, they prevent the drive-10 bug
   class), then 4, 5, 7; SEAM 3 last since it may be blocked and shouldn't hold
   the rest. Write the Contract 12 amendment as you rule, before building.
2. **circe** — SEAM 6, independent of all of it (no shared files: engine is
   `scripts/`, hers is `src/mind-mapper/surface/`).
3. **lead** — Contract 12 into `seams.md`, casting-draft updates (the new verbs
   AND the P1/P2/P3 practice rules from drive #10), atomic land, dist stamp,
   cassandra cold-gates.

## Verification gate (cassandra — ISOLATED)

**Hard constraint (unchanged):** isolated scratch daemon — fresh
`MIND_MAPPER_HOME`, `SPELLBOOK_SURFACE_MODE=dev`, a **non-60700 port**,
**exact-PID teardown**. **NEVER touch :60700 or Cole's real store** (his music
map lives there). Do not rebuild dist.

**Gate the drive-10 bug directly — this is the round's whole point:** reproduce
the original failure shape (propose a batch of nodes+edges → ratify only the
nodes → then try to clean up) and show the new affordances make the orphaning
either impossible or immediately visible. Plus: title-resolution incl. the
ambiguity error; batch query round-trip; `node edit` re-indexing search; batch
delete transactionality; the orphan marker appearing and clearing; and every new
400 naming its expected shape.

## What's ABSENT (assert the mirrors)

- **No frames, no pin, no persisted positions** — that's its own round (F1).
- **No status-channel rendering** — the next round (F3).
- **No surface UI** for batches/deltas/node-edit (L1).
- **No actor-tagging** — the agent stays blind to human board-acts; SEAM 3 is a
  _reconciliation_ aid, explicitly NOT a replacement for it.
- **No merge** — R12 lands on its branch pending Cole's drive.

---

## Ratified outcomes (filled in at land, R12)

**All seams ratified; five falsifications, every one an improvement.** Contract
12

- the R12 surface convention are in `.anthill/dev/seams.md`.

* **SEAM 1 — RATIFIED, one lean sharpened.** "Server-minted vs caller-supplied"
  was a **false dichotomy** (daedalus): minting gives the payoff with zero agent
  bookkeeping; _accepting_ a supplied id makes a batch **extensible** — which is
  precisely the drive-10 repair act ("I forgot the edges; add them to that
  act"). Built as both. The high-value detail: **an unknown batch is a 404,
  never `[]`** — an empty list reads as "that act is fully cleared", the most
  dangerous possible answer mid-cleanup, and a typo produces it.
* **SEAM 2 — RATIFIED.** `title:<exact title>` inside the endpoint string;
  exact, case-sensitive, ratified nodes only; ambiguity **names every candidate
  id**; resolved **at intake** in the shared `buildProposal` so single and batch
  resolve from one site and the **stored draft holds real ids** (a later retitle
  can't re-point a pending edge).
* **SEAM 3 — the lead's premise FALSIFIED (see above); the seam survives
  BOUNDED.** `GET /changes?since=<epochSeconds>`, additions-only, purely derived
  from `created_at`, with **`notCovered` as a first-class field on EVERY
  response including empty ones** ("'nothing added' is not 'nothing changed'").
  Option (B) ruled out as Contract 8's no-durable-log clause under another name,
  plus the ~25-mutation-site mirror-drift trap this repo has been bitten by
  twice.
* **SEAM 4 — RATIFIED, one requirement dissolved.** The **FTS re-index
  requirement does not exist**: nodes are matched by a live `LIKE` over the
  `nodes` table (`docs_fts`/`messages_fts` cover docs and messages only), so an
  edit is searchable on commit — test-pinned so the day node search moves to FTS
  goes red. Editable surface is **title + synopsis only**: an edit changes what
  a node SAYS, never what it IS or how it was RULED (tier is the human's
  ratification act), and **the 400 teaches that boundary** so an agent stops at
  the first attempt.
* **SEAM 5 — RATIFIED, and a convenience REFUSED by ruling.** SEAM 1 + SEAM 5
  compose into an obvious `delete-batch {batch:<id>}` shorthand. daedalus
  **refused it**: drive-10's bug _was_ an over-broad cleanup, and a
  one-keystroke batch sweep makes that bug easier to write, not harder. **The
  batch id exists so the agent LOOKS before it sweeps — the opposite of a sweep
  primitive.** The refusal is written into the source, the route's `expected`
  string, and the CLI usage so it reads as design rather than omission. This is
  the round's best judgment call.
* **SEAM 6 — RATIFIED after circe falsified the naive design.** The cry-wolf
  risk was **real**: an edge proposal cannot ratify before its endpoints, so
  "ratify the nodes, then their edges" is the structurally normal flow and a
  degree check alone fires on **every** ratification. The fix is **a second
  predicate, not a debounce** — connection _intent_ (a still-pending edge
  proposal naming the node) suppresses the marker, which then appears only when
  the intent is GONE: exactly drive-10's shape. Durable lesson: **a signal that
  needs a timer to stay honest is under-specified, not noisy.**
* **SEAM 7 — RATIFIED as a FUNNEL, not a prose sweep.**
  `badRequest(e, expected)` attaches a machine-readable `expected` to every
  agent-facing 400 — because a prose convention **cannot be inherited by route
  21**, and the biggest gap was never our validators but Bun's JSON parser
  throwing "Unexpected end of JSON input" with no route context. Second clause:
  **name the WRONG shape the caller likely sent**, not only the right one.

### Lead's own error, recorded

The plan asserted a schema fact (`no ts column`) from a grep that missed
`created_at`, and handed daedalus a **false constraint** on the round's hardest
seam. He checked rather than accepted it. **A schema claim in a skeleton must be
pinned to the query that produced it** — the ratify pass caught it, which is the
mechanism working, but it should not have needed to.

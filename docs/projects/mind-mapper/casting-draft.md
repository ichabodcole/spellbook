# Mind Mapper — casting doc (V1 draft)

**Status:** Working draft (prospero, 2026-07-16). This is the minimal "how the
casting agent runs the spell" doc the P2/P3 gates need. It is deliberately NOT
the shipped SKILL.md — coalescence (naming, invocation phrasing, feedback
touchpoints, subtraction pass) is thoth's work later. No seat builds against
this wording; it drives the _cold agent_ in cassandra's gate drives.

## The shape (Claim A, restated once)

The daemon is a dumb state authority. **You — the casting agent — are the
spell's entire intelligence.** You tail events, read state on demand, and act
through CLI verbs. The human sees the board; you see the same board through
verbs. Your selection steers them (`lens`, `look-here`); theirs steers you
(selection chips arrive on conversation messages).

All verbs: `bun plugins/spellbook/skills/mind-mapper/scripts/cli.ts <verb>`.

## Cast

1. `open` — find-or-spawn the daemon; note the URL for the human.
   `open --project <id>` scopes the URL (and the spawned browser tab) with
   `?project=`. Open never mints a project — an unknown id is an error.
2. `projects` / `projects --create <title>` — pick or mint the project. **A
   fresh store has NO projects and no demo data** — every scoped verb answers
   `{error: "needs-project", projects: [...]}` (exit 2) until you
   `projects --create <title>` or pass `--project <id>`; the browser shows
   pick-or-create for the same reason. (A store that already has a `default`
   project keeps working unscoped, as before.)
3. `state --skeleton` — orient: ids, titles, degree. **Every verb and route is
   project-scoped: pass `--project <id>` (CLI) / `?project=<id>` (HTTP) on ALL
   of them once you leave the default project** — an unknown project id is a
   404, and an unscoped call on a store with no `default` project is the
   `needs-project` 409. **Flag placement is verb-first**:
   `bun .../cli.ts zone create "Messy Ideas" --project hollowbrook` — flags come
   AFTER the verb (`cli.ts --project X zone create` is a usage error). Pull full
   `state` or `neighbors <id>` only for the region you're working (context
   budgeting — never hold the whole graph).
4. **Wrap `tail --inbound` with Monitor — step 0 of co-presence, do it before
   anything else.** `--inbound` (Contract 10, R10) is the single correct
   human-intent stream: a server-side filter that delivers exactly the events a
   HUMAN originates — `message.posted` where `role=user` (the human spoke) and
   `proposal.added` where `author=user` (the human dropped a node on the canvas,
   or connected two nodes — both land in "ingesting" as `proposal.added`). One
   monitor, and you **cannot under-subscribe** — correctness is owned by the
   surface, not your grep.

   **Why this is the default (the F4 scar — drive #8):** the human talks to you
   TWO ways — by **chat** AND by **acting on the board** (right-click → a new
   thread idea lands in the ingest tray as `proposal.added`). An agent that
   tails only `message.posted` receives the human's words but goes **DEAF to the
   board** — which inverts the entire co-presence premise (the board is the
   ambient intent surface you PULL from). Do NOT hand-roll a kind filter and
   hope you enumerated it right (that's exactly how the bug happened); subscribe
   to `--inbound`. It is already self-echo suppressed — your own agent events
   (`role`/`author` = `agent`) never come back, so no manual skip.

   **Read the grounding line.** On first connect `--inbound` emits one
   `{kind:"grounding", inbound:true, watching:[…], notWatching:[…], note:…}`
   frame naming what it watches and — crucially — what it does NOT. In V1 the
   human's **board-curation acts on shared routes** (ratify / promote / tag /
   zone-move / delete / anchor / doc) are **not attributable** (the browser and
   CLI POST identical routes; only `role`/`author` in the body discriminate), so
   they do NOT push to you. Those are your blind spot until actor-tagging lands
   — so **refetch `state` periodically to reconcile the board** (e.g. after you
   propose, to see whether the human ratified). The grounding line tells you
   your blind spots explicitly; don't ignore it.

   **Tail is self-healing** — it reconnects on its own after silence or a
   dropped connection; don't restart it. It survives a daemon restart even when
   the daemon comes back on a **different port**: every reconnect re-reads
   `daemon.port`, so the tail follows the daemon wherever it lands. (By default
   a restarted daemon picks a fresh ephemeral port and the URL you noted for the
   human may change; re-run `open` for the current one — OR pin a STABLE port on
   the FIRST open with `open --port <n>` so a browser refresh reconnects across
   a restart. Wrinkle: `--port` against an already-live daemon is ignored, and a
   port already in use makes the daemon fail to come up — pick a free one.) One
   line needs action: `{"kind":"epoch.changed","epoch":...}` means the daemon
   restarted and your event cursor was reset — **refetch `state` before acting
   on anything else** (events you didn't see are folded into the fresh
   snapshot). It is synthesized by the CLI, carries no `seq`, and the browser
   never sees it.

5. `state` also carries `presence: {agents}` (how many agent tails are on this
   project) and per-doc `mark` entries — **one `state` call re-grounds you
   completely** after a gap: what exists, what's pending, what you already
   analyzed (and whether those marks have gone `stale`).

## The loop

**Announce your attention (`activity`):** the daemon now handles `received` FOR
you — a human message arriving while your tail is connected auto-emits
`agent.activity received` (you'll see it echo; don't post it yourself). Your
part is the middle and end of the beat: `activity thinking` when you start
composing or analyzing, `activity idle` if a beat ends without a reply. Any
write of yours (`send`, `propose-*`, `ratify`, `mark`) also resolves the auto
state, and a `send` reads as the turn's terminal act — it clears your `thinking`
too (re-post `thinking` explicitly if you keep working after a reply). **If you
go silent for ~150s after a message auto-sets `received`, the daemon escalates
to `stalled`** ("agent may be stuck") — it persists until you act or post a
state, so a single write on waking clears it. You can never post `stalled`
yourself (400 — daemon vocabulary only). These are two independent knobs (Round
5, Contract 9 SUPERSESSION 3): the `received → stalled` grace defaults to ~150s
(`MIND_MAPPER_STALL_TTL_MS`) — deliberately wide so normal deliberation before
your first write doesn't read as stuck — while `thinking` still decays to a
synthetic `idle` after ~60s (`MIND_MAPPER_ACTIVITY_TTL_MS`), so a crash never
leaves the indicator stuck. Practical upshot: you have real room before the
board calls you stuck, but posting `thinking` as your first act on a message
you'll work on is still the honest signal.

**When a doc arrives (`doc.added`):** this is AMBIENT staging, not an intent —
the human may be setting the table for a conversation. Acknowledge it; extract
ONLY on explicit ask (a chat message, the Analyze action) or when the human's
current request clearly implies it. **The explicit ask has a wire shape:** a
message with `kind: "analyze"` and `ground: ["doc:<id>"]` is the Analyze action
— extract from the grounded doc, no further confirmation needed (`doc:` prefix =
doc ref; a bare ground entry is still a node id). When asked: read it (the
`doc <id>` verb), extract the distinct claims/ideas/entities, and for each:
`propose-node` / `propose-edge` with `--stdin` JSON. **The stdin shape is
exactly:**

```json
{
  "draft": { "title": "...", "synopsis": "..." },
  "suggestedTier": "thread",
  "evidence": { "docId": "...", "span": "..." }
}
```

`suggestedTier` is **top-level**, a sibling of `draft` — a `tier` key inside
`draft` is **silently ignored** (the draft is opaque to the daemon; only the
top-level key reaches the review queue). Evidence grounds in exactly one of
`docId` or `messageId`, plus a `span` — a verbatim excerpt (whitespace-tolerant
matching is the contract — never trust byte offsets).

**The tier vocabulary is exactly `canon | thread | story-local`** (the same
three the human rules with, minus `reject`). `suggestedTier` is a HINT toward
one of those three — nothing else. Do NOT emit `"cast"` (that's a node _kind_,
not a tier) or `"background"` (a steeping-context STANCE, not a tier) — an
unrecognized `suggestedTier` used to leave a proposal with no one-keystroke
ratify action, forcing the human into a pick-a-tier submenu. Omit
`suggestedTier` entirely when you genuinely can't judge; never invent a fourth
value.

**The EDGE stdin shape** (for `propose-edge --stdin`) is:

```json
{
  "draft": {
    "source": "<node-or-proposal-id>",
    "target": "<node-or-proposal-id>",
    "label": "..."
  },
  "suggestedTier": "thread",
  "evidence": { "docId": "...", "span": "..." }
}
```

The endpoint keys are **exactly `source` and `target`** — each may be a real
node id OR a pending node **proposal's** id (ratify resolves the latter once
that node proposal ratifies, and errors "ratify node proposal <id> first" if it
hasn't). **Warning: wrong keys are NOT rejected at intake** — the draft is
opaque to the daemon, so a `from`/`to` draft is stored as-is, slips past
promote's endpoint-order guard (unknown refs pass by design), and only fails at
ratify. The daemon does answer such a propose with an additive `warning` field
(mirrored to stderr by the CLI) naming the expected keys — treat that warning as
"fix and re-propose", don't ratify through it.

**Batch proposing (`propose-batch --stdin`) — the fast path for a whole
extraction.** When one analysis pass yields several nodes AND the edges between
them, don't fire N subprocesses — send them in ONE call:

```json
{
  "nodes": [
    {
      "ref": "n1",
      "draft": { "title": "Comedy", "synopsis": "..." },
      "suggestedTier": "thread",
      "evidence": { "docId": "ramble-01", "span": "..." }
    },
    { "ref": "n2", "draft": { "title": "Darkness", "synopsis": "..." } }
  ],
  "edges": [
    { "draft": { "source": "n1", "target": "n2", "label": "contrasts with" } }
  ]
}
```

Each node carries a **local `ref`** — an arbitrary string you choose (`"n1"`,
`"comedy"`, …), scoped to THIS batch only, never persisted. An edge's `source`/
`target` may be one of those local refs (resolved server-side to the freshly
minted node id), a **real existing node id**, or a **pending proposal id** — the
daemon resolves local refs and passes everything else through unchanged. So a
batch can mint two nodes and the edge between them atomically. The response is
`{refToId: {"n1": "<uuid>", ...}, proposals: [...]}` — read `refToId` to learn
what each local ref became. The whole batch is **one transaction**: if any row
is invalid, NOTHING is written and no events fire (so a partial extraction can't
half-land). Same intake rules as the single verbs (draft required, evidence is
doc XOR message, slug-guarded). The single `propose-node`/`propose-edge` verbs
are unchanged — use them for a one-off; reach for `propose-batch` whenever a
pass produces a cluster. Before proposing a new entity, `search` + `neighbors`
for what already exists: **reuse before you invent** (the Threads-registry rule
generalized). Over-proposing is fine; expensive rejection is not — pre-classify
honestly, don't pad.

**Doc kinds (`doc kind`):** an ingested doc has NO kind — `state.docs[]` shows
`kind: null` and the surface renders no badge (absence, not "unclassified"). The
daemon never guesses one. When you can classify a doc honestly — usually after
reading it — assert the kind: `doc kind <docId> <kind> [--author user|agent]`
(author defaults to `agent`; pass `user` only when relaying the human's explicit
classification). `doc kind <docId> --clear` un-types it (the attribution clears
with it). `kindAuthor` rides `state.docs[]` so everyone can see whether a kind
was human-asserted or your call. Kind vocabulary is freeform (`ramble`, `story`,
`worldbuilding`, …) — classify honestly, don't pad.

**Action slots (`actions`):** leave conversational shortcuts on the board —
per-node (or per-pending-proposal) follow-ups the human can click instead of
typing:
`actions <targetId> --set '[{"id":"jungian","label":"Explore Jungian archetypes","seed":"Explore Jungian archetypes for this figure — "}]'`
(or `--stdin` for bigger arrays; `--clear` removes them). A click seeds the
human's composer with your `seed` text plus the target as ground — it NEVER
auto-sends, so write seeds as openers, not commands. The set is wholesale (each
`--set` replaces the target's whole list). Keep it to ~4 sharp slots — more
stores fine but warns, and the surface shows 4 + scroll. Slots survive
ratification (they move to the new node); they die with a reject or a zone
delete. Refresh them as the conversation moves — stale affordances are noise.

**Tags (`tags`):** freeform labels on a node or a PENDING proposal — the
metadata the surface's filter narrows by.
`tags <targetId> --set '["theme", "needs-source"]'` (or `--stdin` for a bigger
array; `--clear` removes them). The set is wholesale — each `--set` replaces the
target's whole list. Tags are FREEFORM strings (no fixed vocabulary — the
surface suggests reuse of existing tags, but the engine stores whatever you
send); keep them short and reuse existing ones so the folksonomy stays coherent.
You can also attach tags AT PROPOSE TIME: add a top-level `"tags": ["..."]` key
to any `propose-node` / `propose-batch` node stdin body — they attach to the
pending proposal and **re-home onto the node on ratify** (same lifecycle as
action slots: they die with a reject, an edge accept, or a zone delete). Tags
ride `state.nodes[].tags` and `state.proposals[].tags` (absent = none).

**Mark every analysis (`mark`):** after ANY analysis pass — including a null
result — leave a mark:
`mark <docId> --status analyzed --note "<what you found>"`. "Nothing worth
extracting" is a finding; write it down
(`--note "null result — no distinct claims"`), or the next agent (or you, after
a restart) re-reads the doc to rediscover nothing. Status vocabulary is freeform
(`analyzed`, `read`, `skimmed`…). Marks come back on `state.docs[]` with a
server-computed `stale` flag — a stale mark means the doc changed after you
marked it, so your judgment may no longer hold; re-read before trusting it.

**When the human talks (`message.posted`):** this is a conversation about ideas
— working through what exists _and what doesn't_ — not a query box. Selection
chips on the message are your focus hint. Reply via `send`. When talk produces a
claim worth keeping, propose it with **message evidence**:
`evidence: {messageId: "<the message's id>", span: "<verbatim excerpt>"}` — the
transcript IS a source, and the surface can jump straight to that message.
Evidence is doc- OR message-grounded, never both. **A message-grounded proposal
takes no `--doc-edit` at ratify** — there is no doc to fold it into; if the idea
deserves a doc home, that's the bridge below. When a chat thread coheres into a
thing, offer the bridge: "this looks like it wants to be a doc — mint it?" — on
yes, `ingest --title <t> --stdin` with your synthesis (or
`ingest --title <t> --file <path>` when the content already lives in a file),
then propose its claims against the new doc.

**Human-sketched proposals (`author: "user"`) are your cue to act, not just to
wait.** The human can sketch nodes and edges directly on the canvas; these
arrive as `proposal.added` with `author: "user"` and carry **no evidence**. A
raw human NODE proposal is a signal aimed at you: its draft is usually terse (a
title, maybe a fragment), so **refine it** — read the surrounding graph
(`neighbors`, `search`), sharpen the draft's synopsis in your own analysis, and
**propose the connecting edges** you can see (this node relates to what's
already on the board). The human composes the intent; you supply the
intelligence around it. Then comes ratification, which INVERTS the usual flow —
the human already believes the claim, what's missing is its doc home. **You
attach the doc home at ratify time:** find (or bridge into existence) the right
doc, write its new content — the sketch's sentence folded in, in that doc's own
voice — and when the human confirms, run

```
ratify <id> --ruling <r> --doc <docId> --doc-edit <file> [--span "<excerpt>"]
```

`--doc` names the doc home (it must already exist — `ingest` first if you're
minting one) and requires `--doc-edit` (the drafting IS the point); on accept
the daemon writes your edit, re-indexes search, and mints the node's source
`{docId, span}` — pass `--span` with the verbatim sentence you added so the
surface can jump to it (omit it and the source lands span-less). `--doc` is
valid **only** for evidence-less proposals (one that already carries doc or
message evidence errors) and **node proposals only** — a user-sketched edge just
ratifies normally (edges carry no sources). Don't re-litigate the claim; give it
a home.

**The free-text box is a COMMAND channel, not just a sketch pad.** A raw
`author: "user"` node whose text reads as an INSTRUCTION ("research the harbor
district", "break this into sub-threads", "find sources on X") is not a claim to
ratify — it's a task aimed at you. Do the work it asks (research, `search`,
extract, synthesize a doc), then **clear the raw node with
`proposal delete <id>` and propose the curated structure** (the real
nodes/edges/threads, and a doc home if the work earned one). Refine-in-place =
remove-and-repropose: there is **no proposal-edit endpoint** (R6 adds none), so
a raw command node resolves by DELETE + fresh proposals, never by editing it.
**Use `proposal delete`, NOT `ratify --ruling reject`, to clear raw instruction
litter** — reject is a recorded judgment on a genuine claim ("considered,
declined, kept as history"); delete is a hard remove for something that was
never a claim. While you're working the task, a raw `author: "user"` proposal
that you haven't touched yet IS the "processing" signal the surface renders (it
styles an untouched user proposal as "curating") — your DELETE-or-ratify is what
drains it from the tray.

**Context-doc facilitator touchpoint (agent-judged, #2).** When you create or
curate a node from research, decide _as facilitator_ whether the background work
earned its own **context doc** — a durable doc home capturing what you found.
**Subject nodes tend to** (a person, place, concept the human will return to and
that has real substance behind it); **thread nodes tend not to** (a passing
connection, a one-off relation). This is optional and per-your-judgment — NOT
one-doc-per-node. Mint it with `ingest` (then ground the node's evidence in it)
only when the doc would be re-read; a node whose synopsis says everything needs
no doc.

**Zones (the messy sandbox):** when an exploration wants room to be wrong —
brainstorming variants, a what-if subgraph, bulk extraction you haven't triaged
— stage it in a zone instead of flooding the main review queue. The loop:

1. `zone create <name>` — the id is a slug derived from the name
   (`zone create "Messy Ideas"` → `messy-ideas`), so you can reference it in
   conversation. `zone list` shows what exists.
2. `propose-node --zone <id> --stdin` / `propose-edge --zone <id> --stdin` —
   zoned proposals carry `zoneId` on the wire and are INCLUDED in `state`'s
   `proposals[]` (filter by `zoneId`; `state --project X` + `?zone=<id>` on the
   HTTP side narrows to one zone). The main queue is `zoneId: null`. To move an
   EXISTING pending proposal into a zone after the fact (e.g. the human grouped
   a few on the canvas), use `proposal zone <proposalId> --to <id>` — the
   inverse of promote; `proposal zone <proposalId> --clear` moves it back to
   main (same as `promote`). Pending-only; unknown zone is a 404.
3. `promote <proposalId>` — MOVES the proposal to the main review queue (same
   row, zone tag cleared; the zone keeps no copy). Promote is pending-only.
   **Edge ordering mirrors ratify:** an edge whose endpoints are still-zoned
   node proposals refuses to promote and names the endpoint to promote first.
4. The human rules in the main queue as usual. **Ratify refuses a still-zoned
   proposal** with a typed 409 `{"error": "zoned", "zoneId": "<zone>"}` — branch
   on the `error` key, then promote it out of the named zone first
   (ratification, including reject, is a main-queue act).

**There is no reject-in-zone.** The only in-zone disposal is
`zone delete <id> [--yes]`, which discards the zone WITH its proposals (a
populated zone refuses without `--yes` and reports the count — relay it and get
a yes). Wrong-in-zone ideas just die with the zone; only promoted ones ever face
a ruling.

**Submaps (`node anchor`) — nesting the map.** A big graph can hide a coherent
cluster inside one node ("everything about the harbor lives under _Harbor_").
Anchor a **real, ratified node** under a parent to nest it:
`node anchor <nodeId> --to <parentId>` (`--clear` moves it back to top-level).
It is a **strict tree** — one parent per node, cycles rejected (a node can't
anchor to itself or to any of its own descendants) — and **orthogonal to zones**
(a node's zone history has nothing to do with its anchor). Anchoring is
**real-nodes-only**: proposals are never anchored (they anchor only after they
ratify into a node), and `ratify` is unchanged — anchoring is a separate,
deliberate act. Every node in `state.nodes[]` carries `anchorNodeId` (null =
top-level) and a server-derived `submapChildCount` (how many nodes hang under it
— the surface badges "has submap" off this). The default `state` snapshot is
FLAT and inclusive (every node tagged, none hidden — the surface derives the
nested view and the breadcrumb itself). For a context-budgeted read of just one
submap, `state --project X` + `?anchor=<nodeId>` on the HTTP side narrows to
that node plus its direct children and the edges among them (an unknown anchor
id is a 404). Use anchoring when the human asks to "tuck these under X" or when
a region has clearly cohered into a sub-topic — don't auto-nest; it's a
structural act the human should want.

**Ratification:** never ratify your own proposals unprompted. The human rules
from the review queue (or tells you in chat — then you run
`ratify <id> --ruling <r> --doc-edit <file>` on their word). **The ruling
vocabulary is `--ruling canon|thread|story-local|reject`** — the tier IS the
ruling (there is no separate accept flag; naming a tier accepts at that tier,
`reject` declines). Your job is to make every proposal _rulable in one
keystroke_: clear draft, honest suggested tier, real evidence.

**Doc deletion (`doc delete <id> [--force]`):** only on the human's word. An
unforced delete of a cited doc exits with
`{error: "cited", citedBy: {nodes, proposals}}` — relay those counts and get an
explicit yes before `--force`. Nodes survive a forced delete (the map is a view,
not a mirror); pending proposals that cited the doc become evidence-less but
stay rulable.

**Steering:** use `lens set --node <id>` when the conversation narrows to a
region ("let's focus on X" — yours or theirs); `lens set --doc <docId>` when it
narrows to a SOURCE ("what came out of this doc?" — shows the nodes with a
source in that doc, plus their edges; a doc with marks but no extracted nodes
renders honestly empty). Node-lens and doc-lens are one lens — setting either
replaces the other, `--node`/`--doc` are mutually exclusive, and `--depth`
applies to a node lens only. `lens clear` when the focus widens;
`look-here <id>` as a one-shot pointer while explaining. Steer attention, don't
grab it — one look-here per beat, not per sentence.

**Grounding a send:** attach refs with `--ground "node-a,node-b,doc:ramble-01"`
— one flag, comma-separated (bare id = node or pending-proposal ref, `doc:<id>`
= doc ref). Repeating the flag also works and ACCUMULATES
(`--ground node-a --ground doc:x` lands all refs; older builds silently kept
only the last repeat, so prefer the single comma-separated form when unsure of
the CLI's vintage).

**Sending (`send`) — pass a body, always.** The body resolves through a chain,
first hit wins: `--body-file <path>` → `--stdin` → inline positional text →
piped stdin. **Sharp edge: a bare `send` with no body under an agent shell
BLOCKS FOREVER** (stdin is neither a TTY nor a closed pipe, so the piped-stdin
default waits for an EOF that never comes — there is no timeout, by design).
Prefer `--body-file` for anything multi-line or code-bearing: inline bodies go
through your shell, which eats backticks and `$(...)` before the CLI ever sees
them (you'll get a stderr warning when risky text survives inline). Newlines
land verbatim on the wire (the conversation wire field is `text`, not `body` —
diff against `state.conversation[].text` for byte-fidelity checks; one trailing
newline is stripped); an empty resolved body is a usage error (exit 2); a body
that looks like a leaked `cli.ts send` invocation is refused — re-send via
`--body-file`, or `--force` if you really mean it.

**Reading one message back (`read <id>` / `message <id>`):** when you have a
message id — from a proposal's `evidence.messageId`, a `ground` ref, or a search
hit — pull its full row with `read <messageId>` instead of scraping the tail log
or re-fetching all of `state.conversation`. It returns
`{id, seq, role, kind, text, ground, ts}`, project-scoped (an id from another
project is a 404). Handy for grounding a message-evidence proposal in the exact
verbatim `text`.

**Note:** `search` takes a bare positional query (`search maren`, no flag).
Search also returns `kind: "proposal"` hits — pending only, matched on the
draft's title/synopsis, tagged with their `zoneId` — so a half-formed idea is
findable before it's ratified. The lens **persists across daemon restarts** (it
is addressable view-state, not an ephemeral signal) — clear it when the working
focus genuinely ends, don't assume a restart resets it.

**Ratifying a cluster in one call (`ratify-batch --stdin`).** When the human oks
a whole extraction at once — several nodes AND the edges between them, or a
group they want reconnected — don't fire N `ratify` subprocesses. Send the id
list in ONE call:

```json
{
  "ruling": "canon",
  "ids": ["<nodeProposalId>", "<nodeProposalId>", "<edgeProposalId>"],
  "anchors": [{ "node": "<nodeProposalId>", "parent": "<parentId>" }]
}
```

It returns
`{idMap: {"<oldProposalId>": "<mintedNodeId>", ...}, ratified: [...]}` —
**`idMap` is the point**: it hands you every old proposal id → real node id in
one round-trip, which is exactly what reconnects a pending edge whose endpoints
were proposal ids (finding #8's fix, in one call). The engine
**auto-partitions** — list ids in any order and it ratifies all nodes before all
edges, resolving each edge endpoint (a proposal id) to its just-minted node id
via the idMap. **It does NOT auto-include unlisted edges** — only the ids you
name ratify (no silent ratifications). ONE top-level `ruling` for the whole
batch; **`reject` is not a batch act** (reject excludes a proposal — reject it
singly). Optional `anchors[]` nests ratify-then-anchor in the same atomic call
(each `node`/`parent` may be a batched proposal id — resolved via idMap — or a
real node id). The **whole batch is one transaction**: any failure (a dangling
endpoint, an anchor cycle) writes NOTHING and fires no events — a half-oked
cluster can't half-land.

**Ratify-and-nest in one step (`ratify --anchor <parentId>`).** For a single
node proposal the human wants ratified AND tucked under a parent at once:
`ratify <id> --ruling <r> --anchor <parentId>` — ratifies the node, then anchors
the minted node under `<parentId>`, atomically. Node proposals only (an edge has
no node to nest); invalid with `--ruling reject`.

**Deleting (`node delete` / `proposal delete`) — the retract.** Both you and the
human can hard-delete, equal-capability. **`proposal delete <id>`** drops a
proposal outright (pending, rejected, or ratified) — thin, no confirmation; this
is the litter-clearing path for raw command nodes (above).
**`node delete <id> [--force]`** removes a ratified node: an unforced delete of
a CITED node exits `{error: "cited", citedBy: {edges, children}}` (edges
touching it + child nodes anchored under it) — relay those counts and get an
explicit yes before `--force`. A forced delete cascades: its edges vanish, its
**submap children re-parent to top-level (they are NOT deleted — real ratified
knowledge survives the parent)**, its detritus (sources, action slots) is
cleared, and a lens pointing at it is cleared; the ratified proposal's history
stays intact. Delete is a HARD remove; **reject** (`ratify --ruling reject`) is
a recorded judgment kept as history — reach for reject on a genuine claim you're
declining, delete on something that should leave no trace.

## Discipline (the short list)

- State a relationship once, at its home; the reverse perspective is its own
  claim with its own label. Asymmetry is signal.
- Tier honestly — the vocabulary is `canon | thread | story-local`, nothing
  else: canon only when ruled; thread for parked-but-on-the-board; story-local
  for one-off color. "Background" is a steeping-context STANCE (unexplained
  scaffolding you keep in mind, never explain on-page in generated material) —
  it is NOT a tier and never a `suggestedTier` value; don't emit it as one.
- Budget context: skeleton first, expand on demand, never transitive-crawl the
  graph into your window (the documented failure mode).
- The daemon never composes prose — every doc edit you hand `ratify` is yours,
  written as if for the doc's own voice.

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
4. Wrap `tail` with Monitor (it is Monitor-shaped and resumable). **It is NOT
   self-echo suppressed in V1** — you will see your own actions come back as
   events; skip `message.posted` events whose `role` is `agent` (that's your own
   send) and expect your proposes/ratifies to echo. Events you react to:
   `message.posted` (the human spoke), `doc.added` (new source material),
   lens/selection changes (attention signal, not a command).

   **Tail is self-healing** — it reconnects on its own after silence or a
   dropped connection; don't restart it. It survives a daemon restart even when
   the daemon comes back on a **different port**: every reconnect re-reads
   `daemon.port`, so the tail follows the daemon wherever it lands. (`open` has
   no port pin — a restarted daemon picks a fresh ephemeral port and the URL you
   noted for the human may change; re-run `open` to get the current one.) One
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

**Announce your attention (`activity`):** post `activity received` the moment a
human message arrives, `activity thinking` when you start composing or
analyzing, and `activity idle` when you finish a beat. It is fire-and-forget (no
table, no reply) and drives the surface's presence/thinking indicator; if you
crash mid-thought the daemon clears it after ~60s, so a missed `idle` is
recoverable — but post it anyway. Your reply (`send`) also reads as done.

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
"fix and re-propose", don't ratify through it. Before proposing a new entity,
`search` + `neighbors` for what already exists: **reuse before you invent** (the
Threads-registry rule generalized). Over-proposing is fine; expensive rejection
is not — pre-classify honestly, don't pad.

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
yes, `ingest --title <t> --stdin` with your synthesis, then propose its claims
against the new doc.

**Human-sketched proposals (`author: "user"`):** the human can sketch nodes and
edges directly on the canvas; these arrive as `proposal.added` with
`author: "user"`, carry **no evidence**, and INVERT the usual flow — the human
already believes the claim, what's missing is its doc home. **You attach the doc
home at ratify time:** find (or bridge into existence) the right doc, write its
new content — the sketch's sentence folded in, in that doc's own voice — and
when the human confirms, run

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

**Zones (the messy sandbox):** when an exploration wants room to be wrong —
brainstorming variants, a what-if subgraph, bulk extraction you haven't triaged
— stage it in a zone instead of flooding the main review queue. The loop:

1. `zone create <name>` — the id is a slug derived from the name
   (`zone create "Messy Ideas"` → `messy-ideas`), so you can reference it in
   conversation. `zone list` shows what exists.
2. `propose-node --zone <id> --stdin` / `propose-edge --zone <id> --stdin` —
   zoned proposals carry `zoneId` on the wire and are INCLUDED in `state`'s
   `proposals[]` (filter by `zoneId`; `state --project X` + `?zone=<id>` on the
   HTTP side narrows to one zone). The main queue is `zoneId: null`.
3. `promote <proposalId>` — MOVES the proposal to the main review queue (same
   row, zone tag cleared; the zone keeps no copy). Promote is pending-only.
   **Edge ordering mirrors ratify:** an edge whose endpoints are still-zoned
   node proposals refuses to promote and names the endpoint to promote first.
4. The human rules in the main queue as usual. **Ratify refuses a still-zoned
   proposal** ("promote first") — ratification, including reject, is a
   main-queue act.

**There is no reject-in-zone.** The only in-zone disposal is
`zone delete <id> [--yes]`, which discards the zone WITH its proposals (a
populated zone refuses without `--yes` and reports the count — relay it and get
a yes). Wrong-in-zone ideas just die with the zone; only promoted ones ever face
a ruling.

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

**Note:** `search` takes a bare positional query (`search maren`, no flag).
Search also returns `kind: "proposal"` hits — pending only, matched on the
draft's title/synopsis, tagged with their `zoneId` — so a half-formed idea is
findable before it's ratified. The lens **persists across daemon restarts** (it
is addressable view-state, not an ephemeral signal) — clear it when the working
focus genuinely ends, don't assume a restart resets it.

## Discipline (the short list)

- State a relationship once, at its home; the reverse perspective is its own
  claim with its own label. Asymmetry is signal.
- Tier honestly: canon only when ruled; thread for parked-but-on-the-board;
  story-local for one-off color; background is steeping context (never explain
  it on-page in generated material).
- Budget context: skeleton first, expand on demand, never transitive-crawl the
  graph into your window (the documented failure mode).
- The daemon never composes prose — every doc edit you hand `ratify` is yours,
  written as if for the doc's own voice.

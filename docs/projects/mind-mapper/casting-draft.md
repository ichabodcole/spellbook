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
2. `projects` / `projects --create <title>` — pick or mint the project.
3. `state --skeleton` — orient: ids, titles, degree. **Every verb and route is
   project-scoped: pass `--project <id>` (CLI) / `?project=<id>` (HTTP) on ALL
   of them once you leave the default project** — a missing scope reads as a
   confusing 404, not an error. Pull full `state` or `neighbors <id>` only for
   the region you're working (context budgeting — never hold the whole graph).
4. Wrap `tail` with Monitor (it is Monitor-shaped and resumable). **It is NOT
   self-echo suppressed in V1** — you will see your own actions come back as
   events; skip `message.posted` events whose `role` is `agent` (that's your own
   send) and expect your proposes/ratifies to echo. Events you react to:
   `message.posted` (the human spoke), `doc.added` (new source material),
   lens/selection changes (attention signal, not a command).

## The loop

**When a doc arrives (`doc.added`):** this is AMBIENT staging, not an intent —
the human may be setting the table for a conversation. Acknowledge it; extract
ONLY on explicit ask (a chat message, the Analyze action) or when the human's
current request clearly implies it. When asked: read it (the `doc <id>` verb —
P3; until then `curl <url>/doc/<id>?project=<id>`), extract the distinct
claims/ideas/entities, and for each: `propose-node` / `propose-edge` with
`--stdin` JSON — a draft (title, synopsis, suggested tier, and for
accepts-to-come: the doc-edit prose) plus evidence `{docId, span}` where `span`
is a verbatim excerpt (whitespace-tolerant matching is the contract — never
trust byte offsets). Before proposing a new entity, `search` + `neighbors` for
what already exists: **reuse before you invent** (the Threads-registry rule
generalized). Over-proposing is fine; expensive rejection is not — pre-classify
honestly, don't pad.

**When the human talks (`message.posted`):** this is a conversation about ideas
— working through what exists _and what doesn't_ — not a query box. Selection
chips on the message are your focus hint. Reply via `send`. When talk produces a
claim worth keeping, propose it (evidence span = the conversation message; the
transcript is a source). When a chat thread coheres into a thing, offer the
bridge: "this looks like it wants to be a doc — mint it?" — on yes,
`ingest --title <t> --stdin` with your synthesis, then propose its claims
against the new doc.

**Ratification:** never ratify your own proposals unprompted. The human rules
from the review queue (or tells you in chat — then you run
`ratify <id> --ruling <r> --doc-edit <file>` on their word). Your job is to make
every proposal _rulable in one keystroke_: clear draft, honest suggested tier,
real evidence.

**Steering:** use `lens set --node <id>` when the conversation narrows to a
region ("let's focus on X" — yours or theirs); `lens clear` when it widens;
`look-here <id>` as a one-shot pointer while explaining. Steer attention, don't
grab it — one look-here per beat, not per sentence.

**Note:** `search` takes a bare positional query (`search maren`, no flag). The
lens **persists across daemon restarts** (it is addressable view-state, not an
ephemeral signal) — clear it when the working focus genuinely ends, don't assume
a restart resets it.

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

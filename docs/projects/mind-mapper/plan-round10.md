# Round 10 plan — co-presence & discoverability paper cuts

**Source:** `drive8-findings.md` (F1–F5), the return-drive of the R8+R9 stack.
**Branch:** `feature/mind-mapper-round10` (cut off the **unmerged** R9 tip —
R8+R9+R10 merge together after Cole's sign-off). **Seats:** prospero (lead),
daedalus (engine — the `--inbound` stream), circe (surface — jobs
discoverability + labels), cassandra (cold gate). A **quick round** (Cole:
"solve these paper cuts before we move forward"), so the plan is tight: two
focused build slices + a docs slice.

> **Framing.** This drive's headline lesson: an agent tailing only the chat bus
> goes **deaf to the board**, inverting the co-presence premise. R10 makes
> correct co-presence the DEFAULT — the surface owns "what the human did," the
> agent subscribes once and can't get it wrong.

## What we're building (5 findings → one round)

- **F5/F4 (engine) — the `--inbound` human-intent stream** — the headline.
- **F1 (surface) — jobs queue discoverability** — persistent toggle + empty
  state
  - human "＋ New job" affordance.
- **F3 (surface) — Select labels** — drop the redundant verb.
- **F2/F4 (docs) — codify the monitoring default** — casting onboarding arms the
  inbound stream as step 0.

## Shared interfaces — ratify on the vine, then fill

### SEAM 1 — the `--inbound` human-intent stream `(CLAIM — awaiting daedalus)`

**Claim:** add a `tail --inbound` mode (name TBD — avoid colliding with
grapevine's `--human` presence flag) that server-side filters the event stream
to _events a HUMAN originated_, so a joining agent runs ONE monitor and cannot
under-subscribe.

**The attributability problem (the real seam):** only two event kinds carry a
clean human/agent discriminator today — `message.posted` (`role`) and
`proposal.added` (`author`). Every board mutation (`node.ratified`,
`proposal.promoted/rejected/ deleted`, `tags.set`, `zone.*`, `doc.*`,
`node.anchored`) is emitted identically whether the human (via surface routes:
`/proposals/:id/ruling`, `/ingest`, the surface proposal POST) or the agent (via
CLI routes: `ratify-batch`, `propose-batch`, `tags`) triggered it. So
`--inbound` can't perfectly filter human board-acts without more attribution.

**Two candidate cuts — daedalus rules:**

- **(A) Clean-attributable V1:** `--inbound` = `message.posted[role=user]` +
  `proposal.added[author=user]`. Fixes the exact drive bug (agent sees chat +
  dropped nodes), emits ZERO false "human did this" signals. Ratify/tag/zone
  attribution = a named follow-on (needs actor tagging). **Cost:** the agent is
  NOT notified when the human _ratifies_ a node — a real board-act it should
  react to.
- **(B) Origin-by-route stamping:** the server stamps an
  `origin: "surface" | "cli"` on every emitted event based on the route that
  caused it (the human's board acts already come through DISTINCT surface routes
  vs the agent's CLI routes). Then `--inbound` = `origin:"surface"`. Universal,
  future-proof, covers human ratify/ tag/zone/delete for free — but touches
  every emit site. **Is it still "quick"?** daedalus judges the blast radius.

**Falsify / rule:** pick (A) or (B) (or a hybrid — e.g. (A) plus origin-stamping
only on the ratify/ruling route, the highest-value board-act). Name the exact
event set `--inbound` admits, the flag name, and whether it's a server param
(`/events?inbound=1`) or a client-side filter. **Also:** the tail must emit a
`kind:"grounding"` first-connect line naming the channels watched + not-watched
(F5 belt-and-suspenders), so a missing channel is visible, not silent.

### SEAM 2 — jobs persistent toggle + empty state + create affordance `(CLAIM — awaiting circe)`

**Claim:** the jobs toggle (`App.tsx:1397`) currently renders only when
`state.jobs.length > 0` — invisible on a fresh session. Change to: **always
render** the toggle (shows `jobs · 0` / a subtle idle state); opening the
sidebar at zero jobs shows an **empty state** explaining what the queue is + a
**"＋ New job"** affordance that POSTs `/jobs` (the surface already has the
mutation pattern — `/send`, `/ingest`, `/proposals/:id/ruling`; `POST /jobs`
exists from R9). This also resolves plan-round9's open question ("does the
sidebar want a human create-job affordance?" → **yes**). **Falsify if:** an
always-on toggle clutters the toolbar enough to want a different affordance
(e.g. under a menu), or the create-job form wants fields beyond `{title}` in V1
(lean: title-only, status defaults `queued`; everything else editable after).

### SEAM 3 — Select labels `(CLAIM — awaiting circe, trivial)`

**Claim:** `nodeActions.ts` labels `select-connected/children/parents` → drop
the verb: **Connected / Children / Parents**. Leave the
`onCommand("Select connected")` dispatch strings UNTOUCHED (command contract,
not display); the "Select ▸" flyout title carries the verb. No behavior change.
**Falsify if:** a renderer uses the label as the command key (it shouldn't —
`key` is separate).

### SEAM 4 — codify the monitoring default `(docs — lead owns)`

The mind-mapper casting/onboarding doc gains a **step 0: arm a Monitor over the
`--inbound` stream before doing anything else** — so the next agent starts on
the right foot by construction, not by remembering to. Pairs the good default
(SEAM 1) with the codified methodology (this). Lands as a project doc / casting
brief (the spell has no formal SKILL.md yet — V1-in-progress).

## Build order

1. **daedalus** — ratify SEAM 1, write the Contract 10 amendment (the
   `--inbound` contract + grounding line) BEFORE the consuming onboarding doc,
   then build the filter + flag + grounding line + tests.
2. **circe** — SEAM 2 (jobs discoverability) + SEAM 3 (labels), in parallel with
   daedalus (no shared files; F1 touches App.tsx/JobsSidebar, F3 touches
   nodeActions.ts — engine is server.ts/cli.ts/events.ts).
3. **lead** — SEAM 4 onboarding doc against the ratified `--inbound` contract;
   land all slices atomically; stamp dist; cassandra cold-gates.

## Verification gate (cassandra — ISOLATED)

**Hard constraint:** cold drive on an **isolated scratch daemon** — fresh
`MIND_MAPPER_HOME`, `SPELLBOOK_SURFACE_MODE=dev`, a non-60700 port, **exact-PID
teardown**. NEVER touch :60700 or the real store. Exercise: (1) `tail --inbound`
on a scratch project → a human-side send + a user-authored proposal.added
appear; an AGENT propose-batch / agent send do NOT (no false human signal); the
grounding line names the channels. (2) Fresh project → jobs toggle is visible at
0 jobs → open → empty state → "＋ New job" creates one → it appears. (3) Node
detail Select section reads Connected/Children/Parents. Full suite green +
mind-mapper tsc clean.

## What's ABSENT (assert the mirrors)

- **No full actor-tagging of every mutation** unless daedalus picks (B) — if
  (A), human ratify/tag/zone attribution is a NAMED follow-on, not silent.
- **No surface change for `--inbound`** — it's an agent-facing CLI/engine
  feature; the browser uses WS unchanged.
- **No merge.** R8+R9+R10 stay stacked & unmerged pending Cole's sign-off (his
  gate, his push).

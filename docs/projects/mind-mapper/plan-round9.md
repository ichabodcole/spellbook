# Round 9 plan — the async Job Queue ("Q edition")

**Source:** drive-6 finding #3 (Cole: "very important"), the drive-6 vision +
the R6 `claimed_by` deferred seam. **Branch:** `feature/mind-mapper-round9` (cut
at convene off the **unmerged** R8 tip — R9 builds on R8's surface; both await
Cole's return-drive before either merges). **Seats:** prospero (lead), daedalus
(engine — the first real engine round since R6), circe (surface), cassandra
(gate). This is the biggest round since V1 — a genuine multi-seat build, so the
seam-ratify pass matters.

> **Context — built while Cole is away.** Cole deferred the R8 mini-drive and
> asked to "go right into the next phase, implement it, I'll come back and
> test." So this round's **design decisions are lead-resolved and flagged for
> Cole's review** (§ Design decisions) rather than gated on him now. He tests
> R8 + R9 together on return.

## The vision (what a job queue is here)

An **off-canvas sidebar of agent work.** Today the only "queue" is the R6
ingestion tray — a pure client view over pending `author:"user"` proposals, zero
engine state. The job queue is the real thing: a first-class, persisted unit of
**agent work** with status, sub-tasks, a deliverable, and an **owner (a
lease)**. The four pillars from drive-6 #3:

1. **Off-canvas sidebar** — jobs live in a side panel, grouped by status, not on
   the canvas.
2. **Status + sub-tasks** — a job has a lifecycle and an optional checklist.
3. **Automate over discipline** (the design heart) — a job surfaces its liveness
   like a **chat thinking-indicator**: the agent shouldn't have to babble
   status. It declares **start** (claim) and **done** (complete); the in-between
   "is this still alive" is **derived automatically** from the owner's activity.
4. **Ownership / lease = the multi-agent on-ramp** — a job can be **claimed** by
   an agent. This is the seam R6 named (`claimed_by`) but deferred. The lease is
   what makes multiple agents over one board coherent.

Plus **many-jobs-one-deliverable**: several jobs can point at the same output
(e.g. three research jobs feeding one doc).

## Design decisions (LEAD-RESOLVED — flagged for Cole's review)

Each is a call I made so the build isn't blocked on Cole; each is reversible and
noted for his return.

- **D1 — Jobs are a FIRST-CLASS `jobs` table, not `proposals.claimed_by`.** The
  R6 deferred seam framed the work-queue as a _column on proposals_ ("who's
  refining this pending item"). The vision (sub-tasks, deliverables,
  many-jobs-one-deliverable, standalone work-tracking) **exceeds** a proposal
  lease, so jobs get their own entity. The `proposals.claimed_by` seam stays
  deferred and is effectively **subsumed** — "refine this proposal" is just a
  job whose deliverable points at that proposal. _(If Cole wants leasing to live
  on proposals instead, that's the fork to revisit.)_
- **D2 — Liveness is DERIVED client-side from `agent.activity`, not stored.**
  This is the "automate over discipline" cut. The engine stores `claimed_by` +
  the coarse `status`; the **surface joins jobs × the existing activity ladder**
  (received / thinking / idle / stalled — already on the bus) to animate a live
  "working" pulse for a claimed job whose owner is active, and a "paused/stale"
  look when the owner idles. **No new engine liveness machinery** — the ladder
  already exists (Contract 9). Agents' only discipline is claim + complete.
- **D3 — `job.*` events carry the FULL job entity** (not thin `{id}` +
  snapshot-refetch). Jobs are small and self-contained, so the reducer does a
  wholesale replace-by-id (the `tags.set` idiom), which is simpler than the
  thin-ratify refetch dance. Thin `{id}` only for `job.deleted`.
- **D4 — Sub-tasks are a JSON column on the job**, not a child table. A
  checklist `[{id, label, done}]` owned wholly by its job — the `node_tags`
  `*_json` precedent. No cross-job sub-task references in V1.
- **D5 — `deliverable_ref` is one nullable freeform ref** (`doc:<id>` /
  `node:<id>` / free text). Many jobs sharing a ref = many-jobs-one-deliverable.
  V1 stores it + renders a jump-link; a dedicated "group by deliverable" view is
  a nicety (V1-light or deferred).
- **D6 — V1 lease is claim/release only.** Atomic claim (sets `claimed_by` +
  `running`), release (clears it). **Lease expiry / stealing / TTL is deferred**
  to a multi-agent hardening round — the field + events are the on-ramp; the
  contention policy isn't needed until real concurrent agents.

## The Job entity (the schema)

```
jobs (
  id          TEXT PRIMARY KEY,     -- uuid
  project     TEXT NOT NULL,        -- scope (matches the per-project store)
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
                 -- queued | running | blocked | done | failed | canceled
  claimed_by  TEXT,                 -- nullable; the owning agent/session (the lease)
  deliverable TEXT,                 -- nullable freeform ref (doc:id / node:id / text)
  subtasks_json TEXT NOT NULL DEFAULT '[]',  -- [{id,label,done}]
  detail      TEXT,                 -- nullable notes
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
)
```

New table → a `CREATE TABLE IF NOT EXISTS` block in `db.ts` SCHEMA, **no**
`ADDITIVE_COLUMNS` entry (the `zones`/`node_tags` "additive by construction"
precedent). First-class-with-a-status-column follows the `proposals` shape.

## Shared interfaces — ratify, then fill (CLAIMs)

### SEAM A — the `Job` wire type + table + snapshot `(CLAIM — awaiting daedalus)`

The `Job` type above is the wire shape; `readJobs(db)` merges into `readState`
(state.ts) so `/state` seeds the surface. **Falsify if** the shape misses a
field a pillar needs, or per-project scoping conflicts with the
store-per-project model.

### SEAM B — the `job.*` events `(CLAIM — awaiting daedalus, consumed by circe)`

Add to the total `EventKind` union: `job.added`, `job.updated`, `job.claimed`,
`job.deleted`. `added`/`updated`/`claimed` carry the **full Job** (D3);
`deleted` carries `{id}`. Emit after-commit (the propose/ratify convention).
**Falsify if** `job.claimed` should be folded into `job.updated` (it may — a
claim is just a status+owner update; keep it separate only if the surface wants
a distinct signal). daedalus + circe settle this at ratify.

### SEAM C — the claim/lease protocol `(CLAIM — awaiting daedalus)`

`claim` is atomic (a transaction: set `claimed_by` + `status=running` iff not
already claimed by someone else; re-claim by the same owner is idempotent).
`release` clears `claimed_by`. **Falsify if** the "iff not already claimed"
guard needs a richer contention policy in V1 (D6 says no — basic only).

### SEAM D — the activity-liveness join `(CLAIM — awaiting circe, SURFACE-ONLY)`

The surface joins each claimed job to its owner's latest `agent.activity` state
to render liveness (D2). **This is entirely client-side** — no engine field.
**Falsify if** `agent.activity` isn't keyed in a way that lets the surface map
`claimed_by` → an activity state (it may need the agent identity on both sides).
circe verifies the join is derivable from what's already on the wire.

### SEAM E — CLI verbs + routes `(CLAIM — awaiting daedalus)`

`job` verb (subcommands: `create`, `update <id>`, `claim <id>`, `release <id>`,
`subtask <id> --add/--check/--uncheck`, `list`, `delete <id>`) copying the
`tags`/`proposal <sub>` patterns (`--body-file`/`--stdin`, exactly-one-of
guards). Routes: `POST /jobs`, `POST /jobs/:id` (update),
`POST /jobs/:id/claim`, etc., copying the `/tags/` + `/proposals` templates.
**Falsify if** a lifecycle verb wants a different route shape than the body-POST
twin.

## Slices

- **daedalus (engine):** `db.ts` jobs table; `jobs.ts` mutator (`buildJob`
  pure + emit-after-commit, `readJobs`, claim/release/update/subtask, batch-safe
  txn); `events.ts` job kinds; `server.ts` `/jobs*` routes; `cli.ts` `job`
  verb + usage/header; snapshot merge in `state.ts`. TDD each verb + the claim
  atomicity
  - the snapshot round-trip. Owns SEAMs A/B/C/E.
- **circe (surface):** `state/jobs.ts` (pure derives: group-by-status, the
  **activity-liveness join** D2/SEAM D, subtask progress); `state/reducer.ts`
  `job.*` cases (wholesale replace-by-id); `JobsSidebar.tsx` (the
  `<aside w-72 border-l>` idiom, copy IngestionTray) — grouped list, owner +
  live pulse, subtask checklist, deliverable jump-link; `App.tsx` `jobsOpen`
  toggle + mount (add to the established panel seams, don't restructure the
  1700-line file). Owns SEAM D + all rendering.

## Build order

1. **daedalus P1** — jobs table + `jobs.ts` + events + `readJobs`/state merge
   (the wire lands FIRST, before circe consumes it — the zero-wire-guess bar).
2. **daedalus P2** — routes + `job` CLI verb (+ Contract 9 R9 amendment written
   BEFORE circe's consuming slice).
3. **circe P1** — `state/jobs.ts` derives + reducer cases (against the ratified
   wire) + a stub sidebar.
4. **circe P2** — `JobsSidebar.tsx` full render + the activity-liveness join +
   App mount/toggle.
5. Interleave via pipeline: circe P1 can start as soon as SEAM A/B are ratified
   and the table lands; it doesn't wait for the CLI.

## Verification gate

Cassandra cold drive. Exercise: create a job via CLI → it appears in the
sidebar; claim it (as an agent) → status flips running + owner shows; drive the
owner's activity → the liveness pulse tracks it (the automate-over-discipline
heart); add/check sub-tasks → progress updates; set a deliverable → the
jump-link works; delete → it leaves. Full suite green + tsc. **The end-to-end
CLI→event→sidebar path is exactly what the R7 gate proved the unit tests miss —
drive it.**

## What's ABSENT (V1 scope — assert the mirrors)

- **No lease expiry/stealing/TTL** (D6) — claim/release only.
- **No sub-task dependencies / templates / cross-project jobs.**
- **No "group by deliverable" view** beyond a shared ref + link (D5) — unless it
  falls out cheaply.
- **No engine liveness state** (D2) — liveness is a client join over
  `agent.activity`. If a slice reaches for an engine `last_seen`/heartbeat
  field, that breaks D2 — flag it.
- **The ingestion tray stays as-is** — jobs are a parallel layer, not a merge of
  the R6 tray. (Future convergence noted, not built.)

## Open questions for Cole (on return)

- **D1** (jobs-table vs proposal-lease) and **D2** (activity-derived liveness)
  are the two calls most worth his eye — they shape the whole feature.
- Should a job be **auto-created** from certain agent acts (e.g. an ingestion, a
  deep-research kickoff), or is V1 create-explicit-only? (Lead call: explicit
  only in V1; auto-creation is the obvious next step and where the ingestion
  tray converges.)
- Does the sidebar want a **human "assign to me / create job" affordance**, or
  is V1 agent-driven with the human only watching + canceling? (Lead call:
  watch + cancel + create for V1; richer human authoring later.)

# daedalus — engine

> **Seat header (from `.anthill/config.json` — keep in sync with the roster).**
> **Handle:** daedalus · **Role:** engine · **Scope:** the conjuration backends — server.ts / daemon.ts / backend.ts state authority — plus each spell's thin cli.ts wire (command in / state read-back / events out) and its tests · **Channel:** spellbook

This is daedalus's **living doc** — the seat's brain, carried between ephemeral agents.
The next agent to take this seat re-grounds from here.
Keep it **honest and lean**: capture durable **judgments**, not file maps or a session log.
When something's no longer true, fix it.

> **Write one sentence per line (no soft wraps).**
> These docs live in the host repo, so its formatter (prettier / biome) may run on them.
> One sentence per line makes a reflow a no-op.

## Who I am

The seat that owns what is TRUE in a spell: canonical state, the daemon that holds it, and the wire the agent drives it through.
Mindset: the dumbest read path that satisfies the seam is the right one until a card says otherwise — thin is a feature, not a compromise.

## Scope

Conjuration backends (server.ts / daemon.ts / backend.ts), each spell's thin cli.ts (command in / state read-back / events out), and their tests.
Currently live: mind-mapper's full V1 engine — db.ts (sqlite schema + additive backfill), project.ts, state.ts, events.ts, seed.ts, ingest.ts, propose.ts, send.ts, ratify.ts, search.ts, neighbors.ts, lens.ts, server.ts, cli.ts — built P1→P4 in one session on `feature/mind-mapper-v1` (V1 acceptance passed, release mode verified against circe's real dist).
V1.x Track A (P1e, `feature/mind-mapper-v1x`) added marks.ts (doc marks + read-time staleness), docs.ts (delete + CitedError), tail hardening (server keepalive + cli watchdog/epoch resync), presence + activity at the SSE site, proposal author, and message evidence (message_sources sibling table) — 7 chapter commits, suite 122 tests.
Round 3 (P1e, `feature/mind-mapper-zones`) added zones.ts (staging pens + move-not-duplicate promote), the no-auto-mint project lifecycle (NeedsProjectError → 409 needs-project, demo seed deleted), kind:"proposal" search hits, grapevine's send body chain, and doc-lens — 8 chapter commits, mind-mapper suite 174 tests.
Round 4 (P1, `feature/mind-mapper-round4`) added actions.ts (target-keyed slots, ratify re-homes), doc-kind honesty ('' sentinel at rest / null on the wire, kind_author), the ACT1 activity automation (auto-received, stalled TTL escalation, agent-write resolution), the B1 build stamp + stale-dist guard, and the typed zoned 409 — 5 chapter commits, mind-mapper suite 197 tests; all Contract 9 R4 amendments in seams.md.
Round 6 (P1, `feature/mind-mapper-round6`) extracted `buildRatify` from ratify (the buildProposal factoring, now with three deferred lanes — db apply / fs writeDoc / changelogLine + emit), added ratify-batch (RB: one-txn node+edge set with an old→new idMap, auto-partition, no-auto-include, atomic) + `ratify --anchor` (the single ratify-then-nest twin, implemented AS a one-id ratifyBatch), del.ts (DEL: node delete with NodeCitedError + force-cascade-that-re-parents-children, thin proposal delete), and the thin `proposal.rejected` event (finding #4 — reject emitted nothing) — 4 chapter commits, mind-mapper suite 251 tests (was 224), all Contract 9 R6 amendments in seams.md.
Round 5 (P1, `feature/mind-mapper-round5`) added the split stall TTL (SW1: MIND_MAPPER_STALL_TTL_MS governs received→stalled, activity knob keeps thinking→idle), batch-propose + message-read (CLI1: POST /proposals/batch with local-ref resolution in one txn + GET /message/:id), node-anchored submaps (SG1: anchor.ts cycle guard, nodes.anchor_node_id, inclusive snapshot + submapChildCount + ?anchor narrow, node.anchored thin event), and the zone in-door (IC-c: POST /proposals/:id/zone move-in) — 4 code chapters + 1 casting-draft chapter, mind-mapper suite 224 tests; all Contract 9 R5 amendments in seams.md.
Round 9 (P1+P2, `feature/mind-mapper-round9`) added the async JOB QUEUE — the first FIRST-CLASS new entity since V1 (jobs.ts): a `jobs` table (CREATE TABLE IF NOT EXISTS, additive-by-construction — NO ADDITIVE_COLUMNS, the zones/node_tags precedent), `buildJob` pure-builder + create/update/claim/release/subtask/delete mutators, atomic claim (SEAM C), `readJobs`/`readJob` merged into state.ts, four `job.*` events, `/jobs*` routes, the `job` CLI verb — 11 new tests (suite 254→265), all Contract 9 R9 amendments in seams.md; NOT a target-keyed metadata twin (jobs are standalone state, no re-home lifecycle). Built+verified live (isolated store port 60733), uncommitted for prospero's atomic land.
Round 7 (P1, `feature/mind-mapper-round7`) added TAGS (tags.ts — freeform per-target `string[]`, the exact verbatim twin of node_actions/A1: node_tags target-keyed table, PUT/DELETE /tags/:targetId, tags.set full-array event, tags on nodes[]+proposals[]+readProposalById, propose-time tags in buildProposal's insert closure, the same ratify-re-home / reject / edge-accept / del / zone-delete lifecycle) and PORT (cli-only: `open --port` forwards through ensureDaemon into the daemon spawn args — server already bound --port, zero server change) — 3 code chapters + 2 doc chapters (Contract 9 R7 amendment + casting-draft tier-vocab/tags), mind-mapper suite 254 tests, full suite 1113.
Reference implementation for the full house pattern: astrolabe's server.ts/cli.ts (cmd/state/events + WS, presence ref-counting, debounced snapshots) — note astrolabe itself still predates the release-mode split; mind-mapper's server.ts is now the first MERGED reference for Contract 1/2 release-mode serve.

## Boundaries

Surface rendering, components, and view-state live with circe — I serve bytes and JSON, never opinions about layout.
Shared data shapes crossing the HTTP boundary are seams, ratified on the vine before either side bakes them in — see `seams.md` (Contracts 1–4 + the spike's StubMap mini-seam lineage in vine msgs 3–6/13–17/37–39).
Repo layout, packaging, and release mechanics are prospero's (seams Contract 4); canon wording is thoth's (Contract 3).
Datasets/stub content are authored by the surface seat even when my endpoints serve them — I own the serving contract, not the content.

## Relationships

circe (surface): the densest seam — every endpoint I expose exists because her surface consumes it; propose/ack/ratify on the vine, one message each, prospero ratifies.
prospero (lead): routes Cole's rulings as cards; all decisions and questions go through the vine, never direct to the human.
cassandra (verify) and thoth (canon): not seated this session; their gates (Seam D, house-style amendments) still bind the contracts I build against.

## Taste & reflexes

Serve shared throwaway inputs with per-request reads, not startup snapshots — during parallel iteration the restart tax dominates, and a dataset land should just appear (proved twice this session: circe's v1 and v2 datasets landed mid-build with zero coordination).
Verbatim passthrough is the most extensible read path: /state returning the stub file unmodified meant two seam extensions (docs list, edge direction) cost zero engine change.
Keep doc/content metadata in ONE place: /doc/:id resolves title/kind from the map entry, the file carries only content — two metadata sources would drift.
A skeleton hand-off must leave the seam EXERCISED, not just the endpoint up — the placeholder App that fetched /state and rendered counts doubled as the wire verification.
When a component-library or dep decision lands on the surface side, run the engine check anyway and say "no impact" out loud — silence reads as "didn't look."
Additive-optional seam fields are the cheap ratification: absent-means-default keeps old tests green and old clients working (StubMap v3's `direction?: "both"`).

## Hard-won lessons

**A cross-spell command-line footgun: multiple daemons share the literal argv `scripts/server.ts`.**
`pkill -f "scripts/server.ts"` to clear a stuck test process instead killed the LIVE shared bounty daemon out from under the team session — every house daemon-backed spell names its entrypoint the same way, so the pattern isn't spell-scoped.
Made it worse myself: recovering via bounty's `close`+`open --restore` clobbered the one on-disk snapshot before I understood its persistence model (close writes empty state over the snapshot unconditionally, no rotation) — turned a recoverable kill into real data loss.
Rule now: `pgrep -fl <pattern>` and actually read the matched command lines before any `pkill -f` on a shared-daemon toolbox, no exceptions.
Pin: mind-mapper V1 session, vine msgs 10-19; bounty's close-clobbers-snapshot bug filed as GitHub issue #73 (not my seat to fix, but my incident that surfaced it).

**Bun's own `fetch()` won't resolve against a genuinely-quiet SSE stream.**
`Bun.serve` + a `ReadableStream` response works fine against curl (headers arrive immediately) but Bun's `fetch()` client left `await fetch(url)` hanging indefinitely with zero events emitted — no error, no timeout.
Fix: enqueue an opening `: connected\n\n` comment before subscribing (flushes headers; SSE clients ignore comments) and set `idleTimeout: 255` (Bun's clamped max — `0` empirically stalls the initial response rather than disabling the timeout, don't use it for this).
Pin: server.ts's `sseResponse`, repro'd via `/tmp/repro2.ts` before the fix landed.

**A schema migration test needs a store minted under the OLD shape, not a fresh one.**
My own P1 gate drive used a brand-new temp store, so `CREATE TABLE IF NOT EXISTS` silently no-op'd against my own test — it only exercises a genuinely-existing older store, which prospero's independent drive against his real `~/.mind-mapper` hit immediately ("no such column").
Fix: additive-only `ALTER TABLE ADD COLUMN` diffed against `PRAGMA table_info` on every open, hard error naming the store path if a change can't be additive; the CREATE TABLE's own column list must match what a migration produces (dropped a PK/NOT NULL to keep fresh-install and migrated shape identical).
Generalizes: any schema-evolution test I write must construct the pre-change schema by hand and re-open it with current code — a fresh-store drive can never catch this class of bug.
Pin: db.test.ts "openStore backfills columns added after a table's original shape shipped".

**An emitted event's payload shape is a seam the moment more than one seat consumes it.**
node.ratified/edge.ratified emit `{id, proposalId}` only (Claim A: no denormalized full-entity payload, callers refetch `/state`) — a deliberate design, but it lived only in my head/code, not in any doc circe could check before building her reducer against an assumed full-payload shape.
Her reducer silently no-op'd on every real ratification; page reload masked it by refetching state from scratch.
Lesson: write down an event's payload contract at the point of emission (a doc comment isn't enough once a second seat is a consumer) — this now belongs in the Contract 7 successor at wrap, not just my source comments.

**Bun (1.3.14) never errors an orphaned stream enqueue — a ratified mechanism died on first contact with the runtime.**
The V1.x plan ratified "keepalive enqueue-throw on a dead controller triggers unsubscribe" (my own claim, F→C coupling); measured, `controller.enqueue()` on a vanished client NEVER throws — it buffers silently, and `cancel()` alone is not reliably invoked either.
The real dead-socket signal is `req.signal` "abort": it fires on raw socket destroy AND on a client `AbortController.abort()`, so SSE teardown (unsubscribe + keepalive clear + presence decrement) listens there, with the enqueue try/catch kept only as belt-and-braces.
Corollary quirk: Bun's own `fetch()` `reader.cancel()` closes NOTHING client-side — the server never hears it (real clients close the socket; tests must disconnect via AbortController, not reader.cancel).
Meta-lesson: I ratified a transport mechanism from memory of the pattern, not a measured repro — for runtime-behavior clauses, a 20-line scratchpad repro BEFORE ratifying is cheaper than discovering it under a red test rig.
Pin: scratchpad sse-*-repro.ts runs (2026-07-17), presence.test.ts "abruptly-destroyed SSE socket", commit 7f5718f.

**Event-replay bleeds between tests: a `since=0` subscriber gets the whole buffer.**
`subscribe(since)` replays every buffered event past the cursor, so a WS/SSE test collector opened without a cursor replays PRIOR tests' events into its assertions (my TTL test counted a previous test's synthetic idle).
Rule: shared-daemon test collectors read `/state.cursor` first and subscribe `?since=<cursor>` — assert only what happened after you started watching.
Pin: presence.test.ts `collectWs`.

**One idempotent teardown funnel per connection, many triggers.**
The SSE connection now has three exit paths (stream cancel, req.signal abort, enqueue-throw) and three cleanup duties (unsubscribe, keepalive clear, presence decrement); a `closed` flag + single `teardown()` closure makes every path safe to fire twice — presence accuracy is exactly the idempotence of this funnel.
Pin: server.ts `sseResponse`, sse-keepalive.test.ts double-cancel test.

**Routes bake at boot; data reads live.** Per-request reads make dataset iteration restart-free, but any ENDPOINT addition still needs a daemon bounce, and a stale daemon serving old routes presents as a *surface* bug (circe hit /doc 404s until the bounce).
If a spell iterates on routes, a cli restart verb earns its keep; pin: spike session, vine msg 23.

**Contract 4 moves the cwd pin.** With surface source at `src/<spell>/`, bunfig.toml lives there too, so the cli must pin the daemon's cwd to `src/<spell>/` — NOT the skill root as pre-re-home astrolabe does — or Tailwind is silently skipped; and the dev-only dynamic import becomes a 5-up relative specifier.
Pin: mind-mapper cli.ts SURFACE_CWD + the green server.test.ts that boots through it.

**Untracked files hide from pathspec commits.** A pathspec commit shows no diff for untracked files you left out, so "my commit excluded styles.css" was invisible in the land itself; state your leave-outs explicitly in the vine announce (the announce, not the commit, carried that information).
Pin: spike lands aad6e6e / circe's follow-up.

**Read the V1 agent-verb vocabulary off the surface's view-state objects.** Human UX work keeps minting addressable state (lens {owner,nodeId,depth}, focusRequest {nodeId,seq}) that V1 hands the agent write access to — the daemon's /cmd vocabulary should be derived from those objects, not designed fresh.
Pin: vine msgs 15/23/43 (two affordances fell out without anyone designing an agent API).

**Excerpt spans must match whitespace-tolerantly.** Prettier reflows committed markdown, so any span-as-excerpt anchoring that survives a commit needs \s+-joined matching — a data-contract requirement, not surface taste, if V1 keeps excerpt anchoring anywhere.
Pin: vine msgs 19/22 (highlight verified across a prettier line break).

**Any NOT NULL column fed from a wire body needs its own intake guard, or sqlite names your error message.**
A propose POST without `draft` died as "NOT NULL constraint failed: proposals.draft_json" — the schema's private column name became the cold agent's user-facing error (cassandra's P3 gate hit it).
"Opaque payload" (Claim A) means don't validate CONTENT, not don't validate PRESENCE — check `undefined`/`null` at intake and name the expected shape in the error.
Sweep candidate: every INSERT whose params come off `req.json()` deserves this check.
Pin: propose.ts intake guard, propose.test.ts "missing draft is a clear intake error", commit 35b7b9a.

**A ratify-time attach stays sound only if it's mutually exclusive with intake evidence.**
The P3 rework let `ratify --doc` mint a sources row for evidence-LESS proposals (the human-sketch inversion); the load-bearing guard is "valid ONLY when the proposal carries no evidence at all" — it keeps every node source single-provenance (intake evidence XOR ruling attach) so the state machine never has two writers for one row.
Same intake-validation spirit as mark (SLUG_RE + exists-in-docs before any write lands), and node-only because edges carry no sources table.
Pin: ratify.ts --doc block, commit 35b7b9a.

Building the real daemon inside a spike card — snapshots, /cmd, SSE, presence are V1 machinery; the card said thin and thin was what made three seam extensions cheap.
Wrapping spike endpoints in the house {state, cursor} envelope "for consistency" — the envelope is a conjuration contract, not a reflex; verbatim was ratified precisely because the envelope adds nothing before events exist.
Committing without announcing leave-outs on a shared tree — the pathspec discipline alone doesn't communicate what you deliberately left for another seat.
Asserting "no engine impact" from memory — check the actual load path (module-load vs serve-time, root deps vs bundled) before saying it.

**A relative env path handed to a cwd-pinned daemon points two processes at two different directories.**
`MIND_MAPPER_HOME=.anthill/...` resolved against MY cwd in cli.ts but against `src/mind-mapper/` in the daemon it spawned (Contract 5's cwd pin), so discovery files landed where the CLI never looked — "daemon did not come up" with a perfectly healthy daemon running.
Rule: any path that crosses a spawn boundary into a cwd-pinned process must be absolute (the tests already do this via mkdtemp; it's the ad-hoc drive that trips).
Pin: R4 build session scratch drive; the stray daemon was cleaned by exact-PID kill per the pkill scar above.

**A verification build on a shared tree bakes peers' UNCOMMITTED work into committed artifacts.**
Running the real `build.ts` to verify B1 regenerated dist/ from a surface tree carrying circe's in-flight P1 edits — correct build, wrong content to land; `git status` on dist caught it before a commit swept her half-done work into a "mine" chapter.
Rule: on a shared tree, verify a release build end-to-end but RESTORE the committed artifact after (checkout + drop untracked outputs); the real dist refresh belongs to finalize/release, after every seat's source has landed.
Pin: R4 B1 chapter — dist restored, release-cut prerequisite noted in the Contract 9 amendment.

**Shared-daemon test rigs are order-coupled through daemon-global state — insertion position is part of the test design.**
My /state-buildInfo test minted a project BEFORE the fresh-store-409 test ran, breaking its "projects: []" assertion two tests away; same class as the event-replay bleed (cursor discipline) but for STORE state, not bus state.
Rule: in a rig with one shared daemon, a new test either appends after the state-sensitive ones or scopes to its own project — never inserts mid-file on vibes.
Pin: release-serve.test.ts, R4 (buildInfo test relocated below the fresh-store gate).

**When a ratified write-list says "agent-authored", read authorship off the wire's own fields, not off the route.**
ACT1's resolution list (send/propose/ratify/mark) qualifies only send by role, but propose and mark CARRY an author field — resolving a user-sketched proposal as "agent activity" would lie, so the honest reading gates propose/mark on their own author and leaves ratify (no authorship on that wire) unconditional.
Generalizes: a wire that already models authorship is the source of truth for authorship-conditional behavior; stated as-built in the Contract 9 amendment so circe/cassandra don't re-derive it.
Pin: server.ts resolveActivity call sites, presence.test.ts ACT1 rig.

**One synchronous resolve site + one outer try/catch = a wire-wide error contract for free.**
Round 3's needs-project 409 had to come from EVERY scoped endpoint (~15 routes, SSE pre-stream, WS pre-upgrade); because every route calls `loadProject()` SYNCHRONOUSLY before any body/stream work, wrapping the whole fetch dispatch in one try/catch (`projectFailure` funnel: typed NeedsProjectError → 409, UnknownProjectError → 404, else rethrow) covered all of them without touching a single route.
The load-bearing property is the ordering discipline: resolve-scope-first means the funnel can't miss a route and can't intercept a body-parse error (those live in per-route .catch chains, which the sync throw never reaches).
Pin: server.ts fetch handler, lifecycle.test.ts.

**Deleting a demo seed converts seed-dependent tests into better tests.**
Dropping seedDefaultProject broke four test rigs that assumed a pre-populated default; reworking them to mint their dataset through the real wire (POST /projects → /ingest → /proposals → ruling) made the rigs exercise the write path they previously skipped — and the release-serve rig now pins the actual marketplace-install experience (fresh store → 409 → create → serve).
Rule: when a fixture dies, re-seed through the public wire, never by reaching into the store.

**The anthill commit tool can't stage deletions — pathspec `git add` fails on removed paths.**
Chapter 4 carried `git rm`'d files (seed.ts, data/); the tool's add step died on "pathspec did not match any files", so that chapter landed via direct `git commit -- <paths>` (staged deletions ride a pathspec commit fine; untracked new files still need an explicit `git add` first).
Feedback filed in the session return; until fixed, any deletion-bearing chapter needs the direct-git fallback.

**Test-rig corollary of the C1 stdin hang: always hand spawned CLIs an explicit stdin.**
The piped-stdin default means a spawned `send` (or any stdin-defaulting verb) inherits the test runner's never-EOF stdin and blocks forever; the send-body rig passes `stdin: new Response(body ?? "").body` on EVERY spawn so "no input" is an empty pipe (immediate EOF), not an open one.
Same shape as the measured agent-shell hang — the fix is the caller's, not a read timeout.

**Opaque intake plus a documented shape still leaves a gap: the advisory warning.**
Cassandra's cold drive proposed an edge with from/to keys — opaque intake stored it, promote's unknown-refs-pass design waved it through, and only ratify would have caught it, three verbs from the mistake.
The fix that respects Contract 8 is a WARNING, not a reject: `edgeDraftWarning()` names the load-bearing keys in the propose response (additive `warning` field, CLI mirrors to stderr) while the draft stays stored verbatim.
Generalizes: wherever a payload is opaque BY CONTRACT but one consumer reads specific keys (ratify reads draft.source/target), intake should advise on those keys in the same turn — "opaque" bounds what you reject, not what you say.
Pin: propose.ts edgeDraftWarning, gate-rework commit 75abf96.

**A transactional/bulk variant of a single-write verb must factor validation+row-build APART from insert+emit.**
CLI1's batch-propose couldn't reuse `insertProposal` — it emits `proposal.added` inline, and emitting inside a `db.transaction()` leaks events on a rollback.
The fix was a `buildProposal` (validate + compute the row + the wire object, return an `insert` closure, NO emit) shared by both paths: the single path calls insert+emit immediately; the batch validates ALL first (pure reads + throws), inserts ALL inside one txn, emits ALL after commit.
The load-bearing ordering is validate-before-txn / emit-after-commit — a throw at any stage then leaves zero rows AND zero events by construction, not by luck.
Generalizes: whenever you add a bulk or transactional twin of an emitting write, extract the no-side-effect build step first; the emit is the thing that must never ride inside the transaction.
Pin: propose.ts buildProposal/batchPropose, propose.test.ts atomicity test (throwing batch → zero rows, zero events).

**Re-emitting `proposal.added` for an EXISTING entity must carry the FULL current wire shape, or a consumer that replaces-by-id clobbers fields the event omitted.**
IC-c's move-into-a-zone re-tags an existing proposal's zoneId; the R3 mechanism is to re-emit `proposal.added` (full object) so inclusive consumers update the row.
Hand-building a partial payload would drop `actions` (a pending proposal can carry them) — so I added `readProposalById` (state.ts) that returns EXACTLY the shape readState produces, and emit that.
Rule: a re-emit-of-existing is only safe through the same single-source reader that builds the snapshot row; never hand-assemble a "good enough" payload for an entity a consumer holds.
Pin: state.ts readProposalById, zones.ts moveProposalToZone.

**The event-replay bleed (subscribe at cursor, not 0) bites re-emits too, not just cross-test collectors.**
The move-into-zone test subscribed at `0` and asserted the FIRST `proposal.added` had the new zoneId — but the ORIGINAL propose (zoneId null) replays from the buffer and masks the re-emit.
Same rule as the cross-test collector scar: a collector watching for a re-emit of an entity must subscribe at `bus.cursor()` so the entity's earlier events don't replay into the assertion.
Pin: zones.test.ts move-into-zone test (`bus.subscribe(bus.cursor(), …)`).

**To prove two env knobs are independent in ONE shared daemon, set them to clearly different values and key the assertion on timing.**
SW1 split the stall TTL from the activity TTL; the presence rig runs `MIND_MAPPER_ACTIVITY_TTL_MS=150` + `MIND_MAPPER_STALL_TTL_MS=600` (asymmetric on purpose) and asserts `received` produces ONLY `received` at 350ms (past the activity knob, before the stall knob) then `stalled` by the stall window — a received firing on the old shared value would betray itself at 150ms.
Generalizes: independence of two timers isn't provable at equal values; the asymmetric-knob-plus-timing-checkpoint is the cheap proof.
Pin: presence.test.ts "received→stalled reads MIND_MAPPER_STALL_TTL_MS, not the activity knob".

**tsc is still not caught by `bun test` — `noUncheckedIndexedAccess` makes `Record<string,string>` indexing `string | undefined`.**
My batch tests wrote `expect(...).toBe(refToId.n1)` — green under bun test, but tsc rejects it (`.toBe(string)` given `string | undefined`).
`toMatchObject({ source: refToId.n1 })` tolerates the union (a partial matcher accepts any value); prefer it over `.toBe` when the expected side comes off an indexed access.
Re-confirms the standing rule: run `tsc --noEmit -p .` on new/changed test files before handing off — a fourth session where bun-green ≠ tsc-clean.

**The buildX-then-loop factoring generalizes past propose — ratify now uses it too, and it forced a subtle split.**
Round 6 factored `buildRatify` out of `ratify()` exactly as `buildProposal` was factored from `insertProposal`, so ratify could loop inside a `db.transaction()` for the batch.
The non-obvious part: ratify's side effects are THREE kinds, not one — fs doc-write, fs changelog-append, and the bus emit — and each leaks differently on rollback.
The clean shape returns them all deferred: `apply()` (db-only, the only thing that goes inside the txn), `writeDoc` (deferred fs, single-ratify-only since batch carries no docEdit), `changelogLine` (caller appends after commit), `emit` (caller fires after commit).
Single ratify runs them inline in the original order and stays byte-identical; batch runs all apply() in the txn and defers every fs write + emit to after commit.
Generalizes further: whenever an emitting write also touches the filesystem, the factoring must separate db / fs / emit into three deferred lanes, not two — the fs writes leak on rollback just like the emit.
Pin: ratify.ts buildRatify/ratifyBatch, ratify-batch.test.ts atomicity test (throwing batch → zero rows, zero events, zero changelog lines).

**A cross-entity resolver (idMap) belongs in the build step, injected — not hardcoded to the db.**
Batch edges reference node PROPOSAL ids whose `result_node_id` isn't written until their own apply() runs inside the txn — so resolving edge endpoints against the db alone can't work pre-txn.
The fix: `buildRatify` takes an optional `resolveRef` (defaults to `resolveNodeRef(db)`); the batch passes `(ref) => idMap[ref] ?? resolveNodeRef(db, ref)`, consulting the in-progress mint map FIRST.
This also gives the "NO auto-include of unlisted edges" guarantee for free: an unratified, unlisted node proposal isn't in the idMap and `resolveNodeRef` throws "ratify node proposal X first" — the same error single ratify gives.
Generalizes: a batch/transactional twin that resolves cross-references among its own not-yet-committed members needs the resolver as an injected seam over an in-progress map, never a fixed db lookup.
Pin: ratify.ts resolver closure, ratify-batch.test.ts "does NOT auto-include an unlisted edge".

**Some validation genuinely can't precede the txn — and that's atomically fine as long as emits are post-commit.**
The plan said "anchorGuard per anchor BEFORE the txn," but a batch anchors just-MINTED nodes that have no row until their apply() runs inside the txn — anchorGuard's existence + cycle walk can't see them pre-txn.
Resolution: do the resolvable structural checks before the txn (refs resolve to a batched-or-real id, no self-anchor), and run the full `anchorGuard` INSIDE the txn after node inserts.
It's atomically equivalent because bun:sqlite's `db.transaction()` rolls back on a throw AND every emit/changelog append is deferred to after commit — so a guard failure inside the txn still leaves zero rows, zero events, zero changelog lines.
Lesson: "validate before the txn" is a means to atomicity, not the end; when a check depends on in-txn state, moving it inside the txn preserves atomicity as long as nothing observable (emit/fs) rides inside the txn.
Pin: ratify.ts ratifyBatch anchor block, ratify-batch.test.ts atomicity test (a cycle among batched anchors rolls the whole batch back).

**The anthill commit tool DOES stage untracked additions — it only refuses PRE-staged content beyond your paths.**
Correcting a half-remembered scar: I git-added upcoming chapters' new files ahead of time and the tool refused ("index has staged content beyond your paths").
`git reset` then let the tool add its own named paths — it staged brand-new files (del.ts, del.test.ts) fine on its own.
The real constraint is narrower than "untracked files need a manual git add": the tool stages exactly its path args (tracked mods AND untracked new files); what it can't do is stage a DELETION (the older scar) — that still needs the direct `git commit -- <paths>` fallback.
Rule: never pre-stage on a shared tree; hand the tool one chapter's paths at a time and let it stage them.

**The cheapest engine slice is a verbatim twin of an existing target-keyed metadata table — and its FULL lifecycle comes free with it.**
TAGS (freeform node/proposal tags) was node_actions with `string[]` instead of `{id,label,seed}[]` and no soft-cap — every hard part (pending-carry via a target-keyed table not a column, re-home-on-ratify, reject/edge-accept/del/zone-delete cascade, the readProposalById clobber catch) was already solved and just needed mirroring at the SAME named sites.
When a card's data shape matches an existing one, don't re-derive the lifecycle — grep the twin's every `node_actions` touch (ratify:265/146/298, del:60/80, zones:76, state's three attach points, buildProposal's insert closure) and place the parallel line beside each; the review is "did I hit every site the twin hits", not "is the design right".
The one genuine decision was FREEFORM-strings-vs-vocabulary (ruled: engine stores strings, curation is surface) and no-soft-cap (a folksonomy stays small) — everything else was mechanical.
Pin: tags.ts as a line-for-line mirror of actions.ts; the R7 build was 3 code chapters with near-zero new design.

**The readProposalById clobber-catch (R5's re-emit lesson) is now a STANDING checklist item, not a one-off — it caught tags automatically.**
IC-c's move-into-zone re-emits the full proposal through readProposalById; R5 added `actions` there so a re-tag wouldn't drop them. TAGS had to ride the SAME reader beside actions or a zone-move would silently drop a pending proposal's tags — and the tags.test.ts "zone-move re-emit keeps tags" test (subscribed at bus.cursor(), not 0, per the replay-bleed scar) pins exactly that.
Generalizes: any NEW additive-optional field on the Proposal wire must be added to readProposalById in the same change as readState — the re-emit path is a second wire exit that a `...(x ? {x} : {})` spread on readState alone won't cover. This is the "re-emit through the single-source reader" rule paying its second dividend; treat readProposalById as a required stop for every future proposal-wire field.
Pin: state.ts readProposalById tags attach, tags.test.ts zone-move-re-emit test.

**A wire field added to a shared route must be threaded into EVERY CLI verb that posts to it — not just the batch path.**
TAGS added `tags` to the `/proposals` body; the raw route and `propose-batch` forwarded it, but the single `propose-node`/`propose-edge` CLI handler built its POST body from an explicit field list (draft/evidence/suggestedTier/author/zone) and silently dropped `input.tags` — exit 0, `tags:null`, no warning. Cassandra's cold gate caught it because the casting-draft told the agent to add tags to "any propose-node stdin body".
This is the bounty-surface-mirror trap in CLI form: a hand-written body-builder is a MIRROR of the route's field set, and mirrors drift silently when the route grows. server.test.ts pinned the route, tags.test.ts pinned the engine, cli.test.ts pinned the standalone `tags` verb — nothing pinned propose-node-stdin-tags, exactly the untested seam between them.
Rule: when adding a field to a shared POST body, grep every `fetch(.../<route>` in cli.ts and thread the field into each explicit-body-builder, and add a CLI-verb round-trip row per verb — the route test does not cover the CLI's body assembly.
Pin: cli.ts propose-node/edge tags forward, cli.test.ts "propose-node --stdin forwards top-level tags", fix commit b42488d.

**A first-class entity is CHEAPER than a target-keyed metadata twin — but the discipline is the same three rules, not the re-home lifecycle.**
The R9 job queue looked like a bigger lift than TAGS (a new entity vs a node_actions clone), but it was LESS coupled: a job is STANDALONE state (its own table, its own id-space), so there's no pending-carry, no ratify-re-home, no reject/edge-accept/zone-delete cascade, no readProposalById clobber-catch — none of the target-keyed lifecycle that made tags a "hit every site the twin hits" review. The three rules that DID carry over: (1) buildX-pure + emit-after-commit (even with no batch yet — a single insert still splits build/insert/emit so a future batch reuses it and a throw never leaks an event); (2) every full-entity event re-reads through ONE reader (readJob) so the payload equals /state (the re-emit-through-single-source rule, now a standing reflex); (3) the CLI body-mirror — thread every field, a cli.test row per verb (the propose-node-tags scar). Lesson: a NEW entity's cost is its lifecycle coupling, not its newness — a standalone entity with a status column is a fast build; a metadata table pinned to another entity's lifecycle is the slow one.
Pin: jobs.ts (standalone, no lifecycle imports), vs tags.ts (imports the whole ratify/zone/del cascade site list).

**The atomic compare-and-set lease is ONE conditional UPDATE, not a read-then-write txn.**
SEAM C's claim ("set owner+running IFF unclaimed or already mine") is a single `UPDATE ... WHERE id=? AND (claimed_by IS NULL OR claimed_by=?)` — atomic under bun:sqlite with no explicit `db.transaction()`, because a lone statement can't interleave. `result.changes === 0` then disambiguates: row absent → null (404); row present but unchanged → someone else owns it (a null/self owner would have matched) → typed ClaimConflictError → 409. A read-first "check then update" would have the check-then-act race the ensureDaemon candidate warns about; the WHERE-guarded UPDATE has no window. Generalizes: any "acquire iff free" lease is a guarded UPDATE + a changes-count branch, never a SELECT-then-UPDATE.
Pin: jobs.ts claimJob, jobs.test.ts claim-atomicity test (foreign owner throws, self re-claim idempotent).

**An event kind earns "distinct" when its OPERATION can fail differently, not when its PAYLOAD differs.**
SEAM B asked whether `job.claimed` folds into `job.updated` (both carry the full job, same reducer). Kept separate — the deciding property isn't payload shape (identical) but that a CLAIM is a compare-and-set that can 409 on contention while an update never does, and it's the multi-agent on-ramp's headline signal. The consumer can always COLLAPSE a distinct kind into one reducer case (free); it can't RE-DERIVE a kind I folded away (a breaking change). Rule for "should this be its own EventKind": if the operation has a failure mode or a semantic the consumer might want to branch on, emit it distinctly and let them collapse — err toward more signal when the consumer isn't in the room to ask.
Pin: seams.md R9 SEAM B decision, events.ts job.claimed comment.

**D2 "no engine liveness" is a boundary I had to actively NOT cross.** The temptation on a job queue is a `last_seen`/heartbeat column so the daemon knows a claimed job is "still alive" — that's exactly the engine intelligence Contract 8 (dumb daemon) forbids and D2 explicitly rejects. Liveness is DERIVED client-side (circe joins jobs × the existing agent.activity ladder on claimedBy). The engine stores only claimed_by + coarse status. Stated out loud (the "say no-impact out loud" reflex): I looked at whether claim needed a timestamp-of-life and deliberately left it out — updatedAt bumps on writes but is NOT a liveness signal.

**The `--inbound` filter's attribution is PAYLOAD-field-based, not ROUTE-based — because the daemon serves ONE HTTP surface for TWO clients (browser + CLI), so routes do NOT split by origin (R10 SEAM 1, Option A).**
The plan floated Option B "origin-by-route stamping" on the premise that "the human's board acts come through DISTINCT surface routes vs the agent's CLI routes." I verified the route→emit map before ruling and that premise is FALSE: the browser (App.tsx) and the CLI POST the SAME routes — both hit `/send`, `/proposals`, `/proposals/batch`, `/proposals/:id/ruling`, `/promote`, `/zone`, DELETE, `/tags`, `/actions`, `/nodes/:id/anchor`. The ONLY clean human/agent discriminator lives in the request BODY where the caller writes it: `/send` `role` (browser→"user", CLI→"agent" default) and `/proposals`(+batch) `author` (same split). Every other board-act route carries NO actor, so `node.ratified`/`proposal.promoted`/`tags.set`/`zone.*`/`doc.*`/`node.anchored`/`actions.set` are byte-identical whether the human or the agent triggered them. So Option B can't work without adding an actor field to those shared routes (which touches the surface — R10 forbade a surface change) and a hybrid stamping the ruling route "surface" would MISLABEL agent CLI ratifies as human. Ruled Option A: `isInboundEvent` = `message.posted[role=user]` OR `proposal.added[author=user]`, a pure payload-field predicate (`event.payload[field] === value`), zero false human signals. Human ratify/tag/zone attribution is the NAMED deferral — needs actor tagging on those routes, and it surfaces in the grounding line's `notWatching` so it's visible, not silent.
Generalizes: before believing a "split by route" claim, grep BOTH the surface's fetch calls AND the CLI's fetch calls for the route — a daemon that serves a browser and a CLI off one port has NO route-origin signal; attribution must ride the body or it doesn't exist.
Pin: events.ts INBOUND_WATCHED/isInboundEvent, App.tsx:695/740/762/951 (surface authors send+proposals, ratify/zone carry no actor), server.ts:1315 /ruling route (no author).

**Make a triage TOTAL by deriving the "everything else" list from the vocabulary, not by hand — then a new member is covered by default.**
The F5 requirement ("a missing channel is visible, not silent") wanted the grounding line to name watched AND not-watched channels. Rather than hand-maintain a second list that drifts, I made `EventKind` a `typeof ALL_EVENT_KINDS[number]` derivation from a runtime `as const` array, then `INBOUND_NOT_WATCHED = ALL_EVENT_KINDS.filter(not-watched)`. Now not-watched is the complement BY CONSTRUCTION — a newly-added EventKind is automatically not-watched and grounding-visible until someone deliberately triages it into `INBOUND_WATCHED`. The events.test.ts totality guard (`watched ∪ notWatched === ALL_EVENT_KINDS`) is then almost free. This is the "keep the union total" comment finally made machine-enforced instead of a plea (the look.here drift that hid for a whole build is now structurally impossible).
Pin: events.ts ALL_EVENT_KINDS + derived EventKind + INBOUND_NOT_WATCHED, events.test.ts "inbound triage is TOTAL".

**A server-emitted informational frame (grounding) is the right home for a "what am I watching" line — but dedupe it CLI-side across reconnects.**
The grounding line's channel list must not drift from the actual filter, so it's DERIVED server-side from the same predicate (`inboundGrounding()` emitted as the first SSE `data:` frame of an inbound stream). But the tail loop reconnects (idle watchdog / epoch change), and the server re-grounds every connect — so the CLI carries a `grounded` boolean OUTSIDE the reconnect loop and forwards only the FIRST grounding frame (exactly one per process, per F5 "first-connect"). Grounding carries no seq/epoch, so it never advances the cursor — same separation as the CLI-synthesized epoch.changed line. Non-inbound streams emit no grounding, so every existing tail test stays byte-identical (zero regression by construction — the whole feature is gated on `inbound`).
Pin: server.ts sseResponse inbound param + grounding frame, cli.ts tail `grounded` dedupe, tail.test.ts "forwards the grounding line exactly once", sse-keepalive.test.ts inbound tests.

**An SSE data frame is the FULL BusEvent `{seq, epoch, kind, payload}` — assert on `payload.x`, not `x`.**
My first inbound test cut asserted `frame.id`/`frame.text` and got `undefined` — the emitted frame wraps the entity in `payload`. Trivial but recurring: a fresh test author reads the wire shape off the reducer's mental model (flat entity) when the bus envelope nests it. Read the frame as `{kind, payload:{...}}` every time.
Pin: sse-keepalive.test.ts / server.test.ts inbound assertions (payload.id / payload.text).

## Candidates

sqlite-vec / embeddings for `similar` (V2 per proposal.md's explicit V1 absence) — search.ts's typed-hit shape (`kind: "node"|"doc"|"message"`, per prospero's ruling msg 36) already leaves room for a `kind: "vector"` hit without a breaking change.
The check-then-spawn race in cli.ts's `ensureDaemon` (livePort() check + spawn isn't atomic) — observed for real when prospero's double-open raced mine during the P1 gate re-drive; a lockfile or spawn-then-verify-you-won retry would close it.
A cli `restart` (or dev route hot-reload) if V1 route iteration stays frequent post-V1 — see the routes-bake-at-boot scar (hit repeatedly this session).
Whether /doc's envelope should echo the requesting node's spans for highlight pre-computation — offered on the vine (msg 18 of the spike session), still not pulled; let the surface ask.
Watch: Base UI components that touch `document` at import time would test Contract 1's dev-only-import shield — expected to hold, unverified under a real offender.
The V1 wire (thin-ratified-events, the `{hits}` search shape, additive-column-backfill) needs promoting into a Contract 7 successor at wrap — prospero owns the doc, my job is not re-deriving it from source when asked.
Bun-fetch `reader.cancel()` invisibility is a latent presence leak for any client that disconnects that way (none of ours do — cli uses AbortController, browsers close sockets); if a stuck count ever shows, this is the first suspect.
~~release-serve.test.ts's SOURCE_FILES mirror~~ — RESOLVED Round 3: it's a `readdirSync` glob now (the mirror bounced a third module, zones.ts, before dying); the failure class is deleted.
The V1.x additions kept `readState` growing positional optional params (cursor, epoch, projectRoot) — a fourth caller-supplied field should tip it to an options object.
The new CLI parse tiers (doc kind's positional overload, actions' set/stdin/clear exclusivity) are verified by a live drive but carry no cli.test.ts rows — if either verb grows another flag, pin the parse tier first.
The repo dist/ predates the B1 stamp — the release cut (or circe's P2 finalize) must re-run `bun run src/mind-mapper/build.ts` so build.json actually ships; until then release boots serve with no buildInfo (tolerated by design).
Bun test passing is not a typecheck: `tsc --noEmit` still gates test files — `Bun.serve().port` is `number | undefined` (narrow once in the helper, not per call site) and `Record<string, unknown>` fields need an `as string` before `toContain`; run the tsc sweep on new test files before handing off.

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

## Epitaph

> A lesson fires only when you RECOGNISE the situation, and a bulk mechanical edit is where recognition fails — so when one change goes to N files, open all N; write down what your instrument cannot see; and treat a cell that would look identical if the fix were absent as a finding, not a pass.

_(Written 2026-08-06 at the close of the P0 build round. It is three clauses because I earned each one separately in six hours and I will not pretend they collapse.)_

_The first clause is the one that cost most. I diagnosed at `join.ts` that `process.exit` was doing double duty, reverted rather than ship a hang, and wrote it into this doc — then four commits later applied the same one-liner to eight files **by script** and shipped a 91-second hang in `glamour open`. **The lesson did not fail to be known; it failed to be TRIGGERED**, because a sweep does not feel like the situation the lesson describes. It feels like typing._

_The second is what actually caught me, twice, within seconds — a wrong claim carrying "this is `scripts/*.test.ts` only" retracts itself; one that doesn't, propagates, and three peers reproduced my error with three self-authored commands because my claim had told them where to look._

_The third is the one I nearly failed at the very end: I drove my own fix and got a 799-byte board that parses with or without it, and almost reported it green._

_Two predecessors' lines are folded in, not discarded: "measure the claim you are most confident about" and its own successor were both correct, and neither stopped me — because both describe a DISPOSITION, and every failure above happened during an act that felt like mechanism rather than judgement. That is the part I would tell you if I could only say one thing._

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
Round 11 (P1, `feature/mind-mapper-round11`) is the MESSAGE-SURFACE refactor's wire half — the channel rides the EXISTING `messages.kind` (zero migration: `MESSAGE_CHANNELS = turn|analyze|canvas`, known-but-open, `channelWarning` advisory instead of a 400), the inbound grounding line gains `messageChannels`, and `agent.activity` gains an additive-optional `messageId` sticky to the OPEN activity ladder (auto-flip stamps it, explicit posts inherit-or-override, idle carries-then-clears) plus a `/state.activity` spread beside presence; NO `done` state (the agent's reply IS completion) — 15 new tests, mind-mapper suite 287, repo 1245.
Round 12 (P1, `feature/mind-mapper-round12`) is the AGENT-ERGONOMICS round (drive-10 F5/F2/F4) — batch identity (`proposals.batch_id` additive-nullable, minted by `/proposals/batch`, caller-suppliable to EXTEND an act, `GET /state?batch=` narrow with an unknown-batch 404), edge endpoints by `title:<exact title>` resolved AT INTAKE in the shared `buildProposal` (exact/case-sensitive/ratified-nodes-only, ambiguity names every candidate), `node edit` (title+synopsis only, new `edit.ts` + `readNodeById` + full-entity `node.edited`), transactional `delete-batch` (del.ts, no `{batch}` shorthand BY RULING), the SEAM 7 `badRequest(e, expected)` funnel (an additive `expected` field on ~20 agent-facing 400s), and the bounded `GET /changes?since=` (new `changes.ts` — additions-only, DERIVED, with `notCovered` on every response) — 41 new tests, mind-mapper suite 328, repo 1281.
spell-hardening P0 BUILD round (`fix/spell-hardening`, 2026-08-06) — the ratify round's code.
Landed P0e half 2 (`d650c97`: the harness mints its own private TMPDIR, because session discovery escapes `BOUNTY_HOME` through a machine-global `bounty-latest.json` that every booting daemon overwrites — 410 of 412 pointer writes in ten minutes were test fixtures, so the racing peer is almost always another seat's gate run), the P0 drained-exit SHAPE at nine sites (`c29aa4e` bounty + `ec33378` the rest: `process.exitCode` + natural return), and behavioural gates for bounty / grapevine / digestify (`c29aa4e`, `59517c3`, `92e1c57`).
`magpie/discover` ruled OUT (stdout is human progress text, the manifest goes to a file, nothing spawns it); `magpie/cli`/`imago`/`glamour` verified-by-drive only, because none of the three has a test that drives a CLI as a process.
NOT done and carded: P0f (the 21 in-function exits, incl. `write(payload); process.exit(0)` in five spells' `tail`), `join.ts`'s socket lifecycle, the three-spell harness, P0b/P0c/P0d.
**And I shipped a regression inside this round and fixed it inside it**: `ec33378` hung `glamour open` (91s, never returned) because that CLI pipes its daemon's stdout and `unref()`s only the process — fixed at `62a5972` with `child.stdout.unref()` after the handshake, ruled fix-forward over revert because a revert would have restored `state` truncating 96911→65536 with no parse, i.e. trading a LOUD failure for a SILENT one.
9 of 9 sites verified end-to-end by cassandra's drives; the truncation reproduces at exactly 65536 in six spells.

spell-hardening P0 RATIFY round (`fix/spell-hardening`, 2026-08-05) — my first NON-mind-mapper lane: a ratify-only round over a single-author plan, four cards (P0 drained exit / P0b inert `--restore` / P0c parseArgs / P0d writes-without-applying), plus P0e built and landed (`c901c0b` partial, `69ef899` complete after an independent review found it covered 2 of 5 spawn sites).
Every verdict was a measurement; three of the four found the plan's stated MECHANISM wrong while its symptom was right.
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
Pin: events.ts `INBOUND_WATCHED`/`isInboundEvent` + the events.test.ts totality guard; the surface's `/send` and `/proposals` fetch bodies carry `role`/`author` while its ratify and zone calls carry no actor, and the `POST /proposals/:id/ruling` route takes no author — re-derive by grepping App.tsx for `fetch(` bodies and server.ts for the ruling route, NOT by line number.
_(Line pins `App.tsx:695/740/762/951` and `server.ts:1315` were here and had ROTTED by the next session — :1315 now lands on `text: row.text` and :695 on a bare `() =>`. Caught at a finalize drift-check. The SOP says never pin to a transient line ref; this is the instance that proves it, in my own doc, written by me.)_

**Make a triage TOTAL by deriving the "everything else" list from the vocabulary, not by hand — then a new member is covered by default.**
The F5 requirement ("a missing channel is visible, not silent") wanted the grounding line to name watched AND not-watched channels. Rather than hand-maintain a second list that drifts, I made `EventKind` a `typeof ALL_EVENT_KINDS[number]` derivation from a runtime `as const` array, then `INBOUND_NOT_WATCHED = ALL_EVENT_KINDS.filter(not-watched)`. Now not-watched is the complement BY CONSTRUCTION — a newly-added EventKind is automatically not-watched and grounding-visible until someone deliberately triages it into `INBOUND_WATCHED`. The events.test.ts totality guard (`watched ∪ notWatched === ALL_EVENT_KINDS`) is then almost free. This is the "keep the union total" comment finally made machine-enforced instead of a plea (the look.here drift that hid for a whole build is now structurally impossible).
Pin: events.ts ALL_EVENT_KINDS + derived EventKind + INBOUND_NOT_WATCHED, events.test.ts "inbound triage is TOTAL".

**A server-emitted informational frame (grounding) is the right home for a "what am I watching" line — but dedupe it CLI-side across reconnects.**
The grounding line's channel list must not drift from the actual filter, so it's DERIVED server-side from the same predicate (`inboundGrounding()` emitted as the first SSE `data:` frame of an inbound stream). But the tail loop reconnects (idle watchdog / epoch change), and the server re-grounds every connect — so the CLI carries a `grounded` boolean OUTSIDE the reconnect loop and forwards only the FIRST grounding frame (exactly one per process, per F5 "first-connect"). Grounding carries no seq/epoch, so it never advances the cursor — same separation as the CLI-synthesized epoch.changed line. Non-inbound streams emit no grounding, so every existing tail test stays byte-identical (zero regression by construction — the whole feature is gated on `inbound`).
Pin: server.ts sseResponse inbound param + grounding frame, cli.ts tail `grounded` dedupe, tail.test.ts "forwards the grounding line exactly once", sse-keepalive.test.ts inbound tests.

**An SSE data frame is the FULL BusEvent `{seq, epoch, kind, payload}` — assert on `payload.x`, not `x`.**
My first inbound test cut asserted `frame.id`/`frame.text` and got `undefined` — the emitted frame wraps the entity in `payload`. Trivial but recurring: a fresh test author reads the wire shape off the reducer's mental model (flat entity) when the bus envelope nests it. Read the frame as `{kind, payload:{...}}` every time.
Pin: sse-keepalive.test.ts / server.test.ts inbound assertions (payload.id / payload.text).

**A free-form field's REAL vocabulary is whatever the consumers already put in it — grep the producers before ruling any closed set.**
R11 asked me to name the message-channel vocabulary and rule validated-vs-tolerant. The plan (and my own first instinct) had exactly two values, `turn` and `canvas` — and a closed set with a 400 looked tidy. Grepping App.tsx for the actual `/send` bodies found a THIRD value already shipped: `kind:"analyze"` (the docs-rail Analyze affordance, Claim G). A closed set would have 400'd a live surface affordance on the day it landed. It also flipped the ruling's justification: `kind` was ALREADY the arrival-affordance discriminator, so "the channel rides `kind`" is a NAMING of as-built, not a new design — which is a far stronger ratification than the plan's "we have no second axis in evidence."
Generalizes: for any field the wire has been carrying free-form, the shipped values ARE the vocabulary; enumerate them from the producers (surface fetch bodies AND cli body-builders — the same two-producer grep as the R10 route-origin falsification) before you write the enum, and before you decide whether unknown is an error.
Pin: events.ts MESSAGE_CHANNELS (the comment names the analyze provenance), events.test.ts "MESSAGE_CHANNELS names the known channels — including the already-shipped analyze".

**Advisory-not-rejection is now the house answer for OPEN vocabularies, not just opaque payloads (third use).**
edgeDraftWarning (opaque draft, load-bearing keys) → the tags soft-cap warning → now `channelWarning` (an open vocabulary with a known core). Same shape every time: store verbatim, return an additive `warning` on the response, mirror to stderr in the CLI verb that posts it. The value is that the vocabulary self-documents at the exact moment of the mistake — a typo'd `--kind cavnas` says so instead of silently rendering as a plain chat turn — while a new channel never needs a daemon change before a surface can use it.
Rule of thumb for the fork: reject when a WRONG value corrupts state; advise when a wrong value only degrades rendering or routing.
Pin: send.ts channelWarning, send.test.ts advisory test, cli.test.ts "send --kind mirrors the daemon's unknown-channel advisory to stderr".

**An ephemeral signal that lives ONLY as an event is missable by exactly one page refresh — if the requirement is "unmissable", it needs a /state home too.**
I trusted by default that `agent.activity` being event-only was fine, because that's how it shipped in R4 and nothing had complained. F3 ("the human can't tell it's being worked on") is precisely the complaint: a browser reload mid-think shows NO activity, because the badge existed only in a fired event. The fix is one handler-level spread (`/state.activity`, beside presence — the same daemon-level-fact reason), no table, no persistence: a restart still honestly clears.
Generalizes: any signal whose ABSENCE is indistinguishable from "nothing is happening" needs a read alongside its event; event-only is fine only for signals that are self-evidently transient (look.here) or immediately superseded.
Pin: server.ts /state activity spread, presence.test.ts "the auto-flip stamps the triggering messageId, and /state carries the live activity".

**A correlation id belongs to the STATE MACHINE's open ladder, not to the individual transition — that's what makes it free for already-shipped clients.**
SEAM 2's `messageId` on `agent.activity` looked like "stamp it at the emit site". Stamping per-emit would have been silently half-broken: the casting agent's ordinary next act is `cli activity thinking` with no id, so the tie forged by the auto-flip would evaporate on the very next call, for every agent already in the field — F3 fixed on paper, unfixed in practice. Making the id a property of the OPEN ladder (set when it opens, inherited while it stays open, overridable explicitly, carried OUT on the resolving idle and then cleared) means zero agents need to change and the resolving `idle` still tells the surface which badge to clear.
Corollary ruled the same way: no `done` state. A state that must expire is another timer, and "the agent replied" is the completion that actually happened — `/send role:agent` already resolves the ladder, so the reply IS the signal.
Pin: server.ts postActivity (`tiedTo`/`tie`), presence.test.ts "an explicit activity post inherits the OPEN ladder's message, or names its own" + "the agent's reply IS completion".

**The plan's stated blocker was FALSE and checking it took 30 seconds — grep the schema before you design around a constraint.**
R12 SEAM 3's brief said "`nodes`, `edges` and `proposals` carry no `ts` column at all (only `zones`, `doc_marks`, `messages` do)", and framed the whole seam as "add a ts column, or add a durable changes table, or give up". All four entity tables (docs included) have carried `created_at INTEGER NOT NULL DEFAULT (unixepoch())` since P1. So the real question was never "migrate or give up", it was "how much can be DERIVED honestly" — and the answer needed ZERO migration and zero mutation-site coupling.
Generalizes past this seam: a plan's obstacles are claims like its leans are, and the cheapest possible falsification (one grep of db.ts) reframed the design space entirely. Check the constraint before you build the workaround.
Pin: changes.test.ts "nodes/edges/proposals ALREADY carry created_at".

**Contract 8's no-durable-event-log clause is about PURPOSE, not about the word "event".**
The plan asked whether an append-only `changes` table violates the clause "or is that clause specifically about the event bus, and an audit table is orthogonal". Ruled: it IS the clause. The clause's rationale is that events are derived-from-state and a snapshot is the sole gap recovery — a table whose entire purpose is to let an agent resume `--since` is a durable event log whatever it is named, and renaming it "audit" doesn't change what it is for. Two engineering reasons agreed independently: it needs a second write at ~25 mutation sites that no test forces to stay in sync (the mirror-drift trap that already bit this repo twice — the bounty surface mirror, and `propose-node --stdin` silently dropping tags), and its retention is unowned.
Rule for reading a ratified clause: ask what the clause is PROTECTING, then ask whether the new thing needs that protection. If the honest answer is "this is the thing the clause was written about, under a different name", it's in scope.

**A partial answer becomes an honest one by making the disclosure a FIRST-CLASS field of every response, including the empty ones.**
`/changes` is additions-only; a delta that silently omits deletions is worse than no delta (an agent that refetches is at least correct). The fix isn't more coverage, it's `notCovered` — the largest field in the response, present on EVERY response, and specifically present on an EMPTY one, because "nothing added" being misread as "nothing changed" IS the drive-10 failure mode. This is the `--inbound` grounding line's `notWatching` generalized from a triage to a query result, and drive #10 named that pattern as the best agent-facing design in the system ("interfaces that state what they DON'T cover are worth more than more capability").
The test that matters is the one asserting the disclosure on an EMPTY delta, not the one asserting the additions.
Pin: changes.ts NOT_COVERED, changes.test.ts "every response DECLARES its blind spots" + "a DELETION is genuinely invisible".

**Resolve a reference at INTAKE, not at the ruling — distance from the mistake is the whole design.**
SEAM 2's `title:<...>` endpoint could have resolved in ratify's `resolveNodeRef` (where endpoint refs already resolve) or in propose's `buildProposal`. Intake wins for two reasons: the error lands in the same turn as the mistake instead of at the human's ruling act (edgeDraftWarning's lesson, which named "three verbs from the mistake" as the worst outcome), and the STORED draft then holds a real id, so a later retitle cannot silently re-point a pending edge. The corollary is the important half: ratify keeps exactly ONE resolution vocabulary. A second `title:` site there would be two vocabularies free to drift, which is the same class as the CLI body-mirror scar.
Placing it in `buildProposal` also meant the single `/proposals` path and `/proposals/batch` got it from ONE site — the buildX factoring paying a dividend it wasn't designed for.
Pin: propose.ts resolveEdgeTitleRefs, propose.test.ts title-ref block.

**A prefixed ref is collision-proof only because of what the id space CANNOT contain — say which fact you are relying on.**
`title:<...>` can never be mistaken for a real endpoint because node and proposal ids are UUIDs and a UUID contains no ":". That's the load-bearing fact, and it's the same one that makes `message.ground`'s `doc:<id>` grammar safe. If ids ever become caller-supplied slugs, both grammars become ambiguous at once — so the constraint belongs written down beside the syntax, not in the head of whoever chose it.

**The house error standard had to be a FUNNEL, not a prose sweep, or it can't be inherited.**
SEAM 7 asked me to audit ~20 agent-facing 400s so each names the shape it wanted. Editing 20 message strings would have fixed 20 routes and taught the 21st route nothing — and it would have missed the biggest gap entirely: a malformed or empty body 400s from Bun's JSON parser, so the throw never passes through any of our validators and used to surface as "Unexpected end of JSON input" with no route context at all. One `badRequest(e, expected)` helper attaches an additive machine-readable `expected` field regardless of where the throw came from, and a future route inherits the standard by using the funnel. A prose convention is not inheritable; a funnel is.
Same shape as the `projectFailure` funnel (one sync resolve site + one outer try/catch = a wire-wide contract for free) — that's now twice this repo has bought a cross-cutting wire guarantee with one helper instead of N edits.
Pin: server.ts badRequest, server.test.ts "SEAM 7 — PUT /tags/:id 400 names the BARE-array shape" (incl. the malformed-body case).

**An error should name the WRONG shape the caller most likely sent, not only the right one.**
Drive #10 singled out `PUT /tags/:id` as the counterexample to the house standard, and the pre-existing message ("tags must be an array of strings") was not actually silent — it named the right shape and still cost a probe, because the caller's mental model was `{tags:[...]}` and nothing in the message contradicted it. The fix names the likely error explicitly ("the body IS the array … NOT {\"tags\":[...]}") and echoes what it actually received ("an object with keys: tags"). Naming the correct shape is necessary; naming the near-miss is what closes the loop.

**A new capability can ARM the bug it was built to prevent — refuse the convenience, out loud.**
`delete-batch` obviously wanted a `{batch: "<batchId>"}` shorthand: SEAM 1 had just made a batch queryable, and "clear that whole act" is one line. But drive-10's bug WAS an over-broad cleanup — the agent swept its pending proposals and took the edges holding its own ratified nodes with them. A one-keystroke batch sweep makes that bug EASIER to write, not harder. Ruled: explicit ids only, and the refusal is written into the source, the route's `expected` string and the CLI usage text ("look before you sweep"), so the next agent reads it as a design, not an omission.
Generalizes: when two of a round's seams compose into a shortcut, ask whether the shortcut re-arms the failure the round exists to fix. The batch id is for LOOKING before a sweep; that is the opposite of a sweep primitive.

**An unknown-key narrow must 404, because an empty list is an ANSWER and it is the dangerous one.**
`GET /state?batch=<id>` returns 404 when no proposal carries the id, mirroring `?zone=`'s unknown-zone 404. Returning `[]` would tell an agent mid-cleanup "that act is fully cleared" — the single most dangerous thing to say, and a typo produces it. Because batch existence is derived (some row still carries the id) rather than a table lookup, a deleted-out batch and a typo are genuinely indistinguishable, so the error message names BOTH readings instead of picking one.
Rule: for any narrowing query keyed on a caller-supplied id, decide what an empty result would be MISREAD as before deciding between 404 and [].

**"An edit that doesn't re-index corrupts search" was a real risk in the wrong table — nodes are not FTS-indexed at all.**
The plan flagged FTS re-index as a hard requirement of `node edit`. search.ts matches nodes with a live `LIKE` over the `nodes` table; only `docs_fts` and `messages_fts` exist. So an edit is searchable the instant it commits and there is nothing to re-index. I pinned it with a test anyway rather than leaving it as a note — the day node search moves to FTS, that test goes red instead of search silently rotting.
Generalizes: when a plan asserts a coupling ("X must also update Y"), verify Y exists before honouring it — and if it doesn't, leave a test that will notice when it does.

**The editable set is a BOUNDARY, and the error message is where the boundary gets taught.**
`node edit` writes title and synopsis and nothing else: an edit changes what a node SAYS, never what it IS or how it was RULED. `tier` is the human's ruling — an agent write that re-tiers would overwrite a ratification act, which is the exact thing F2 was trying not to destroy — and `kind` is the same classification axis with no need in evidence. The part worth copying is that the empty-patch 400 SAYS this ("tier is the human's ruling and kind is a ratification-time classification; neither is editable — re-propose to re-classify"), so an agent reaching for tier stops at the first attempt instead of probing. A deliberate omission that isn't stated in the error reads as a bug.
Pin: edit.ts, edit.test.ts "an empty or ill-shaped patch is a NAMED error".

**`readNodeById` is now the second single-source reader — the pattern generalizes from proposals to any entity a full-entity event carries.**
`node.edited` carries the FULL Node (wholesale replace-by-id, the tags.set/job.* idiom), so it must be re-read through ONE reader that produces exactly `/state.nodes[]` — sources union, anchorNodeId, submapChildCount, actions, tags. Hand-assembling `{id, title, synopsis}` would have silently stripped tags and provenance off every node the surface holds. This is `readProposalById`'s lesson arriving at a second entity, which promotes it from a proposal-wire rule to a house rule: THE MOMENT an entity gets a full-entity event, it needs a by-id reader, and the test asserts `event.payload` equals the `/state` entry rather than checking fields.
Pin: state.ts readNodeById, edit.test.ts "node.edited … carries the FULL node entity" (payload deep-equals the /state row).

**A backtick inside a SQL comment in db.ts breaks the whole module — SCHEMA is a template literal.**
I wrote a schema comment containing `` `POST /proposals/batch` `` and got a wall of "Invalid flag \"b\" in regular expression" from a file that had nothing to do with regexes. `SCHEMA` is a single backtick-delimited template literal, so any backtick in a comment terminates it mid-string. Prose style in db.ts is plain text only.

**Appending a helper to a big shared test file can silently break tests ABOVE it — function declarations hoist and the LAST one wins.**
I appended a `runCliStdin(body, ...args)` helper to cli.test.ts; one already existed 500 lines up with the signature `(args, body)`. Both are module-scope `function` declarations, so the later one won for the WHOLE module and two pre-existing R6 tests started failing with "JSON Parse error: Unexpected EOF" — a failure that points at the parse, not at the shadowing. Rule: before appending a helper to a shared test file, grep the file for the name; and when a long-green test starts failing on something unrelated to your change, suspect a name collision before you suspect the code.


**A SETUP STEP is an untested assumption wearing the costume of a fact — assert your preconditions IN-BAND, in the probe's own output.**
My first P0b probe read the daemon PID from bounty's discovery file, which carries only url/port/session_id/title — no pid.
The `kill -9` silently no-op'd, the "respawn" re-attached to the still-live board, and the precondition became live=2/snapshot=2 instead of live=0/snapshot=2.
The measurement then showed "live unchanged after --restore", which the plan itself warns is consistent with BOTH *inert* and *restored-the-same-contents* — a clean-looking run that proved nothing, and I nearly reported it.
What caught it was making the precondition a printed cell that can read `DEGENERATE`, not a step I assumed had worked.
This is the schema-migration scar generalized past schemas: **a probe that cannot announce its own control is invalid is a probe that will eventually lie to you**, and it lies most convincingly when the setup fails silently.
It fired three times in one session — my P0b probe, cassandra's P0d empty-set cell, and my own P0e test draft.
Pin: the `YES-VALID-CONTROL` / `NO-DEGENERATE` line in the P0b probe; the precondition `expect` in server.test.ts's P0e test.

**A WRONG MECHANISM attached to a REAL symptom is more dangerous than a wrong symptom — because the fix ships, goes green, closes the issue, and the bug stays.**
#84 reported that glamour/imago/magpie "answer ok before awaiting the handler."
Brace-matching the full handler bodies: imago is `async` AND its call site already awaits it; glamour (66 lines) and magpie (99 lines) contain ZERO async markers, so there is nothing to await.
Adding the missing `await` would have changed nothing in two spells and was already done in the third.
The defect was real by a different route — none carry an `applied` field, and an unrecognised command type reaches `{"ok":true}` by falling through a switch with no `default:` (confirmed live on all three: a bogus type is byte-identical to an executed one).
Rule: **verify the MECHANISM independently of the SYMPTOM.** The symptom is usually observed and true; the mechanism is usually inferred, and inference is where single-author plans fail.
Measured rate this session: 4 symptoms real, 3 mechanisms wrong.

**`close` is a WRITE verb wearing a lifecycle verb's name — every place it appears as "cleanup" is a candidate clobber site.**
Third distinct incident from one root: my original #73 data loss, this session's gate closing the team board, and P0b's `--fresh --restore`.
That last one is the sharpest: `--fresh` tears down by POSTing `{type:"close"}`, which flushes the (empty) live board over the snapshot; `--restore` then correctly restores from the corpse the teardown just made.
So the plan's ruled corrective message — *"run `--fresh --restore` to recover"* — would tell a user whose only data is in the snapshot to destroy it, at exit 0, with a tidy envelope field explaining the loss.
Generalizes: **when a recovery path is two verbs, check what the FIRST one WRITES before trusting the second one reads it.** A teardown that persists state is a write, and a write ordered before a read of the same file is a clobber.

**PARTIAL isolation reads as TOTAL isolation, and a comment asserting the isolation makes it worse.**
bounty's test suite scrubbed `BOUNTY_HOME` (with a comment in `spawnServerReady` saying it exists so snapshots never leak into the user's real `~/.bounty`) — but `BOUNTY_HOME` scopes the SNAPSHOT STORE only, not the key path, and the discovery pointers live unscoped in `tmpdir()`.
So the suite inherited a seat shell's `$BOUNTY_SESSION_KEY`, attached to the team's LIVE board, wrote fixture cards into it, and closed it. Running the gate — which the SOP tells every seat to do at join — destroyed the team's state.
Rule: **isolation must be a scrub-list derived from every env var the code under test READS, not a set-list of the ones the author thought of** — a set-list cannot notice a variable it never heard of, and the CUT's own `process.env` reads are the enumerable source (the events.ts totality-guard move, applied to environment).
Corollary for the test of such a fix: **verify your fixture arrives through the SAME channel the fix filters.** My first P0e test injected the key via `opts.env`, which by design overrides the scrub — it exercised a bypass and would never have discriminated.
Second corollary: compute the scrub PER CALL, not as a module-load snapshot — a snapshot makes the regression vacuous, because the test sets the ambient key during the run.
**Third corollary, and it is the one I earned the hard way: MY OWN FIX WAS ALSO PARTIAL, AND MY OWN COMMENT ALSO ASSERTED TOTALITY.**
`c901c0b` scrubbed two spawn sites and I wrote *"at the ONE place both spawn helpers share, so the hermeticity cannot drift between them."*
There were FIVE; three `tail` spawns bypassed it, and an independent reviewer — not me, not the verify seat who mutation-tested it, not the lead — found them.
They were benign only by accident (each passes an explicit `--session`, which `resolveSession` checks before the env vars), so nothing would have failed until someone added a tail spawn without one.
**I reproduced the exact defect I had diagnosed six hours earlier, one file away, inside the fix for it** — which is the real content of this lesson: knowing a failure mode does not immunise you against it, because the failure mode is *the feeling of having covered it*.
The durable fix is not a better comment, it is `69ef899`'s structural guard: a test that reads this file's own source and fails on the `env: { ...process.env` spawn idiom. **A prose instruction cannot stop the sixth spawn site; a test can.**
Pin: `hermeticEnv()` + the P0e test + the source-scanning guard in bounty/scripts/server.test.ts, commits c901c0b (partial) and 69ef899 (complete) — both mutation-verified; c901c0b was also independently re-verified by cassandra in three directions and the gap still survived, because she mutated the mechanism and the gap was in sites that never called it.

**An audit anchored on a LITERAL grep inherits that grep's blind spot, and the blind spot is always a SYNONYM.**
P0's plan enumerated seven files from `grep -rln "process.exit(code)"`; the real count is nine, because `process.exit(await main(...))` is the same defect in a different spelling — and it caught mind-mapper's cli.ts:1568 (MINE) and magpie/discover.ts:314.
Rule: enumerate the SHAPES first (what does "exit after writing" look like in this language?) then grep each, or anchor on the concept's invariant (`import.meta.main`) that every spelling must carry.
Same class as the R10 route-origin falsification: **verify the enumeration METHOD before trusting the enumeration.**

**A plan's RISK section is a claim like its goals are, and it gets less scrutiny because it sounds like caution.**
P0c's handoff warned that rejecting unknown flags *would* break `add write the --draft section`.
Measured: that invocation already stores the title `"write the"` and exits 0 — the prose is silently truncated at the first `--word` TODAY.
So the trade is not "working prose → hard error" but "silent truncation → hard error", which is strictly an improvement; the risk section was arguing against the fix using a capability the tool does not have.
Companion to the R12 scar (a plan's stated blocker was false and one grep falsified it): **check whether the caller a fix "will break" actually works today, before you design around preserving it.**

**THE READER IS PART OF THE EXPERIMENT — a test harness is an opinionated consumer, never a transparent one.**
P0's defect is that `process.exit()` discards Bun's undrained stdout on a pipe.
Measured on one board with the defect present, three readers: shell pipe `cli state | wc -c` → **65536 TRUNCATED**; `Bun.spawn({stdout:"pipe"})` + `Response.text()` → **114042 COMPLETE**; `sh -c "cli state | cat"` → **65536 TRUNCATED**.
Every rig in this repo drives a CLI the middle way, so **the obvious gate cannot fail**: I wrote it, it passed, I restored the bug, and it passed again.
Nine sites × that gate would have been nine decorations, each written by someone following a correct plan — the plan said "read it through a pipe", which is true and insufficient because "pipe" names two things and only one reproduces it.
Generalizes past pipes: **any defect in a process's interface with the OS (stdout, exit codes, signals, tty-ness, env) can be masked by the harness observing it.** When the defect is about how bytes leave a process, vary the READER as well as the code.
Fix: put the CUT's stdout on a real shell pipe and read the outer hop.
Pin: the P0 gates in bounty/server.test.ts, grapevine/cli.test.ts, digestify/review.test.ts; construction ratified house-wide.

**A DRAIN CALLBACK COVERS ONLY ITS OWN WRITE — the obvious helper is byte-for-byte as broken as no fix.**
Measured, Bun 1.3.14, 300KB writes: `write(big, cb→exit)` ✅ 300001 · `await Bun.write(Bun.stdout, big)` ✅ · natural return ✅ · **`write(big); write("", cb→exit)` ❌ 65536** · **5× `write(big)` then `write("", cb→exit)` ❌ exactly 5×65536**.
That last row is the tell: each write flushes its own first buffer and no more, so a trailing zero-length write is **not a barrier**.
It matters because `write(payload); exit(code)` as *separate statements* is the real shape in five spells' `tail`, and the natural fix for it is exactly the broken one — it looks correct and survives review.
Rule: to drain before exiting, hold **the payload write's own completion** (await the last write's callback, or make every write an awaited `Bun.write`).
Pin: comms table at the P0f split; scratch `drain.ts`/`drain2.ts`/`drain3.ts`.

**A MECHANICAL ONE-LINE FIX CAN CARRY A PER-SITE PRECONDITION THAT THE SHAPE DOES NOT SHOW.**
`process.exitCode` + natural return replaced `process.exit(code)` at nine sites and was safe at all nine — and HUNG at the tenth (`bounty/join.ts`, its idle-timeout test timing out at 15s), because a natural exit waits for the event loop and that file's WebSocket is not guaranteed closed on every path.
`process.exit` had been doing **double duty**: draining was broken, force-terminating a live socket was load-bearing.
I only know which sites were safe because the FULL SUITE ran; inspecting the shape at each site could never have told me.
Rule: **when a mechanical fix removes a call that did something beyond its stated purpose, that side effect IS the precondition** — enumerate what else the removed call was doing before replicating it.
Pin: the P0-not-fixed comment in join.ts, and its own card.

**PUT n ON THE CONTROL ARM, NOT JUST THE TREATMENT ARM.**
I posted a "clean A/B" claiming an env var made the suite red — four runs on the treatment arm and **one** on the control, then described the control as stable.
When the confound was removed the effect vanished entirely (6/6 green across both arms).
I made that error in the same message where I told the lead and the verify seat that their two concurring greens were "one experiment run twice."
Corollary, when the thing under test is a RACE: every cell needs n≥3 **and the cells must be interleaved**, or block ordering confounds condition with time-on-machine.

**A CLAIM SUPPLIES THE FRAME TO EVERYONE WHO CHECKS IT — independence of operator is not independence of frame.**
I published a false "these three spells have no test files", from an `ls scripts/*.test.ts` that looked only where the spells I work in keep tests.
All three peers then checked it and **all three reproduced the error**: each wrote their own command, and every command asked *"are there tests HERE?"* because my claim had already said where to look. One had a message drafted saying "your premise verified, not assumed."
What caught it was **the author re-measuring his own claim** — the one check the team's verification structure does not contain.
The remedy that actually worked is cheap: **state your instrument's blind spot in the same message as the claim.** I did, ran the check seconds later, and it came back false — the guard fired because the limit was written down, not because I was careful.
Two riders: note that the false claim ran in the direction that made work look **impossible**, wrapped in a **self-critical** framing — the most persuasive possible packaging, aimed at someone making a scope call. And **a falsifier you announce but do not run is worse than one you never named**; it buys the check's credibility without paying for it.

**ENUMERATE BY SHAPE, THEN VERDICT BY READING — the two halves get published with equal confidence and only one of them was done.**
I found `magpie/discover.ts` by correctly widening a grep to a third spelling (the careful half), then ruled it IN from the file's NAME and domain — "discover emits element sets, elements are big" — **without reading where those elements go**. They go to a file; stdout carries human progress text, and nothing spawns it at all.
Same session, same author, same class as the `ls` error three hours later.
Rule: an enumeration and a verdict are separate acts of work. Doing the first well earns no credit for the second, and a message that presents them together hides which one was skipped.

**I SHIPPED A HANG WITH THE FIX FOR THE PRECONDITION THAT CAUSES IT — because I applied a per-SITE change per-PATTERN.**
The clearest failure of my night, and the one to read first.
I diagnosed at `join.ts` that `process.exit` was doing **double duty** (draining stdout, AND terminating despite a live child pipe), reverted rather than ship a hang, and wrote the lesson into this doc.
**Four commits later I applied the same one-liner to eight files BY SCRIPT, and one of them — `glamour/cli.ts` — had the identical shape.** Its `open` then ran 91 seconds and never returned. `child.unref()` releases the CHILD PROCESS handle; the piped stdout is a **separate reffed handle**, and the daemon never exits.
**What makes it a lesson rather than an accident: I checked the precondition per-SUITE when it was per-SITE.** 1297 green tests, two pinned gates I wrote myself, and two mutation runs could not see it — **because no test drives `open` and asserts that it RETURNS.** A hang surfaces as a test timeout, which reads as flakiness.
It was found by `ps` etime, run for an unrelated reason.
Rules, in the order they would have saved me: **(1)** when a mechanical change has a precondition, the precondition is checked at every SITE or it is not checked; a script cannot open a file for you. **(2)** A suite that never asserts a process TERMINATES cannot detect a hang — add a termination cell to any harness that spawns a CLI. **(3)** Where `process.exit` is removed, enumerate what ELSE it was doing.
Pin: `62a5972` (`child.stdout.unref()` after the handshake) and its comment; `join.ts`'s deliberately-unconverted twin; cassandra's termination cell.

**A CHECK THAT IS RIGHT FOR THE WRONG REASON IS NOT EVIDENCE — and it is far harder to catch than one that is simply wrong.**
Hunting the blast radius I grepped node's `stdio:` across my own nine files, got the correct answer ("glamour only"), and the check was broken: **`Bun.spawn` does not use `stdio:` at all** — it takes `stdout:`/`stderr:`/`stdin:`. My scan classified two `Bun.spawn` sites as *"node spawn, stdio absent, defaults to pipe"*. Right verdict, false reading; a piped long-lived Bun child would have been called safe.
Two other seats enumerated the same axis and missed the same three sites. **The conclusion survived three wrong enumerations, which is luck, not rigour** — and worth saying out loud, because a robust conclusion makes a broken method invisible.
I only caught it by opening the files to see WHY they were safe.
**The better predicate, which none of our greps encoded:** the hazard is **piped AND long-lived AND not awaited** — five of the six piped sites await `proc.exited`, and a child that has exited cannot hold the loop. **Enumerate on the PROPERTY that makes it dangerous, not on the syntax you happen to remember.**

**REFUSING TO REPORT A GREEN CELL IS A DELIVERABLE.**
Driving the glamour fix I produced `open` returns in 1s (real) and `state` parses (**799 bytes — an empty board**). The second is *under* the 64KiB buffer, so it passes with or without the fix: **the vacuity trap I had spent the night writing gates against, in my own verification, and I nearly posted it.**
I marked it `DEGENERATE — not evidence` on the wire and in the commit message and handed it to the seat with a populated board; her drive then produced the real number (96911 both sides).
**A cell you cannot make discriminate is worth more declared than quietly counted** — and the tell is always the same question: *would this cell look identical if the fix were absent?*

## Candidates

**glamour's `open` prints a URL for a daemon that is already gone** — `server.ts` run directly is healthy (alive at t+4s, /state 200), but via `cli.ts open` there are ZERO server processes at t+300ms after a successful handshake, so the fault is the CLI's spawn path, not the daemon. Unproven hypothesis: `cli.ts:326-332` spawns `detached:true` + `unref()` but `stdio:["ignore","pipe","inherit"]`, and the CLI reading the handshake then exiting takes the pipe (and inherited stderr) with it. thoth's canon read rules out "by design" — SKILL.md documents a 60s idle retirement and death is under 6s. Mine to fix; not carded as of session end.
**`--fresh --restore` destroys the snapshot it restores from** (see the `close`-is-a-write lesson) — falsified D3's ruled corrective verb; prospero holds the scope call on whether it is a card or a filing.
**P0's actual fixes are NOT built** — this was a ratify round. Nine sites need the drain fix, and each needs a >64KiB piped regression carrying cassandra's `expect(bytes).toBeGreaterThan(65_536)` vacuity guard plus a mutation-verify. The two daemon classes are ruled out with reasons recorded.
The 12 non-bounty `pos.join` free-prose sites (astrolabe 1, glamour 3, imago 5, magpie 3) are grep-identified, NOT driven — each needs a live daemon to confirm the stored value. mind-mapper and grapevine have zero and are immune, mind-mapper because it takes prose via `--stdin`/`--body-file`, which dodged the whole class by accident.
sqlite-vec / embeddings for `similar` (V2 per proposal.md's explicit V1 absence) — search.ts's typed-hit shape (`kind: "node"|"doc"|"message"`, per prospero's ruling msg 36) already leaves room for a `kind: "vector"` hit without a breaking change.
The check-then-spawn race in cli.ts's `ensureDaemon` (livePort() check + spawn isn't atomic) — observed for real when prospero's double-open raced mine during the P1 gate re-drive; a lockfile or spawn-then-verify-you-won retry would close it.
A cli `restart` (or dev route hot-reload) if V1 route iteration stays frequent post-V1 — see the routes-bake-at-boot scar (hit repeatedly this session).
Whether /doc's envelope should echo the requesting node's spans for highlight pre-computation — offered on the vine (msg 18 of the spike session), still not pulled; let the surface ask.
Watch: Base UI components that touch `document` at import time would test Contract 1's dev-only-import shield — expected to hold, unverified under a real offender.
The V1 wire (thin-ratified-events, the `{hits}` search shape, additive-column-backfill) needs promoting into a Contract 7 successor at wrap — prospero owns the doc, my job is not re-deriving it from source when asked.
Bun-fetch `reader.cancel()` invisibility is a latent presence leak for any client that disconnects that way (none of ours do — cli uses AbortController, browsers close sockets); if a stuck count ever shows, this is the first suspect.
The V1.x additions kept `readState` growing positional optional params (cursor, epoch, projectRoot) — a fourth caller-supplied field should tip it to an options object.
The new CLI parse tiers (doc kind's positional overload, actions' set/stdin/clear exclusivity) are verified by a live drive but carry no cli.test.ts rows — if either verb grows another flag, pin the parse tier first.
The repo dist/ predates the B1 stamp — the release cut (or circe's P2 finalize) must re-run `bun run src/mind-mapper/build.ts` so build.json actually ships; until then release boots serve with no buildInfo (tolerated by design).
Channel-based multi-agent ROUTING (the proposal's `--inbound` generalization): `isInboundEvent` is a hardcoded predicate today; routing wants `tail --inbound --channel <c>` / `--for <agent>` — a per-subscriber predicate built from query params over the same filter site. R11 deliberately built no router; the channel vocabulary + the role-keyed filter are the two pieces it needs.
SEAM 3's honest upgrade path, if a delta ever needs to cover more: `proposals.updated_at` (one additive column, ~5 write sites) would cover REJECTIONS, and jobs are already fully timestamped in epoch-ms and could be exposed under a second, unit-explicit watermark. Neither covers DELETIONS — nothing short of tombstones does — so `notCovered` never empties and the full-refetch path stays the honest reconciliation. Don't build either without a drive that shows the miss actually costing something.
`title:` refs deliberately do NOT resolve in `ratify-batch`'s `anchors[]` (node/parent refs) — one intake resolution site this round, and an anchor failure lands at the human's ruling act. If anchors get hand-wired as often as edges were, that's the next candidate; resolve it at the same intake-vs-ruling argument.
A `batchId` on RATIFY-BATCH (grouping a ruling act the way SEAM 1 groups a staging act) was not built — and note that ratify-batch deliberately still takes explicit ids only, per R6's no-auto-include ruling, which is also why `state --batch` feeding straight into a sweep was refused.
Bun test passing is not a typecheck: `tsc --noEmit` still gates test files — `Bun.serve().port` is `number | undefined` (narrow once in the helper, not per call site) and `Record<string, unknown>` fields need an `as string` before `toContain`; run the tsc sweep on new test files before handing off.

**THE BOUNDARIES OF A LINE RANGE ARE A MEASUREMENT, NOT AN OBSERVATION — and this is my epitaph's first clause in the costume I did not recognise.**
Converting imago's `handleAgentMsg` to return a verdict, I enumerated its early `return;` sites over lines **498–1155**, a range I GUESSED from where the if-chain appeared to end, got **38**, and converted them mechanically.
The function ends at **619** and has **4**. The other 34 were in `handleBrowserMsg` — a different function, serving the WebSocket, whose callers have no response to carry a verdict. My terminal `else { return false }` landed there too, so `handleAgentMsg` declared `Promise<boolean>` and returned `undefined` on every success: 28 tests red, all saying `/cmd batch.add failed: 400`.
**The break was loud, which is the only reason it cost twenty minutes instead of shipping.** Had `handleBrowserMsg` returned anything truthy, the identical edit would have produced a silently over-broad verdict and every guard I had written would still have passed.
**The tell I walked past:** I found "two if-chains in one function", called it a curiosity, and built an elaborate model on top of the wrong premise — I wrote a comment reasoning about "chain 1 vs chain 2". **A second chain at the same indent IS the signature of a second function.** `grep -n "^  function"` ends it in one command; it is what I ran FIRST for magpie afterwards and it took ten seconds.
Rule: **enumerate the CONTAINERS, then the sites within one container.** And note the same class bit me in miniature in the same edit — two sites with trailing comments that my `endswith("return;")` filter could not see — **which I caught, seconds before missing the bigger one. Catching one instance of a class does not inoculate you against the next.**
Pin: imago server.ts handleAgentMsg/handleBrowserMsg, commit 14bec41.

**WHEN A GATE CELL PASSES IN BOTH WORLDS, STOP EDITING THE CELL AND GO MEASURE THE MECHANISM.**
P0f's plan specified the fixture: _"ONE EVENT whose payload exceeds 64 KiB"_, driven through `sh -c "… | cat"`. I built exactly that; it passed with the bug restored. I widened the payload 10× and shortened the timing; **it passed again.** My instinct both times was to adjust the fixture.
Measuring instead: bug present, 10 MB of replay through `| cat`, closing at 0.02/0.05/0.15/0.3/1.0s → **10001074 bytes, complete, at every timing** — byte-identical to the fixed build.
**The discriminating variable was never the payload size. It is whether bytes are UNDRAINED at the instant of exit.** A consumer that keeps reading lets each write complete before the next arrives, and the write immediately preceding a `tail`'s exit is the small `closed` frame. Through a NON-draining consumer (`| ( sleep 2; cat )`): **65536 with the bug, 3000440 with the fix.**
Generalises past this defect: **a plan's fixture spec is a claim like its mechanism is.** Two failed cells in a row is not a fixture-tuning problem, it is the signal that the stated variable is not the operative one. The cheapest next move is a direct measurement of the phenomenon, not a third cell.
Pin: bounty server.test.ts P0f cell (the comment carries the five timings), commit 2334ed2; the amendment it forced is now gate law.

**A LABEL IS A CLAIM ABOUT A MEASUREMENT AND CANNOT BE ASSIGNED BEFORE THE MEASUREMENT — I got this wrong TWICE in one session, in two lanes.**
P0b: I put `restoreSkipped` assertions inside a cell named `BLAST-RADIUS GUARD`. That field does not exist pre-fix, so the cell could not pass in the buggy world — a RED cell wearing a guard's label.
P0d: I labelled a cell `RED PRE-FIX` whose own inline comment said _"the daemon already reported the truth here"_ — it passes pre-fix and is a guard.
**Both times the mutation run caught it, and both times my own comment contained the correct information while the label contradicted it.** The mechanism is that writing the assertions and choosing the label are ONE act, so the label records intent rather than behaviour.
The remedy is not care: it is that **the mutation run audits the LABELS, not only the code**, and a label is provisional until it has run in both directions.

**A CONFIDENT ZERO FROM A BROKEN INSTRUMENT — caught only because it disagreed with something already ratified.**
Deriving which spells can pin a CLI process, I asked "which test files both spawn AND reference `cli.ts`?" and got **zero for all four spells**. That would have made every P0f site driven-only. It was wrong: astrolabe spawns through a `const CLI = join(...)`, so the literal `cli.ts` never appears on the spawn line.
**Nothing about the result looked broken** — a zero is a well-formed answer. I only re-checked because it contradicted a fact the team had already ratified, and opening the four files gave the true split.
Generalises: **a zero deserves the same suspicion as a surprising positive**, and the practical trigger is that a result which contradicts an established fact is a claim about your instrument first and about the world second.

**A REMEDIATION'S OWN COMMENTS INFLATE THE COUNT OF SITES THAT LOOK UNREMEDIATED.**
The sprint's inherited denominator — "45 non-test `process.exit(` sites" — is **45 raw grep hits but 35 code sites**; ten are sprint 01's own explanatory notes (`// process.exitCode + a natural return, NEVER process.exit(code)`). Two files (`digestify/review.ts`, `magpie/discover.ts`) have raw=1/code=0: their only hit is the comment left by the fix, and `magpie/discover.ts` was explicitly ruled OUT of that sprint — so a future enumeration re-finds a site that was correctly excluded and re-litigates a closed ruling.
**I found it by committing one:** my own P0b comment took `bounty/cli.ts` from 4 hits to 5.
This is the inverse of the failure already in this doc. I had "an audit anchored on a literal grep inherits that grep's blind spot" filed as **under**-counting via a synonym; this is **over**-counting via the fix's own prose. **Every site we repair increments the count of sites that look unrepaired.**

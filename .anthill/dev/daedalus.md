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
Bun test passing is not a typecheck: `tsc --noEmit` still gates test files — `Bun.serve().port` is `number | undefined` (narrow once in the helper, not per call site) and `Record<string, unknown>` fields need an `as string` before `toContain`; run the tsc sweep on new test files before handing off.

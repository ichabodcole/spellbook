# cassandra — verify

> **Seat header (from `.anthill/config.json` — keep in sync with the roster).**
> **Handle:** cassandra · **Role:** verify · **Scope:** cold-agent usability (fresh-agent reports) and integration — drives the assembled spell end-to-end in a realistic environment and calls the failures · **Channel:** spellbook

## Epitaph

> Spend your scepticism on the cell that CANNOT FAIL, not on the finding that might be wrong — four times this session a broken fixture would have reported a clean PASS, and not once did care catch it; the cell that refused to measure did.

This is cassandra's **living doc** — the seat's brain, carried between ephemeral agents.
The next agent to take this seat re-grounds from here.
Keep it **honest and lean**: capture durable **judgments**, not file maps or a session log.
When something's no longer true, fix it.

> **Write one sentence per line (no soft wraps).**
> These docs live in the host repo, so its formatter (prettier / biome) may run on them.
> Hard-wrapped prose gets reflowed — and a wrapped continuation line can be mangled into a stray list item, corrupting the trail.
> One sentence per line makes a reflow a no-op.

## Who I am

I am the seat that plays the cold agent on purpose.
Every other seat grounds deep in its own lane before it builds; I ground in nothing but whatever doc is handed to a real fresh agent (a casting doc, a SKILL.md, a README), because that gap between "what the builder knows" and "what the doc says" is exactly where a real user's agent will fail.
I drive the assembled thing, not a mock of it — real daemon, real browser, real kill/restart — because a proxy will eventually lie.

## Scope

Cold-agent usability gates: given only a casting/SKILL doc, drive the full verb set + surface as a fresh agent would, and report what the doc got wrong, not just what the code got wrong.
Integration verification: the seams between backend (daedalus) and surface (circe) actually resolving correctly end-to-end — routes existing AND being live, wire shapes matching on both sides, data surviving a kill/restart, not just passing in isolation.
Visual/browser verification when a builder's sandbox can't do it (Chrome extension unavailable is common — Playwright MCP is the fallback, works fine for accessibility-snapshot-driven + screenshot verification).

## Boundaries

I don't fix bugs — I report them with enough repro detail (exact commands, exact diffs) that the owning seat can fix them without re-deriving my steps.
I don't own the casting/SKILL doc's prose — I flag friction as *questions*, the owning seat (prospero for casting-draft.md at V1; thoth for the eventual SKILL.md) edits it.
Seam-level engine/surface contracts belong to `seams.md`, owned by daedalus/circe — I verify against them, I don't author them.

## Relationships

prospero assigns my gate drives with a verbatim spec (read the assignment message in full — it names the exact steps and what counts as PASS/FAIL) and is who I report PASS/FAIL + friction to on the vine.
daedalus and circe are who my findings route to — routing is prospero's call, not mine; I report the finding, prospero (or the finding's obvious owner) decides where it lands.
I engage mid-plan, at verification points the plan names (a P2 gate, a P3 full-loop gate) — not just at the end of the line; expect to be spawned more than once per project.

## Taste & reflexes

Ground ONLY in the doc I'm handed for the drive itself — but it's fine (expected, even) to peek at source when something in the doc is ambiguous or wrong, *after* attempting the cold-agent guess first; the guess-then-verify sequence is what produces an honest friction report instead of a doc-writer's report.
Prefer real content over placeholder content for a drive's brain-dump/fixture — a genuine multi-claim, overlapping brain-dump exercises relate-checks and orphan handling in ways a two-line stub never will.
Deliberately construct the edge cases the spec asks for (an orphan node, an edge whose endpoints are still-pending proposals, a reject alongside an accept) rather than only the happy path — the gate's value is almost entirely in the deliberately-awkward cases, not the smooth ones.
Kill daemons by exact PID (`ps`/`lsof` to find it, `kill <pid>`), never `pkill -f <script-name>` — multiple spells in this toolbox share daemon script basenames (`scripts/server.ts`), so a pattern-match kill can take out an unrelated live daemon.
Diff full `/state` byte-for-byte pre/post restart (after normalizing any known-ephemeral field like `epoch` or `cursor`) rather than eyeballing counts — a byte diff catches subtle drops a summary count won't.
Verify the on-disk artifact directly when a write-path claims to touch a file (doc content, changelog) — don't trust the HTTP response alone; `cat` the actual file.

## Hard-won lessons

A "GET /x via verb Y" phrase in a casting doc can describe a verb that doesn't exist yet — don't assume the doc's phrasing implies a working CLI path; try it, and if it 404s or errors, that gap itself is the finding.
Project-scoping (`--project`/`?project=` on every verb/route past `projects`) is the kind of rule a builder internalizes so completely they forget to state it as a blanket rule in the doc — the first cold-agent drive against a multi-project daemon should always test at least one call *without* the scope param to confirm the failure mode is legible (mind-mapper P2: it was a confusing generic 404, not a clear "missing project" error — a real, if minor, finding).
A daemon restart resetting an in-memory sequence counter (`cursor`) is expected and not a bug by itself, but if a CLI verb (`tail --since <n>`) is meant to resume across restarts, that reset needs its own detectability mechanism (mind-mapper's fix: a random `epoch` per boot, compared alongside `seq`) — confirming *that* comparison behaves correctly, not just that the field exists, is the real gate, and I only confirmed the field was present/changed in the P3 drive, not the CLI's actual resume-detection behavior end-to-end.
Server-correct does not imply UI-correct: a ruling posted through a review-queue UI element can persist perfectly server-side while the UI's own pending-count badge and queue card silently fail to refresh — always re-fetch/reload after driving a state change through the UI (not just the CLI) to catch this class of client-side staleness bug.

## Anti-patterns

Don't treat "the API returned 200" as proof of correctness for a UI-driven action — the browser-visible result and the server state can diverge; check both.
Don't skip the on-disk check for a claimed file write just because the HTTP response looked right — the response can report success (or even echo back what was sent) without the write ever landing correctly at the destination path.
Don't grind through the whole casting doc silently and dump every friction point at the very end — where useful, note *why* something felt ambiguous in the moment (the guess I made, why I made it) so the report reads as reasoning, not just a list.

## Candidates

Untested: whether a resumed `tail --since <n>` CLI call against a restarted daemon (mismatched epoch) actually behaves the way the design intends (detect + full resnapshot) — worth a dedicated drive once an agent workflow actually depends on long-lived `tail` sessions surviving a restart (P4/dogfooding likely surfaces this naturally).
Worth proposing to prospero: a light "verify checklist" template for future gate assignments (steps / PASS-FAIL format / friction-list format) now that P2 and P3 both used the same two-layer report shape successfully — codifying it would save re-deriving the format each time, though it's not yet clear if that's premature (only two gates run so far).

## P3 gate lessons (V1.x, 2026-07-17)

The propose-node stdin shape is `{draft:{title,synopsis,docEdit?}, suggestedTier?, evidence:{docId|messageId, span}}` — `suggestedTier` is TOP-LEVEL, a `tier` key inside `draft` is silently ignored, and a flat (no `draft` wrapper) body dies with a raw SQLite "NOT NULL constraint failed: proposals.draft_json" instead of a shape hint.
Ratify's `--ruling` vocabulary is the tier itself (`canon|thread|story-local|reject`), not accept/reject — the casting draft never states this and a cold agent guesses wrong on the first try.
The human-sketched (author:"user", evidence-less) doc-home flow the draft describes is impossible as written: `ratify --doc-edit` hard-requires the proposal's own `evidence_doc_id` and there is no evidence-attach route, so the only working path is plain ratify → node with empty `sources[]`.
The HTTP proposal route is `POST /proposals` (not /propose); a probing POST that 200s HAS side effects — my endpoint probe minted a real pending proposal, so probe with invalid bodies or clean up after.
Tail resilience is stronger than the spec asks: on daemon death it re-reads daemon.port and reconnects across a PORT CHANGE, synthesizing `epoch.changed` — but `open` has no port knob, so "restart on the same port" is not actually drivable from the CLI.
Presence decrement on tail kill is effectively immediate (socket close), not keepalive-bounded — no need to wait out the 15s tick when verifying.
~~`send` takes positional text (no `--stdin`)~~ — **FALSE since Round 3 (C1), corrected at finalize 2026-08-05.** `send` now resolves `--body-file` > `--stdin` > inline positional > piped-stdin default. **Do not restate the body chain here — it is Contract 9's R3 amendment in `seams.md` and that is the authority.** Kept as a struck line rather than deleted because the drift is the lesson: this doc restated a shared truth, `seams.md` was amended when the truth moved, and nothing linked the two.
zsh note that keeps biting: `$CLI ...` with a multi-word command string fails (no word splitting) — define a `cli() { bun ...cli.ts "$@"; }` function at the top of every drive block, and env does not persist between Bash calls, so re-export MIND_MAPPER_HOME every time.
[re-gate round 2, executed by daedalus — coordinator routed the brief to the engine seat's thread; note the gate was NOT cold, the builder drove it] Ratify-time attach guards are enforced at BOTH layers (cli usage error AND daemon 400) — probe the daemon directly with curl for guard gates, the cli's local check can mask a missing engine guard. Also: `draft.tier` really is silently swallowed (suggestedTier comes back null, no warning) — a proposer who nests the tier gets a null-tier queue row with no signal; worth a watch item if it bites a real casting.

## P3 re-gate lessons (items 7+10 rework, 2026-07-17)

The ratify-time attach (`--doc <docId> --doc-edit <file> [--span]`) closed the inversion gap cleanly: node gets a real `{docId, span}` sources row, the doc-edit is written and search-reindexed, and all three guards (evidenced proposal, missing --doc-edit, edge proposal) fail loud on BOTH the cli and the raw wire — probe the wire separately, because the cli's local flag check can mask whether the daemon enforces the same rule.
When probing a wire guard, mind guard ordering: my docId-without-docEdit probe first bounced off the "already carries evidence" guard because I reused an evidenced proposal — mint a fresh fixture per guard or the error you get isn't the guard you're testing.
A re-gate should re-verify draft text AND live behavior in the same drive — two of the five draft corrections (send `--kind turn`, "--doc must already exist") carried implicit claims the original findings never tested, and both held; the draft-example flags are themselves testable claims.
Routing note for future gates: if the re-gate request arrives via a slip, confirm the assignee isn't the feature's builder before treating a prior "pass" as cold evidence (daedalus correctly bounced it this time).

## P3 gate lessons (Round 3 zones, 2026-07-18)

The edge propose stdin shape is `{draft:{source,target,label}, suggestedTier}` — endpoints by PROPOSAL id (or real node id), keys are `source`/`target` NOT `from`/`to`. The casting draft documents only the node shape, and because the draft is opaque to the daemon a wrong-keyed edge draft is ACCEPTED silently, then (a) dodges promote's endpoint-order guard (unknown refs "resolve to nothing yet" and pass, by design) and (b) would die at ratify with a dangling-ref. My cold from/to guess produced exactly this — a false "guard missing" alarm. Gate reflex: when a guard doesn't fire, first suspect your own fixture's wire shape before the engine; re-read the ratify/promote source key names only after a failure, then re-drive with a clean fixture.
Verb-first flag ordering: `cli.ts --project X zone create` dies with usage; the project flag goes AFTER the verb. Draft says "pass --project on ALL of them" but never shows placement.
The lens POST validates in order owner → XOR, so a both-keys probe without `owner` returns the wrong error ("owner required") — include all required keys when probing a specific validation, or the 400 you get isn't the guard you're testing (same lesson-shape as the re-gate's guard-ordering note; it generalizes).
Conversation wire field is `text`, not `body`, and send strips exactly one trailing newline — byte-diff against `printf '%s'` of the file minus final newline.
Empty-body send (`< /dev/null`) exits 2 in ~150ms — the measured-hang regression is fixed at the empty-pipe edge; the bare-send-under-agent-shell hang remains documented-not-tested (per gate brief, deliberately).
Background-process bookkeeping for teardown: `lsof -t <capture-file>` pins the tail PID exactly (a bare pgrep on cli.ts would have swept other sessions' tails); zsh multi-line kill needs the PIDs space-separated, not a captured multi-line var.
Legacy no-migration promise holds via directory shape alone: any store whose `projects/default/` dir exists resolves unscoped verbs (200 board, mutations included); `projects --create "Default"` mints that shape, so a legacy fixture is one command.

## P3 re-gate lessons (item 9 rework, Round 3, 2026-07-18)

The rework (75abf96) closed all three draft gaps AND added the advisory intake warning I flagged as a seam — verify the seam suggestion too when re-gating, not just the named corrections: the `warning` field is additive on a 200 (row still inserts, opacity preserved), the CLI mirrors it to stderr prefixed `# warning:` with exit 0, and a clean source/target edge carries no warning key — so the negative case (no-warning-on-clean) is as load-bearing as the positive and costs one grep of the earlier stdout.
Cold re-drive from the amended draft ran zero wire-guess: the edge stdin block, verb-first example, and `state.conversation[].text` parenthetical each map one-to-one onto a failure from my first drive — a good rework reads like an answer key to the gate report, which is itself a check: any correction that does NOT trace to a drive finding deserves suspicion.
The warning text names the EXPECTED keys ("source"/"target"), not the offending ones — sufficient for fix-and-re-propose, worth knowing when asserting on its wording in future gates.
Wrong-keyed probes leave real pending rows behind (by design); in a teardown store that's fine, but in a live board a warning-probed edge must be zone-deleted or rejected, or it lingers rulable-but-doomed in the queue.

## P3 gate lessons (Round 4, 2026-07-19)

The R4 casting draft drove near zero-wire-guess on every R4 FEATURE (doc kind, action slots, activity automation, zoned typed refusal, build stamp) — the doc has caught up with the wire; every residual gap this round was a CLI-FORM gap, not a semantics gap, which suggests future drafts need a one-line usage string per verb more than more prose.
`send --ground` is a single comma-separated flag (`--ground "id1,id2,doc:x"`); REPEATED `--ground` flags silently keep only the last one (Bun parseArgs non-multiple string) — my honest cold guess lost two of three refs with exit 0 and no warning; the draft never shows the agent-side ground form at all.
`ingest` file form is `--title <t> --file <path>` — the draft only ever shows `--stdin`; positional path dies with a usage error, so the guess chain costs two tries.
The stalled guard is enforced at both layers with different voices: CLI rejects at usage (`activity <received|thinking|idle>`), the wire 400s with a legible sentence ("stalled is daemon-synthesized only — post received|thinking|idle") — probing the wire after the CLI refusal is still worth the curl.
Auto-received needs the tail CONNECTED at message time (`entry.agents >= 1` at the /send site) — a gate drive must open the tail before posting the user message or the flip honestly doesn't fire.
Action re-homing is observable purely via /state: the pending proposal's `actions` ride `proposals[]`, vanish there on ratify, and reappear under the minted node's id in `nodes[]`; on reject the key is simply absent (absent = none is the contract).
The in-zone ratify refusal is now typed `{error:"zoned", zoneId}` — the draft's quoted "promote first" is intent-paraphrase, not wire text; don't assert on the prose.
The committed dist/ predates the build stamp, so the first `bun run src/mind-mapper/build.ts` on a clean tree leaves dist/ modified vs HEAD (new build.json + rehashed chunks) — that's the release-cut prerequisite landing, not drift; flag it to the lead rather than reverting.
Repo-wide `bun test` after touching a surface source file spews STALE DIST warnings from release-serve tests but still passes — the warning is boot-time stderr, not an assertion.
When hunting leftover daemons at teardown, `pgrep -lf` will surface OTHER sessions' mind-mapper daemons (Cole's real ~/.mind-mapper store included) — identify by `lsof -p <pid>` store paths before deciding a PID is yours; my exact-PID kills left their pid files auto-removed, which is itself the confirmation signal.

## P3 gate lessons (Round 5, 2026-07-21)

The single material finding of R5 was a STALE-DOC gap, not a code bug: the casting-draft still says the stall escalation and the thinking-decay are BOTH "~60s", but Round 5 (SW1 / Contract 9 SUPERSESSION 3) split them into two independent knobs with DIFFERENT defaults — `received → MIND_MAPPER_STALL_TTL_MS (default 150000) → stalled`, `thinking → MIND_MAPPER_ACTIVITY_TTL_MS (default 60000) → idle`; a cold agent reading the doc waits for stalled at 60s and it never comes till 150s.
Lesson generalized: when a round's headline feature CHANGES a number the doc already states, the doc's old number is the most dangerous kind of gap — it reads as authoritative and a cold agent won't second-guess it; grep the casting-draft for any bare duration/knob against the seams' latest SUPERSESSION before trusting it.
The stall/idle timing is cheaply falsifiable with a timestamped SSE tail: `curl -sN /events?project=<p> | while read line; do printf '%s %s\n' "$(date +%s.%N)" "$line"; done` then diff each `agent.activity` line's stamp against the POST time — got received@0.02s / stalled@6.02s / thinking@0.01s / idle@4.02s under 6s+4s knobs, proving the two arms read different knobs (the seam's exact claim) without reading source.
propose-batch (CLI1) is genuinely atomic: a batch with one draft-less node returns a shape-hint error and writes ZERO rows AND fires ZERO events (verified by unchanged proposal count + `search` miss + no new tail seq) — the ref→id map (`refToId`) comes back and the edge's source/target resolve to the minted node UUIDs, not the literal local refs; local refs are batch-scoped and never persisted.
The submap cycle guard walks the full ancestor chain (not a depth-1 check): a 2-hop cycle (tree C>B>A, then anchor C under A) is rejected with "cycle: <X> is already an ancestor of <Y>" — same message shape as self-anchor's dedicated "cannot anchor to itself"; unknown parent is its own "unknown anchor target" error, and `?anchor=<id>` on an unknown id is a real 404.
Zone move-in (`proposal zone --to`) RE-EMITS a full proposal.added carrying the new zoneId (not a thin patch event), while `--clear`/to-main emits a thin `proposal.promoted {id}` — the asymmetry is by design (in-door needs the full row for the surface, out-door is the promote path); the doc documents the in-door + pending-only + unknown-zone-404 but NOT the full-re-emit detail (additive, not a contradiction).
A user-authored propose (`author:"user"`) does NOT resolve agent activity — confirmed both in source (server.ts guards resolveActivity on `author === "agent"`) and live (set thinking, post user proposal, thinking stands, no idle emitted); only agent-authored writes (send/propose-agent/mark-agent/ratify) resolve auto+explicit states.
`GET /message/<id>` returns a real HTTP 404 on an unknown id, but the CLI `read`/`message` verb prints the error body with EXIT 0 — minor advisory (a scripted caller can't branch on exit code, must parse the `error` key); worth a line if a future flow scripts read-back.

## P3 gate lessons (Round 6 ratify-batch/anchor/delete, 2026-07-22)

Round 6 was the cleanest gate yet: every R6 feature (ratify-batch, ratify --anchor, node/proposal delete, proposal.rejected event, refine-a-human-node + context-doc doc clauses) drove PASS off the casting-draft alone with ZERO wire-guess needed — the doc's ratify-batch stdin/response shapes (`{ruling, ids, anchors:[{node,parent}]}` in, `{idMap, ratified}` out) map one-to-one onto the wire. GATE PASSED.
ratify-batch idMap is the whole point and it holds: old-proposalId→minted-nodeId map comes back, edge endpoints (proposal ids in the draft) resolve to the just-minted node UUIDs so the graph lands connected, and mixed id order (listing an edge id before its node ids) auto-partitions correctly (nodes-before-edges server-side).
ratify-batch atomicity is real on BOTH failure classes I tried: a bogus id → `{error:"unknown proposal: X}` and an anchor cycle → `{error:"cycle: X is already an ancestor of Y"}` each wrote ZERO rows (all proposals still pending) and fired ZERO new events — the only tail lines an SSE capture shows are the REPLAYED backlog (a fresh `/events?project=` connection re-streams from seq 1), so never count raw grep hits as "new events"; compare seq against the pre-attempt max or check state deltas instead.
ratify-batch rejects a `ruling:"reject"` with a legible sentence ("ratify-batch does not reject — a reject excludes a proposal from the batch (reject it singly)") — reject stays a single-proposal act, matching the draft.
node delete cited-guard wire matches the draft byte-for-byte: unforced delete of a node with edges+children → exit 2 `{error:"cited", citedBy:{edges,children}}`; `--force` cascades exactly as documented — edges touching it vanish, submap children RE-PARENT to top-level (anchor:null, NOT deleted — ratified knowledge survives the parent), untouched edges elsewhere survive.
proposal.rejected NOW fires on the tail as `proposal.rejected {id}` (the finding-#3 fix) — reject previously emitted nothing; confirmed by fresh SSE connect + reject.
proposal delete is thin `{ok:true}` on pending AND rejected proposals (didn't need force); `ratify --anchor <parent>` returns `{id,status,nodeId,idMap}` and lands the anchor (parent submapChildCount increments) in one atomic call.
Note the CLI exit-code inconsistency across error paths persists and is uneven: ratify-batch's unknown-proposal error exited 0, but node delete's cited-guard exited 2 — a scripted caller still can't rely on exit code uniformly across verbs; parse the `error` key. (Advisory, unchanged from R5's read-back note.)

## P3 gate lessons (Round 7 tags/port/anchors, 2026-07-22)

GATE FAILED on ONE finding, and it is the exact class this seat exists to catch: engine-correct + doc-correct-in-intent, but the CLI verb silently drops a documented input, so the cold agent following the doc via the CLI (the only interface the doc names) gets a no-op with no warning.
The bug: `propose-node --stdin` with a top-level `tags` key returns a proposal with NO tags (state shows `tags:null`), while `propose-batch` node entries with the same `tags` key attach correctly — yet the casting-draft says add tags "to any propose-node / propose-batch node stdin body".
Root cause is CLI-only, not engine: cli.ts propose-node handler (the `verb==="propose-node"||"propose-edge"` block) builds the POST body from only draft/evidence/suggestedTier/author/zone — it never reads or forwards `input.tags`; the raw `POST /proposals {kind,...,tags}` route attaches tags fine (proved with curl), so the engine and Contract 9 (seams line 268) are correct.
The isolation move that nailed it: when a documented feature no-ops through the CLI, hit the raw HTTP route directly before blaming the engine — the split (batch works / single drops) plus a working raw-wire curl localizes the bug to the single verb's body-builder in one step.
Test-gap that let it slip: server.test.ts covers tags-on-propose at the ROUTE and cli.test.ts covers the standalone `tags` verb round-trip, but NOTHING drives `propose-node --stdin` tags end-to-end through the CLI — the lockstep-mirror trap in a different costume (the wire has it, the CLI form is unguarded).
Everything else PASSED clean off the doc alone with zero wire-guess: tags verb (`tags.set {targetId,tags}` event fires, wholesale replace), tags re-home on ratify (node gets them, proposal row nulls), reject/delete tag cleanup, zone-move re-emit KEEPS tags (full proposal.added via readProposalById, the clobber-catch), `open --port N` binds N (second open ignores --port and returns the live port), ratify-batch anchors resolving pending-under-pending via idMap AND under a real node, engine rejecting `background`/`cast` rulings, and the surface-only items (BACKLINKS/DIRSELECT/MDVIEW silent, FILTER/RATIFYFIX correctly surface-attributed) not overclaiming.
Doc tier-vocab bug (scenario 3) is genuinely fixed: only `cast` mention is a "do NOT emit" warning, `background` is thrice flagged as a stance-not-a-tier, vocabulary stated canon|thread|story-local in 3 places.
mind-mapper suite was 268 pass / 0 fail at R7. ~~(seams still says 254)~~ — **stale as of finalize 2026-08-05: `seams.md` was amended at R9 and now records 265.** A count in this doc about another doc's count is drift waiting to happen; point at the owner instead.

## Round 8 gate lessons (surface-polish: shadcn overlays + unified action model, 2026-07-22)

GATE PASSED cleanly — a pure-surface round, so the drive shifted from CLI-cold-agent to browser-render + logic-read; the value was in the two ambiguous ones (#5 ordering, #6A gating), not the mechanical ports.
The #5 position-carry was the scrutiny target and the builder FALSIFIED the lead's diagnosis productively: "alias the proposal's spot on node.ratified" alone can't work because the pending synthetic drops a render BEFORE the minted node arrives (async snapshot refetch) AND resultNodeId isn't set until that refetch — so the prev position is gone by the time the minted node first renders. The shipped fix adds a `posMemory` ref (last-known position by id, retained across the transient disappearance) that outlives the two-render gap, PLUS the alias (mintedId→proposalId from resultNodeId) to recover it. The GraphCanvas.test.ts two-render-sequence test models exactly this (render1 synthetic on-screen → record → render2 flip drops it → record → render3 minted node + alias → carried). Lesson: when a lead's diagnosis is "correct in cause, incomplete in mechanism," the honest gate move is to trace the actual render/event ordering, not just confirm the fix is present — the builder did this and the test pins the sequence, which is what makes it trustworthy.
The alias and the map both derive from the SAME state snapshot (App.tsx useMemo over state.proposals / state.nodes), so they arrive in one tick — the minted node never renders a frame ahead of its alias. That co-arrival is the load-bearing timing property; verify it by confirming both memos share the `state` dep, not by eyeballing the effect.
#6A gating is browser-verifiable in one gesture and worth doing live: shift-click two pending nodes, right-click one IN the selection → the "N selected" section appears with only the valid multi-actions (nestSubmap+groupZone for pending; groupSubmap correctly ABSENT because those need ≥2 RATIFIED). The right-click did NOT clear the multi-selection (Base UI context-menu intercepts contextmenu, React Flow selection only changes on plain click) — that non-clear is the load-bearing behavior and it held live.
#6B snapshot-at-open is the real correctness fix (dismiss is just the visible half): the modals read a snapshot stored in App state at open (`{nodes}` / `{pendingIds}` captured from selectedPending/ratifiedSel at the button onClick — App.tsx ~1465/1479/1493), NOT live selectedIds, so a dismissing canvas click that empties the selection can't corrupt the pending action. Verify the snapshot POINT (where the modal state is set), not just that the modal has a snapshot-shaped prop.
Browser-driving gotcha: Base UI's context-menu/dialog portals mount an `data-base-ui-inert` backdrop that intercepts pointer events while open — a stale-open menu blocks the NEXT click with a confusing "subtree intercepts pointer events" timeout. Press Escape (which also confirms Escape-dismiss works) between gestures; don't fight the backdrop.
Dev-mode bundle sanity without a browser: fetch the `/_bun/client/index-*.js` chunk and grep for your new symbols (buildNodeActions/multiSelectActions) — a 3.5MB chunk with the symbols present proves the tsx graph bundled; the "Build Error" string that greps positive is just Bun's HMR error-overlay TEMPLATE, not a failure (check context: `<span class="count">${...}</span> Build Error`).
Teardown note: after a Playwright drive the killed daemon's port can still show a second lsof pid — that's the BROWSER's client-side network-service socket (Brave/Chrome Helper), NOT a server and NOT yours to kill; `ps -o command=` it before touching, kill only the `bun` pid holding your store.sqlite.
Suite this round: 289 pass / 0 fail (was 268 pre-R8; +21 from nodeActions.test/multiSelect.test/GraphCanvas.test additions), mind-mapper tsc-clean, biome clean. NO engine files touched (surface-only boundary held).
The gesture FEEL (does inline nest-from-flyout feel better than the modal? does the auto-dismiss-on-outside-click ever annoy?) is the one thing a headless drive can't judge — flagged for Cole's mini-drive, per the plan's Cole-focus note.

## Round 9 gate lessons (async Job Queue — first real multi-seat engine+surface round since R6, 2026-07-23)

GATE PASSED cold and clean — engine 265/0, surface 307/0, mind-mapper tsc-clean, biome-clean on all 11 changed files; full CLI→daemon→event→/state→browser lifecycle driven live on an isolated store (port 60741) with zero wire-guess.
Claim atomicity is the headline and it held on the wire, not just the unit test: alice claim → running+alice, self-reclaim idempotent (re-sets running, bumps updatedAt), foreign `bob` claim → 409 `{error:"claimed",claimedBy:"alice"}` AND the CLI exits 2 on it — a genuinely uniform non-zero exit, notable because R5/R6 flagged uneven exit codes across verbs; R9's `job` verb is `res.ok ? 0 : 2` throughout, so a scripted caller CAN branch on exit here (the first verb family where that's true).
The event stream is the SEAM-B proof and it maps one-to-one: `job.added` → `job.claimed`×2 (DISTINCT kind, FULL entity — not folded into updated) → `job.updated`×5 (2 subtask-add + 1 check + 1 status-update + 1 release) → `job.deleted` thin `{id}`. Release correctly emits `job.updated`, NOT `job.claimed` (acquisition-only) — verify by grepping the captured SSE kinds against the count of mutations you drove, not by trusting the reducer.
The D2 liveness join is HONEST about the wire and the builder stated the narrowing in-code (state/jobs.ts header): `agent.activity` carries `{state}` ONLY (no agent identity), presence is a bare count, so the V1 join is PROJECT-SCOPED (one activity attributed to whoever holds a claim — single-casting-agent reality). The join fn still takes an `activityByAgent` MAP so it's per-owner by lookup — the day the wire keys activity by owner, only App's map construction changes. This is the right shape: forward-compatible without an engine field. No `last_seen`/heartbeat column anywhere (grepped db.ts/jobs.ts/events.ts) — D2 boundary held.
The App map construction has a subtle correctness point worth confirming, not eyeballing: it collapses `agentBadge` to a proxy (`stalled → stalled`, else `thinking`), which is only correct because `badgeFor` (state/activity.ts) already normalizes received→"thinking", idle→null, stalled→"stalled" — so `agentBadge` is NEVER raw "received"/"idle". Trace the badge normalizer before trusting the collapse; if badgeFor ever surfaced raw "idle", the proxy would wrongly show live.
Live browser flip is cheap and worth it here (the "automate over discipline" heart): the liveness dot drove `bg-thread-tier animate-pulse` ("owner active") → `bg-ink-faint` ("owner idle") when I posted `activity idle`, live over the WS. Gotcha: a fresh browser connect REPLAYS the bus buffer, so an `agent.activity` posted BEFORE the browser connected still lands (the dot was already live on load from a replayed thinking) — post activity AFTER connect if you want to prove the flip is event-driven and not replay.
The stalled→static-attention branch (false-liveness rule: `LIVENESS_DOT.stale = "bg-attention"`, no `animate-pulse`) is code+unit-verified but NOT driven live — synthetic `stalled` needs the 150s received→stall TTL (or an env-knob daemon restart); POST /activity rejects "stalled" (daemon-only vocab), so you can't shortcut it. Flagged for Cole's return-drive if he wants the stalled look confirmed visually.
Lane boundary clean: engine strictly under scripts/, surface strictly under src/mind-mapper/surface/; the surface keeps its OWN `Job`/`Subtask`/`JobStatus` types in types.ts (never imports scripts/jobs.ts) and they match the engine wire field-for-field — verify the two type decls agree by hand since nothing structurally guards the drift (the bounty-surface-lockstep-mirror class, benign here because both are hand-written from the same Contract-9-R9 clause).
Schema falsification the builder made within remit (stated in the R9 seams amendment): created_at/updated_at are INTEGER epoch-MS app-written (`Date.now()`), NOT the house `unixepoch()`-seconds default — because updated_at must bump per-mutation with sub-second ordering (a claim + a subtask-check in the same second must order) and the wire should carry numbers like every other ts. Confirmed live: consecutive mutations produced strictly increasing ms updatedAt. Surface renders ms.

## Round 11 gate lessons (the message surface — channels, collapse, activity-tied-to-a-message, 2026-07-26)

GATE PASSED with only paper-cuts; suite 1224/0, biome clean, zero console errors, and every R11 clause in the casting-draft drove ZERO wire-guess (channel vocabulary, `activity --message`, no-`done`-state, tolerant-unknown-kind, `ground` prefixes) — the draft has fully caught up with the wire on semantics.
**The reflective miss I want the next agent to inherit: the brief said `SPELLBOOK_SURFACE_MODE=dev` AND "verify against the built dist as shipped," and those two instructions CONFLICT.** Dev mode bundles the surface from source, so my entire browser drive tested source, not the artifact Cole actually runs — I trusted "dev" by default because every prior round's brief said it. Fix, now a reflex: close any surface-bearing round with (a) a `grep` of `dist/*.js` for the round's new user-visible strings and (b) ONE release-mode daemon (env unset, separate port) re-driving the headline assertion. Both passed here, but I nearly shipped a PASS that never touched the artifact.
The single highest-value step of the round was `activity thinking --message <OLDER id>` while a newer human message existed: it is the ONLY assertion that distinguishes the real wire tie from a "latest message" heuristic, and it cost one CLI call plus one DOM count (badge moved to the older bubble, `count === 1`). Generalize: when the honest implementation and its cheap fake produce identical output on the happy path, the gate's whole value is constructing the case where they diverge — find that case first, not last.
Absence assertions need their OWN fixture. "The channel filter appears at 2+ channels" proves nothing about the present-only rule; I had to mint a second single-channel project to see the control genuinely absent. Any "renders only when N>1" claim is two stores, not one.
Boundary-pinning a ratified predicate is three sends and worth every one: 90 chars collapses / 89 does not / a long human `turn` never collapses / a 325-char agent reply never collapses — that pins `human ∧ side-channel ∧ ≥90` exactly, instead of the mushy "long ones collapse" a screenshot would have given me.
Refetch-storm claims are MEASURABLE, never eyeballable: attach a Playwright `page.on('request')` counter, fire 10 mutations from inside the page's own origin, then count `/state` requests — got a clean 0 across 10 `job.added` events. Counting after the fact from the network panel doesn't work because your own verification `fetch('/state')` calls pollute the log.
**Synthetic `PointerEvent`/`MouseEvent` dispatch does NOT drive React Flow's connect gesture** — it uses pointer capture, so `dispatchEvent` sequences silently no-op (my dead-drag "failed" for ten minutes against working code). Use Playwright's real driver mouse (`page.mouse.down/move×N/up` via `browser_run_code_unsafe`); `browser_drag` also works but only between two real elements, which is useless when the drop target is empty canvas. Same family: a React controlled `<textarea>` ignores a plain `.value =` — use the native prototype setter plus an `input` event.
Teardown scar in a NEW costume: I piped `ps -o command=` through `cut -c1-90`, which truncated the path so my `case "$CMD" in *server.ts*)` matched NOTHING and skipped every kill while printing a confident "SKIP". Never pattern-match against truncated `ps` output — match the untruncated command, then `kill` the exact PID. (Also: 13964 was mine and 13979 was Cole's live :60700 — adjacent PIDs, one digit apart, is exactly how a catastrophic mis-kill happens; print both full command lines side by side before killing.)
Cold-guess failures were CLI-FORM only, never semantics: `job add` (it's `job create --title <t>`) and `job claim --agent` (it's `--owner`). Both usage strings were legible so recovery was one step — the same conclusion as R4, that drafts need a one-line usage string per verb more than more prose.
The R11 paper-cuts I reported (all surface copy, none blocking): the zone-tab ramble modal shows the SAME ex-ante copy as the main tab ("goes to the agent as a message — no node is created") even though a `zone:<id>` ground ref will ride, so the one place provenance is non-obvious is the one place the modal doesn't name it; and non-collapsible short side-channel bubbles still expose `aria-expanded="true"` on their channel-badge button, advertising a toggle they don't have.
Named consequence worth remembering, not a bug: the "from: &lt;Zone&gt;" chip resolves the zone name from live state, so a message carrying `ground:["zone:x"]` renders NO chip until that zone exists — and deleting a zone silently strips provenance from historical messages. That is Contract 11's "degrades to invisible for a consumer that doesn't know it" working as ratified; don't file it as a regression.

## Round 12 gate lessons (agent ergonomics — batch identity, title refs, node edit, orphan marker, 2026-07-27)

GATE PASSED with findings; suite 1281/0, biome clean, zero console errors on any R12 page, and every R12 clause drove ZERO wire-guess off the casting-draft's new "Working the board" section.
**The central judgment I want the next agent to inherit: R12 makes the drive-10 bug IMMEDIATELY VISIBLE, not impossible — and the distinction is load-bearing.** Nothing refuses the destructive act: `delete-batch` cheerfully deleted three pending edges whose endpoints were already-ratified canon nodes, with no warning and exit 0. What R12 buys is (a) a cheap join (`state --batch`) that makes reconciliation one call instead of memory, (b) usage strings that TELL you to look first, and (c) an orphan marker that lit up on all four nodes within one event of the sweep. That third one is the real guard — the human sees it now. When grading a round whose stated aim is "prevent a bug class", always separate *prevented* from *surfaced*, and say which you actually got.
The highest-value single check was `state --batch <typo>` and it held perfectly: 404 (not `[]`), CLI exit 2, and the message names BOTH readings plus a third useful fact ("ratified/rejected members would still be listed"), which is what lets an agent distinguish "typo" from "swept". An empty list here would have been the dangerous regression; it is worth spending the first five minutes of any batch-query gate on the unknown-id case, before the happy path.
**Absence-of-a-feature is testable and should be tested as DESIGN, not as a gap.** `delete-batch {batch:<id>}` 400s with an `expected` string that says the shorthand is deliberately absent and points at `state --batch` — so an agent that reaches for the sweep is taught the rule at the moment it reaches. A refusal that explains itself is a feature; verify the refusal's WORDING, not just its status code.
**Diagnosed circe's flagged edge-render gap: PRE-EXISTING, intermittent, NOT an R12 regression.** An edge added live to the canvas sometimes never paints and never self-heals (drag, tidy, resize, layout-mode toggle all fail; only a reload/remount fixes it). Rates measured with an identical harness: R12-dev ~1/4, R12-release 1/6, **R11-release 3/8** — so it predates the round and is mode-independent. The decisive step was reading React's fiber directly: `document.querySelector('.react-flow').__reactFiber$…` walked up to the fiber whose `memoizedProps` holds `edges`/`nodes` — the edge WAS in the prop with `source`/`target` exactly matching two rendered node ids, so the surface's derivation chain (`mapWithPending → … → filteredMap`) is innocent and the drop is inside `@xyflow/react`. Generalize the technique: **when the DOM disagrees with the data, read the React props off the fiber before blaming either side** — it splits "we computed it wrong" from "the library dropped it" in one call.
Corollary for the fix owner (circe): the likely shape is a race between the edge landing in RF's store and RF's node measurement settling, and since RF never re-derives afterwards, the cheap repair is to force a new `edges` array identity when `useNodesInitialized()` flips true.
**Comparing rounds needs a controlled harness, not two ad-hoc drives.** My first R11-vs-R12 comparison used R11-release vs R12-dev and "proved" a regression that wasn't one. The fix was one page-side loop that seeds a fresh project, reloads, waits a varied delay, POSTs the edge from the page's own origin, and counts — run identically against all three daemons. Any intermittent bug demands N trials per arm before you say the word "regression".
A dev-mode daemon cannot be stood up in a bare `git worktree` (no `node_modules` → Bun build 500s); run the historical arm in RELEASE mode off its committed `dist/`, and then run the current arm in release mode too so the arms match.
**`.anthill/scratch/` and the session scratchpad are NOT session-private in practice** — my "fresh" `MIND_MAPPER_HOME` was a directory a previous seat's drive had already populated (two of its projects were sitting there). It didn't hurt (my project ids were new), but a gate that asserts "a fresh store has no projects" would have failed for the wrong reason. Mint a date/handle-stamped subdir, or `rm -rf` it first.
Engine clauses that held cleanly, all first-try off the doc: title refs (`title:<exact>` resolves; ambiguity names both ids; case-mismatch says case-sensitive AND points at `search`; a pending proposal's draft title correctly does NOT resolve; an unresolvable ref in a batch writes zero rows and fires zero events), `node edit` (tier survives, search hits the new synopsis instantly, an omitted field is not blanked, `""` clears, empty title refused, and the empty-patch 400 explains *why* tier/kind aren't editable), `delete-batch` transactionality (2 bogus ids among 5 → nothing deleted, both named, cursor unmoved), and batch EXTENSION (re-supplying the batchId files the forgotten edges into the original act — the drive-10 repair, and the batch view then shows ratified members beside the new pending edge).
`/changes` passed its NEGATIVE test, which is the only one that matters: created a proposal, deleted it, `changes --since 0` reported nothing about it AND `notCovered[0]` is deletions — present verbatim on the EMPTY response too. Grade a self-declaring interface by whether the disclosure survives the empty case; that's where a lazy implementation drops it.
The SEAM 7 funnel is real but not total: every malformed-body probe I fired (`/proposals`, `/proposals/batch`, `/proposals/delete-batch`, `/nodes/:id`, `/tags/:id`, `/send`, `/ingest`, `/ratify-batch`, `/jobs`, `/activity`, `/proposals/:id/zone`) returned `expected` — **except `POST /projects`**, which still 400s bare on both its validator and its parse catch. A funnel gate should end with a sweep of every `status: 400` literal in the source that did NOT go through the helper; two remained (`/projects`, `/proposals/:id/promote`), and only the first is a genuine shape error.
Watch item for the doc: a batch edge draft stores its endpoints AS WRITTEN, so edges drafted against local refs hold the ORIGINAL PROPOSAL ids — after a partial ratification, grepping `state --batch` for a ratified node's uuid finds no edge, and the agent must join through `resultNodeId`. Title-ref'd edges store real node ids instead. The casting-draft doesn't name this asymmetry and it's exactly the reconciliation step drive #10 skipped.

## Spell-hardening P0 ratify round — gate auditing as a discipline (2026-08-05)

First non-mind-mapper round in this seat, and the first where my object was **gates themselves** rather than a running spell.
The card asked one question of four gates — *what result would have FAILED this?* — and the answer is that the question is necessary and **not sufficient**.

### The taxonomy — four ways a gate cell fails, and only the first is the one people look for

**1. Decoration — the cell cannot fail.**
Found directly by the card's question.
P0's over-buffer precondition was stated in prose rather than asserted; P0c's Gate line used a *valid* value where only a bogus one discriminates.

**2. Inverted control — the cell fails a CORRECT implementation.**
Found by asking the question's missing second half: **evaluate the assertion against the world AFTER the intended fix, not only the buggy one.**
P0d asserted "`state` does not show the task" for a duplicate id, but `applyTaskAdd` refuses the duplicate and leaves the original holding that id — so the assertion is false post-fix.
**Worse than decoration**: decoration passes silently, an inverted control dispatches the builder to break working code while wearing a red gate that looks like diligence.

**3. False premise — the cell names an operation that does not do what the cell assumes.**
P0b's final cell said "confirm `--fresh --restore` actually restores"; it does not restore, and it deletes the snapshot first.
**This one hides best, and the reason is precise: it passes both earlier tests.** It can fail, and it does not fail a correct fix — it fails *everything, always*, and "this cell can definitely fail" is the exact reasoning that makes you stop looking.
**A permanently-red cell reads as unusually sensitive rather than broken.**

**4. Aggregate dilution — every cell is valid, but the headline count is dominated by cells that already passed.**
P0c enumerated 15 entry points of which 9 already conformed, so "15/15 green" was ~60% incapable of failing.
**Per-cell validity does not aggregate into suite validity, and the aggregate number is the one humans read.**
Remedy: partition the populations in the gate text and report the counts separately; a blended count is what makes the dilution invisible.

### The unifying rules

**Audit what a gate INSTRUCTS, not only what it ASSERTS.**
Every cell names an operation, and that operation is a claim about the world exactly as falsifiable as the assertion resting on it.
I checked evidence-*admissibility* and never questioned the *verb* — and **admissible evidence about a non-existent behaviour is still a broken cell**.

**Ground every verb a gate names before judging the cell that uses it.**
This is why the P0d catch worked and the P0b miss did not: for P0d I had read `applyTaskAdd` and knew the post-fix world; for P0b I reasoned about the cell's logic with an ungrounded verb.
One `--help` or one throwaway probe per verb.

**A gate can instruct a DESTRUCTIVE act, and that is a safety review separate from the logic review.**
P0b's final cell destroyed the snapshot — the exact recoverable→unrecoverable conversion the refusal it gates exists to prevent.
Require the warning **at the instruction**, never in a linked finding the runner may not have read.

**When a cell says "pick something with property X", check that something with property X exists PRE-FIX.**
If it does not, replace the selection instruction with a **constructed fixture plus a recorded pre-fix baseline**.
Category 3 predicted this second instance before I found it: P0d's second half asked for "a command the reducer declines" when magpie's `/cmd` switch has 13 cases and zero `default:`, so that set is empty.
*(Stated as a claim to test, not an established property — n=1 on prediction.)*

### The house's default vacuity, four costumes in one evening

`>65_536` by construction · precondition as its own cell · a bogus value not a valid one · a board that is populated not empty.
**Generalised: any assertion of the form "X is unchanged / complete / matches" is VACUOUS when X is empty or small — and the empty case is exactly what a broken fixture produces.**
So the failure of the *setup* silently manufactures a passing *measurement*, which is why it recurs: fixture and assertion are written by one person in one breath, and the assertion is the half that gets scrutinised.
**Remedy: make the precondition its own assertion cell, before the measurement, and assert identity (ids/titles) rather than count.**

### Verification craft this round sharpened

**A positive control must be generated by a party OTHER than the observer.**
I broadcast "touch a card, confirm a frame arrives" as a wire test; `--as` does documented self-echo suppression, so a self-write is the one write the observer cannot see.
I handed the team a diagnostic that reports a healthy wire as dead.
**Ask who authors the stimulus and whether the observer can see that author's traffic at all.**

**Measure exit codes WITHOUT a pipe.** `$?` after a pipe is the filter's status — the SOP's own land-string scar, which I then committed while auditing gates.
It cost nothing only because the wrong answer contradicted a peer; **a measurement that confirms what you expect gets no second look**, which is where this error is invisible.

**When you notice you are DISCOVERING a tool's behaviour by experiment, check whether it is DOCUMENTED.**
I characterised `bounty tail`'s echo suppression empirically for an hour; it is two lines of `bounty --help`.
Empirical characterisation feels like rigour and is correct when docs are silent — which is why it never prompts you to ask whether they are.

**Prefer a claim you can re-check from a saved artifact over one that depends on what happened while you were watching.**
Same hour, same author: my filter finding (proven against captured bytes) survived; my `--mine` finding (a timing inference from a live stream) was withdrawn.
**The evidence type predicted which one held.**

**When two invocations disagree, re-run BOTH at the same instant before theorising** — a disagreement measured minutes apart may be measuring *time*, not the variable.
I wrote this rule down and then failed to apply it to the arm I had already convinced myself about.
**The rule did not fail; I did not run it on the finding I liked** — and a reflex applied only to claims you doubt is a mood, not a reflex.

**Mutation-verify a gate in THREE directions when you contributed a cell to it:** fix present → pass, fix reverted → fail *at the right assertion*, and **the precondition cell's own fixture removed → fail at the precondition**.
A precondition that never fires is itself decoration.

### Where a finding LIVES decides whether it survives

**A claim about a gate that lives outside the gate has the same durability problem as a contract restated in three seat docs** — it drifts, and the copy that gets executed wins.
I reported a fix and left its *reasoning* on the wire; the gate would have shipped carrying the split with no *why*, one reasonable refactor from being undone.
**Write it where it is executed, once.**
The auditor's output is itself an artifact with a durability question, and I did not apply my own lens to it.

**`uncheckedAgainst` is sampled at COMMIT time, not GATE time.**
It cannot distinguish *dirty during the gate* (a true false-green) from *dirtied between gate and commit* (a timing artifact); it is conservative by design and should stay so.
**Non-empty is a prompt to investigate, not a verdict.**
The only general method for the benign case is re-running the gate on the committed tree.

**Announce the RELEASE of a shared file, not only the claim of it.**
The convention has an opening beat and no closing one; my "restored, tree clean" would have let the lead read his own envelope without waiting for me.

### Reflexes carried in, re-confirmed

Kill daemons by exact PID after matching the **untruncated** command line — never `pkill` on a shared `scripts/server.ts` argv, never `close`.
zsh does not word-split: **never put multi-word anything in a variable destined for argv** — not the command path, not a flag bundle (bit me twice more this round, in the flag-bundle costume).
Mark absence explicitly (`UNVERIFIED` / `UNVERIFIED-BY-CONSTRUCTION`) and say which specific thing you did not check; peers will drive it and hand the result back.

### The blind spot this seat ships with — audit your OWN instruments

**Every habit this role trains points scrutiny outward, so the verify seat's own tooling is the least-audited artifact in any session it works.**
Nothing else in this doc tells you to check your own instruments; it is all about driving someone else's.
That is a gap in the seat, not in whoever holds it — which is why it is written here.

Three instances in one session, all mine, all found by someone else or by accident:
I broadcast a wire self-test that could not work (`--as` suppresses your own echo, so the tester is the one party who cannot see the event).
I published a filter fix that made a tail report events but not its own death, then kept running that incomplete filter myself for an hour while recommending the corrected one to others.
I audited a gate cell's logic without ever grounding the verb it named.

**The unifying failure: I never connected "this is a gap in the thing I am auditing" to "I am using the thing I am auditing."**
The recommendation and my own configuration were separate objects until a peer re-armed and made them touch.

**Reflex to adopt: after you publish a correction to any instrument, immediately check whether you are running the uncorrected version.**
It is one command, and the answer was "yes" every time it came up this session.

## Sprint 02 "success-shaped lies" — ratifying, then cold-driving, two lanes (2026-08-06)

First session in this seat with BOTH halves of the job in one sitting: ratify three gates as a design review, then cold-drive two of them as a fresh agent.
The craft below is what survived; every item cost something.

### Run the second arm even when the first is all-green — that is where the mislabel lives

My P0b cold gate came back **6 red / 2 guard / 1 precondition, all pass, arm 1**, and I nearly stopped.
Ran the pre-fix arm only because this seat's epitaph says to, and **one of the six was not a red cell**: *"the refusal names no corrective verb"* PASSES pre-fix, because **pre-fix there is no refusal at all, so "contains no `--fresh`" is vacuously true of a message that does not exist.**
That is **G8's own rule** — *every "X is not there" needs "and the thing that would have put X there ran"* — which I had read that morning and QUOTED in my own ratify hours earlier.
**Fix it, do not relabel it:** the cell now asserts the refusal OCCURRED (rc≠0 ∧ field present) AND is verb-free, in one predicate. Relabelling to a guard would have been honest and strictly weaker.

### A label is a claim about a MEASUREMENT — and it EXPIRES when the cell's assertions are edited

Two instances one session, opposite polarity: the engine seat had a correctly-labelled cell whose **edit** changed its class (label went stale); I had a **new** cell labelled from intent and never evaluated pre-fix.
**A rule that says only "label after measuring" catches the second and lets the first through.**
The enforcement clause is the part that survives: **no cell carries a label until BOTH arms have run; a cell whose assertions changed since its last two-arm run is UNLABELLED, not still-labelled.**
Why a clause and not a principle: **both seats AGREED with the principle before breaking it.** A clause is checkable by someone who never followed the argument.
Countable metric: how many cells CHANGED label between arms. Mine was **1 of 9**.

### ⚠ Ask WHICH WAY a gate degrades without its fixture — the answer differs per gate and the safe-looking one is the dangerous one

Only visible by running the broken-fixture arm on TWO gates in one session:

| gate | fixture broken → | reads as |
| --- | --- | --- |
| P0b | **all 6 reds still PASS**, precondition fails alone | **a perfect 6/6 with one odd line** |
| P0d | everything fails, precondition names why | obviously broken |

P0d's fixture is load-bearing for the **MEASUREMENT**; P0b's only for the **MEANING** — the refusal mechanism fires whether or not anything was at risk.
**A gate whose cells still pass on a broken fixture needs its precondition far more than one whose cells collapse with it.**

### Pin the WORLD; stop reasoning about WHEN

Cost me two results in one session. The remedy both times: a `COLD_GATE_ROOT` env knob so the SAME cells run against two pinned detached worktrees — **one variable, two worlds.**
That knob is also the only reason the pre-fix arm existed at all; without it arm 2 is a rewrite instead of a re-run.
**Never attribute a measurement to a sha you did not check out.** A peer mid-lane makes the working tree, the blob, and HEAD three different objects.
Corollary that DID work: comms messages carry timestamps, so **the channel is a queryable record of when the tree was dirty** — `git status`-before and `uncheckedAgainst`-at-commit are both point samples at the EDGES of the window.

### A claim drafted before its check is not awaiting verification — it is a fabrication awaiting a rubber stamp

I wrote *"I checked those two cases and they do not occur in this set"* into a FINISHED message, then ran the check, and the check refuted my own sentence.
**Care wrote the sentence.** What caught it was a rule with no judgement in it: **run the check before the sentence ships, even when you are sure.**
Same session, same hour: four successive instrument defects in ONE denominator check — overlapping git-grep pathspecs that double-counted (and **the file-count check I ran to validate the method PASSED while the method was wrong**), measuring the dirty tree, a field-strip built for the wrong output format that silently produced a confident `prose=0`, and a "string literal" regex firing on any earlier quote.

### An absence claim decays as the sprint it serves lands commits

ONE commit invalidated TWO of the sprint's own artifacts — it added a `process.exit(` in **prose** (inflating an audit count) and the first **computed-key read** (falsifying a "zero computed-key reads" claim), neither re-derived.
Distinct from a glob asking the wrong question **at one instant**: here the measurement was right, the question was right, and **the world moved under it by our own hand, same week, same goal.**
**Remedy: an artifact a later lane CONSUMES gets its absence claims re-run at the sha that CONSUMES it, not the sha that derived it.**
Sharper still, from the artifact's author: **a published absence claim has no listener — reading a fact does not propagate it to the claims you have already published.** He read the counterexample in his own terminal forty minutes after publishing, and it did not fire.

### Name-shaped evidence about harnesses is a coin flip — ask "does it spawn?", never "is it named after the CLI?"

**3 of 6 files named `cli.test.ts` contain zero spawn primitives** (glamour, imago, magpie) — all three are legitimate unit tests of CLI helpers, which is what makes it a trap and not a bug.
This is the mechanism that would have marked a spell PINNABLE on a file whose own first line says it does not spawn.
Related, same lane: **"does a process harness exist?" is the wrong question — ask it once PER CAPABILITY.** Termination is observable under `Bun.spawn`; drain is not. One verdict per site conflates two requirements that come apart at exactly the site under test.

### Observe TERMINATION on the process itself, never as a side effect of its output being consumed

A peer found that a G7 termination cell reads both pipes to completion before awaiting exit, so a **detached grandchild** holding an inherited handle stalls the observation — `proc.kill()` releases pipes held by `proc`, not by a grandchild.
Its failure mode is the bad kind: **it does not go RED, it becomes UNREACHABLE** — "a red cell names the hung verb; a timeout says the suite is slow."
**Add to the gate-failure taxonomy as a fifth mode: degrades from DIAGNOSIS to NOISE.**
My own harness was immune **by accident** — file redirection + `kill -0`, chosen for the exit-code-through-a-pipe scar, not for this.

### Declare your METHOD before you run it, and say which residue is still shared

Posting the method up front lets a peer attack the design instead of the outcome, and it converts "we agree" into something worth having.
**An independent check must differ in METHOD, not only in operator** — but finish the thought: after confirming a peer's number by a different corpus and tool, I still shared their **lexical** blind spot, and said so. **Two lexical scanners agreeing about lexemes is one method run twice; two corpora agreeing about a trend is not.**

### ⚠ TIMING can BE the condition — a fixture can satisfy a spec's letter and not its content

The amended P0f fixture requires a consumer **not draining at the instant of exit**.
My cell had the right SHAPE (`| ( sleep 2; cat )`) and the wrong SCHEDULE (closed at 4s, so the consumer had resumed draining before the exit fired).
Result: **200285 vs 200286 — no truncation in either world**, which reads as *"the amended fixture does not discriminate"* — **a finding against a gate law landed twenty minutes earlier.**
Corrected to block 8s / close at 1s: **65536 pre-fix, complete post-fix.** The law is right.
**The failure presented as THE SPEC IS WRONG rather than MY CELL IS WRONG, and that is the most dangerous direction available, because it points outward at a peer's ruling.**
**What caught it was that the result CONTRADICTED A MEASUREMENT ALREADY ON THE RECORD.** Against an empty record I would not have re-examined my own cell.
**Generalise: a ratified fact is a tripwire that audits instruments nobody aimed it at — that is a reason to ratify beyond being right about the fact.**

### `tail` carries SURFACE→AGENT events; every CLI verb is an AGENT action

Spent a drive discovering this: a >64 KiB payload sent with the CLI's `say` never enters `tail`, because `emitEvent` for text lives in **`handleBrowserMsg`** (magpie `server.ts:335`, imago `:683`, glamour `:274` `message.send`), while the CLI's `say` goes `/cmd` → `handleAgentMsg`, which broadcasts to browsers and never emits.
So **no CLI verb can put a large payload into the stream the drain defect truncates** — the fixture is only constructible over `/ws`, posting as the surface would.
**This is not a quirk; it is what these spells ARE** — the membrane faces both ways, big payloads flow agent→surface, and the surface→agent events are small by nature.
Bounty is the exception (agent writes enter its event log), which is exactly why a bounty-shaped assumption did not transfer.

### Never `2>/dev/null` a FIXTURE-BUILDING step

When my precondition went degenerate I had no diagnosis, because I had silenced the `say` that built the fixture — I had to re-run it with stderr visible to learn it had **succeeded**, which is what redirected me from the write to the stream.
**Silencing a step you assert nothing about is fine. Silencing the step that CREATES the thing you measure discards the only evidence separating "the fixture failed" from "the fixture worked and the mechanism is elsewhere" — and those need opposite responses.**

### Adopting a peer's mitigation means you can no longer confirm the hazard

I drove glamour clean through the four-hazard stack — by sending stderr to a FILE and observing termination on the process, i.e. thoth's remedy adopted wholesale.
**So the drive says nothing about whether the hazard is still live.** `UNVERIFIED-BY-CONSTRUCTION`.
**"My run was safe" is evidence I obeyed a peer, not evidence the hazard is gone** — the same shape as adopting the `--pin` cwd mitigation. Say which one you have.

### Say what the gate CANNOT claim as loudly as what it can

P0d's `/cmd` cells assert the ROUTE's answer, but post-fix the verdict ORIGINATES in a surface reducer — my probes cannot distinguish "reducer reports and route propagates" from "route hard-codes and discards it," because **both emit the bytes I measured.**
Cells valid; **coverage stops at the seam.** Marked `UNVERIFIED-BY-CONSTRUCTION` rather than left as an absence.
I also shipped an incomplete gate and caught it BETWEEN arms — my first `/cmd` draft had no *"a valid command still answers ok"* guard, so **a fix that rejected EVERYTHING would have passed 5/5.**
**Report a gate you repaired mid-drive; a quiet repair looks identical to having got it right.**

## P0 build round — building gates instead of auditing them (2026-08-06)

First session where this seat AUTHORED the instruments rather than reviewing someone else's.
Ten-plus defects were found in mine; the craft below is what survived.

### The precondition cell is worth more than the assertion it guards

**It fired four times and was right every time**, and each firing was a broken FIXTURE that would otherwise have reported a clean PASS:
a 36-byte mind-mapper state (bootstrap ordering), a 799-byte glamour state (wrong `say` convention), a 0-byte glamour arm (a real shipped hang), and a `>65536` threshold that a smaller payload would have satisfied vacuously.
**Every one would have read as `COMPLETE == COMPLETE`** — the failure of the setup silently manufacturing a passing measurement.
**Rule: in any gate of the form "X is unchanged / complete / matches", assert the FIXTURE FIRST as its own cell, printing its measured value.**
The assertion is the half that gets scrutinised; the setup is the half that fails silently. **Print the number (`overBuffer: true (bytes=88941)`) so the cell NAMES the state rather than dying of it** — daedalus's shape, better than mine.

### Assert TERMINATION whenever the fix's failure mode is non-termination

Every gate I built measured BYTES and none asserted the CLI EXITS — for six spells.
A shipped hang surfaced only as `0 bytes` because my harness gave up: **an accident of the wrapper, not an assertion.** To a byte count, a hang and a silent success are identical.
**P0 replaced `process.exit(code)` with a natural return, and a natural return is exactly the change that can fail to terminate** (reverted at `bounty/join.ts`, shipped in glamour).
**Match the assertion to the fix's failure mode, not to the bug's symptom.**

### Drive BOTH arms even when the pre-fix result feels already known

glamour pre-fix returned; glamour post-fix hung. Same spell, same fixture, one commit apart — **a controlled experiment I did not design.** The two-arm structure built to measure truncation is what isolated a regression introduced BY the fix.

### A DENOMINATOR IS A CLAIM ABOUT THE CELLS YOU DID NOT RUN

Three seats published three mechanisms for one anomaly in an hour; all three measurements were real and reproducible, all three mechanisms wrong, because nobody ran the cell separating their mechanism from the next-most-obvious one.
**Before publishing a mechanism, construct the cell that discriminates it from the runner-up, and run it.** Each cost ten seconds.
(The anomaly: **executing** a CJS binding — `require`/`module`/`__dirname` — in `bun -e` makes an uncaught throw exit 0 silently. `if(false){require(...)}; throw` exits 1, which is what pins "executed" over "present". Remedy: explicit `catch{process.exit(1)}`, or `bun run <file>`.)

### Verifying a peer's claim with the peer's own METHOD is duplication, not verification

Twice: prospero "independently verified" my finding by running my exact command; I "verified" daedalus's enumeration with his own `ls .../scripts/*.test.ts` glob. **Both reproduced. Both were wrong.**
**An independent check must differ in METHOD, not only in operator** — `find` over a subtree cannot assume the location a glob assumes. **A confirmation is worse than the original error: it converts one seat's mistake into an agreed fact.**

### Name the LAYER, not just the SHA

Four committed-vs-working disagreements in one session, the last one with both seats citing correctly.
**`git show <sha>:<file>` (blob) · working tree · `HEAD`-at-the-moment-you-read-it are three different objects**, and a peer mid-land makes them disagree honestly.
**Measuring a shared tree and attributing the result to a commit** hit three seats; `git status` belongs in the MEASURING step, not the write-up. **When auditing a peer's artifact, copy it out and cite a sha256** — mine changed between my read and my run, and I nearly reported a defect already fixed.

### My instruments erred consistently toward UNDER-reporting

Of ten-plus defects, **not one was a false positive in my favour**: a discriminator blind to id families I had not anticipated (hiding 2 of 3 intruders in my own published evidence), a fingerprint blind to mutation, a tautological all-clear wired to the baseline, an empty-array expansion that dies only on bash 3.2.
**So "do my results look right?" cannot find them — they DID look right.** The only things that worked were a peer running my code, and cells whose frame I did not choose.

### Gate-driving craft, per spell

**Ground verbs from SOURCE, never `--help`** — the hand-rolled parsers swallow it and EXECUTE the verb (`close --help` closes the board). Astrolabe dispatches `--help` properly; not knowing which is which is the point.
**Spells that look alike diverge exactly where a fixture depends on them:** `say --stdin` (magpie) vs `say <positional>` (glamour, imago); `state` defaults to `?lean=1` in glamour/imago and needs `--full`, so a lean gate is permanently vacuous rather than wrong.
**The two-reader design is the reusable core:** reader A to a FILE with no pipe anywhere; reader B through `sh -c "… | cat"`. Pre-fix they disagree and the disagreement IS the defect. A `Bun.spawn({stdout:"pipe"})` harness CANNOT fail on this class.
**Six spells truncate at exactly 65536** regardless of payload size — the buffer boundary is the mechanism.

### `grep -c` — one root, four costumes, all mine, after fixing it three times

It prints `0` **and** exits 1 on no match: `|| echo 0` appends a second value · its exit status read as a verdict · `grep -c … && next` skips the chain · `[ "$(grep -c … || echo 0)" -ge 1 ]` throws on `0\n0`.
**Never in a chain or a substitution without a separate assignment.** Recorded because a defect I accepted, understood and could explain did not transfer to the next script I wrote thirty minutes later — the team's first principle, n=4, by the seat that keeps quoting it.

### A correctly-WORKING seat produces no signal either

The SOP's scar is *"a correctly-waiting seat produces no signal."* **Its twin: long silent drives look identical to idleness**, and the lead nearly started a duplicate drive on top of mine. `ps` was the only surface that knew.
**Post mid-flight partials, not just results** — the board says `doing` and the wire says nothing.

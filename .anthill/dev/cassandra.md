# cassandra — verify

> **Seat header (from `.anthill/config.json` — keep in sync with the roster).**
> **Handle:** cassandra · **Role:** verify · **Scope:** cold-agent usability (fresh-agent reports) and integration — drives the assembled spell end-to-end in a realistic environment and calls the failures · **Channel:** spellbook

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
`send` takes positional text (no `--stdin`), unlike ingest/propose which are `--stdin` JSON — the asymmetry is a cold-agent trap worth a line in the casting doc.
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
mind-mapper suite is now 268 pass / 0 fail (seams still says 254 — grew since that note; all green).

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

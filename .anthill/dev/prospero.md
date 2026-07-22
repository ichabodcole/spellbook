# prospero — lead

> **Seat header (from `.anthill/config.json` — keep in sync with the roster).**
> **Handle:** prospero · **Role:** lead · **Scope:** orchestration, the file-scoped atomic land, human liaison, and repo ops (release-please cuts, dependency updates, marketplace.json / plugin.json manifests) · **Channel:** spellbook

This is prospero's **living doc** — the seat's brain, carried between ephemeral agents.
The next agent to take this seat re-grounds from here.
Keep it **honest and lean**: capture durable **judgments**, not file maps or a session log.
When something's no longer true, fix it.

The fields below are the **locked structure** (every seat doc has them).
The header above is pre-filled from config; the bodies are scaffolded prompts — fill them as the seat earns content.

> **Write one sentence per line (no soft wraps).**
> These docs live in the host repo, so its formatter (prettier / biome) may run on them.
> Hard-wrapped prose gets reflowed — and a wrapped continuation line can be mangled into a stray list item, corrupting the trail.
> One sentence per line makes a reflow a no-op.

## Who I am

The lead: orchestration, human liaison, the file-scoped atomic land, and repo ops.
I hold the product judgment between the human and the seats — rulings in, work routed out, knowledge landed at wrap.

## Scope

Session orchestration (convene → cards → briefs → ratifications → finalize), routing Cole's decisions to seats as cards with the ruling baked into the notes, seam ratification (product side), repo ops (root deps, shared config like tsconfig, .gitignore, merge-notes), and the atomic doc land.

## Boundaries

I do not implement — even when a fix looks one-line, it goes to the owning seat (context lives there).
Seam contracts belong to their owning seats in `seams.md`; I ratify and point, never restate.
Merge to develop / push / release are Cole's, always — I stage the branch and stop.

## Relationships

circe (surface) and daedalus (engine) ping-pong seams directly on the vine; I ratify after both halves speak.
Cole's drive feedback comes to me raw; it leaves me as cards with rulings.
Cross-project consumer negotiation (e.g. the Operator doc-linking channel) is my lane when it shapes this repo's architecture.

## Taste & reflexes

- Route a human ruling as a card whose notes carry the *why* verbatim — seats should never need to ask "what did Cole mean."
- Ratify additive-optional seam changes fast (propose → one ack → ratify); hold anything non-additive for both owners.
- Verification points are human drives; several small drives beat one big one — every drive round this session produced rulings a plan would have guessed wrong.
- Flag-before-LAND (not before-work) for dep/shared-file changes: ratification overlaps building, zero dead time. Worked three times without a miss this session.
- Independently re-verify before closing a card (run the tests, curl the endpoint) — cheap, and twice caught nothing precisely because the seats knew I would.

## Hard-won lessons

- After a batch card-add, seats can claim by stale memory of the board — announce batch-adds with card ids and require claims against fresh `state` (the focus/force mix-up, session 2026-07-16; fix captured by circe too).
- Crossed vine messages (two seats reporting past each other) resolve by re-reading the channel before acting, not by trusting the latest notification — msgs 18/19 same session.
- Untracked files hide from pathspec commits: a seat's "landed" can silently omit a new file (styles.css, commit 934f422 caught it) — when reviewing a land, check `git status` for strays, not just the named paths.
- **Cut the feature branch AT CONVENE, not at wrap** — the V1 session built 27 commits directly on develop because convene skipped init-branch; the retro-branch fix (branch at tip, reset develop) was clean only because nothing was pushed. Make branch creation part of the convene checklist reflex.
- Emitted event payloads are seams: if a bus emit shape isn't written where a consumer can read it, the consumer WILL guess wrong (P3 badge bug) — thin-event conventions go in seams.md the day they're designed, not at wrap.
- A spike closes when its load-bearing uncertainty is resolved, not when feature ideas stop arriving — everything after that point sorts into known-build (V1 plan) or new bounded uncertainty (its own experiment card).

- Subagent-mode re-dispatches route by AGENT THREAD, not seat identity — the V1.x re-gate went to daedalus's thread (the builder) instead of cassandra's, and only his honesty flagged it.
Before continuing an agent, verify the thread IS the seat you mean (the board-claim fresh-state rule, applied to agent threads).
- Ratify runtime-behavior claims only with a measured repro (daedalus's enqueue-throw clause died on first contact with Bun) — a 20-line scratchpad repro before ratification is cheaper than a red rig.
- The V1.x round proved the two-round gate shape: cold drive → falsifications → owner rework → COLD re-drive by the same non-owner.
The builder's own probes of his fix passed identically but prove nothing — independence is the property, not the probe list.

- The R4 gate passed on the FIRST cold drive — the causal chain worth preserving: seam claims ratified (2/7 falsified pre-build) → Contract 9 amendments landed BEFORE consumer contact → casting-draft amended by the builder as each verb landed.
The two-round shape is the safety net, not the expectation; the ratify round is what shrinks it.
- Parallel seats on one shared tree: a seat's verification BUILD bakes peers' uncommitted src into committed artifacts (daedalus's dist rebuild captured circe's in-flight edits) — artifact rebuilds are a land-time act for the lead, or need a clean-tree check first (fed upstream as anthill feedback).
- Same-day drive→merge→convene→build→gate is sustainable when the drive findings are triaged INTO the plan skeleton while fresh — the drive-3 findings doc's triage header WAS the round-4 scope, no re-derivation.
- When a skeleton seam claim gets falsified by BOTH owners independently onto the same prior precedent (R5 submap-scoping → the R3 zones inclusive-snapshot ruling), that convergence is the strongest possible signal the precedent is load-bearing house architecture — promote it from "a ruling" to a named invariant the next plan cites up front, not re-derives.
- A round that CHANGES A NUMBER the casting-draft already states (R5 split the 60s stall into 150s/60s) leaves the doc's stale figure as the most dangerous gap — the code is more correct AND the doc actively teaches the old behavior. Casting-draft prose is the lead's to fix (not implementation); grep the doc for any constant a build round touches, at plan time, and list it as a doc-delta in the plan.
- Gate-fix ownership: a doc-only gate failure (casting-draft prose) is the LEAD's rework, not a seat's — fix it directly and cold-re-drive the single item (resume the gate agent's thread with a focused re-verify), don't spin the whole gate again.
- The ratify round is where the LEAD's own skeleton gets corrected, not just the seats' claims — R6: both owners independently found "reject emits no bus event" (the real root cause of a bug I'd scoped as a surface patch), and circe caught two of my mis-scopings (a derive I said needed an event map when the wire field already existed; a gesture I scoped to the wrong node-set). Write skeleton claims as falsifiable *hypotheses about the mechanism*, and the owners will find the mechanism you got wrong — that's the point, not a failure of the skeleton.
- When a batch/atomic verb wraps an existing single-op function, the recurring hazard is that the single-op does deferred-unsafe work inside what will become the transaction (emits + FS writes that leak on rollback) — propose-batch needed buildProposal extracted from insertProposal; ratify-batch needed buildRatify from ratify (and ratify had THREE such lanes, not two). Name "extract the pure builder first" as the P1 prerequisite whenever a batch verb is planned over an existing mutator.

## Anti-patterns

- Letting a "later"-tagged card sit adjacent to an active one with a similar title — retitle or re-note parked cards so they can't be claimed by title-adjacency.
- Merging or pushing on session momentum — the human's look is a gate the team cannot run itself.
- Restating a seat's seam candidate in my own words in multiple docs — single-source in seams.md, point everywhere else.

## Candidates

- Astrolabe-branch merge coordination: root tsconfig gained DOM/DOM.Iterable libs and Contract 5's cwd-pin refinement applies — reconcile when that branch merges.
- The unified-scaffold recipe now has real inputs: circe's shadcn-on-Base-UI port findings + the retrofit audit's port/skip reasoning + Contract 5 — thoth should synthesize these when next seated.
- V1 planning via anthill:plan; force-layout card parked on the board as the experiment marker.
- Consider naming the flag-before-land discipline in the SOP (circe's suggestion; it earned it — held five-for-five across spike + V1).
- House-style candidates for thoth's next seating: unique daemon-entrypoint filenames (or argv markers) per spell + the exact-PID-kill counter-pattern (pgrep before pkill); the pkill incident + cassandra's repeated-use confirmation are the evidence.
- V1 dogfood rounds are Cole-gated and unstarted: a real brain-dump session, and linked-Hollowbrook via Operator extract_links when their deploy lands.
- House-style candidate for thoth (returned by daedalus at R4 gate rework, applied live in casting-draft): casting/SKILL docs quote typed error KEYS verbatim and paraphrase only the remedy — prose-quoting error strings drifts from the wire.
- OKF (Google's Open Knowledge Format) is on Cole's adoption radar for Operator — if it lands, the mapper's Operator importer and an OKF boundary adapter converge into one round-5 work item.

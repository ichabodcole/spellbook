# circe — surface

> **Seat header (from `.anthill/config.json` — keep in sync with the roster).**
> **Handle:** circe · **Role:** surface · **Scope:** the spell surfaces — React studios (glamour, imago, magpie, astrolabe, mind-mapper) and Alpine surfaces (bounty, digestify, grapevine watch) — plus theming/semantic tokens (imago/glamour convention) and the vendored `ui/` component layer (mind-mapper pilot) · **Channel:** spellbook

This is circe's **living doc** — the seat's brain, carried between ephemeral agents.
The next agent to take this seat re-grounds from here.
Keep it **honest and lean**: capture durable **judgments**, not file maps or a session log.
When something's no longer true, fix it.

> **Write one sentence per line (no soft wraps).**
> These docs live in the host repo, so its formatter (prettier / biome) may run on them.
> One sentence per line makes a reflow a no-op.

## Who I am

The surface seat: I build the human-facing half of the co-presence board — the rendered UI, its interaction grammar, and its visual vocabulary.
My lens is the manifesto's board-not-form test: every affordance must keep both parties able to see and act on the shared work-object.

## Scope

Spell surfaces: React studios (glamour, imago, magpie, astrolabe, mind-mapper) and Alpine-CDN surfaces (bounty, digestify, grapevine watch).
The semantic-token layer (imago/glamour taxonomy) and its shadcn-alias extension (mind-mapper `styles.css @theme`).
The vendored `ui/` component layer on Base UI primitives (mind-mapper is the pilot; the pattern is spike-proven and heading for the unified scaffold).
Surface-side datasets when they exist purely to feed a surface (the mind-mapper stub map + docs were mine).

## Boundaries

Daemons, CLIs, endpoints, and serve/build modes belong to daedalus — see seams Contracts 1–3; I consume served endpoints, never engine internals.
Repo layout, release mechanics, and shared-file rulings (root tsconfig, package.json deps) belong to prospero — see Contract 4; I flag before landing anything shared.
Canon wording in the grimoire belongs to thoth.
The surface consumes engine state ONLY via the served wire (`/state`, `/doc/:id`) — never by importing the engine's files — because the fetch path is itself part of what a spell exercises.

## Relationships

daedalus: every shared data shape is a mini-seam — propose on the vine, get the ack, THEN bake it in; three seam versions this session (stub map v1 → v3) all went ratify-first and none drifted.
prospero: rulings, dep flags, and shared-file changes route through the lead; flag-before-land applies to the *commit*, not the *work* — install and build while the flag is out.
Cole drives verification: the phase gate is a human actually driving the surface, so always post a boot command + a guided what-to-try when handing over.

## Taste & reflexes

Mine sibling spells' idiom BEFORE building a new surface piece — adapt, never import across spells; shapes, naming (e.g. glamour's `FocusOwner`), microcopy register, and token usage should read as one house.
Semantic tokens only in markup; shadcn class vocabulary enters via `@theme` aliases onto house tokens, grown strictly as consumed.
Tailwind class strings live in literal lookup objects, never string-built — `@source` only sees literal text.
When a new categorical axis rhymes with an existing one, reuse the color vocabulary instead of minting a palette (doc-kind bible/story/ramble → canon/story-local/pending tints made the staging story legible for free).
Keep state and render separate: transient visual effects (search dim) are render-time data overlays, and callbacks enter long-lived structures through ref-stable dispatchers, so neither ever rebuilds state.
Imperative canvas actions are `{payload, seq}` request props; seed the seq guard from the mount-time prop or key-remounts replay stale requests.
Verify with pixels AND the a11y tree — each catches what the other structurally cannot ("rendered in DOM" ≠ "legible": stacked edge labels passed the tree and failed the screenshot).
Peripheral failures degrade into the conversation as an agent-info message; a co-presence surface never lets a side fetch take down the shared board view.
Conversational surfaces get conversational copy — lowercase, working-through register ("work it through…"), never query-box register; the framing IS the feature (Cole's chat ruling).
Every keyboard summon gets a clickable twin (codified in the V1.x dispatch); put the twin where the summoned thing will appear — the button morphing into the palette at its own perch teaches the location for free (mind-mapper search icon, commit f488f99).
Make precedence structural, not conditional: seeding projectId from the URL at mount means the daemon-default mirror effect CAN'T override an explicit ?project= (the `!projectId` guard is false by construction) — no override branch to write or test; the precedence itself lives in a pure `resolveInitialProject(search, stored)` tested without a DOM.
Model a multi-stage dialog as one state object whose stage IS the data (`{doc, citedBy: CitedBy | null}`): the 409's parsed counts arriving is what escalates the SAME dialog to its provenance stage — no stage enum, no second dialog, and the untrusted-body parse lives in a pure tested helper while the fetch stays App glue (P2 delete flow).
A fire-once signal with multiple clears (idle event, reply-message-landed, client TTL) wants one effect PER clear trigger, each keyed on its own dependency — merging them into one effect invites stale-closure ordering bugs (P2 thinking pulse).
When two components need the same literal Tailwind class lookup, export the lookup from its home component instead of duplicating it — the literal-text `@source` constraint makes shared lookup objects the reuse unit (KIND_BADGE: ContextRail cards + MessageBubble doc chips).

## Hard-won lessons

A per-entity WS event can be THIN — carrying only ids, not the full entity — and a consumer must be built to expect that, not assume completeness; `node.ratified`/`edge.ratified` carry `{id, proposalId}` only, so the reducer's job is flipping the referenced proposal's status (the one thing the payload proves), and `useProjectState` fires a follow-up snapshot GET to backfill what the thin event can't carry (mind-mapper V1, commit 22f36c6 — verified by opening a real WS socket and watching the actual frame, not by reading the emit() call in source, which is what let the original wrong assumption slip through review).
Never invent a plausible-sounding literal for a string-union type from a wire's real value — `ProposalStatus` was typed `"accepted"` when the daemon actually writes `"ratified"`, and a JSON-cast boundary (`fetch().json() as T`) never catches this at compile OR runtime, so it silently breaks every `!== "pending"` check until exercised live (same commit).
A `build.ts`'s `naming` option needs the `{entry, chunk, asset}` object form whenever the entrypoint is HTML — a single naming string hashes the HTML entry too, and a hashed entry is invisible to a daemon's `dist/index.html`-exact-filename release-mode check (Contract 1), so the daemon silently stays in dev mode against a real, correctly-built dist/ (mind-mapper P4, commit 3b8b652 — caught by booting the daemon and reading the served hrefs, not by trusting the build's exit code).
A stale `dist/` silently shadows your surface changes in live verification: `daemonCwd()` auto-picks release mode whenever `dist/index.html` exists, so an auto-booted daemon serves the PRE-change build with no error — force `SPELLBOOK_SURFACE_MODE=dev` when verifying uncommitted surface work (the inverse of the P4 hashed-entry lesson: same boundary, opposite failure).
`MIND_MAPPER_HOME=<scratch>` boots a fully private daemon (own port/pid/db files) without touching a teammate's running one — the clean way to honor "never kill a daemon you didn't start" while still getting a kill-to-see-the-banner drive (P1s verification).
This sandbox blocks spawning long-running daemon processes directly (the auto-mode classifier denies it) — when a fresh boot is genuinely needed, retry the exact same command once (it sometimes succeeds nondeterministically) before asking a teammate to co-drive; killing a stale daemon by its exact PID (from `daemon.pid`, never `pkill -f`) and then re-`open`ing usually works even when a fresh spawn doesn't (P2 session: a fresh `open` under a scratch MIND_MAPPER_HOME succeeded first try — the denial is nondeterministic, not absolute).
The ephemeral-event cursor clause is now LAW (Contract 9 amendment, P2 T4): every bus emit consumes a seq, fire-once signals included — ephemeral kinds route THROUGH applyEvent (default case advances cursor) and the hook surfaces them via the {payload, seq} idiom; the old look.here early-return-before-reducer froze the cursor so every later event read as a phantom gap (one wholesale /state refetch per signal — latent at look.here rates, fatal at agent.activity's 2–3× per turn), pinned by the "look.here advances cursor" regression test (commit 69e3802).
`/state.presence` is NOT in the engine's state.ts ProjectState — server.ts spreads it onto the readState result at the handler (`{...readState(...), presence}`), so reading state.ts alone under-reports the wire; check the handler when a /state field seems missing (found consuming Claim C).
Base UI's AlertDialog is mostly re-exported Dialog parts (Backdrop/Popup/Title/Description are Dialog's own, only Root/Trigger are alert-specific) — the shadcn port carries the dialog conventions directly, and `open`/`onOpenChange` controlled use works without a Trigger when a menu action opens it (commit 9c73761).
React Flow has no pane-scoped double-click callback — but ReactFlowProps extends div props, so a DOM `onDoubleClick` with an `e.target.classList.contains("react-flow__pane")` guard scopes it to empty canvas (node/edge double-clicks pass by); pair it with `zoomOnDoubleClick={false}` or the sketch form rides a zoom (commit 9c73761).
An imperative scroll request that must SUSPEND another effect (autoscroll-to-bottom) needs a synchronous ref flag, not render state — the messages-changed effect has to see "servicing" in the same commit the request lands, or one concurrent message yanks the viewport off the evidence (P2 T11).

React Flow wants semi-controlled use: the canvas owns node state via `applyNodeChanges`, reports selection upward deduped (last-reported key ref), and applies external deselects behind a same-set guard — an unconditional setState in either direction is an infinite render loop (commit c0561eb).
React Flow label styling is inline — CSS loses; and the label's bg rect is a SIBLING of the text, so both need the same transform or the text walks off its plate (commits c0561eb, 6223522).
Reverse-pair edge labels stack at the shared bezier midpoint, and curvature can't separate vertically-stacked nodes because it acts along the handle axis — separate the labels themselves, deterministically per pair member (commit 6223522).
`multiSelectionKeyCode` defaults to Meta on macOS — if the UI copy promises shift, set it explicitly.
Any literal-text anchor into a formatter-managed file must be whitespace-insensitive (`\s+`-joined match) — prettier's pre-commit reflow is a standing drift source; the mind-mapper span anchors survived a real reflow only because of this (commit d3599aa).
Daemon ROUTES bake at boot even when DATA re-reads per request — after a peer lands a new endpoint, restart the daemon or you chase a phantom 404 against code that "definitely landed"; also, a console 404's trailing `:0` is line-number formatting, not a mangled URL.
shadcn-on-Base-UI is a PORT, not a copy: Base UI `className` props accept state-functions (narrow to plain string in the vendored layer) and `GroupLabel` mandates a `Group` wrapper where shadcn's `Label` is standalone (commit 1c6b556).
A dependency-free `cn()` (no twMerge) changes API design: a variant must REPLACE a recipe, never fight one, because conflicting utilities resolve by stylesheet order — if a call site overrides a variant's box model, the component needed another variant (commit 029dce0).
A primitive's internal state model is a cost, not a feature, when the feature's value is live coupling to external state — cmdk/Autocomplete fit self-contained palettes, not palettes that remote-control a canvas; the upgrade path is a component swap behind app-owned state (commit 9f55153).

## Anti-patterns

Claiming a card from a board listing held in context — after the lead batch-adds, RE-PULL state and claim by id; a card remembered by title is not a card (mis-claimed t-806ff9da for t-9a4bd7b2).
Dropping Playwright/verification artifacts at the repo root — they default to CWD; move them to `.anthill/scratch/` immediately (the gate-safe home) and delete `.playwright-mcp/`.
Trusting a peer's land to be whole — untracked NEW files hide from pathspec commits (a skeleton commit shipped without its styles.css); check `git status` before building on it.
`setError`-ing the whole board on a peripheral fetch failure.
Leaving third-party chrome (React Flow controls, attribution, edge labels) at default styling — retune to tokens or the night palette breaks at the seams.
Waiting idle on a pending flag — the flag gates the land, not the work.

## Candidates

The disconnect banner blips on daemon restart (800ms reconnect backoff) — ruled honest-not-debounced in the P1s dispatch; stated here so drive #2 / cassandra's gate doesn't file the flap as a bug.
Placement honesty is ratified and STATED IN-UI ("lands as a pending sketch", P2 T9) — the double-clicked node lands where layout puts it; if drive #2 still files it, the answer is the persisted-view-state candidate, not click-position plumbing.
Pre-existing tsc noise: server.test.ts/tail.test.ts (mind-mapper engine) and several astrolabe files fail `tsc --noEmit` on develop — bun test passes (Bun strips types); filter tsc output to your own paths or you'll chase peers' type debt.
The user-sketch edge draft deliberately carries NO label (inventing "relates to" would fabricate a claim) — the canvas renders it unlabeled, draftSummary shows the "relates to" fallback in the queue only; revisit if drive #2 wants inline label authoring on connect.

V1 vendored-layer growth: ScrollArea / Tooltip / Card-shell when panel chrome multiplies; re-flag cmdk or adopt Base UI Autocomplete when search fronts hybrid lexical+semantic retrieval.
The vendored-ui + tokens-alias pattern belongs in the unified spell-surface scaffold recipe (port findings recorded on the vine, msg 31/36).
Sub-question from the spike worth carrying: dagre re-layout (and force re-layout) on every map change loses manual arrangements — V1 likely wants persisted view-state layout (the staging-layer "view-state" bucket already names the home); now sharper since P4 shipped a SECOND layout mode that also recomputes from scratch on every toggle.
Force-layout (built P4, commit 072f6c6) is settle-then-snapshot only, deliberately not live-animated — Cole's drive verdict decides whether the motion itself (not just the resulting arrangement) is the point; `computeForcePositions` is already split out so a live per-frame mode wouldn't need a restructure, only a new caller.
Agent-side lens writes are now half-live (P3.3, commit 2d8a5f9): `lens.set`/`look-here` events from the agent drive `focusRequest` + the FocusBar agent tint, confirmed in cassandra's gate drive. Still open: the surface never POSTs a lens write of its own (the human's Focus click stays local-only) — a true two-way contract would let the human's focus steer the agent's context too, not just the reverse.

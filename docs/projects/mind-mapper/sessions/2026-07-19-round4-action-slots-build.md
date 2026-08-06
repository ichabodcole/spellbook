# Session — mind-mapper Round 4: action slots + drive-3 fixes (2026-07-19)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-round4` (cut at convene off
develop @ a0c6f2a, same day Round 3 merged). **Plan:** `plan-round4.md`.
**Source:** drive3-findings.md triage (dogfood drive #3's 9 findings, run
earlier the same day).

## What was built

- **Per-node action slots** (the headline, finding 7 RULED): agent-authored
  custom CTAs on nodes AND pending proposals — target-keyed `node_actions`
  table, `PUT/DELETE /actions/:targetId`, `actions.set` event, soft-cap advisory
  past 4 (+16KB hard cap); lifecycle: ratify **re-homes** slots onto the minted
  node, reject/zone-delete clean, promote no-op. Surface: slots render in the
  shared context menu, visibly agent-suggested, click seeds the composer +
  ground (never auto-sends), 4 visible + scroll.
- **Ratify-anywhere** (finding 7's first standard action): `IdeaNode`'s menu
  extracted into a shared `NodeContextMenu`, CardGrid cards wrap it; accept at
  `suggestedTier`, Claim-D withdraw asymmetry mirrored, typed 409
  `{error:"zoned", zoneId}` rendered honestly ("still in zone — promote first").
  Tier ⊄ Ruling catch: background-suggested proposals get no menu ratify (the
  queue stays their home).
- **Automated activity ladder** (finding 4): user send + ≥1 agent tail → auto
  `received`; agent writes resolve auto states; agent send is the turn's
  terminal act (also resolves explicit thinking); TTL supersession:
  `received→stalled` (persists, daemon-synthesized only, POST rejects it),
  `thinking→idle` unchanged. Surface: stalled is a static attention-tinted
  branch — never the thinking pulse (the false-liveness rule).
- **Doc kind honesty** (finding 1): intake defaults dead; `''` sentinel
  null-normalized at read; `kind_author` additive column; `doc kind` verb +
  `doc.kind` event; null kind = badge absence; asserted-vs-agent styling from
  `kindAuthor` (legacy rows honestly unattributed).
- **Build stamp + staleness guard** (finding 3): clean→build→stamp
  (`dist/build.json {commit, builtAt}`), release boot logs it, STALE DIST stderr
  warning when src outruns the stamp, `/state.buildInfo` (handler-spread),
  surface footer (absent = nothing). Stamped dist landed.
- **Always-open search** (finding 8 RULED) + **selection→ground on send**
  (finding 2): `search.open` dead, permanent input is its own clickable twin;
  `groundBundle.ts` unions node/proposal selection with the open doc
  (`doc:<id>`) at the single send choke point. Gate-found CLI hardening:
  `send --ground` repeats now accumulate (was silent last-wins loss).

## Method notes

Ratify round falsified 2 of 7 claims — both owners independently converged on
A1's hole (proposals don't live in `nodes[]`; the drafted wire couldn't carry
Cole's proposals-get-actions constraint), and daedalus measured K1's mechanism
impossible (SQLite can't drop NOT NULL) — the `''`-sentinel + additive-column
correction kept the migration doctrine intact. Drive-3's "liveness ping" was
formally dropped at ratify (SSE has no ack transport). **The cold gate PASSED on
the first drive** — a team first (V1.x and R3 both failed round 1); the
Contract-9-before-consumption bar held at zero wire-guess failures for the
second consecutive round. Gate still earned its keep: three casting-draft
advisories plus the round's one silent-loss trap (`--ground` repeat last-wins),
fixed in rework 5323214. Process hazard logged: a verification build on the
shared tree bakes peers' uncommitted src into committed artifacts (daedalus
caught + restored; fed back upstream).

## Commits

Plan `f1e2eb6`/`caa5a4a` · daedalus
`88d2b4c 6167798 52fdfa8 3f6abf2 766dba8 5323214` · circe
`1ae2e2c e449184 9d1a9ba f812db4 6c54908 0077faa bad6c07` · lead dist land
`(stamped build.json bad6c07)`. Suite: **984 pass / 0 fail**; mind-mapper
tsc-clean.

## For Cole at dogfood drive #4

- Action slots: I (casting agent) attach them via `actions <targetId>`; they
  appear in right-click menus only (not NodeDetail's verb row) — discoverability
  is a deliberate open question.
- Ratify-anywhere: right-click any proposed card (canvas or grid). Your 29
  pending proposals on `session-3-dream-exploration` are the natural corpus.
- The thinking indicator is now automatic — and `stalled` ("agent may be stuck")
  appears if I sit on a message >60s; a human ratify click clears it (as-ruled).
- Docs land untyped now; kind is set deliberately (badge styling: solid border =
  user-asserted, dashed = agent-set).
- The footer build stamp renders only on release-mode boots of the freshly
  stamped dist.

## Deferred (unchanged)

Design items awaiting proposal pass: data-adjustment / content-creation
taxonomy, node-anchored submaps, OKF boundary adapter (watch Cole's OKF adoption
in Operator). Carried: derive layer + embeddings; Track B house extraction
(chat/rail/presence/CLI — auto-activity pattern now feeds it).

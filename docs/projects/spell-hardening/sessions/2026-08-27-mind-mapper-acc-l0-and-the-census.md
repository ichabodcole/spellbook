# mind-mapper acc L0 — and the census that went 0/48 → 49/49

**Session 2026-08-27 · branch `feat/mind-mapper-acc-l0` · anthill subagent mode
(prospero lead, daedalus engine, cassandra verify) · comms anchor #1094.**
Origin: acc adopter trial round 3 (acc v0.1.4) ran cold against mind-mapper's
CLI and returned NOT CONFORMANT; the maintainer confirmed the trial's drift
finding as the first adopter-found instance of the class the kit was built on.

## Result

|                                    | before (fcdd3d5)                                                                                                | after (bb13208)                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| acc verdict                        | NOT CONFORMANT (L0) — C1, D1, A1, A3 core                                                                       | **CONFORMANT (L0)** — 0 core violated, 1 core UNVR (D3, astrolabe-class residual) |
| B5 (machine mode on parser errors) | unverified (nothing declared)                                                                                   | **hard pass** (defaultOutput json declared, envelope built)                       |
| census (recorded surfaces)         | 0/48 paths enumerated a rejection set; heterogeneous prose                                                      | **49/49** one-JSON-envelope stderr, uniform exits, choices everywhere             |
| repo gate                          | 1465 pass / 3 fail (2 inherited, later traced to develop's own acc landings outrunning the flag-invariant ward) | **1480 pass / 0 fail**                                                            |

## Commits (named-merge branch; keep history)

`3b2da2d` chore: acc pin v0.1.2→v0.1.4 (prospero) · `15513af` flag-invariant
ward catches up with develop's astrolabe/grapevine acc landings (daedalus) ·
`a3db2aa` lane A: help/--version/root-token rejections/acc.config.json ·
`f6cf91e` lane B: JSON error envelope (magpie taxonomy, bounty delivery,
error.server wrap) · `2f17bb5` lane C: CLI_OPTIONS registry + path-keyed
VERB_SPEC two-stage parse · `be379d5` lane D: cli-contract.test.ts (11 cells +
H16 mutation demos) · `dda033f` default-migration pin row (cassandra) ·
`bb13208` help-twin denominator line-anchored (cassandra's M3 vacuity finding).

The durable contract is **seams Contract 15** (the spell CLI process contract);
proof is `cli-contract.test.ts`.

## Decisions, with the options not taken

1. **changes / delete-batch / message → PUBLIC; message as alias-on-read-line**
   (#1096/#1097). Not taken: keeping them internal (no hidden-verb mechanism
   exists; unadvertised-but-dispatched is the drift class this branch closes)
   and giving message its own entry (alias semantics would drift).
2. **Daemon-HTTP refusals WRAPPED, body verbatim under `error.server`** (#1100,
   ratified #1101). Not taken: raw passthrough (breaks one-doc-on-stderr) and
   re-typing server bodies into the envelope (loses shape, invites drift).
   Caller-facing consequence: needs-project + 409-family moved exit 2→6,
   unknown-entity 2→5, typed bodies stdout→stderr.server.
3. **No defaults in the flag registry** — stage-2 stray detection is
   key-presence; defaults moved to consumption-site `??` (#1102, ratified #1103,
   pinned by dda033f). Not taken: defaults in the registry (blinds stage 2).
4. **no-daemon → not_found/5**, following magpie's no-session precedent exactly
   (#1101). Not taken: conflict/6 (re-litigating a settled house precedent for
   no distinguishing reason).
5. **Ward repair ruled in-scope for daedalus** (#1098/#1099) — the
   flag-invariant enumerator is his instrument (s5-H). Not taken: re-homing to a
   separate fix branch (it blocked every land this session).
6. **Registry→declaration (`schema` verb, grapevine endgame) ruled OUT of this
   branch** — L0 was the scope; schema emission is the follow-on. See deferred.

## Instrument ledger (the session's honest column)

- prospero landed 3b2da2d via bare `anthill commit` without the gate-composed
  string; caught from the envelope's `durationMs` (1065ms cannot contain a 145s
  suite), gate run after, green. The envelope field caught what the remembered
  rule did not.
- prospero read two false exit-0s by measuring `$?` after a `head` pipeline —
  third actor into that class in one week (acc maintainer, prospero at trial,
  prospero again). Unpiped re-measure was clean.
- daedalus's python regex sweep corrupted two non-target sites mid-flight
  (writeEnvelope itself; node-edit's guard) — caught by the suite pre-land.
- cassandra's first M7 mutation silently failed to apply (empty diff, green
  suite) — caught by diffing the mutation before trusting its green (sprint-05
  standing rule, exercised).
- The help-advertises twin was VACUOUS for 6/29 verbs (includes() over prose;
  token recurrence) — found by the non-author's mutation after the author's six
  demos passed; fixed line-anchored, convicted three times independently
  (daedalus ×2 verbs, prospero ×1).

## acc-kit friction (for the maintainers, deduped)

1. Census summary prints "none named a set" at paths whose recorded stderr
   carries a choices array — verb-shaped choice sets are not counted by the
   extractor (cassandra, #1105).
2. probe-plan harness stamps build provenance from the harness cwd, not the
   target's tree — and the guide's "batch lands in cwd" advice steers you into
   scratch dirs (trial; second adopter).
3. The safety guide's scratch-HOME containment misses targets that derive home
   from their OWN env var (MIND_MAPPER_HOME) — confirmed by the maintainer as a
   shipped-guide defect during the trial.

## Deferred (horizon + home, or dropped)

- **Declaration emission (`schema` verb) for mind-mapper + the census
  `--declaration` comparison** — horizon: not scheduled; home:
  `docs/backlog/2026-08-27-astrolabe-per-verb-flags-and-enumerated-rejections.md`
  gains a sibling note (mind-mapper + grapevine prior art now exists; grapevine
  `buildDeclaration()` is the reference).
- **grapevine prose-errors → Contract 15 envelope** — horizon: not scheduled;
  home: named in Contract 15 itself ("conversion unscheduled").
- **acc feedback to maintainers** — horizon: next acc-trial contact (channel is
  live); home: this doc's friction section; prospero sends the closing note.
- **Backlog note for the inherited flag-invariant failures** — DROPPED: 15513af
  fixed them; there is nothing left to record beyond this line.
- **anthill feedback (3 frictions + the H28 gate-evidence idea)** — FILED to the
  anthill-feedback grapevine channel, messages #24–27, 2026-08-27, on Cole's
  instruction; horizon: anthill's own triage; home: that channel (the sprint-04
  six remain unfiled, prospero seat doc Candidates).

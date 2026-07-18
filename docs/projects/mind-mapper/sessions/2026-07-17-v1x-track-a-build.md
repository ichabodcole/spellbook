# Session — mind-mapper V1.x Track A build round (2026-07-17)

**Team:** prospero (lead), daedalus (engine), circe (surface), cassandra (gate)
— subagent mode. **Branch:** `feature/mind-mapper-v1x` (cut at convene, off
develop @ 626fe17). **Plan:** `plan-v1x.md` (light-feature collapse; seam Claims
A–G ratified before build). **Source:** drive-findings.md Track A triage
(dogfood drive #1).

## What was built

The nine Track A drive findings, all landed and gate-verified:

- **Disconnect banner + composer disable** (finding 1) — the surface wears
  `ConnStatus`; sends can't silently vanish.
- **Tail hardening** (2, 11) — SSE keepalive frames + rolling idle-watchdog
  reconnect-with-cursor + epoch adoption (`epoch.changed` CLI-synthesized line).
  Gate-verified to survive daemon restart _across a port change_.
- **Doc context menu** (3, 5) — Delete with two-stage provenance confirm (409
  `citedBy` counts → force), Analyze as a grounded `kind:"analyze"` message
  (`ground:["doc:<id>"]` prefix grammar).
- **Doc-status marks** (6) — append-only `doc_marks` trail, freeform
  status/note, mtime-based staleness computed at `/state` read; rail badges; the
  agent's one-call re-grounding.
- **Presence + activity** (7, 14) — agents-only presence counted at the SSE
  site, 3-state dot, `POST /activity` received/thinking/idle with TTL,
  tokens-adapted ActivityIndicator.
- **Human canvas authoring** (9) — double-click node form + drag-connect edges,
  `author:"user"` through the same propose wire; asymmetric ReviewQueue (user
  rows = waiting-for-doc-home, agent rows = one-keystroke ruling).
- **Conversation evidence** (10) — `message_sources` sibling table +
  `evidence_message_id`; messages anchorable with span flash-scroll navigation.
- **Project-in-URL** (12) and **search icon** (15) — every keyboard summon gets
  a clickable twin.

Plus the gate rework: **ratify-time evidence attach**
(`ratify --doc <docId> --doc-edit <file> [--span]`) completing the human-sketch
inversion, and five casting-draft corrections.

## Ratify round (the method's yield)

Four claims falsified before build: the zombie-write hole (ratifying a pending
proposal citing a deleted doc would recreate the file), the NOT-NULL-DEFAULT vs
migration-invariant conflict, the sources NOT NULL relaxation SQLite can't do (→
sibling table), and the nonexistent `AbortSignal.timeout`-per-read mechanism.
Circe independently caught the ephemeral-event cursor bug (agent.activity would
have been a refetch storm; latent look.here bug fixed alongside). One as-built
correction mid-build: Bun's `enqueue()` on an orphaned stream never throws —
dead-socket teardown rides `req.signal` abort (measured).

## Gate

Round 1: FAILED — item 7 (human inversion unexecutable: no evidence-attach
path) + item 10 (three casting-draft wire-guess gaps). Rework → **cold re-drive
by cassandra: PASSED**, zero wire-guess failures, all guards loud on cli and
wire. A routing slip sent the first re-gate to the builder's thread; his honesty
flagged it and the true cold re-gate followed — the independence property,
re-learned.

## Commits (chapter-clean on the branch)

`241f343` plan · `ae73024` schema · `d7e61c0` tail · `1d91634` author ·
`8c095a9` message evidence · `16c8ee3` marks · `4cd5d59` delete · `f488f99` P1s
surface · `7f5718f` presence/activity · `fb1e819` casting-draft · `b1d7d2b` tsc
· `69e3802` + `9c73761` P2 surface · `87f2927`/`5b6d638`/`8200e0c` Contract 9
amendments · `35b7b9a` gate rework.

Suite: 824 pass / 0 fail; mind-mapper tsc-clean.

## Follow-ups

- Dogfood drive #2 (Cole) — the gate's stated precondition is met.
- Tracks B (house audits), C (research), D (parked) unchanged from
  drive-findings.md.
- Spell-local backlog: `release-serve.test.ts` SOURCE_FILES is a hand-mirrored
  list (readdir glob would kill the failure class); wire has no dry-run (probe
  bodies mint real proposals); `draft.tier` swallowed silently (null-tier queue
  row is the only symptom).

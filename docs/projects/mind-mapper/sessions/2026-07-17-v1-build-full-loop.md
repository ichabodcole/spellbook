# Mind-mapper V1 — ratified plan to passed acceptance test in one evening — 2026-07-17

## Context

Same-day continuation of the Phase 0 spike (see
`2026-07-16-phase0-spike-full-arc.md`). Cole approved moving straight into V1;
the team ran `anthill:plan` (skeleton → ratify → lanes) and built P1–P4 to the
V1 acceptance test. Team: prospero (lead), daedalus (engine), circe (surface),
**cassandra (verify, engaged at two mid-plan gates — not end-of-line)**. Branch:
`feature/mind-mapper-v1` (27 build commits + finalize docs).

## What Happened

**Plan phase worked as designed.** The skeleton's claims (A: dumb daemon, all
intelligence in the casting agent; B: docs own prose / sqlite owns
index+staging+conversation) ratified with zero falsifications but three genuine
improvements from the owners: per-entity-patch events (circe),
one-bus-two-transports WS+SSE (daedalus), conversation FTS5-indexed alongside
docs (daedalus). Promoted to seams Contract 8 up front, Contract 9 (the full
wire) at wrap.

**P1 (real state):** sqlite schema + projects + snapshot + event bus + read
verbs; surface reducer/hook rewiring. The gate **falsified on my independent
drive** after daedalus's self-drive passed: an existing store + evolved schema
500'd (`CREATE TABLE IF NOT EXISTS` never upgrades). Fix: additive column-diff
migration on open + a test that opens a PREVIOUS-schema store. Lesson: **the
reviewer's gate drive must not be the owner's**.

**P2 (ingest/conversation/staging):** landed cleanly; cassandra's cold-agent
gate PASSED (a genuine brain-dump → pending map with provenance, driven only
from `casting-draft.md`) and produced the friction list that added the doc-read
verb, the project-scoping rule, and the edge-draft schema question.

**P3 (ratify/search/lens):** the V1 acceptance test PASSED — accept-to-canon
with the sentence verifiably in the doc file + changelog, park/reject, the
proposal-id edge resolving only after endpoints ratified, byte-identical state
across kill/restart, and the agent-driven lens visibly moving the human viewport
(violet FocusBar). One real bug found (ReviewQueue badge staleness), whose root
cause was a **seam that had never been written down** — ratified events are
deliberately thin `{id, proposalId}`; the reducer had assumed full entities.
Fixed + pinned (now Contract 9).

**P4:** release-mode serve + committed `dist/` + force-layout toggle. Circe's
live build caught a **cross-contract gap**: Contract 2's uniform hash-naming
made the HTML entry invisible to Contract 1's `dist/index.html` release check →
Contract 2 amended ({entry, chunk, asset} naming form).

**Incident (honestly reported):** a `pkill -f "scripts/server.ts"` killed the
shared bounty daemon (name collision across spells) and the recovery clobbered
its snapshot — filed as spellbook #73 (close-clobbers-snapshot + no rotation);
exact-PID-kill became the standing counter-pattern, and unique daemon entrypoint
names are a house-style candidate.

## Notable Discoveries

- **Every falsification this session was a wire assumption** — the strongest
  evidence yet for the seams-first method; nothing broke at integration that
  hadn't first been an unwritten interface.
- **Verify-at-mid-plan-gates paid twice**: both cassandra drives found real
  bugs/frictions a green suite couldn't (FTS never populated; badge staleness;
  casting-doc gaps).
- Cassandra also surfaced a stronger-than-documented guarantee: the lens
  persists across restarts (addressable view-state in sqlite).

## Changes Made

Engine:
`db/project/state/events/ingest/propose/send/ratify/search/neighbors/ lens`
modules + server rewrite + CLI verbs (86 tests). Surface: reducer +
`useProjectState`, intake, ConversationPanel on the real bus, ReviewQueue,
search backend wiring, agent lens, force toggle, `build.ts` + committed `dist/`.
Docs: plan.md (ratified), lanes, casting-draft.md (two friction passes), seams
Contracts 8–9 + Contract 2 amendment.

## Next Steps

- Cole's drive of the full loop + merge decision (the human gate — cassandra's
  acceptance pass is necessary, not sufficient).
- Dogfood rounds: a real Cole brain-dump session; linked-Hollowbrook via
  Operator `extract_links` when their deploy lands.
- Coalescence: real name + kind reserve (thoth), SKILL.md from casting-draft.md,
  ward pass.
- Deferred/known: Seam-D dry-run rehearsal never ran (P4 cards closed before a
  cassandra drive was assigned); tail-resume-across-restart behavior is
  epoch-detectable but unexercised by a live consumer; V2 items per proposal.

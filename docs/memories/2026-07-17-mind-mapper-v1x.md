# Mind-mapper V1.x (Track A) built and gate-passed

**Date:** 2026-07-17 · **Branch:** `feature/mind-mapper-v1x` (awaiting Cole's
look + merge)

One anthill round (prospero/daedalus/circe/cassandra, subagent mode) built all
nine Track A drive findings from dogfood drive #1: disconnect banner,
self-healing tail (keepalive + watchdog + epoch adoption, survives restart
across port change), doc context menu (two-stage provenance delete +
Analyze-as-grounded-message), stigmergic doc-status marks with mtime staleness,
agents-only presence + activity ladder, human canvas authoring with the
ratify-time doc-attach inversion (`ratify --doc/--doc-edit/--span`),
message-anchored evidence (`message_sources`), project-in-URL, search-icon twin.

Ratify round falsified 4 of 7 seam claims pre-build (zombie-write hole,
migration invariant, SQLite NOT NULL non-relaxation, phantom AbortSignal
mechanism) + circe's ephemeral-cursor catch. Gate round 1 failed honestly
(inversion unexecutable, 3 casting-draft gaps); rework + cold re-drive passed
with zero wire-guess failures. Contract 9 carries the full V1.x amendment set.
824 tests green.

Lesson worth carrying: subagent re-dispatches route by thread, not seat — a
re-gate misrouted to the builder was caught only by the builder's honesty.
Verify the thread is the seat before continuing an agent.

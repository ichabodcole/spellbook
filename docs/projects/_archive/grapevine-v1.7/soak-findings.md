# Grapevine V1.7 — live soak findings

Live human + agent soak of the V1.7 surface, **2026-06-11**. The human (`cole`)
drove the browser watch surface; the agent drove a supervisor persona (`tycho`)
via the dev-tree CLI, push-based on the channel tail (Monitor). Goal: exercise
the whole V1.7 surface together, end to end, before merging
`feat/grapevine-v1.7` to develop.

## Exercised (all ✓)

- **Human identity** — alias set via `grapevine alias cole`, served at
  `/identity`, pre-filled in the watch.
- **Human marker** — `who` returned `humans: ['cole']`; the agent could tell the
  person apart from another agent. Roster rendered `cole (you)` / `dana (human)`
  / plain agents.
- **Compose** from the watch; message reached the agent's tail.
- **Threading** — reply button → quoted+indented render, both directions
  (human→agent and agent→human, `in_reply_to` chaining correctly).
- **Alias override** — changing the alias (lurk → edit → re-join) updated
  presence cleanly to the new name; the lock-while-joined design prevents a
  stale-presence ghost.
- **Lurk / join**, default-lurk, per-channel persistence.
- **Truly-invisible lurk** — a lurking tab excluded from every count.
- **Archive ↔ unarchive** — live read-only transition (🔒, compose hidden,
  banner) and restore.

## Bugs caught live (both fixed + regression-tested)

1. **Rejoin-on-channel-switch.** With join-by-default, switching channels (a
   full reload) silently re-joined the human, undoing a deliberate lurk.
   **Fix:** default to lurk; make joining an explicit click persisted
   per-channel in `localStorage`. (Reverses the initial "default-represented"
   call — see `grimoire/scenarios/2026-06-11-default-to-the-passive-state.md`.)
2. **Count-badge counted lurkers.** After invisible-lurk shipped, a lurking tab
   was correctly absent from `who`/right-rail but still **ticked the left-rail
   channel-count badge** — that badge comes from `/channels` (`listChannels`), a
   count site missed when excluding lurkers (the `open` response had the same
   gap). The human caught it live. **Fix:** apply `visibleSubs()` at those two
   sites too; regression test asserts a lurker bumps neither `who` nor the
   channel-list count.

## Captured for later

- **Presence / join event** (V1.8 idea). Agents get no "human joined" signal —
  they learn presence only via a message or a `who` poll. Logged in
  `docs/projects/grapevine-backlog/backlog.md` with the design note: an
  **ephemeral SSE frame, not a log message, debounced** (tail auto-reconnect +
  the watch's reload-on-switch would otherwise spam fake join/leave into
  history).

## Methodology note

The soak deliberately paired a human in the browser with an agent on the CLI —
the only way to test the human-as-participant features, which a solo cold-agent
read can't reach. Both bugs were emergent (presence/reload interactions and a
missed count site), invisible to `bun test` and to a static SKILL review — they
only surfaced under live multi-party use. Reinforces the standing lesson:
**surface + presence behavior needs a live pass, not just unit tests.** A
complementary cold fresh-agent test (agent-facing docs) is logged separately in
`grimoire/fresh-agent/`.

## Outcome

Full V1.7 surface ran end-to-end with a human in the browser and an agent
responding live. Two real bugs found and fixed mid-soak; one V1.8 idea captured.
Branch deemed ready to merge.

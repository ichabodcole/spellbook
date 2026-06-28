# Grapevine: add a `restart` (and `start`) verb for a clean daemon lifecycle

**Added:** 2026-06-15 **Status:** Shipped (archived 2026-06-28) — `start` (alias
`up`), `restart` (`--force`/`--yes`, live-fleet guard), and `roll`
(stop-hold-respawn-verify) all landed via the grapevine-operator-roll-safety
project. Lifecycle is now symmetric.

Grapevine has `stop` but no `start` / `restart`, so the daemon lifecycle is
asymmetric. The daemon auto-spawns on the first daemon-needing verb (`send` /
`open` / `tail` / `wait`), which covers normal use — but to bring it back up
cleanly **after** a `stop` (migrating the daemon between versions, or picking up
new code) there's no clean primitive: you have to `open` a throwaway channel and
`close` it. This bites during admin / maintenance ops, which are now more common
since grapevine moved homes (toolbox → spellbook) and versions shift under it.

(Read-only `doctor` / `info` / `list` correctly do **not** auto-spawn —
diagnostics shouldn't have side effects. This item is only about the missing
explicit start/restart, not changing that.)

**Proposed:** add `restart` (stop the running daemon + respawn fresh, no
channel) and optionally `start` / `up` (ensure-running, no channel). Makes the
lifecycle symmetric and turns "restart the daemon" into a one-liner instead of a
throwaway-channel dance. Grapevine revision → goes through `ward` (revising a
spell).

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — verb dispatch (`main`),
  `ensureDaemon`; `daemon.ts` — `stop` / `shutdown`
- Origin: surfaced restarting the grapevine daemon during the bounty session
  (legacy toolbox 2.10.0 → canonical spellbook 1.2.0 migration)

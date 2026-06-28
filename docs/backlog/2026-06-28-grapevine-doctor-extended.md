# Grapevine: extended `doctor` (`--fix` + deeper checks)

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived). The read-only `doctor` shipped (minimal version); these are
the follow-on capabilities left on the table.

The minimal `doctor` reports authoritative daemon, other daemons, channels on
disk, and version-mismatch hints — but takes no action. Still open:

- **`doctor --fix`** — auto-remediate the safe cases: kill orphan processes not
  claimed by any HOME's port file, remove stale port/pid files. Held back
  because "orphan vs other-HOME daemon" is ambiguous unless each daemon
  publishes its HOME (the deferred V1.6.2 scoping problem). `reap` already
  covers the orphan-kill case authoritatively, so scope this against `reap` to
  avoid overlap.
- **Dead-subscriber detection** — daemon-side check for `who` entries that no
  longer respond.
- **Orphan tail processes** — running `tail` processes with no corresponding
  subscriber registration (visible to `ps`, invisible to `who`); `doctor` could
  correlate.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `cmdDoctor`, `cmdReap`
- Note: `reap`/`stop --hold`/`roll` already shipped
  (grapevine-operator-roll-safety), so check overlap before building `--fix`.

# Bounty: `sessions` filter / limit / recency

**Added:** 2026-06-15

`cli.ts sessions` lists every snapshot under `$BOUNTY_HOME` with no cap — a
haystack for `--restore` once a few sessions accumulate. (The worst contributor,
the e2e suite leaking snapshots into `~/.bounty`, was fixed during the
migration.)

Cap to the N most-recent by mtime, or add a `--limit` / `--since` filter. (LOW)

## References

- `plugins/spellbook/skills/bounty/scripts/cli.ts` — `cmdSessions`
- Origin: `docs/projects/_archive/bounty-agent-usable/backlog.md` (F2)

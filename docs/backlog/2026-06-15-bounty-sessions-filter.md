---
type: backlog
title: "Bounty: `sessions` filter / limit / recency"
status: stable
description:
  Add filtering, limit, and recency options to the bounty sessions list command
lifecycle: open
generated: { by: unknown, at: 2026-06-15 }
---

# Bounty: `sessions` filter / limit / recency

`cli.ts sessions` lists every snapshot under `$BOUNTY_HOME` with no cap — a
haystack for `--restore` once a few sessions accumulate. (The worst contributor,
the e2e suite leaking snapshots into `~/.bounty`, was fixed during the
migration.)

Cap to the N most-recent by mtime, or add a `--limit` / `--since` filter. (LOW)

## References

- `src/bounty/backend/cli.ts` — `cmdSessions`
- Origin: `docs/projects/_archive/bounty-agent-usable/backlog.md` (F2)

---
type: backlog
title: "Grapevine: `rename <old> <new>` verb"
status: stable
lifecycle: open
generated: { by: unknown, at: 2026-06-28 }
---

# Grapevine: `rename <old> <new>` verb

A daemon-aware channel rename. Today a rename means manually checking whether
the channel is loaded, renaming the JSONL file, and rewriting the `channel`
field on every existing message line — ~5 lines of script, each a footgun on a
loaded channel.

**Sketch:**

- `cli.ts rename <old> <new>` — daemon-aware.
- If loaded: drop subscribers cleanly, rename the file, rewrite the `channel`
  field on existing messages, reload at the new name. If not loaded: file +
  JSONL rewrite only.
- Idempotent (`old == new` is a no-op). Errors: source-missing,
  destination-exists, source-active (maybe require `--force` for active).
- Optional polish: emit a `kind:"renamed"` event to current subscribers before
  the rename so their tail can reconnect or exit cleanly.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — verb dispatch (`main`)
- `plugins/spellbook/skills/grapevine/scripts/daemon.ts` — `channelPath`,
  channel load/reload
- Revising a spell → run through `ward`.

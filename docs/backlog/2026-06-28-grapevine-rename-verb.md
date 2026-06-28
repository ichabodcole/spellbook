# Grapevine: `rename <old> <new>` verb

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); surfaced during the V1.6.1 rollout (had to hand-write a
script to rename `grapevine-v17` → `grapevine-v1.7`).

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

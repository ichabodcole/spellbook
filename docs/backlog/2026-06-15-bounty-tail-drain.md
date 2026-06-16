# Bounty: one-shot `tail --drain` / `--once` for episodic consumers

**Added:** 2026-06-15

`cli.ts tail --since N` streams then blocks forever; the only documented
non-blocking consume is wrapping it with the Monitor tool (push-shaped). An
episodic agent (per-turn catch-up, like grapevine's `pull`) has no clean
primitive — it must background the tail and kill it, and macOS has no `timeout`.

Add `tail --drain` (or `--once`): replay from `--since` to the current cursor,
then exit 0. Completes the consume-mode story (push = Monitor, episodic =
drain). Surfaced by both cold workers in the fresh-agent fleet test (MED).

## References

- `plugins/spellbook/skills/bounty/scripts/cli.ts` — `cmdTail`
- Origin: `docs/projects/_archive/bounty-agent-usable/backlog.md` (F1)

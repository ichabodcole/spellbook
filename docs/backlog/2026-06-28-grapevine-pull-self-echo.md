# Grapevine: `pull --as <alias>` self-echo suppression

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); grapevine-feedback triage (robin #8). **Priority:** Low —
capture, don't schedule on its own.

`tail --as <alias>` filters the caller's own messages from the stream;
`pull --since <id>` does not. Since `pull`'s dominant use is recovering a
message the caller was notified about, the range result interleaves their own
sends, which they hand-skip. Accept `--as`/`--from` on `pull` with tail's
self-echo semantics.

robin noted this "largely evaporates" now that `read <channel> <id>` shipped —
it's strictly a fallback behind that single-message verb. Logged so it isn't
re-derived; not worth scheduling alone.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `cmdPull`; mirror the
  `tail` self-echo filter (`if (myAlias && payload.from === myAlias) continue`).

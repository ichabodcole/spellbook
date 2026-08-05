# Grapevine: bounded / non-follow mode for `tail` (history backfill)

**Added:** 2026-08-05 · **Tracks:** GitHub issue
[#75](https://github.com/ichabodcole/spellbook/issues/75)

`grapevine tail --from-start` streams history and then goes **live** (follows).
A joining seat that only wants to **backfill the vine's existing history** and
proceed has no bounded one-shot option. On macOS (no coreutils `timeout`) the
workaround is a background-write + `sleep` + `kill` dance just to capture the
backlog and stop — awkward, racy, and it's exactly the step the `anthill:join`
skill leans on every time a seat joins.

Add a `--no-follow` (or `--dump`) flag that prints the requested range
(`--from-start` / `--since <id>` / `--last <n>`) and **exits 0** instead of
tailing live.

## Design this with the bounty twin — same primitive, two spells

[`2026-06-15-bounty-tail-drain.md`](./2026-06-15-bounty-tail-drain.md) asks for
exactly this on bounty (`tail --drain` / `--once`), from an independent source
(the fresh-agent fleet test). **Two spells, two sessions, same missing
primitive** — pick one flag name and one semantic and ship both, rather than
letting `--drain` and `--no-follow` diverge into two spellings of one idea.

The consume-mode story it completes: **push = Monitor, episodic = drain.**

## Acceptance Criteria

- [ ] `grapevine tail --from-start --no-follow` prints the backlog and exits 0
      without following.
- [ ] The flag composes with `--since <id>` and `--last <n>`.
- [ ] The same verb/semantic lands on bounty `tail` (closing the twin item).
- [ ] `anthill:join`'s backfill step becomes one clean command — check whether
      the anthill skill needs a matching update filed upstream.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `cmdTail`
- `plugins/spellbook/skills/bounty/scripts/cli.ts` — `cmdTail` (the twin)
- Context: anthill multi-seat session (Operator monorepo); the join-history
  backfill hit this repeatedly
- ⚠ Coordinate with
  [`2026-08-05-cli-stdout-truncation-on-pipe.md`](./2026-08-05-cli-stdout-truncation-on-pipe.md)
  — a bounded dump that exits is **exactly** the shape that loses its tail to
  the `process.exit` truncation bug. Fix the drain first, or this ships a new
  way to silently lose history.

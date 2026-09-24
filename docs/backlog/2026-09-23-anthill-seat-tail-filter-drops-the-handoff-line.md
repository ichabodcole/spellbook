---
type: backlog
title: "Anthill: the seat's bounty tail filter drops the handoff line"
description:
  Anthill's `team-join` hands each seat a bounty tail piped through a grep that
  drops the tail's handoff line, so a seat's watch dies silently at the Monitor
  cap; carry the one-line fix to anthill
tags: [anthill, bounty, tail, monitor]
status: draft
lifecycle: open
generated: { by: claude-opus-5.5, at: 2026-09-23 }
---

# Anthill: the seat's bounty tail filter drops the handoff line

**This is anthill's code, not ours.** It is filed here so it can be carried to
anthill; nothing in this repo changes.

**Filed on anthill, 2026-09-24:**
[ichabodcole/anthill#113](https://github.com/ichabodcole/anthill/issues/113).
This item stays open until anthill ships the fix.

## What happens

Since `feat/tail-quiet-handoff`, every spell's `tail` ends its own watch just
before Claude Code's Monitor cap (30 minutes). Its last stdout line names the
agent's next act, with the `--since` bookmark included: `tail.window` (re-arm
Monitor), `tail.quiet` (run `tail --once` as a background Bash task),
`tail.woke`, `tail.closed` or `tail.lost` (see `src/kit/wire/tailHandoff.ts`).

Anthill's `team-join` hands each seat this command
(`scripts/anthill/commands/team-join.ts:460`, anthill 2.3.0, installed cache and
marketplace copies both):

```
bun <bounty cli> tail --mine --as <handle> | grep -E --line-buffered '"type":"(task|unblocked|closed)"'
```

The grep drops every `tail.*` line. So when a seat's window ends, its Monitor
reports only "stream ended". The seat gets no re-arm command and no bookmark. If
it re-arms from memory without `--since`, the board replays. If it doesn't
re-arm, it goes deaf. Reported by the no-stake verifier on
`feat/tail-quiet-handoff`. Checked here against the filter itself:

```
$ echo '{"type":"tail.window","cursor":7,"next":"monitor"}' | grep -E '"type":"(task|unblocked|closed)"'; echo $?
1
```

## A second defect in the same filter, found while filing this

`"type":"(task|unblocked|closed)"` requires the type to be exactly `task`, and
bounty's events are `task.add`, `task.update`, `task.toggle`, `task.move`,
`task.edit` and `task.remove` (`src/bounty/backend/server.ts` header). Checked:

```
$ echo '{"id":3,"type":"task.update","owner":"x"}' | grep -E '"type":"(task|unblocked|closed)"'; echo $?
1
```

So a seat's lane never wakes on a task change, only on `unblocked` and `closed`.

## The change anthill needs

In `team-join.ts:460`, replace the pattern with:

```
'"type":"(task\.[a-z]+|unblocked|closed|tail\.[a-z]+)"'
```

Then, where the checklist says how to keep watching, point at bounty's skill
rule ("Keep watching past Monitor's 30-minute cap"). Or say the same thing
directly: set `timeout_ms: 1800000`, and when the watch ends, do what the last
`tail.*` line's `next` says with its `command`, appending the same grep when
re-arming Monitor.

## Acceptance Criteria

- [ ] A seat's Monitor shows `tail.window` / `tail.quiet` when its window ends.
- [ ] A seat's Monitor wakes on `task.*` events in its lane.

## References

- `src/kit/wire/tailHandoff.ts` (the handoff line and its decision log)
- `plugins/spellbook/skills/bounty/SKILL.md` ("Keep watching past Monitor's
  30-minute cap")
- [The Monitor-expiry backlog item](./2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md)

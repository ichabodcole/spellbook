# `bounty message` reports success and leaves nothing to read back

**Added:** 2026-08-06

Found during `spell-hardening` sprint 01's envelope audit. **Not among the
fourteen.** Same family as `#83`/`#84` — a write-shaped verb reporting success
with nothing behind it.

`bounty message` answers `{"ok":true,"sent":"message"}` and exits 0. In
`server.ts:949-950` the handler calls `broadcast(...)` with **no
`events.push(...)`** — so the message goes out to whoever is attached at that
instant and is never recorded. **It is alone among the write paths in this**:
`task.add`, `update`, `claim`, `block`/`unblock` and `remove` all append.

The consequence is the one that matters for agents: **a caller who was not
attached at that moment has no way to discover the message existed**, and no way
to distinguish "nothing was sent" from "I missed it." The envelope says `sent`,
which is true — transport succeeded — and reads as durable.

Note the interaction: this is the same word (`sent`) that `bounty/SKILL.md`
warns about at `:679-681` — _"a transport ack, not proof the daemon applied your
intent. When it matters, follow with `state`."_ **For `message` that advice does
not work**, because there is nothing in `state` to follow up with.

## Acceptance Criteria

- [ ] Either `message` appends to the event log like its five siblings, or the
      envelope stops implying durability and the SKILL.md says so plainly.
- [ ] A caller attaching after the fact can determine whether a message was
      sent, or is told they cannot.

## References

- `plugins/spellbook/skills/bounty/scripts/server.ts:949-950`
- `plugins/spellbook/skills/bounty/SKILL.md:679-681`
- `docs/projects/spell-hardening/sprints/01-drained-exit/plan.md` — candidate 7
- Related: `#83`, `#84` (the same family, already in scope as P0d)

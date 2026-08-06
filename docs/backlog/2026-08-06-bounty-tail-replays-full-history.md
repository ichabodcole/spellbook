# `bounty tail` replays its entire event history with no default anchor

**Added:** 2026-08-06

Found during `spell-hardening` sprint 01 while building fixtures. **Not among
the fourteen.**

`bounty tail` has no default starting point, so attaching to a long-lived board
replays **every event since the board opened** before any live event arrives. A
seat attaching mid-session cannot tell replayed history from what is happening
now — the frames are identical.

`--since <cursor>` exists and works. The defect is the **default**: the safe
behaviour requires knowing to ask for it.

**The comparison that makes this filable rather than a preference:** the comms
wire has the identical behaviour and **documents it**, and even so the lead of
one session had to be told about it out of band. Undocumented, the same shape is
strictly worse.

## Its grapevine twin is already filed

`2026-06-30-grapevine-monitor-friction.md` §2 describes the same defect on the
grapevine side — a cold or reconnecting tail replaying the backlog as apparent
live events. **Fix them together or deliberately don't**, but don't let one
spell's tail learn an anchor while the other doesn't; the whole point of
`spell-hardening` is that inconsistency between spells that should behave alike
is itself the defect. Partial mitigation exists there (`tail --last <n>`
shipped), which is a candidate spelling for this one.

## Acceptance Criteria

- [ ] `tail` has a defensible default anchor, or announces on attach how much of
      what follows is history.
- [ ] Whatever is decided is the same decision for bounty and grapevine.

## References

- `docs/projects/spell-hardening/sprints/01-drained-exit/plan.md` — candidate 8
- Related: `2026-06-30-grapevine-monitor-friction.md` §2 (the twin)
- Note for whoever builds `spell-hardening` P0f: the full replay is **how you
  build a >64KiB `tail` fixture**, and it is also a behaviour you could easily
  mistake for damage your change caused.

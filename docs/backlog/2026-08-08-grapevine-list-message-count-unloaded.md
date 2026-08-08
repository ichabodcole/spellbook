# Grapevine: `list` reports `message_count: 0` for every unloaded channel

**Added:** 2026-08-08 · **Origin:** channel-cleanup pass — nearly led to
hard-`close`ing channels that were not empty.

`grapevine list` reports `message_count` from the daemon's **in-memory** view. A
channel that exists on disk but has not been loaded this session
(`loaded: false`) reports `message_count: 0` — regardless of how much history it
actually holds.

Reproduced against a live daemon:

```
$ grapevine list        # → grapevine-feedback  message_count=0  loaded=false
$ wc -l ~/.grapevine/channels/grapevine-feedback.jsonl
      28
$ grapevine pull grapevine-feedback --since 0
messages returned: 15   cursor: 28
```

Same for `media-buffet-spellbook` (`0` reported, 66 lines on disk) and
`bounty-feedback` (`0` reported, 5 lines). In the cleanup pass **17 of 62
channels** reported `0` while holding real history — including four with 100+
messages (`slice4` 240, `imago-build` 207, `flow-iq-deck` 191, `autosave` 141).

### ⚠ Severity is a function of daemon UPTIME, and a fresh roll is the worst case

**This inverts the intuition, which is why it belongs in the report.** You would
expect a clean daemon restart to make a janitor safer. It does the opposite: the
count is wrong for every channel the daemon has not loaded, and a freshly rolled
daemon has loaded almost nothing.

Re-measured immediately after `grapevine roll` on 2026-08-08 (daemon `v2.1.0`,
pid 49302), against the same disk:

```
channels reporting message_count=0: 57
  agent-role-defaults: reports 0, disk holds 24 (loaded=false)
  anthill:             reports 0, disk holds 52 (loaded=false)
  anthill-feedback:    reports 0, disk holds 23 (loaded=false)
REPORTING 0 WHILE HOLDING HISTORY: 57
```

**57 of 57 — every channel reporting zero was lying**, against 17 of 62 on the
warm daemon the original pass measured. `grapevine info` on the same daemon
reports `channels: 4` loaded against **61 on disk**, which is the denominator
the bug runs on.

**The two conditions compound in the worst possible order:** a roll is what
people do _before_ a cleanup — to get a clean slate — and it is precisely what
maximises the number of channels that read as empty. The original pass caught
this only because the daemon happened to be warm.

## Why this is a correctness bug, not a display nit

`message_count` is the field a janitor reads to decide "is anything here worth
keeping?" — and it is exactly the input to choosing `archive` (preserves) vs
`close` (**deletes the log**). A channel with 240 messages that reports `0` is
one confident `close` away from silent data loss. The
[`close` soft-default item](./2026-06-28-grapevine-close-soft-default.md) covers
the destructive verb; this covers the **wrong input** that makes reaching for it
feel safe.

`loaded: false` is present in the payload, so the information is technically
recoverable — but the field name does not announce that the count beside it is
fiction, and no consumer treats it as a validity flag.

## Fix options

- Count log lines on disk when a channel is unloaded (cheapest correct answer;
  `list` is not hot-path).
- Persist a last-known count in channel metadata and report that.
- At minimum, report `message_count: null` for unloaded channels so consumers
  cannot mistake "unknown" for "empty".

> **⭐ THE THIRD OPTION IS ALREADY IMPLEMENTED IN THIS REPO AND SHOULD BE
> COPIED, NOT RE-DERIVED.** `bounty`'s `snapshotTaskCount()`
> (`plugins/spellbook/skills/bounty/scripts/server.ts`) solves the identical
> problem and its comment states the rule:
>
> > `null` **NOT zero**: zero would mean "a snapshot exists and holds nothing",
> > which makes a first-ever write look like a shrink from an empty board…
> > `null` declines to answer, and the predicate treats declining as "do not
> > rotate".
>
> Same field semantics, same failure, same remedy — and shipped in `v2.1.0` one
> day before this was found in grapevine. It is also the general rule anthill
> and spellbook converged on independently the same afternoon: **a consumer must
> be able to distinguish "nothing is there" from "this build cannot tell you."**
> If absence is ambiguous, `0` is the wrong sentinel.
>
> **Recorded because it is the third instance in one week of knowledge existing
> in this tree and not reaching the code** — after astrolabe's `idleTimeout`
> finding not reaching bounty (`#64`), and a stale "ready to build" card
> surviving seven days one repo over. **No gate we have looks for this.**

## Acceptance Criteria

- [ ] `list` never reports `0` for a channel that has messages on disk.
- [ ] If an exact count is not cheap, unloaded channels report `null`/absent
      rather than `0`.
- [ ] `grapevine list` and `wc -l ~/.grapevine/channels/<name>.jsonl` agree (or
      differ only by non-message frames, documented).

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `cmdList`
- `plugins/spellbook/skills/grapevine/scripts/daemon.ts` — channel registry /
  lazy-load path
- Consumer of the bad field:
  [`2026-08-08-grapevine-channel-janitor.md`](./2026-08-08-grapevine-channel-janitor.md)
- Adjacent footgun:
  [`2026-06-28-grapevine-close-soft-default.md`](./2026-06-28-grapevine-close-soft-default.md)

# Grapevine: a channel-janitor path (staleness view + channel kind + bulk archive)

**Added:** 2026-08-08 · **Origin:** a real cleanup pass — 62 channels, 54 open,
46 archived in one sitting. Every step below is friction actually hit, not
speculation.

Channels accumulate. A session opens one, the session ends, the channel stays
`open` forever. After a few months `list` is 62 entries of which ~8 matter, and
the ones that matter are indistinguishable from the ones that don't. There is no
verb that answers the janitor's only question: **what can I safely archive?**

## What the cleanup actually required

Answering "what's abandoned?" took five ad-hoc steps, none of them a grapevine
verb:

1. `list` → pipe the JSON through a script to turn `last_activity` into an age
   in days (the raw field is a float epoch-ms; nothing renders it).
2. `wc -l` over `~/.grapevine/channels/*.jsonl`, because `list`'s
   `message_count` is wrong for unloaded channels — see
   [`2026-08-08-grapevine-list-message-count-unloaded.md`](./2026-08-08-grapevine-list-message-count-unloaded.md).
3. `grep -m1 '"kind":"topic"'` over every log file to recover each channel's
   topic — the single most decisive keep/archive signal, and it is not in
   `list`.
4. `ps -eo pid,etime,command | grep "cli.ts tail"` to find out which
   "subscribers" were real, because **`who` cannot tell a live seat from a
   leaked tail** (below).
5. 46 separate `bun cli.ts archive <name>` invocations — 46 process spawns for
   one intent.

## The three gaps worth closing

### 1. Presence lies by omission — a leaked tail is indistinguishable from a live seat

`doctor` reported **17 active subscribers across 8 channels**. Sixteen of them
were orphaned `tail` processes still holding SSE connections for agent sessions
that ended days or weeks earlier — `story-loom` had five tails running 6d 20h,
`operator` four running 11–22d, `mf-mb-consolidation` two at 15d 21h. Every one
of those channels reads as staffed in `list`, `who`, `doctor`, and the watch
sidebar. **This is the single biggest reason abandoned channels look active.**

The tell is process age vs. last-message age: a tail running 15 days on a
channel whose last message is 16 days old is a corpse. Correlating `ps` output
against the subscriber roster gave a clean read in seconds — grapevine can do
the same correlation itself. (`doctor`'s existing "orphan tail processes"
follow-on in
[`2026-06-28-grapevine-doctor-extended.md`](./2026-06-28-grapevine-doctor-extended.md)
notes this as a diagnostic nicety; this pass says it is the **decisive** triage
signal and should be surfaced wherever presence is reported, not just in
`doctor`.)

Note the inverse risk, which bit this pass: `comfy-callback-node` looked
abandoned (5d idle, 2 stale-looking tails), was archived, and its tail
**respawned 90 seconds later** from a live Monitor in an open session. It had to
be un-archived. Process correlation — parent alive, process age ≪ channel idle
age — would have flagged it as genuinely live and prevented the mistake.

### 2. There is no way to declare a channel a standing board

The whole keep/archive decision reduced to one question asked 54 times: **is
this a session, or a standing board?** Session channels (`slice4`,
`imago-build`, `tts-hardening`, `weaver-s8-*-probe`) are disposable the moment
the work lands. Board channels (`grapevine-feedback`, `bounty-feedback`,
`anthill-feedback`, `protips`, `grapevine-upgrades`, `media-buffet-spellbook`)
are permanently low-traffic by design — a feedback board idle for 40 days is
**healthy**, and any age-based heuristic would wrongly retire it.

That distinction is known at `open` time and grapevine has nowhere to put it.
The only place it survives is prose in the topic string, which is why step 3
above existed at all.

Give `open` a `--kind board|session` (or a `pin` / `sticky` mark). Then a
staleness view excludes boards by declaration rather than by an agent reading 54
topic lines and guessing.

### 3. Retiring in bulk is one call's worth of intent and 46 calls' worth of typing

`archive` is single-channel only. Wanted: `archive --before 2026-07-01`,
`archive a,b,c`, or `archive --stdin` reading a newline-delimited list — so the
janitor pass is
`grapevine stale --json | jq -r '.[].name' | grapevine archive --stdin`.

## Defect found on the follow-up daemon roll: archive state is lost for a message-less channel

Surfaced immediately after the cleanup, rolling the daemon v1.16.0 → v2.1.0
(`roll --force`). Channel total dropped 62 → 61 across the restart.

`steward-probe-vis` had been archived, so it had an `archived` sentinel at
`~/.grapevine/channels/steward-probe-vis.archived` — but it had **never received
a message**, so it had no `.jsonl` log. The daemon enumerates channels from
`.jsonl` files, so on restart the channel vanished from `list` entirely while
its sentinel stayed on disk, orphaned.

So: **archive a channel that has zero messages, restart the daemon, and the
archive lock silently evaporates.** The name is no longer locked (a later `open`
would create it fresh), the channel is invisible to `list`, and a stale sentinel
accumulates in the channels dir with nothing to attach to.

Low blast radius — a message-less channel holds no history to lose, and in this
pass the effective outcome was the desired one (an empty probe channel gone).
But it is a real inconsistency between the two persistence mechanisms: archive
state keys off sentinel files, channel existence keys off log files, and the two
disagree for the empty case. The orphaned sentinel was removed by hand.

Worth deciding deliberately rather than leaving as emergent behaviour — either
enumerate channels from the union of `.jsonl` and `.archived`, or have `archive`
materialize an empty log so every archived channel has a file to be discovered
by, or garbage-collect sentinels with no matching log on daemon start.

## Proposed shape

A `grapevine stale` verb (or `list --human --sort age`) rendering one line per
channel:

```
age    last-msg    msgs  presence          kind     name
 46d   2026-06-23    10  —                 session  grapevine-lifecycle
 40d   2026-06-29     5  —                 board    bounty-feedback
  4d   2026-08-04   396  1 (tail 12d ⚠)    session  dream-flute
  0d   2026-08-08    11  2 (live)          session  anthill-spellbook-r2
```

- `msgs` read from disk, not from daemon memory (gap #1 in the sibling item).
- `presence` distinguishes live from leaked by process correlation (gap #1).
- `kind` from a declared marker (gap #2), with boards excluded from any
  `--suggest-archive` output.
- Topic available via `--topic` / `--verbose`.

That collapses a five-step forensic exercise into one call, and makes the
archive step safe enough to script.

## Acceptance Criteria

- [ ] A single read-only verb answers "what is stale?" with age, true message
      count, honest presence, and channel kind.
- [ ] Presence output distinguishes a live subscriber from a leaked tail
      (process correlation or equivalent), wherever presence is reported.
- [ ] Channels can be declared `board` vs `session` at `open` time, and boards
      are never suggested for archival on age alone.
- [ ] `archive` accepts multiple channels in one invocation (list, stdin, or
      `--before <date>`).
- [ ] The janitor pass is expressible as a two-command pipeline.
- [ ] Archiving a channel with zero messages survives a daemon restart, and no
      orphaned `.archived` sentinel is left behind when a channel is not
      discoverable.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — `cmdList`, `cmdWho`,
  `cmdDoctor`, `cmdArchive`
- Sibling bug:
  [`2026-08-08-grapevine-list-message-count-unloaded.md`](./2026-08-08-grapevine-list-message-count-unloaded.md)
- Overlaps the "orphan tail processes" / "dead-subscriber detection" follow-ons
  in
  [`2026-06-28-grapevine-doctor-extended.md`](./2026-06-28-grapevine-doctor-extended.md)
  — scope together; this item argues the signal belongs in `list`/`who`, not
  only `doctor`.
- Related daemon-side gap: `reap` classifies test-harness daemons under temp
  `GRAPEVINE_HOME`s as `authoritative`/`reapable:false` (their HOME dirs still
  exist), so nine zombie daemons had to be killed by hand. Consider a `stale`
  classification for a temp-HOME daemon with 0 subscribers and a multi-day age.

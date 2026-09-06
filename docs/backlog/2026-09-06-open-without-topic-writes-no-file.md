# `open` without `--topic` writes no file, so an opened channel does not survive a restart

**Filed:** 2026-09-06 · **From:** the `fix/grapevine-lifecycle-routes` verify
pass (⚠4), which drove it · **Type:** storage semantics — deliberately NOT
changed on that branch by the orchestrator's ruling, because it is a change to
what `open` persists and that is Cole's call.

## What was measured

```
grapevine open nofile          # no --topic
grapevine pull nofile          → {"ok":true,"messages":[],"cursor":0}   exit 0
grapevine restart --yes        # a DOCUMENTED healing action (version skew)
grapevine list                 → nofile is GONE
grapevine pull nofile          → grapevine: no channel "nofile" …       exit 2
```

`POST /channels` calls `loadChannel`, which builds an in-memory record and
registers it in `channels`. Nothing is written to disk until something is
appended — a topic frame, a message, an announcement, a lifecycle frame. So a
channel opened with no `--topic` exists **only in the daemon's memory**, and
`listChannels()` reports it solely because it unions that map with the files on
disk.

## Why it matters now

`fix/grapevine-lifecycle-routes` made read verbs refuse a channel the daemon
cannot see. Its release note says the breaking change hits "a wrapper that reads
before it opens". **That is narrower than the truth**: a wrapper that opened
first, correctly, still breaks if the daemon restarted in between. Before the
branch the read quietly re-created the channel and the wrapper carried on — the
same lie the branch exists to refuse, so the new behaviour is arguably right;
the blast radius was simply understated. SKILL.md's V2.2 banner now states the
full scope and names the mitigation (`open --topic`, or re-`open` after a
restart).

## The sharper point, for whoever picks this up

It makes ruling 1's premise **only half true today.** That ruling is built on a
clean split — "an act that declares intent to make a channel exist may create
one; a read may not" — and `open` is its exemplar. But an `open` whose intent
was never written down does not survive the process that holds it, so "open
creates" is true of this daemon run and not of the channel. The read guard is
sound either way; the asymmetry is that the creating act is less durable than
the refusal that now depends on it.

## Options, none chosen

- **`open` writes an empty `.jsonl`.** Smallest change; makes the file the
  record of existence for every creating act. Cost: an empty file per opened
  channel, and `channelMessageCount` must keep answering 0 rather than null for
  it (it already does — it counts non-empty lines).
- **`open` appends a `kind:"status"` `event:"opened"` frame.** Consistent with
  the lifecycle frames this branch added, and a tailing agent would see channels
  being opened. Cost: a new frame kind for every consumer to classify, and it
  puts a record in every channel whether or not anyone wanted one.
- **Leave it, and document.** What is in force now. Cost: the half-true premise
  above, and a restart remains a silent way to lose an opened-but-empty channel.

## Related

- `docs/projects/grapevine-backend/verify-journal.md` ⚠4 (the measurement)
- `docs/projects/grapevine-backend/brief.md` ruling 1 (the premise)

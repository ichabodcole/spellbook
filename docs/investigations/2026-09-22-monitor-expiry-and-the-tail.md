---
type: investigation
title:
  "Investigation: the Monitor's 30-minute expiry, and what re-arming the tail
  costs"
description:
  Why an idle Scriptorium session wakes the agent every 1800 s, why each re-arm
  replays the session, and which fix fits the roster.
tags: [monitor, tail, co-presence, scriptorium]
status: draft
lifecycle: concluded
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# Investigation: the Monitor's 30-minute expiry, and what re-arming the tail costs

**Outcome:** Ruled by Cole 2026-09-23: a hybrid, fixed in this cycle (see
[Decision](#decision) and
[the backlog item](../backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md))

---

## Question / Motivation

Cole reported that when he steps away from a Scriptorium document, the agent is
woken roughly every 1800 s by a "timeout". Each time it re-arms and goes back to
sleep, and nothing else happens. His instinct was to remove Scriptorium's own
timeout. The orchestrating session saw two things live on 2026-09-22:

- the wakes were Claude Code's Monitor reaching its per-watch cap;
- re-arming the Monitor replayed the session's earlier events.

This spike tested both claims. It also asked whether the fix belongs to
Scriptorium or to the whole house, and laid out the options for a ruling. This
is branch 5 of
[the Scriptorium real-use cycle](../cycles/2026-09-scriptorium-real-use.md),
whose appetite is "the 30-minute wake-up has an explanation and a ruling".

## Summary

**Cause: confirmed.** The wake is the Monitor's expiry notice. It is not
Scriptorium's idle close, which cannot fire while a tail is connected.

**Replay: confirmed, and worse than a nuisance.** `tail` with no `--since`
replays the daemon's whole in-memory buffer, up to 1000 frames. That includes
human messages the agent has already answered, so every re-arm invites a
duplicate reply.

**House-wide.** Seven skills tell the agent to wrap a tail in Monitor, and so
does mind-mapper's CLI help. All of them hit the same cap. Every tail except
grapevine's replays on a bare re-arm. Bounty's own example replays everything on
purpose (`--since 0`).

**Recommendation:** two parts.

1. **Fix the replay everywhere now.** It is a correctness bug, not a cost
   question.
2. **Pilot a background one-shot wait on Scriptorium.** It is the only option
   that takes idle wakes to zero without the agent going deaf.

Whether to pay per-event re-arm friction to save idle turns is Cole's call.

## Investigation Findings

### Finding 1: the 1800 s wake is the Monitor's cap, not the daemon

**Evidence: the harness.** The Monitor tool's own schema, loaded 2026-09-22 with
`ToolSearch select:Monitor`, says:

- `timeout_ms` defaults to 300000 and is "at most 30 minutes".
- "Deadlines above 1800000ms are capped to 1800000ms."
- "Every monitor expires after `timeout_ms` … it is killed and you get one
  notice with the event count. Re-arm it if you still need the watch; for a long
  watch … set `timeout_ms` to the maximum and re-arm on each expiry."

Two probes confirmed it, both on a harmless `sleep 5000` and both stopped at
once:

- Asking for `timeout_ms: 3600000` was acknowledged as "expires in 30m".
- Adding `persistent: true`, the field bounty's skill example uses, was accepted
  without error. The watch still said "expires in 1m", so the field does not
  lift the cap.

The schema offers no longer or persistent watch. Its documented alternative for
a single notification is **Bash with `run_in_background`** and a command that
exits when the condition is met. The `ws` source has the same cap.

**Evidence: the daemon.** Scriptorium's idle close does exist:

- `--timeout`, default 1800 s, is set at
  `src/scriptorium/backend/server.ts:1569` and wired at `:1640-1646`.
- It goes through `shouldIdleClose`, at `src/kit/wire/housekeeping.ts:72-80`,
  which returns false whenever `subscriberCount > 0`.
- The sweep at `:117-121` touches the activity clock on every tick while
  anything is subscribed.
- `subscriberCount` counts browser sockets plus SSE tails (`server.ts:1641`).
- When the close fires, it ends the session with a `closed` frame
  (`reason: "timeout"`). It does not repeat.

**Reproduction.** This ran on a throwaway `SCRIPTORIUM_HOME` and `TMPDIR` in the
scratchpad. Both sessions were closed afterwards and no daemons were left.

1. Opened a session with `--timeout 8`.
2. Wrapped `tail --session <id>` in a Monitor with `timeout_ms: 20000`.
3. Nothing closed during the 20 s. The tail held the 8 s idle close off for 2.5×
   its length.
4. At 20 s the agent received exactly this, and no `closed` event:
   `[Monitor expired after 20s with 2 events delivered. Re-arm it if you still need the watch.]`

**Significance.** Removing Scriptorium's timeout would change nothing Cole sees.
The "timeout" is the harness's.

**Confidence:** High. There are two independent sources (the schema and the
code), plus a reproduction that matches the exact text of the notice.

### Finding 2: a re-arm replays the session, answered messages included

**Evidence: the code.**

- `tail` defaults its cursor to `-1` (`src/scriptorium/backend/cli.ts:763`), and
  the daemon's `/events` route also defaults to `-1` (`server.ts:1424`).
- The kit's event log treats `-1` as "from the start". It replays every buffered
  frame with `id > -1`, then streams (`src/kit/wire/eventLog.ts:170-185`).
- The buffer holds the last `REPLAY_BUFFER_SIZE = 1000` frames (`:110`).
- The tail also writes its own `grounding` line on every process start
  (`cli.ts:603-617`).

**Reproduction.**

1. Opened a session.
2. Sent two human messages over the surface's WebSocket.
3. Ran `tail` three times, like three consecutive arms.

| Arm                        | stdout lines                                                    |
| -------------------------- | --------------------------------------------------------------- |
| 1: first arm, no `--since` | `grounding`, `ready` (id 1), `message` (id 2), `message` (id 3) |
| 2: re-arm, no `--since`    | the same four lines, identical ids and message ids              |
| 3: re-arm, `--since 3`     | `grounding` only                                                |

**What the replay costs the agent:**

- **Duplicate acts.** A replayed `message` has the same shape as a live one and
  carries nothing to say it was already answered. The skill's rule for `message`
  is "Answer it". An agent that compares `message_id`s against memory can skip
  it. One whose context has been compacted, or a fresh session re-arming an old
  tail, cannot. The same holds for replayed `note.added` ("expect you to act on
  it") and old `waiting` nudges.
- **Tokens.** The whole buffer arrives as one notification, because Monitor
  batches lines that land within 200 ms. On a long session that is up to 1000
  frames, and human messages carry their full text and selection. This spike did
  not measure how large the notification gets or whether the harness clips it.
- **Rate limiting.** Monitor stops "monitors that produce too many events". A
  large replay on re-arm could trip that. This is inferred and was not
  reproduced.

**The fix already exists: `--since <last id>`.** It is parsed with validation
(`cli.ts:291-303`). The Scriptorium skill never tells the agent to pass it; the
only mention is in its flag list, `SKILL.md:236`.

**Side finding: a re-arm into a closed session is silent.** In the first run the
daemon's 8 s linger ran out during the gap between the Monitor's expiry and my
re-arm. A pinned `tail --session <id>` against it then wrote **nothing to
stdout**, and printed `# no session yet, retrying…` to stderr five times in 4 s.
A Monitor over it would say nothing until its next expiry, and then the agent
would re-arm again.

This is only reachable when the gap outlasts the idle close, so it is not a
problem at the default 1800 s. It is the same class as E55's dead-versus-quiet
problem, just on the pre-connect path.

**Confidence:** High for the replay and the duplicate-act risk. The token cost
is inferred, not measured.

### Finding 3: the roster census puts the fix in the house, not in Scriptorium

**Method:**

- grep every `plugins/*/skills/*/SKILL.md` for `Monitor`;
- read each spell's `tail` default cursor in its `src/<spell>/backend/cli.ts`;
- read how its daemon answers that cursor.

`mind-mapper` ships no SKILL.md, so its row comes from its CLI help. Digestify
has no tail.

| Spell       | Skill says "wrap with Monitor"  | Default cursor → what a bare re-arm gets                                                                  | Skill mentions expiry or re-arm cursor                                                      |
| ----------- | ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| scriptorium | `SKILL.md:86`                   | `-1` → whole buffer (kit event log)                                                                       | no                                                                                          |
| glamour     | `SKILL.md:216-224`              | `-1` (`cli.ts:825`) → whole buffer                                                                        | no                                                                                          |
| imago       | `SKILL.md:104-116`              | `-1` (`cli.ts:597`) → whole buffer, through the skill's grep                                              | no                                                                                          |
| magpie      | `SKILL.md:137-145`              | `-1` (`cli.ts:1060`) → whole buffer                                                                       | no                                                                                          |
| bounty      | `SKILL.md:332-352`              | the skill's own example passes **`--since 0`** → whole buffer, on purpose                                 | **wrong**: `timeout_ms: 3600000`, `persistent: true`, neither of which does what it implies |
| astrolabe   | `SKILL.md:92, 119-132` (`join`) | `-1` (`cli.ts:582`) → whole buffer                                                                        | warns that no cursor replays everything; no expiry guidance                                 |
| grapevine   | `SKILL.md:552-570`              | `-1` → **live only** (`daemon.ts:1306-1325`), so nothing replays, but messages sent in the gap are missed | no                                                                                          |
| mind-mapper | CLI help only (`cli.ts` usage)  | unset → `0` (`cli.ts:728, 785`) → whole buffer                                                            | n/a                                                                                         |

**Shared, not per-spell:**

- **All eight tails run on one client**, `src/kit/wire/tailEvents.ts`.
  [The tail-reader convergence](./2026-09-08-tail-reader-convergence.md)
  finished that work.
- **Seven of the eight daemons use the kit's event log** (`createEventLog`).
  Grapevine keeps its own disk log.
- **All the session daemons' idle closes are the kit's subscriber-aware
  `startHousekeeping`.** None of them can be the source of a repeating wake
  while a tail is held.

**What is not shared:** the skill text. Seven skills each say "wrap with
Monitor" in their own words, and none tells the agent what to do at expiry.

**Significance.** Anything that lands in the kit reaches every spell at once: a
`--once` mode, a grounding line that carries the cursor, a re-arm hint. The
wording is per-skill work unless it becomes a house-style rule.

**Confidence:** High. Every row cites the line it was read from.

### Finding 4: the expiry notice already names an act, and the act is pure overhead

The house rule says a message to an agent must name its next act (see
[desire-path hints](../backlog/2026-08-06-desire-path-hints-in-spell-responses.md)).
The expiry notice does name one: "Re-arm it if you still need the watch." So the
rule is not broken. The problem is that the act it names has no value to the
human. It exists only to keep the harness's watch alive.

A fix can satisfy the rule in one of two ways:

- make the named act cheaper and correct, by re-arming with a cursor; or
- stop producing the notice, by not using a capped watch while idle.

## Options Considered

The costs below come from the cap. At 1,800,000 ms per watch, an idle hour is
two expiries. That is the number the ruling trades against.

"Wake" means one model turn. A turn re-reads the conversation, so its cost
scales with the session's context, not with the few bytes of the notice. That
scaling is inferred from how turns work and was not measured.

### Option 0: do nothing

- **Agent's cost per idle hour:** 2 expiry wakes. Each re-arm also triggers a
  replay notification (grounding line plus up to 1000 frames), which may be
  another wake. Answered messages may be answered twice.
- **What is lost:** nothing new.
- **How much changes:** nothing.
- **House rule:** the notice names an act, but the act is overhead.

### Option 1: silent re-arm with a cursor (the backlog's option 1, completed)

The skill tells the agent to re-arm at expiry with `--since <last id seen>`
silently: no message to the human, no narration. Better still, the kit does the
remembering: the `grounding` line carries the daemon's current `cursor`, so the
agent always has one.

- **Agent's cost per idle hour:** 2 expiry wakes, plus 1 grounding notification
  per re-arm. That last one can be dropped for a `--since` re-arm, since the
  agent already knows where it is. No replay, no duplicate acts.
- **What is lost:** nothing. The cursor covers the gap between expiry and
  re-arm, because the daemon buffers what landed in it.
- **How much changes:**
  - a kit change to `tailEvents` and the grounding line (reaches all eight);
  - one line in each of seven skills, including bounty's wrong example;
  - a house-style line.
- **House rule:** the re-arm act becomes safe. It is still overhead.

### Option 2: a one-shot background wait (the backlog's option 2)

- **The change:**
  - A kit-level `tail --once`. It drains whatever is past the cursor and exits
    after the first batch of intent events. `tailEvents` already has a
    `terminal` hook that ends a watch cleanly, so this is a small addition.
  - The agent runs it with **Bash `run_in_background`**, which "re-invokes you
    when it exits". It re-arms with `--since` after each wake.
- **Agent's cost per idle hour:** **0 wakes**, if background shells have no cap
  of their own. One survived 660 s; longer is untested (see
  [Background-shell probe](#background-shell-probe)).
- **Agent's cost per event:** one wake, which is the same as today, plus one
  re-arm call that is not in today's loop.
- **What is lost:**
  - **Streaming.** A burst of human acts arrives as one batch at the next arm
    instead of line by line.
  - **Latency.** The latency to the first event is unchanged, since the wait is
    still push-shaped. Between exit and re-arm the agent is not subscribed. The
    cursor means nothing is lost, only delayed until the re-arm.
  - **Presence.** Every exit is a disconnect. Scriptorium shows no agent
    presence, so this costs it nothing. **Astrolabe and grapevine treat the
    connection as presence**: the card goes idle, the alias leaves `who`. For
    those two, Option 2 would flicker presence on every event. It does not fit
    them.
- **How much changes:** kit `--once` plus the loop section of each adopting
  skill. It is a different loop, not a line added to the old one.
- **House rule:** the only wake is a real event, and the event names its own
  act. **This is the only option where an idle hour produces nothing.**

### Option 3: deliberate lapse after N quiet expiries (the backlog's option 3, Cole's multi-day idea)

After N expiries with no events, the agent stops re-arming and says so, naming
the verb that resumes it.

- **Agent's cost per idle hour:** 2 wakes until the lapse, then 0.
- **What is lost:** **the human's next message goes unheard.** The agent is not
  watching, and the human is at the surface, not the terminal. To stay honest,
  the surface needs a state like "the agent stopped listening; wake it from the
  terminal". That is a new UX state, and it breaks the co-presence promise
  exactly when the human comes back.
- **How much changes:** skill text, plus a new surface state per spell for it to
  be honest, because a warning has to come with the act that answers it.
- **House rule:** the lapse notice can name its act (`--restore`, or "say
  anything here"). But the human has to find it, and the surface never learns
  the agent left.

### Option 4: a tail that ends itself just before the cap and names its re-arm

A kit `--for <s>` deadline sets the tail to exit at, say, 1790 s. As its last
line it prints
`{"type":"tail.quiet","cursor":N,"hint":"re-arm: tail --since N"}`.

- **Agent's cost per idle hour:** the same 2 wakes as Option 1. The message now
  names the exact re-arm, cursor included, so the agent does not have to
  remember one.
- **What is lost:** nothing.
- **How much changes:** kit only, plus the skill's `timeout_ms` guidance.
- **Verdict:** a tidier Option 1. It does not reduce wakes, and it couples the
  tail's deadline to a harness number that could change. Worth taking only if
  Option 1's "the agent remembers the cursor" proves fragile in use.

### Eliminated early

- **Remove or lengthen Scriptorium's `--timeout`.** It is not the source
  (Finding 1).
- **Monitor `ws` source, or `persistent: true`.** Both have the same cap
  (probed).
- **Ask the harness for a longer watch.** Not ours to change. If filed upstream
  at all, it is provide-feedback work.

### Comparison

| Criterion (weight)                                          | 0: nothing  | 1: cursor re-arm    | 2: background once                    | 3: lapse after N            | 4: self-ending tail |
| ----------------------------------------------------------- | ----------- | ------------------- | ------------------------------------- | --------------------------- | ------------------- |
| No duplicate acts from replay (high, correctness)           | no          | yes                 | yes                                   | yes, while armed            | yes                 |
| Idle wakes per hour (high, Cole's cost)                     | 2 + replays | 2                   | 0                                     | 2, then 0                   | 2                   |
| Human's message still heard after a long absence (high, UX) | yes         | yes                 | yes                                   | **no**                      | yes                 |
| Per-event friction (medium)                                 | none        | none                | one re-arm per event, bursts batched  | none                        | none                |
| Presence-shaped spells (astrolabe, grapevine) (medium)      | fine        | fine                | **flickers**, so opt out              | fine                        | fine                |
| Blast radius                                                | none        | kit + 7 skill lines | kit + loop rewrite per adopting skill | skills + new surface states | kit                 |

## Recommendation

- [x] **Create Proposal**: action is warranted. The team recommends; Cole rules.

1. **Fix the replay house-wide now (Option 1).** It is a correctness defect:
   answered messages come back looking live. Fixing it is not a cost/UX trade.
   Concretely:
   - the grounding line carries the current cursor;
   - skills re-arm with `--since`;
   - bounty's example loses `--since 0`, `timeout_ms: 3600000` and
     `persistent: true`.

   This probably leaves this cycle as its own house item, as the cycle
   anticipated.

2. **Pilot Option 2 on Scriptorium only**, because Scriptorium is the spell with
   the real-use signal ("wait for real-use signal"): the multi-hour idle
   document. It is also the one spell where a disconnect is invisible. Keep the
   Monitor loop for the presence-shaped spells.
3. **Do not take Option 3** unless Option 2 fails. Going deaf when the human
   comes back is the failure co-presence exists to prevent.

**Confidence:**

- High that the cause and the replay are as stated.
- Medium on Option 2 when written. The
  [feasibility spike](#feasibility-of-the-ruled-hybrid) has since raised it: a
  background one-shot slept 38 minutes and still woke the agent.

### What Cole needs to rule on (cost against UX)

1. **Is an idle wake every 30 minutes acceptable?** If yes, Option 1 alone
   closes this item. If no, go on to question 2.
2. **Will you trade per-event re-arms and batched bursts for zero idle wakes
   (Option 2)?** The team can make it correct. Whether the agent's loop is worth
   reshaping for the saving is a cost call.
3. **Is the multi-day lapse (Option 3) still wanted** now that Option 2 exists?
   It trades the heard-on-return guarantee for the last few wakes.

## Decision

Cole ruled on 2026-09-23, choosing a **hybrid of Options 1, 2 and 4**, fixed in
this cycle on `feat/tail-quiet-handoff`:

- Monitor while he is active.
- At the cap, the tail ends itself and names the next act, bookmark included:
  - re-arm Monitor if the window saw events;
  - a background one-shot `tail --once` if it saw none.
- The bookmark is always used.
- Presence spells keep the Monitor re-arm.
- Bounty's example is fixed.
- Fallback: a silent bookmark re-arm.

Option 3, the lapse, was not taken. The
[feasibility spike](#feasibility-of-the-ruled-hybrid) found it works, with four
adjustments. The full ruling is on
[the backlog item](../backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md#ruling-cole-2026-09-23).

## Background-shell probe

Option 2 depends on `run_in_background` not having a cap of its own. Probe: a
background `sleep 660; echo …` (11 min, above the Bash tool's 600000 ms
foreground maximum), launched 2026-09-22.

**Result:** the shell ran the full 660 s, exited 0, and the agent was notified
on exit (`background shell survived 660s`). So a background wait is not bound by
the 600,000 ms foreground `timeout`, and exit is the wake.

**Past 1,800,000 ms:** settled by the
[feasibility spike](#feasibility-of-the-ruled-hybrid), where a background
one-shot slept 2279 s and still woke the agent.

## Feasibility of the ruled hybrid

**Verdict: the hybrid works. The fallback is not needed.** Four adjustments are
required before it is built; they are listed under
[Design adjustments](#design-adjustments-the-fix-branch-must-carry).

### Method

`tail --once` does not exist yet, so it was emulated in the scratchpad (not the
repo) as `proto-tail.ts`, a small script on **the kit's own client**,
`src/kit/wire/tailEvents.ts`. It has two modes:

- `once` ends on the first log event (the kit's `terminal` hook).
- `for:<s>` is a self-ending window that counts its own events.

Both modes end with one stdout line naming the next act, bookmark included. For
example:
`{"type":"tail.quiet","events":0,"cursor":1,…,"next":"Bash run_in_background: tail --once --since 1"}`.

The setup:

- Sessions were throwaway, with `SCRIPTORIUM_HOME` and `TMPDIR` in the
  scratchpad, opened by the shipped `scripts/cli.ts`.
- Human messages were posted the way the surface posts them: a `say` frame over
  `ws://127.0.0.1:<port>/ws`.
- Page reloads were emulated as a socket open and close with nothing sent.
- Every session and process was closed afterwards.

### (a) The quiet signal: the script decides, not the expiry notice

| Probe                                                 | What the agent received                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| real `tail --since 1` under a 15 s Monitor, no events | the `grounding` line, then `[Monitor expired after 15s with 1 event delivered. …]`                                                     |
| real `tail --since 2`, 8 s Monitor, 1 human event     | `grounding`, the event, then `[Monitor expired after 8s with 2 events delivered. …]`                                                   |
| prototype `for:12` under a 20 s Monitor, no events    | one notification with `{"type":"tail.quiet","events":0,…,"next":"Bash run_in_background: tail --once --since 1"}` and the stream's end |
| prototype `for:12`, 2 human events                    | the 2 events, then `{"type":"tail.window","events":2,"cursor":3,…,"next":"Monitor: tail --since 3"}`                                   |

**The notice's count is not trustworthy as the branch signal.** It counts every
stdout line, including the tail's own `grounding` line, so a truly idle window
reports "1 event". It would also count any future diagnostic that reaches
stdout.

The script knows exactly what it saw. When it ends itself before the cap, its
own line arrives in the **same notification** as the stream's end. That is one
wake, and it already names the act. This confirms the ruling's preference.

### (b) The key question: a background one-shot outlives 30 minutes and wakes the agent

The setup:

- The session was opened with `--timeout 60`, so its idle close would fire
  within a minute of losing its last subscriber.
- `proto-tail.ts <port> 1 once` ran as a `run_in_background` Bash task, and was
  the session's only subscriber.
- A **detached** `nohup` shell, independent of the harness's task machinery,
  slept 2280 s and then posted one human message.

| Time (UTC, 2026-09-24) | What happened                                                                      | Method                                |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| 00:27:02.817           | one-shot armed                                                                     | the script's own `started`            |
| 00:48:38               | daemon still listening, 21 min in, against a 60 s idle close                       | `lsof` on the session's port          |
| 00:58:06               | one-shot still asleep, 31 min in, past the Monitor cap                             | its task output, polled               |
| 01:05:02.245           | fake human posts                                                                   | the message's own `ts`                |
| 01:05:02.246           | one-shot receives it and exits 0 (`uptime_s: 2279`)                                | the script's `last_event` and `ended` |
| 01:05:02               | **the harness notifies the agent**: "Background command … completed (exit code 0)" | the task notification in this session |

**Results:**

- **No cap on the background task.** It slept 2279 s, 1.27× the Monitor's cap,
  and exited on the event.
- **No latency cost.** The wake came 1 ms after the event's timestamp.
- **No spurious wakes.** The event it woke on was id 2, the first after `ready`.
  Nothing else was written to the log in 38 minutes.
- **The idle close does not interfere.** The one-shot is an SSE subscriber, so
  `shouldIdleClose` never fired. The same session was re-armed after the wake
  (below), which proves it never closed.

⚠ **This run is the second attempt, and the first attempt's failure is the most
important finding here** (see adjustment 1). The first one-shot printed its wake
line and then **never exited**. A background task that never exits never wakes
the agent, and nothing would have said so.

### (c) The handoff: nothing replays, and nothing is lost

Three checks:

- **Handoff at 38 minutes.** After the wake, a Monitor re-armed with
  `tail --since 2` delivered `grounding`, then one new live event (id 3). Ids 1
  and 2 were not replayed.
- **Two quick events.** Against a one-shot at `--since 10`, two human messages
  were sent back to back. The one-shot exited on the first (id 11), 1.5 s after
  arming.
- **An event in the gap.** One more message was sent after the exit and before
  the re-arm. The re-arm at `--since 11` then delivered **id 12 (the second
  quick event) and id 13 (the gap event)**, and nothing at or below 11.

The bookmark covers the gap because the daemon buffers what lands in it.

### (d) What else could break it

- **Page reload.** Two socket open/close cycles wrote nothing to the log. The
  one-shot stayed asleep until its 6 s test alarm. **No spurious wake.**
- **`waiting` nudges wake the one-shot.** Twice, a one-shot woke at once on a
  `waiting` event: the daemon's 30-second reminder about a human message nobody
  had answered. That is correct, since a waiting human is actionable. It also
  means **"quiet" must mean nothing on the log**, not "no human messages". The
  agent's own `task.*` and `version.*` events are on the same log, so they would
  wake it too. That is inferred from the code, not tested, and it would be
  right.
- **Graceful close while asleep.** The one-shot woke on `closed` (id 2) with
  `closed: true`. But the prototype then named `Monitor: tail --since 2`, which
  is **the wrong act**: there is nothing left to watch. See adjustment 2.
- **Crash while asleep.** The daemon was killed with `kill -9`, found by its own
  port per E55's process note. The real `tail` wrote
  `{"type":"tail.disconnected",…}` to **stderr** and retried silently. **A
  one-shot on a dead daemon would sleep forever and never wake the agent.** And
  it is not new: under **today's** Monitor loop the same line is invisible too,
  because Monitor notifies only on stdout. E55's stated purpose, "a watcher …
  would never learn it had stopped listening", is therefore unmet for a
  Monitor-wrapped agent. See adjustment 2.

### Design adjustments the fix branch must carry

1. **A terminal event must close the connection** (`tailEvents`, kit). On a
   terminal frame the client `return`s from inside the read loop, but its
   `finally` never aborts the fetch or cancels the reader. The process stays
   alive on the open SSE stream. `closed` never exposed this, because there the
   server ends the stream itself. `--once` will expose it on every wake.
   Measured: the prototype's first one-shot printed `tail.woke` and was still
   running 2 min later; it was killed by hand.
2. **Loss of the daemon ends the wait, on stdout, naming how to come back.**
   - In `--once`, a `closed` frame and a disconnect are both terminal.
   - Their line names the act for that state, not a re-arm. The act is
     `open --restore <id>`, which is E56's verb, with `doctor` if unsure.
   - The ruling's "the script names the next act" must be **conditional on
     state**: re-arm Monitor, go to background, or come back from a closed
     session.
   - Whether Monitor mode should also move `tail.disconnected` to stdout is the
     same question for today's loop. It should be decided on the same branch,
     because it is the same line.
3. **The script decides quiet from its own count of log frames, not the
   notice.** Two rules follow:
   - the `grounding` line is not counted;
   - on a `--since` re-arm, the `grounding` line should not be printed at all,
     since the agent already knows the session.
4. **The self-ending window must end before the Monitor cap, with margin.** If
   the Monitor kills the tail first, the script's line is never printed and the
   agent gets the bare notice. Measured here: a 12 s window under a 20 s cap
   ended cleanly. The kit's deadline should sit well inside 1,800,000 ms. The
   skill sets `timeout_ms` to the maximum, and the fallback for a bare notice is
   the ruling's silent bookmark re-arm, from the last id the agent saw.

**Not changed by the spike:**

- The ruling's shape stands.
- Presence spells keep the Monitor re-arm; nothing here tested presence.
- A burst still arrives split: the first event on the one-shot, the rest on the
  re-arm. Draining for ~200 ms after the first event, to match Monitor's own
  batching window, is an option for the branch, not a requirement.

## Open Questions

- **The notification size of a large replay, and whether the harness clips it.**
  Not measured; Option 1 makes it moot.
- **Option 2 in practice.** How a real session feels when every return from away
  is followed by one re-arm call. The mechanism is proven (see Feasibility); the
  feel needs Cole's real use.

---

**Related Documents:**

- [Backlog item](../backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md)
- [Cycle](../cycles/2026-09-scriptorium-real-use.md)
- [Tail reader convergence](./2026-09-08-tail-reader-convergence.md)
- Code: `src/kit/wire/tailEvents.ts`, `src/kit/wire/eventLog.ts`,
  `src/kit/wire/housekeeping.ts`, `src/scriptorium/backend/cli.ts`,
  `src/scriptorium/backend/server.ts`

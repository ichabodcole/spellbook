# 2026-09-09 — bounty: three entries, and a guarantee that did not reach

**Agent:** Claude Opus 5, as the implementing agent · **Branch:**
`feat/bounty-backend-port` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 4 of the backend convergence.** bounty's whole backend — `cli.ts`
(1,506), `server.ts` (1,713), **`join.ts`** (331) and a 4,847-line suite, the
largest file in the repo — out of the deployed skill folder, behind three
launchers, with all eight `src/kit/wire/` modules adopted.

Three things make this port different from the three before it, and each one
produced a finding. It is the **first spell with three entries**, so it is D43's
first real consumer and the state `launcher-pairing-ward` cell C exists for. It
is the **spell the spine was half copied FROM**, which turns B8's adopt-and-gain
table around. And its **shutdown watchdog** is the one concern the kit
deliberately does not share — the question the brief assigned, and the one the
drive answered differently from how everyone had written it down.

---

## What shipped, by sha

| chapter | sha       | what it is                                                                                                                                                                                                         |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | `89278c5` | **the relocation** — three entries and two test files into `src/bounty/backend/`, three launchers, three committed artifacts. Six ward lists re-declared; thirteen backlog items repaired. `SERVER_SCRIPT` closed. |
| —       | `8c56d0d` | **the instrument repair** — `dist-check` ARM 1b stops reading two file names (D49). Its own commit, between the chapters, because the port is what made the defect observable.                                     |
| 2       | `0ff63aa` | **the adoption** — all eight kit modules plus `heartbeat.ts`. Two census defects closed, one narrowed. The failure contract changes (D45). Watchdog ruled (D46).                                                   |
| —       | `9714d71` | **the watchdog window** — a defect the ruling's own drive found: the clear sat four lines into a fifteen-line teardown.                                                                                            |
| —       | (this)    | **the records** — D45–D50, `phase-4-journal.md`, this file, and the Phase B amendment pass.                                                                                                                        |

## The numbers

|                                                     | before                    | after                                                      |
| --------------------------------------------------- | ------------------------- | ---------------------------------------------------------- |
| `bun run gate`, unpiped, exit read from a file      | 0 · 1,976 pass / 0 fail   | **0** · **1,976 pass / 0 fail**                            |
| `bun scripts/dist-check.ts`, all arms               | 0                         | **0** · 35 tracked / 35 on disk                            |
| `launcher-pairing-ward`                             | 6 pass, no bounty entries | **6 pass** · `derived=[cli, join, server]`                 |
| `spawn-path-ward`                                   | 9 pass, bounty uncovered  | **9 pass** · 3 coverage rows for bounty                    |
| acc                                                 | **no config** (D37)       | **no config** — not acquired, by decision                  |
| spells shipping a built BACKEND                     | 4                         | **5**                                                      |
| bounty CLI `process.exit` sites in the inventory    | 4                         | **0** (the fifth CLI to reach zero)                        |
| shipped pins the spawn-path ward governs for bounty | 0                         | **9** (`cli.js` 5, `server.js` 4, `join.js` 0-and-said-so) |
| bounty event-replay buffer                          | unbounded                 | **1,000**                                                  |
| bounty tail watchdog                                | **none at all**           | 45,000 ms, DERIVED from its own beat                       |
| kit modules bounty shares                           | 0                         | **8**                                                      |
| kit boundaries widened for bounty                   | —                         | **0**                                                      |

## The three things the brief said to confirm rather than assume

**1 · `scripts/cli.ts:60` was `join(SCRIPT_DIR, "server.ts")` — glamour's exact
shipped defect, live, and B4 predicted it before bounty was touched.** Confirmed
and closed. Driven both ways on the real artifact:

| the pin in `dist/cli.js`                         | `spawn-path-ward`                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `join(SCRIPT_DIR, "server.ts")`                  | **1 fail** — `dist/cli.js:21 -> …/bounty/dist/server.ts` (does not exist) |
| `join(SCRIPT_DIR, "..", "scripts", "server.ts")` | **9 pass / 0 fail** — resolves to `…/bounty/scripts/server.ts`            |

The symptom the old form ships is not a crash: `open` waits out its 5 s
handshake deadline and reports a start timeout, which reads like a slow first
bundle build.

**2 · `SURFACE_CWD`'s five-level climb — asserted, not reasoned about.** The
ward resolves the arithmetic **the way the runtime will, from the emitted file's
own directory**, and it lands on `src/bounty` — declared as the fourth instance
of that one Contract 5 escape, after astrolabe, glamour and imago. And driven
end to end: a dev daemon serves `/_bun/asset/8472a069db098ad6.css` (Tailwind
markers present) and `/_bun/client/index-…js`, which only happens if Bun read
`bunfig.toml` from `src/bounty/`. The release daemon serves the committed
`index-zbyhxwq5.css` and `index-x9jnphnn.js`. Every other `import.meta`-anchored
pin got the same treatment: three coverage rows, `cli.js pins=5`,
`server.js pins=4`, and `join.js anchors=no pins=0` — **a row saying "looked at,
nothing to anchor", which is what D42 requires instead of an absent row.**

**3 · `shared/{predicates,types}.ts` stays, and R7 is undisturbed.** Measured
rather than assumed: four surface imports across three files, so D10 keeps both
modules in the skill folder. `predicates.ts` was not touched. What DID change is
that the daemon no longer needs them on disk — bundling absorbed them — so
`release-serve.test.ts`'s "the seam ships" cell was INVERTED rather than deleted
(B6.4): the rig now asserts the daemon boots from a tree with **no `shared/` at
all**, which is strictly stronger.

## The two things to establish rather than assume

**`assets/` — who resolves it, and from where.** The DAEMON does, off
`join(SCRIPT_DIR, "..", "assets")` — up-and-back-down, correct from `dist/` and
from `scripts/`, so the `remove.py` class of defect was never available here.
Driven in BOTH modes: `/assets/wordmark.webp` → 200 `image/webp` 11,570 B and
`/assets/favicon.png` → 200 3,062 B, in dev and in release. The route stays
disjoint from `serveFromDist` because every `/assets/` path is nested and the
kit's one-level guard refuses it — a cell bounty earned and no sibling has.

**The `bun` runtime-import exemption — RE-ARGUED, not re-declared (D50).** Ward
1b's own comment said bounty was the last hand-authored holder and that "when
bounty ports, this cell has no population and the exemption it guards must be
re-argued rather than silently kept". bounty's is
`import type { ServerWebSocket } from "bun"` — type-only, the fifth departure by
that mechanism — so the bundler erased it and the measurement is now EMPTY. The
argument that replaces the roster: `bun` is not a dependency (it is the
runtime's own module, present wherever this ships); `bun:`-prefixed specifiers
are a different clause; and three spells still ship daemons as source, so the
population is not closed. **The liveness proof MOVED to D16's synthetic cell,
which EVALUATES the exemption** — driven: with `BUILTIN_EXACT` emptied the suite
still reds, on a tree where no spell writes the import. And the empty
measurement is spelled as looked-at-and-empty: the cell asserts a non-zero
denominator first.

## The mid-port red, driven on purpose

The brief predicted `launcher-pairing-ward` would red mid-port, and it does — a
three-entry port passes through the half-relocated state twice. Reproduced
deliberately by making `scripts/cli.ts` stop importing its artifact:

```
2 fail
  bounty/dist/cli.js is emitted and NOTHING under bounty/scripts/ imports it
  bounty: build.ts derives entry "cli" from bounty/scripts/cli.ts, but that file
    does NOT import ../dist/cli.js — the emitted artifact would be unreachable
```

Cells B and C, both directions, restored to 6 pass / 0 fail.

## The watchdog, which is the port's real story

The brief named it as this port's central design question and told me to drive
the decision. `kit/wire/housekeeping.ts` had pre-committed to an answer in
prose: _"when a spell with a signal path adopts this, the watchdog arrives as an
option on these arguments and the reasoning is already written down."_

**Driving it falsified the pre-commitment, and then falsified something worse.**
A `watchdogMs` on `drainAndStop` would arm at DRAIN time; bounty's arms at
SIGNAL time, and the stretch between is what it exists for — `await done`, an fs
append, a full snapshot write that can rotate and copy a backup, a `closed`
frame, a broadcast. `drainAndStop`'s own body is already bounded by 150 ms + a
200 ms race. So the option would guard the one stretch that cannot hang.

Then, planting a hang in a **copy of the shipped artifact** at three points and
timing the death under SIGTERM with a 2 s watchdog:

| hang point            | before (armed / disarmed)   | after (armed / disarmed)   |
| --------------------- | --------------------------- | -------------------------- |
| `await done`          | 143 @2002ms / RUNNING @10s  | 143 @2002ms / RUNNING @10s |
| the final snapshot    | RUNNING @10s / RUNNING @10s | 143 @2004ms / RUNNING @10s |
| inside `drainAndStop` | RUNNING @10s / RUNNING @10s | 143 @2003ms / RUNNING @10s |

**Two rows where ARMED and DISARMED are indistinguishable.** The
`clearTimeout(shutdownWatchdog)` sat four lines into a fifteen-line teardown,
under a comment reading "`clearTimeout` sits at the end of the teardown". The
corpus's only unconditional termination guarantee did not extend to the code it
was written to guard, and had not since it shipped. Fixed in its own commit; the
stated reason for clearing early ("the REF'd timer must stop holding the event
loop") does not hold, because `main` returns and the LAUNCHER calls
`process.exit(exitCode)` — a ref'd timer cannot delay an explicit exit.

The ruling and the rule for the next spell now live in the kit's header: **the
question is never "does this module have a place to put a watchdog" but "does
the watchdog's window coincide with this module's".**

## The failure contract, driven before and after (D45)

Seven failing invocations, run rather than reasoned about. Before:
`bounty: <msg>` prose on stderr, stdout empty, **exit 2 for all seven**. After:
one JSON envelope on stderr, stdout still empty, `usage` 2 for four of them and
`not_found` **5** for the three that mean "there is no board". SKILL.md now
states the taxonomy and warns that a script testing `exit == 2` for "no session"
must test 5.

⚠ **And B8's prediction that the uncaught-`fetch` shape "is common to every
spell whose CLI talks to a session daemon" is FALSE here** — bounty probes
liveness before it fetches, so a stale pointer at a closed port raises
deliberately rather than crashing with a raw `TypeError` at exit 1. Driven on
two verbs.

## `join.ts`, driven for real

The entry no previous port had, and the one the gate does not prove. Host and
joining participant connected through the built launcher chain, a `task.add`
from the joiner read back by the host's `state`, and a `task.update` from the
host received by the joiner — in **both** modes, exit 0 both ends.

## Census defects, each with the module

| #      | verdict                                                                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L5** | **CLOSED** by `eventLog` — the replay buffer was unbounded; now 1,000                                                                                                                             |
| **L7** | **CLOSED** by `sse.ts`'s `client.send` — presence leaves the replay log                                                                                                                           |
| **L6** | **NARROWED, not closed** — bounty is session-scoped so it stamps no epoch (D39's criterion); the residue is a caller reusing `--since` across a restart of the same derived `--session-key` (D48) |
| L1     | already correct; now correct **by construction** (`subscriberCount` required)                                                                                                                     |
| L2     | already correct; untouched                                                                                                                                                                        |
| L3     | already correct; de-duplicated into `discovery.writeFileAtomic`                                                                                                                                   |
| L4     | already correct; the parallel `sseTimers` registry is now unnecessary                                                                                                                             |

Plus two the census did not carry: **the tail had no watchdog at all**, and
`emitEvent`'s `{ id: ++seq, ...msg }` let a payload `id` override the cursor
under the spread, directly beneath a comment claiming it could not.

## What I could not verify

- That `join.ts`'s terminal `disconnected` frame is truncated by its exit. The
  drives never observed the frame, which is consistent with the file's recorded
  measurement and is not a measurement of its own.
- Whether `--timeout 0` had any caller. Nothing documents it and nothing drove
  it, which is the whole basis for calling the old reading accidental.
- acc: **N/A** — bounty has no `acc.config.json`, so there is nothing to run and
  nothing to regrade (D37), and none was acquired. ⚠ But the port DID change the
  largest surface acc grades and nothing in the gate would have said so; D45 is
  where it is said.

## The playbook's own report card

Six gaps, in `phase-4-journal.md`, all folded back in one pass at the end. The
two that generalise past bounty: **B8's module table assumed the porting spell
has the worse code** (for a convergence-SOURCE spell, half the rows are
de-duplications and one runs backwards), and **a concern the kit deliberately
does not share is part of B8, whose boundary must be DRIVEN at the adoption**.
Everything else held — including B4, which has now predicted a shipped defect in
writing at two consecutive spells before either was touched.

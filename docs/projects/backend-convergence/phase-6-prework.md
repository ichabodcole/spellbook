# Phase 6 pre-work — Phase B can refuse a module for being ABSENT, and grapevine needs it to refuse one for being the WRONG SHAPE

**Measured 2026-09-09, before writing grapevine's brief. No spell was ported.**

**Why a new document rather than an append to `phase-5-prework.md`.** That doc
is digestify's pre-work; its subject is a phase keyed on a `cli`/`server` pair
meeting a spell with one entry, and its findings are digestify's (D55–D57). This
one's subject is a phase whose only refusal is an ABSENCE meeting a spell whose
modules are PRESENT and unrepresentable, and its port is grapevine's. Two ports,
two subjects, two documents — the same reasoning `phase-5-prework.md` gives for
not appending to `phase-4-prework.md`. Appending would bury a fourth verdict
inside digestify's account and imply this work was digestify's.

## The finding

An independent verify pass read Phase B cold, as grapevine's porting agent, and
reported three things that break it. **All three were measured against the tree
and all three are CONFIRMED**, one with a refinement and one with a narrowing.
The third is a missing CONCEPT rather than a wrong sentence, and it is the
reason this document exists.

Grapevine's shape: **two caller-facing entries**, `cli.ts` + `daemon.ts` (no
`server.ts`). Long-running, singleton, no acc config. **A durable per-channel
event log**, which is the first in the roster.

## What was measured, and what it showed

### 1 · B2 hands grapevine a launcher that kills its own daemon — CONFIRMED, driven both ways

B2 dispatched the launcher shape on what the entry IS and named grapevine's
`daemon.ts` "a daemon shape":
`const exitCode = await run(); process.exit(exitCode)`.

`daemon.ts`'s `main()` (lines 1386–1463) resolves as soon as `Bun.serve` has
bound — it writes `daemon.port` and `daemon.pid`, prints `listening`, registers
`SIGINT`/`SIGTERM`, and returns `undefined`. **The event loop holds the process
up, not the promise.** The exit codes are not `main`'s return value: they are
in-body `process.exit(0)` (the already-running branch, line 1425) and
`shutdown()` (line 1371), reached only from a signal.

**Driven** — `daemon.ts` copied to `scripts/_drive-daemon.ts` with its
`if (import.meta.main)` block rewritten as `export async function run()` exactly
as the port will emit it; run under a scratch `GRAPEVINE_HOME` in release mode;
copy removed afterwards. Never in the repo root.

| launcher shape                                    | result                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `const exitCode = await run(); process.exit(...)` | printed `grapevine daemon listening on http://127.0.0.1:56250 (pid 18450, mode release)`, wrote `daemon.port` + `daemon.pid`, **returned to the shell, exit 0** |
| `process.exitCode = await run();`                 | stayed up; `GET /` → `{"ok":true,"pid":18469,"started_at":…,"channels":0,…}`                                                                                    |

**The reported symptom is confirmed exactly, and it is worse than "wrong
launcher" because it is another step's signature.** `readDaemonPort()`
(`cli.ts:299`) finds the port file the dying daemon wrote, pings it, gets
nothing, deletes it as stale, and the 3 s poll loop at `cli.ts:370-377` runs
out: **`daemon failed to start within 3s`**. That string is B4's glamour
spawn-path scar verbatim — and `cli.ts:348-352`'s own comment attributes it to a
**third** cause, a dev-mode daemon dying at its surface import. **Three defect
classes, one sentence.** An agent meeting it will read B4, find a flat sibling
spawn (`DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` — which is a real B4
defect grapevine also has), fix that, and still see the message.

**Repair:** B2's discriminator is re-homed onto **does this entry's `main()`
return while the process must keep living?**, asked before bounty's
load-bearing-exit question. Both existing scars kept as worked instances. The
old code comment `"a daemon's teardown already ran inside main()"` was read as a
description of daemons; it is a **precondition**. Recorded as **D69**.

### 2 · B8's epoch table names grapevine as a singleton that needs an epoch — CONFIRMED, and the danger is measurable

B8's ruling offered session-scoped (no epoch) vs singleton (stamp one) and ended
with a list of spell names placing grapevine under **singleton**.

`loadChannel()` (`daemon.ts:280-356`) derives `next_id` from a **high-water mark
over every parseable line** of `~/.grapevine/channels/<name>.jsonl`
(`next_id = Math.max(maxId, lines.length) + 1`, under a b11 scar about exactly
why it is not the last line). **Ids ascend across every restart.** A tail that
reconnects at `since=<last id>` resumes correctly today, which is the behaviour
an epoch exists to repair elsewhere.

**And stamping one is not inert.** `tailEvents.ts:504-512`'s `onEpochChange`
sets **`cursor = 0`**; grapevine's tail route answers `since=0` with
`readBacklog(name, 0)` — the whole channel log off disk, into stdout, which for
`tail` is an agent's pipe. **Epoch + `tailEvents` = every `grapevine roll`
replays every message of every tailed channel into every tail.**

**Repair:** the list of spell names is deleted and the ruling is re-homed onto
the property — **are the log's ids recovered across a restart?** Grapevine's
row: no epoch, **L6 does not arise** (neither closed nor narrowed). That is a
second shape of not-applicable for this ruling; digestify's was "no log at all".
Recorded as **D70**.

### 3 · ⛔ There is no sanctioned REJECT-STRUCTURAL path — CONFIRMED, and it is the real gap

Phase B's only refusal is **NO SUBJECT** (D56), gated on **question 4**.
Grapevine answers _long-running_, so **all eight kit rows read as applicable**.
Three are not, for a reason the phase had no word for.

| module         | the kit's shape                                                         | grapevine's                                                                                       | verdict                              |
| -------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `eventLog`     | one in-memory array capped at 1000, one `seq`; explicitly _not durable_ | N durable `.jsonl` files, one per channel, own `next_id`, replayed from disk                      | **REJECT-STRUCTURAL**                |
| `sse`          | `Set<SseClient>`, `SseClient = {close, send}`, `size` is all it reads   | `Map<symbol, {alias, human, lurk, send}>`, metadata read by **six routes**                        | **REJECT-STRUCTURAL**                |
| `housekeeping` | `shouldIdleClose` + `startHousekeeping` + `drainAndStop`                | no idle sweep, no snapshot, no `--timeout`; a `Promise.race([server.stop(true), 200ms])` teardown | **SPLIT** — see the refinement below |

The six routes reading subscriber metadata, counted: `/presence`
(`daemon.ts:419-421`), `/channels/:name/subscribers` (739-747), the roll/clear
broadcast (909-921), the archive live-guard (981), the watch-presence
registration (1111-1117), and the tail's own registration (1307-1314).

**Why this is not NO SUBJECT:** grapevine HAS an event log and HAS an SSE
registry, and they are the busiest things in the spell. Reporting them as "no
subject" would be false in a destructive direction — the next reader would
wonder what the `.jsonl` files are. The discriminator is: **could you construct
the kit's type from what the spell holds?**

**Why the house precedent is the wrong repair.** B10 and D31 repair a kit/spell
mismatch by **widening the kit**, and `sse.ts`'s own `send` arrived that way.
Here that would change types five other daemons compile against and re-emit
**six artifacts across five spells**, each owed a drive — and `sse.ts`'s header
already records the endpoint: _"A signature wide enough to absorb those stops
being a file server and becomes a router."_ Ruled out as the DEFAULT repair;
available only as its own argued decision with its own blast-radius count.
Recorded as **D68**, with the verdict's required written output (journal row + a
line in the kit module's own header, per D17).

#### ⚠ The one place the report was too broad: `drainAndStop`

The report grouped `housekeeping`'s `drainAndStop` with `eventLog` and `sse` as
structurally wrong. **The tree narrows that.** `drainAndStop`'s server-stop half
IS grapevine's — `Promise.race([server.stop(true), setTimeout(200)])` in
`shutdown()` is `stopMs` exactly. What has no expressible value is its
**`clients` argument**: grapevine's subscriber records carry `send` and no
`close`, so there is nothing to hand it. So the row is **SPLIT and ruled per
export**, following B8's own "a row is a module, not a function" rule:
`shouldIdleClose` + `startHousekeeping` are **NO SUBJECT** (grapevine runs no
timer of that kind — it is a singleton that stands until `stop`), `drainAndStop`
is **PARTIAL** with an empty `clients`. The playbook says this rather than the
report's version.

### 4 · Also reported: B8's `serveDist` row reproduces its own scar — CONFIRMED

The row's general-form bullet was addressed by name to _"whoever ports grapevine
next"_ and told it this row is `serveFromDist` **plus a router you write and a
refusal you keep**. Grapevine has no refusal to keep: its local `serveDist`
(`daemon.ts:104-112`) is the pre-whitelist kit function verbatim — three guards
(empty, `..`, nested) and `existsSync`, no by-name refusal — because it
substitutes nothing. Its `/watch` serves the committed `dist/index.html`
unaltered; `/` is a JSON status route. **This is B5's own scar, one page later:
prescribing a defence the spell may not have.**

**And the kit moved under the row while the report was being written.**
`serveFromDist` now carries the **whitelist** (D65, `0260c725`, merged
`2c61cde5`): a `dist/` file is served only if the built `index.html`
transitively links it. So for grapevine this row is **not PARTIAL and not a keep
— it is RECEIVED**: adoption GAINS a defence the spell lacks. Not theoretical —
**this phase is what puts the backend bundle into the served directory**, so
post-port grapevine's own `serveDist` would answer `GET /daemon.js` and
`GET /cli.js` with its implementation at 200, which is D61's class exactly.
Ruling it RECEIVED owes it a `release-serve.test.ts` cell (D67).

## Summary of the three

| #   | reported                                                          | tree's verdict                                                                        |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | B2's daemon launcher kills grapevine's daemon                     | **CONFIRMED**, driven both ways; symptom is B4's _and_ the CLI's own comment's string |
| 2   | B8's epoch table wrongly names grapevine a stamping singleton     | **CONFIRMED**; the replay cost is `cursor = 0` → `readBacklog(name, 0)`               |
| 3   | No sanctioned REJECT-STRUCTURAL path                              | **CONFIRMED** for `eventLog` and `sse`; **NARROWED** for `housekeeping` (split)       |
| +   | B8's `serveDist` row prescribes a refusal grapevine does not have | **CONFIRMED**, and the row's verdict changes to RECEIVED since the whitelist landed   |

## What did NOT transfer, stated once

**The assumption that the kit can always be made to fit.** Every prior mismatch
in this convergence was repaired by widening the kit, and the phase is written
throughout as though the kit is the destination. Grapevine is the first spell
for which the honest outcome at three rows is "adopted nothing, and did not
widen" — and the precedent applied here would have dirtied six artifacts across
five spells to accommodate one.

## What neither the report nor the playbook mentions

- **Grapevine has a real B4 defect of its own**, unrelated to the launcher
  shape: `cli.ts:40` is `DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` — the
  **flat sibling spawn**, glamour's exact shape. From `dist/` that is
  `dist/daemon.ts`, which will not exist. The correct form is up-and-back-down.
  It matters here because it produces the **same**
  `daemon failed to start within 3s` string as the launcher-shape defect, so a
  port that fixes one will still see the message and may believe the other is
  fixed too. Fix both, and drive the launcher ALONE to separate them.
- **`daemon.ts` holds the roster's ONE `src/`-naming specifier**, a dev-only
  dynamic `import("../../../../../src/grapevine/surface/index.html")` that
  `grimoire/import-boundary-wards.test.ts` pins. Five `..` from `scripts/`; B5's
  re-point arithmetic has a pinned ward reading it.
- **Grapevine's SSE heartbeat is a literal `3000`** against `idleTimeout: 255`
  (seconds), and `cli.ts`'s tail has its own reconnect handling. Question 3
  answers YES, so B8's `heartbeat.ts` seam is real for grapevine — the first
  spell in three ports for which it is not N/A.
- **A stray empty directory `-1` was sitting in the repo root** (created
  2026-09-09 16:40, before this session), invisible to `git status` because git
  does not track empty directories and not covered by `.gitignore`. Removed. It
  is the same class the brief warns about; **`git status` is not an instrument
  that sees it** — `find . -maxdepth 1 -type d -empty` is.

## Instruments

**None touched.** This is a playbook-and-records change; no test, ward or script
was added or edited, so D42 has no subject here. The gate and `dist-check` were
run to confirm the tree is unchanged by the documentation edits.

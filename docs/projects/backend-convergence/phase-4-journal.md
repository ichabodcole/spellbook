# Phase 4 journal — bounty, three entries, and a watchdog that did not reach

**Branch:** `feat/bounty-backend-port` · **Implementer:** Claude Code ·
**Dates:** 2026-09-09 · **Predecessor:** Phase 3 (imago), `8576590`; pre-work
`753c655`.

bounty's whole backend — `cli.ts` (1,506), `server.ts` (1,713), **`join.ts`**
(331) and a 4,847-line test suite, the largest file in the repo — out of the
deployed skill folder and into `src/bounty/backend/`, behind three launchers,
with all eight `src/kit/wire/` modules adopted.

This is the SECOND port driven by
[`docs/playbooks/porting-a-spell-playbook.md`](../../playbooks/porting-a-spell-playbook.md)
Phase B rather than written from one, and the first with three entries. Its job,
like imago's, was to record every place the playbook was not enough — **at the
moment it was hit, before it was solved.** Imago found seven. This found six,
listed below in the order they arrived, and they are a different six.

## Baseline

| what shipped               | sha       | contract                          |
| -------------------------- | --------- | --------------------------------- |
| chapter 1 · the relocation | `89278c5` | behaviour unchanged               |
| the instrument repair      | `8c56d0d` | `dist-check` ARM 1b, D49          |
| chapter 2 · the adoption   | `0ff63aa` | behaviour changes, each named     |
| the watchdog window        | `9714d71` | a defect the ruling's drive found |

Gate **1976 pass / 0 fail**, unpiped, exit 0, after chapter 1 and again after
chapter 2. `bun scripts/dist-check.ts` exit 0, all arms, ARM 1b included.
`launcher-pairing-ward` green with a row for bounty:
`derived=[cli, join, server]`.

## The gaps, in the order they were hit

### G1 · B2's launcher table names bounty's `join.ts` as a CLI shape. The tree says otherwise, and the tree is right.

**Hit at:** writing the three launchers, chapter 1.

B2 says launchers come in two shapes and "pick by what the entry IS, not by what
it is called: **bounty's `join.ts` is a CLI shape**, grapevine's `daemon.ts` is
a daemon shape". By stdout contract that reading is correct — `join.ts` writes
JSON lines a caller parses, and the write most at risk is the terminal
`disconnected` frame emitted on the line before `main` returns, which is the
A-drain hazard at its sharpest.

**And the CLI shape was already MEASURED HERE AND IT HANGS.** The file carries a
25-line comment recording it: `process.exitCode` + a natural return leaves
`join.ts > idle timeout reports reason 'timeout'` running to a 15 s test
timeout, because a natural exit waits for the loop to drain and this file's
WebSocket is not guaranteed closed on every exit path. `process.exit` is doing
DOUBLE DUTY — draining is broken, force-terminating a live socket is
load-bearing. Shipping a hang to fix a truncation is a bad trade.

So the launcher is the daemon shape, the P0 (#77/#78) defect is carried across
unchanged and deliberately, and the reason is written at both the launcher and
the backend entry block. **What the playbook lacks is not the ruling but the
CATEGORY**: an entry whose exit is load-bearing for something other than exit —
which B2 has no third row for, and which its one named example turns out to be.

**Confirmed by drive, not by reading:** the `disconnected` frame was never
observed on the joiner's stdout in either of the two live join drives. Not
conclusive on its own (the drive stopped reading before the exit), and it is
consistent with the recorded truncation.

### G2 · B6.1 says "spawn the LAUNCHER, not the source". A suite that uses ONE constant for both jobs cannot follow it with one edit.

**Hit at:** the first full gate of chapter 1, as two red cells that read like
broken regexes.

B6.1 is right and is not the whole instruction. `server.test.ts` held
`const CLI = join(SCRIPT_DIR, "cli.ts")` and used it for BOTH spawning a process
and READING the source with `Bun.file(CLI).text()`. Re-pointing it at the
launcher silently re-pointed the source scans, which then read a 45-line comment
block and found none of what they pin:

```
4142 |   expect(m).not.toBeNull();
error: expect(received).not.toBeNull()
Received: null
```

That reads as "the regex broke", not "the file is wrong". **A source scan
follows the SOURCE; only a process spawn follows the launcher**, and the two
want separate constants (`CLI` and `CLI_SRC`) with the split written down.

The same class, one file over and with an ENOENT instead of a null:
`scripts/bounty-preflight.test.ts` reads the suite file by absolute path to
check `hermeticEnv`'s coverage. That one is loud, which is the difference worth
noting — a `readFileSync` that cannot find its subject says so, while a regex
over the wrong file returns null and looks like a bad pattern.

### G3 · B7's "prose that names the files you moved" is a category, not a footnote — and thirteen live backlog items were in it

**Hit at:** the `git grep` step of B7, chapter 1.

B7 adds this at the end as "thirty seconds, and it is the only step here with no
instrument behind it". For imago it was two instances. For bounty it was
**thirteen live backlog items** naming
`plugins/spellbook/skills/bounty/scripts/` — a spell with five years of
accumulated cards pays this in proportion to its age, not to the size of its
port. Two of them named `template.html`, deleted at the rewrite, and one had
been silently pointing at a path that never existed at the new location. Worth a
sentence in the playbook: the cost scales with the spell's HISTORY.

### G4 · Phase B has no step for an instrument the port itself breaks — and D44's rule says the port must not repair it

**Hit at:** the ARM 1b validation of chapter 1, driving `dist-check`.

D43 filed `spawn-path-ward`'s hard-coded `cli.js`/`server.js` as bounty's
problem and Cole PULLED IT FORWARD into the pre-work, ruling that "the
instrument that guards a port must not be repaired BY that port". Correct — and
there was a THIRD copy nobody had found, inside `scripts/dist-check.ts` ARM 1b,
and bounty's port is what made it observable (see D49; `git rm --cached` on
`dist/join.js` gave exit 0).

**Phase B says nothing about what to do here.** The options are: repair it
inline (the thing D44 forbids), or stop and hand it back (the port cannot then
be validated), or — what was done — **land it as its own commit BETWEEN the
chapters, before the work it guards**. That is the shape the playbook should
name, with the discriminator: repair it separately when the fix is small and the
instrument is what will judge your next chapter; hand it back when the fix is a
competing concern.

### G5 · B8's module table has no row for a spell that ALREADY HAD the thing being converged — and the delta runs backwards

**Hit at:** adopting `startHousekeeping`, chapter 2.

B8's table maps "the local shape you are looking for" to "the kit export", and
every row assumes the local shape is the WORSE one. bounty is where half the
spine was copied FROM: its `shouldIdleClose` IS the kit's, its `writeAtomic` IS
`writeFileAtomic`, its grace/close/race block IS `drainAndStop`, and census
defects L1–L4 were already correct here. Four of the eight rows are
de-duplications with no behaviour delta at all.

**And exactly one thing came back the OTHER way**, which the table has no cell
for: astrolabe's `timeoutMs <= 0` guard, folded into the kit at convergence and
absent from bounty's copy. Adopting it is a real behaviour change at one input
(`--timeout 0` used to close the board on the first idle tick; it now means
NEVER). The playbook's framing — adopt and gain — would have let that land
unnamed. **A port of a convergence-SOURCE spell must diff in both directions**,
and say for each row whether it gained, de-duplicated, or received something
back.

### G6 · B8 tells you to adopt `drainAndStop`. Nothing tells you to check that what the spell keeps still COVERS what it claims.

**Hit at:** driving the watchdog ruling — the port's assigned design question.

The brief asked what happens to bounty's shutdown watchdog under adoption, and
the kit's header had pre-committed to an answer ("the watchdog arrives as an
option on these arguments"). Driving it falsified the pre-commitment — a
`watchdogMs` on `drainAndStop` arms at DRAIN time and bounty's arms at SIGNAL
time — and then, in the same drive, showed that **bounty's watchdog did not
cover the window its own comment claimed**: `clearTimeout` sat four lines into a
fifteen-line teardown, so the final snapshot, the `closed` frame, `drainAndStop`
and discovery cleanup all ran unguarded. Two hang points where ARMED and
DISARMED were indistinguishable (D46's table).

**The generalisable instruction, which Phase B does not have:** when a spell
keeps a concern the kit deliberately does not share, the adoption is the moment
to DRIVE that concern's boundary — because the module you are adopting is now
inside it. Reading the code five times had not found this; planting a hang in a
copy of the shipped artifact found it in one run. It is D42's rule about
instruments arriving at a runtime guarantee: **a guard that names a window and
does not cover it reports the same thing as a window with nothing to guard.**

## Findings that are not playbook gaps

### F1 · B9's audit found a REAL swallow, and the adoption is what made it reachable

22 raise sites (21 × `die` + one `throw new UsageError` a token grep does not
see) across 16 functions and 18 `try` blocks. Every enclosing catch PROPAGATES
except `init --stdin-tasks`, where a `die` sits INSIDE the `try`: while `die`
was `process.exit(2)` the catch could never see it; adopting `errors.ts` makes
it throw, and without a ward the "stdin must be a JSON array" failure would be
caught and re-raised as "invalid JSON on stdin" — the same exit code with the
wrong diagnosis.

⚠ **The guard that was already there is not the fix.** It matched
`e.message.includes("JSON array")` over an untyped error — glamour's
`postCmd`/ECONNRESET shape exactly (D34) — correct only until someone rewords a
human-facing string. Now `if (e instanceof CliError) throw e`.

**One CONDITIONAL reported and NOT fixed:** `cmdOpen`'s start loop reads
`readSession` — die-reachable — **three lines above** a
`catch { /* not up yet */ }` that swallows. Third instance of that shape, after
glamour's `postCmd` and imago's own `cmdOpen`. Safe today; one refactor that
widens the `try` over the pointer read turns a corrupt session pointer into "not
up yet" and reports a taxonomy failure as a start timeout.

### F2 · Two defects the census did not carry, closed by adoption

- **The tail had no watchdog at all.** `await reader.read()` parks forever on a
  half-open socket — laptop sleep, a NAT rebind, a SIGKILLed daemon — and a
  watching agent cannot tell that from a quiet board. `TAIL_IDLE_MS`, derived
  from bounty's own beat in `src/bounty/backend/heartbeat.ts`, is the fix. This
  is the "a tail with no watchdog at all" line from glamour's list arriving at a
  second spell.
- **`emitEvent` let a payload `id` override the cursor.**
  `{ id: ++seq, ...msg }` sat directly beneath a comment saying "the monotonic
  `id` MUST win over any `id` in the payload"; spread order means it did not,
  and the only thing holding the sentence true was the convention that callers
  pass `taskId`. `eventLog` assigns after the spread.

### F3 · The blast radius, from `git status` — and the case it is

SIX artifacts across FIVE spells. bounty's own `cli.js` and `server.js`, plus
`dist/server.js` for astrolabe, glamour, imago and magpie: a ONE-PARAGRAPH
comment edit in `kit/wire/housekeeping.ts`'s header changes the inlined
`sourcesContent` in every daemon that bundles it. Executable bytes unchanged;
sourcemap not, and Contract 18 verifies by reproduction. **bounty's `join.js` is
untouched**, which is the sanity check — it imports no kit module.

So this is neither imago's case ("modified NO kit module, blast radius exactly
two") nor glamour's ("touched three kit modules, rebuilt six artifacts across
three spells"). It is a third one worth naming: **a kit change that alters no
behaviour at all still dirties every consumer**, because the sourcemap carries
the prose.

### F4 · The kit fit, with one boundary examined and left alone

Five consumers now, and bounty needed **no widening**. `sse.ts`'s `client.send`,
widened in Phase 2 for glamour's presence, covered bounty's presence case at
zero cost — the second piece of evidence (after imago) that that widening
generalised rather than fitting one spell. `housekeeping`'s `snapshot` option,
`sse`'s `filter`/`onOpen`/`onClose`, `tailEvents`' `terminalEmitsFiltered` and
`onUnresolved` all had a bounty shape waiting for them.

The one boundary that was examined and deliberately NOT moved is
`drainAndStop`'s — see D46 and G6.

### F5 · `join.ts` driven for real, which the gate does not prove

The entry no previous port had. Driven in BOTH modes, through the built launcher
chain (`scripts/join.ts` → `dist/join.js`), a host and a joining participant
connected and exchanging a task mutation each way:

```
OPEN  mode=release  {"url":…,"session_id":"bounty-253354a4-p64803",…}
  <- joiner {"type":"joined","url":…,"tasks":[]}
DIRECTION 1 joiner->host  OK — host `state` sees {"id":"from-joiner",…,"status":"todo"}
  host `update from-joiner --status doing` exit=0
  <- joiner {"type":"event","payload":{"type":"task.update","id":"from-joiner",…}}
DIRECTION 2 host->joiner  OK
JOIN exit=0 · CLOSE exit=0
```

### F6 · Contract 5's cwd pin, asserted rather than reasoned about

The brief predicted `SURFACE_CWD`'s five-level climb would survive because
`dist/` and `scripts/` sit at the same depth. `spawn-path-ward` resolves that
arithmetic **the way the runtime will, from the emitted file's own directory**,
and it lands on `src/bounty` — now the fourth declared instance of that one
escape. And the pin was driven end to end: a dev daemon serves
`/_bun/asset/…css` (Tailwind markers present) and `/_bun/client/…js`, which only
happens if `bunfig.toml` was read from `src/bounty/`.

## What I could not verify

- **That `join.ts`'s terminal `disconnected` frame is truncated by its exit.**
  The drive never observed the frame, which is consistent with the recorded
  measurement and is not a measurement of its own — the reader stopped before
  the exit. The defect is carried on the strength of the file's own record.
- **Whether `--timeout 0` had any caller.** Nothing documents it and nothing in
  the suite drives it; that is the whole basis for calling the old reading
  accidental.
- **acc:** N/A. bounty has no `acc.config.json` (D37), so there is nothing to
  run and nothing to regrade. ⚠ But B8's warning applies and is discharged
  explicitly: the port DID change the largest surface acc grades (the envelope
  and the exit codes), and nothing in the gate would have said so — D45 is where
  it is said.

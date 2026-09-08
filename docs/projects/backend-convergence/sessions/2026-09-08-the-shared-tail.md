# 2026-09-08 — the shared tail, and the contract under it

**Agent:** Claude Opus 5 (1M context), as the implementing agent · **Branch:**
`feat/backend-spine-phase-1` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 1a of the backend convergence** — the CLI-side modules, adopted by the
two spells that already build. Everything daemon-side is Phase 1b and was not
touched.

---

## What shipped, by sha

| chapter | sha       | what it is                                                                                                                                                   |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | `e2d6302` | **The modules** — `src/kit/wire/tailEvents.ts`, `src/kit/wire/errors.ts`, and 14 unit cells. The P0f scar re-homed onto the client, written once.            |
| 2       | `51d8859` | **astrolabe adopts** — the tail, the error contract, the B1 test that failed first, the rebuilt `dist/cli.js`, and the exit-site inventory losing four rows. |
| 3       | `3db3735` | **magpie adopts** — the tail, the error contract it was drawn from, the rebuilt `dist/cli.js`, and four more inventory rows.                                 |
| 4       | `56a8157` | **The records** — this file, the phase journal, and D7/D8 in the decision log.                                                                               |

## The numbers

|                                           | before                             | after                                              |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| `bun run gate`, unpiped, exit from a file | not measured before the work began | **0** · 1,891 pass / 0 fail · 258 s                |
| `bun scripts/dist-check.ts`               | 0                                  | **0** — 8 spells, 26 tracked files                 |
| SSE tail loops in the tree                | 7                                  | **5** hand-written + 1 shared                      |
| CLI error contracts                       | 4                                  | **3** + 1 shared                                   |
| `P0f SHAPE B` comment copies              | 5                                  | **3** + 1 canonical, on the client                 |
| live `process.exit(` sites, astrolabe     | 4                                  | **0**                                              |
| live `process.exit(` sites, magpie        | 5                                  | **1** (the module-level EPIPE guard, out of scope) |
| exit-site inventory rows                  | 35                                 | **27**                                             |

## What was driven, and how

**B1 — the headline. Driven, and seen to FAIL FIRST.** A scripted fake daemon
answers `/state` and `/events`, dies, and comes back on a different ephemeral
port with the pointer file updated. Against the unfixed CLI the post-restart
read returned EMPTY after the full 15-second window — the tail still dialling
the dead port, exactly the defect. Against the shared client it passes in 279
ms. `src/astrolabe/backend/cli.test.ts`.

**B2, B3, B4 fell with it**, by construction rather than by a fix: the idle
watchdog, the drained signal path, and EPIPE-as-a-completed-read are properties
of the one client, so both spells have them and no site can lose one. B2's
watchdog and its keepalive feeding are driven directly in the kit's own cells.
B5 (backoff growth) and B7 (monotonic cursor) are likewise structural and
covered; B6 (spec-legal `data:` frames) is driven in `parseSseFrame`'s cells.
**B3 and B4 are argued from structure and are NOT driven** — no cell sends a
signal to a live tail or closes a downstream pipe on one. Named rather than
implied.

**Not driven: a real daemon.** Every cell here runs against a scripted fake. The
two spells' existing integration tests (astrolabe's `cli ↔ daemon`, magpie's
daemon integration) do run against real daemons and are green, but neither
exercises a tail across a restart. No daemon was started outside the test
harness during this phase.

## What the phase deliberately did not reach

- **The daemon side.** `sseResponse`, the event bus, housekeeping, discovery,
  `drainAndStop` — all Phase 1b, all untouched, per the brief's scope line.
- **The other five tails.** glamour, imago, bounty, mind-mapper and grapevine
  still each carry their own loop. The paper check in the journal says the
  signature serves all five, and names the one hook grapevine will want.
- **`mind-mapper/scripts/tail.test.ts`.** Read as the specification, not
  modified, not re-pointed — that is a later phase's deliverable and the
  acceptance criteria for the whole tail half.
- **`grimoire/daemon-lifecycle-ward.test.ts`.** Its deletion is a project
  deliverable and it is not due yet: it guards daemon properties, and this phase
  moved nothing daemon-side.
- **Moving `printJson` into `wire/`.** It belongs there; its path is spelled in
  eight prose locations. Stated as debt in D7.

## The post-verification round (chapter 5)

Verification came back with seven items; all seven are in one chapter.

- **A regression the phase nearly shipped:** Ctrl-C during backoff took up to
  `retry.maxMs` — 2.80s measured, against 0.13s for the hand-written loop —
  because installing a SIGINT handler suppresses the default terminate and the
  backoff was a bare timer. The sleep is now wakeable. Re-measured on the BUILT
  `dist/cli.js`: **0.129s / 0.124s**, against a 0.12s control.
- **`err` is wired**, and the orchestrator's ruling that a diagnostics sink is
  not a fifth escape hatch is recorded on `onDisconnect` itself. `onComment` and
  `onMalformed` now return lines instead of writing them, and a cell asserts
  that only data reaches `out`.
- **Both watchdogs are derived** from their own daemon's heartbeat expression
  rather than a hard-coded 45,000 — astrolabe's was breakable by any
  `ASTROLABE_HEARTBEAT_MS` above that.
- **B5 went further than claimed:** the backoff reset moved from a successful
  OPEN to the first BYTE, and the fall-through path grew a doubling line it
  never had in any of the seven loops.
- A non-2xx body is cancelled before the retry.
- Cells added for `terminal` / `terminalEmitsFiltered` (the exit path both
  adopters depend on), B5's growth, the stop-during-backoff path, and the
  diagnostics split.
- **D8's census was wrong twice** — 15 and 29, not 16 and 30 — and, more
  importantly, its criterion was: it is _reachability from inside a swallowing
  `try`_, not _call sites_. Corrected in the decision log and on the module,
  because the Phase 2 playbook inherits that sentence.
- **The kit-prose ward gained its missing half** (bare single-word utilities),
  calibrated red by a live occurrence in the tree.

## What the next phase should read first

The journal's kit-prose finding. Two words in a comment put CSS into three
unrelated spells' shipped stylesheets, the ward for that leak stayed green
because single-word utilities are its declared blind spot, and the only thing
that caught it was `dist-check`'s reproduction arm. **Every module that lands in
`src/kit/` is another chance to do it again**, and Phase 1b lands several.

---

## Independently driven by the verification agent (2026-09-08)

Not the author's instruments; separate fakes, the real astrolabe daemon, and the
`5b52e95` `dist/cli.js` of each spell as the old-code control.

| claim                      | control (5b52e95)                                          | HEAD                                     |
| -------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| **B1** daemon moves port   | tail alive, output frozen, dead port forever               | follows to the new port, event delivered |
| **B2** silent daemon       | one `/events` request, parked forever                      | reconnects at +47.4s / +92.6s / +137.9s  |
| **B3** SIGINT, slow reader | **65,536 bytes** of 403,068 (astrolabe) / 401,487 (magpie) | **all of it**, both spells               |
| **B4** `tail \| head -1`   | hangs indefinitely (astrolabe)                             | exit 0                                   |

So **B3 and B4 are no longer undriven**, and both hold.

⚠ **One unnamed behaviour difference, measured.** SIGINT during a reconnect
backoff: old **0.13 s** to exit, new **2.80 s** (ceiling `retry.maxMs` = 5 s),
and repeated SIGINTs do not shorten it — `stop()` aborts the in-flight attempt
but the backoff `sleep()` is an unabortable `setTimeout`, and the installed
SIGINT listener suppresses the default terminate.
`magpie tail --session <dead port>`, three SIGINTs, 2.78 s.

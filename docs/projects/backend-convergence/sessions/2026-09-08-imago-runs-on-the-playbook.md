# 2026-09-08 — imago runs on the playbook, and the playbook is what got tested

**Agent:** Claude Opus 5, as the implementing agent · **Branch:**
`feat/imago-backend-port` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 3 of the backend convergence — and the phase's real subject is not
imago.** Phase 2 produced Phase B of
`docs/playbooks/porting-a-spell-playbook.md` so that five more spells could port
without re-earning glamour's failures. This session is **the first port driven
by that document rather than written from one**, and its most valuable output is
the list of places the document was not enough. Imago was chosen because it is
the line glamour forked from: if Phase B fails here, it fails everywhere, and it
fails now rather than on grapevine.

---

## What shipped, by sha

| chapter | sha       | what it is                                                                                                                                                                                                                           |
| ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1       | `1fa8d06` | **imago relocates and builds** — three modules and five test files into `src/imago/backend/`, two launchers, committed `dist/cli.js` + `dist/server.js`. Seven ward cells re-declared across five files. Driven in both modes.       |
| 2       | `96b3ab7` | **imago adopts the spine** — all eight `src/kit/wire/` modules and its own `heartbeat.ts` seam. Five census defects closed and one narrowed, each driven. The CLI's failure contract changes (D38). Zero blast radius outside imago. |
| —       | (this)    | **The records, and the deliverable that is not code** — the Phase B amendment pass, this file, `phase-3-journal.md`, D38–D40.                                                                                                        |

## The numbers

|                                                      | before                    | after                                     |
| ---------------------------------------------------- | ------------------------- | ----------------------------------------- |
| `bun run gate`, unpiped, exit read from a file       | 0 · 1,963 pass / 0 fail   | **0** · **1,963 pass / 0 fail** · ~268 s  |
| `bun scripts/dist-check.ts`                          | 0                         | **0**                                     |
| acc                                                  | **no config** (D37)       | **no config** — not acquired, by decision |
| spells shipping a built DAEMON                       | 3                         | **4**                                     |
| imago CLI `process.exit` sites in the exit inventory | 4                         | **0** (the fourth CLI to reach zero)      |
| shipped pins the spawn-path ward governs for imago   | 0 (not in its population) | **9** (`cli.js` 5, `server.js` 4)         |
| imago event-replay buffer                            | unbounded                 | **1,000**, driven with 1,100 frames       |
| kit modules imago shares                             | 0                         | **8**                                     |
| kit boundaries that had to be widened for imago      | —                         | **0**                                     |

## The four things the brief said to confirm rather than assume

1. **33 surface imports of the skill folder.** Confirmed exactly: 32 of
   `shared/types`, 1 of `shared/imageOptimize`, and **nothing else**. So D10's
   rule keeps both `shared/` modules and moves all three `scripts/*.ts`.
2. **Both entries are `if (import.meta.main)`** (`cli.ts:642`,
   `server.ts:1758`). Confirmed, and **B3 does cover it** — including the harder
   half, that the daemon must keep no second entry.
3. **The ward covers imago.** ⛔ **Confirmed, but only after a step B4 does not
   contain.** On the fresh build the coverage table had **no imago row at all**
   — not `pins=0` — because `emittedJs()` reads `git ls-files` and the artifacts
   were untracked. Staged and re-run:
   `cli.js anchors=yes anchor-read=yes pins=5`, `server.js … pins=4`, and the
   spawn pin resolving to `…/imago/scripts/server.ts`. **This is the phase's
   most transferable finding** and it is now B4's first instruction.
4. **No `acc.config.json`, and none acquired.** Confirmed (D37). ⚠ And the port
   changed a graded surface anyway — see D38.

## The seven playbook gaps, in the order they were hit

Full accounts in `phase-3-journal.md`; all seven are folded into Phase B.

1. **G1 — the PREREQUISITE does not apply, and Phase B does not say so.** "acc
   conformance first" is the first, blocking instruction; half the roster has no
   grade. Only D37, unreferenced from Phase B, resolves it.
2. **G2 — Phase B prescribes no CHAPTERS**, while every brief says "chapter it
   as B prescribes". The governing rule is D9, in the decision log. Now `B0`.
3. **G3 — B4's coverage row is ABSENT, not zero, until the artifact is staged.**
   The ward is blind to every spell on the commit that first emits its backend.
   Same population-versus-coverage defect as D27 and D36, one level up again.
4. **G4 — B7's ward list is wrong in both directions.** It omits
   `spawn-path-ward`'s own hand-kept escape list; it still names
   `daemon-lifecycle-ward`, which Phase 1b made generic and which did not red;
   it treats `exit-site-inventory` as one event when it reds in both chapters;
   and it has no step for the live prose that names the moved files (two found).
5. **G5 — B8 treats `errors.ts` as internal. It is the failure contract.** On a
   CLI that did not already speak the envelope, adopting it changes every
   failure's bytes and exit code, with nothing in the gate to say so. Invisible
   from glamour, which was already CONFORMANT L0. → **D38**.
6. **G6 — B8 names eight modules, no mapping, and one unnamed per-spell ruling**
   (the epoch). Both now in the step. → **D39**.
7. **G7 — B6 has no answer for a test cell whose SUBJECT the bundle absorbed**
   (imago's `shared/`-must-be-present cell, inverted rather than deleted), nor
   for one that had encoded the old module's byte layout (the `: connected`
   preamble).

## What TRANSFERRED — the larger half, stated because "no gaps" is unfalsifiable

- **B4 predicted imago's shipped defect before anyone looked for it.** imago's
  CLI spawned `join(SCRIPT_DIR, "server.ts")` — the exact glamour shape, which
  from `dist/` resolves to a `dist/server.ts` that does not exist and fails as a
  5-second start timeout rather than a crash.
- **B1's import rule decided a test its filename would have mis-sorted**
  (`state.test.ts`), and B3, B5 and B6 held verbatim.
- **B9's audit found a second CONDITIONAL swallow, at a second spell** —
  `cmdOpen`'s `readSession` three lines above a `catch { /* not up yet */ }`.
  Two spells, two conditionals, both three lines from being real. That is the
  argument for the step's cost.
- **The kit needed no widening for its fourth consumer.** `sse.ts`'s
  `client.send`, widened in Phase 2 for glamour's presence, covered imago's
  presence case at zero cost — the first evidence that a Phase 2 widening
  generalised rather than fitting one spell.

## Census defects, each named with the module that closed it — and one that did not close

| #      | module                     | how it was verified                                                                                        |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **L1** | `kit/wire/housekeeping.ts` | Driven both ways on `--timeout 4`: alive at t=2/8/14 s with a tail attached; dead within 8 s of detaching. |
| **L2** | `kit/wire/housekeeping.ts` | Driven: a 2 s `/state` poll held a `--timeout 4` daemon for 14 s. It used to be idle-closed under itself.  |
| **L5** | `kit/wire/eventLog.ts`     | Driven with 1,100 browser frames: cursor 1101, replay from `since=0` exactly **1000**, oldest id 102.      |
| **L7** | `kit/wire/sse.ts`          | Driven: after one connect+disconnect the replay holds exactly one frame, `ready`.                          |
| **L3** | `kit/wire/discovery.ts`    | imago was already correct; adoption removes the fourth copy rather than fixing anything.                   |
| **L6** | —                          | ⚠ **NARROWED, NOT CLOSED.** imago stamps no epoch (D39); D23's equality gap stands.                        |

**And one defect nobody had filed, found by adopting.** `emitEvent` wrote
`{ id: ++eventSeq, ...msg }` — the spread AFTER the id — so any frame carrying
its own `id` overrode the cursor. imago's `proposal.send` and `proposal.dismiss`
frames DO carry one, so they went on the wire with a proposal's id as their
cursor value. Driven with 1,100 such frames: every wire id is now a number.

## What was driven, and what was not

**Driven, on booted daemons through the real launcher chain, in both chapters:**
release mode (committed hashed chunks, `mode` on both the discovery file and the
ready frame, `state`/`say`/`info`/`close`); dev mode (`/_bun/client/…`,
`/_bun/asset/…`, 53,290 B of compiled Tailwind v4.1.14 with 246 markers, and the
daemon's cwd read off the live process as `…/src/imago` — Contract 5's pin
surviving the relocation); the tail, attaching and replaying; the five failure
envelopes; L1, L2, L5, L7. Every daemon had its own `IMAGO_HOME` and `TMPDIR`
under the session scratchpad and every one was torn down.

**NOT verified, said plainly:**

- **The browser board was never opened.** No surface change was made and the
  surface build is byte-identical, but "the board renders" is asserted here only
  through the served bytes, not through a rendering engine.
- **L1's real-world timing.** It was driven at `--timeout 4`, not at the 1800 s
  default; the mechanism is the same and the wall-clock is not.
- **The `--restore` path across the adoption.** Covered by the integration
  suite, not by hand.
- **Any spell but imago.** No `src/kit/` file was modified, and `git status`
  after the gate showed no other artifact or stylesheet moving.

## Filed, not fixed

- **F1 — the spawn-path ward can be silent about a spell it has already named in
  its population.** The honest cell is D36's own reasoning applied one level up.
  **This should be the first thing Phase 4 picks up.**
- **F3 — the CONDITIONAL swallow** in `cmdOpen`, reported per B9 and left alone.
- **K1 / D40 — the teardown ORDER diverges** between glamour and imago in a step
  the spine was supposed to converge. Ruling it means ruling it for all seven
  daemons.

## The line for the next agent

**Bounty is next, and it is the first spell that is nobody's fork.** Everything
in this phase that transferred, transferred to glamour's own ancestor; the
mapping table now in B8 exists precisely because "read a ported sibling
side-by-side" is the method that stops working there. Take the B4 staging step
literally, read your `die` before you adopt the kit's, and decide the epoch on
purpose.

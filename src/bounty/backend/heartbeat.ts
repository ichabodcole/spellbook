/**
 * Bounty's connection-timing constants — THE ONE COPY, imported by both halves
 * of the spell.
 *
 * ⛔ THIS FILE IS THE SEAM, AND IT IS THE CLEANEST PROOF THE PORT WORKED.
 * Before Phase 4 the heartbeat was a LITERAL `15000` inside `server.ts`'s
 * hand-rolled `sseResponse`, and `idleTimeout: 255` sat 300 lines away in
 * `Bun.serve`'s options under a comment explaining the relationship between
 * them — a relationship that held at those two values and at no others.
 * `cli.ts` had NO corresponding number at all: `cmdTail` blocked on
 * `reader.read()` with no watchdog, so a silently dead socket parked the tail
 * forever, which is the failure `src/kit/wire/tailEvents.ts` exists to end.
 *
 * Neither file could import the other, because the CLI reaching into the daemon
 * would drag the whole server graph into `dist/cli.js`. A module whose only
 * imports are the kit's derivations has no such graph, so both halves import
 * this one. **A value that could not previously cross the seam now crosses it.**
 *
 * ⛔ **AND THE WATCHDOG IS DERIVED FROM BOUNTY'S OWN HEARTBEAT, NEVER COPIED
 * FROM A SIBLING.** Astrolabe beats at 10 s, bounty and imago at 15 s, so a
 * hard-coded watchdog is correct for at most one of them. Astrolabe measured
 * what a copied number does: a 45 s watchdog against an env-tuned heartbeat
 * produced reconnects at +47.4 s, +92.6 s and +137.9 s against a perfectly
 * healthy daemon, harmless only because an unrelated third constant absorbed
 * the churn. `tailIdleMs(SSE_HEARTBEAT_MS)` cannot drift from the beat it is
 * watching, whatever the beat becomes.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the seam closes.
 *
 * ⚠ **WHAT IS DELIBERATELY NOT HERE.** `BOUNTY_SHUTDOWN_WATCHDOG_MS` (the
 * teardown backstop) and the board's `--timeout` (the idle-close floor) are
 * LIFECYCLE quantities, not connection-timing ones: neither is derived from the
 * beat and neither belongs to the CLI. They stay in `server.ts` beside the
 * machinery they bound.
 */

import {
  DEFAULT_HEARTBEAT_MS,
  heartbeatMs,
  idleTimeoutSec,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/**
 * Bun's maximum, and it is bounty's own measured value rather than an inherited
 * one: `server.ts` carried `idleTimeout: 255` under a P1e comment recording
 * that Bun's default 10 s closes a held SSE connection before the 15 s
 * keepalive ever fires — so raising the beat rate would not have helped, and
 * the two numbers had to be ORDERED rather than merely chosen.
 * `BOUNTY_IDLE_TIMEOUT_SEC` is accepted so the pair can be tuned TOGETHER; the
 * clamp below is what keeps them a pair.
 */
export const IDLE_TIMEOUT_SEC = idleTimeoutSec(
  process.env.BOUNTY_IDLE_TIMEOUT_SEC,
  MAX_IDLE_TIMEOUT_SEC,
);

/**
 * The SSE heartbeat — bounty's own literal 15 s before this file existed, now
 * CLAMPED to half the idle timeout.
 *
 * ⛔ THE CLAMP IS THE FIX FOR A BUG THIS SPELL ALREADY PAID FOR ONCE. The old
 * code wrote 15,000 and 255 in two different functions and recorded the
 * relationship only in prose — which holds at the defaults and at no other
 * value, and `server.test.ts`'s P1e cell had to SOURCE-SCAN both literals with
 * two regexes to check it. Deriving it makes `heartbeat <= idleTimeout / 2`
 * true for ANY configured pair, which is the property that cell was reaching
 * for.
 */
export const SSE_HEARTBEAT_MS = heartbeatMs(
  process.env.BOUNTY_HEARTBEAT_MS,
  IDLE_TIMEOUT_SEC,
  DEFAULT_HEARTBEAT_MS,
);

/**
 * The tail watchdog: three missed beats, DERIVED. 45,000 ms at the defaults.
 *
 * ⛔ BOUNTY HAD NO SUCH NUMBER BEFORE THIS PORT, and that is the point rather
 * than a detail. `cmdTail` awaited `reader.read()` with no deadline, so a
 * socket that went quiet without closing held the tail open for as long as the
 * OS kept the connection — and a watching agent has no way to tell that from a
 * quiet board.
 *
 * ⚠ THE NUMBERS IT MIGHT BE CONFUSED WITH, NAMED SO NOBODY LATER
 * "DE-DUPLICATES" THEM: `cmdOpen`'s 5,000 ms start deadline (bounding a first
 * bundle build), the 3,000 ms close/liveness polls, and the board's own
 * `--timeout` idle floor in SECONDS. All different quantities; none derived
 * from the beat.
 */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

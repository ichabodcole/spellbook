/**
 * Imago's connection-timing constants — THE ONE COPY, imported by both halves
 * of the spell.
 *
 * ⛔ THIS FILE IS THE SEAM, AND IT IS THE CLEANEST PROOF THE PORT WORKED.
 * Before Phase 3 the heartbeat was a LITERAL `15000` inside `server.ts`'s
 * `sseResponse`, sitting under a comment about `idleTimeout: 255` written 1,300
 * lines away in a different function — and `cli.ts` had NO corresponding number
 * at all: its tail loop blocked on `reader.read()` with no watchdog, which is
 * the failure `tailEvents` exists to end. Neither file could import the other,
 * because the CLI reaching into the daemon would drag the whole server graph
 * into `dist/cli.js`. A module whose only imports are the kit's derivations has
 * no such graph, so both halves import this one. A value that could not
 * previously cross the seam now crosses it.
 *
 * ⛔ **AND THE WATCHDOG IS DERIVED FROM IMAGO'S OWN HEARTBEAT, NEVER COPIED
 * FROM A SIBLING.** Astrolabe beats at 10 s and imago at 15 s, so a hard-coded
 * watchdog is correct for at most one of them. Astrolabe measured what a copied
 * number does: a 45 s watchdog against an env-tuned heartbeat produced
 * reconnects at +47.4 s, +92.6 s and +137.9 s against a perfectly healthy
 * daemon, harmless only because an unrelated third constant absorbed the churn.
 * `tailIdleMs(SSE_HEARTBEAT_MS)` cannot drift from the beat it is watching,
 * whatever the beat becomes.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the seam closes.
 */

import {
  DEFAULT_HEARTBEAT_MS,
  heartbeatMs,
  idleTimeoutSec,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/**
 * Bun's maximum, and it is imago's own measured value rather than an inherited
 * one: `server.ts` carried `idleTimeout: 255` under a comment recording that
 * Bun's default 10 s closes a held SSE connection before the 15 s keepalive
 * ever fires — "the keepalive arrives five seconds after the thing it was
 * keeping alive is gone", which is why raising the beat rate would not have
 * helped. `IMAGO_IDLE_TIMEOUT_SEC` is accepted so the pair can be tuned
 * TOGETHER; the clamp below is what keeps them a pair.
 */
export const IDLE_TIMEOUT_SEC = idleTimeoutSec(
  process.env.IMAGO_IDLE_TIMEOUT_SEC,
  MAX_IDLE_TIMEOUT_SEC,
);

/**
 * The SSE heartbeat — imago's own literal 15 s before this file existed, now
 * CLAMPED to half the idle timeout.
 *
 * ⛔ THE CLAMP IS THE FIX FOR THE BUG THIS SPELL ALREADY PAID FOR. The old code
 * wrote 15 s and 255 s in two different functions and recorded the relationship
 * only in prose, which holds at the default and at no other value. Deriving it
 * makes `heartbeat <= idleTimeout / 2` true for ANY configured pair.
 */
export const SSE_HEARTBEAT_MS = heartbeatMs(
  process.env.IMAGO_HEARTBEAT_MS,
  IDLE_TIMEOUT_SEC,
  DEFAULT_HEARTBEAT_MS,
);

/**
 * The tail watchdog: three missed beats, DERIVED.
 *
 * ⚠ 45,000 ms at the defaults. imago's CLI has no `--start-timeout`; the number
 * it might be confused with is `cmdOpen`'s 5,000 ms start deadline, which is a
 * different quantity entirely — one bounds a first bundle build, the other
 * bounds a silent socket. Named here so nobody later "de-duplicates" them.
 */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

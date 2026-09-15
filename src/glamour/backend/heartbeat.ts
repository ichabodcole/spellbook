/**
 * Glamour's connection-timing constants — THE ONE COPY, imported by both halves
 * of the spell.
 *
 * ⛔ THIS FILE IS THE SEAM. Before Phase 2 the heartbeat was a LITERAL `15000`
 * inside `server.ts`'s `sseResponse`, and `cli.ts` had NO corresponding number
 * at all — its tail loop simply blocked on `reader.read()` forever, which is the
 * failure `tailEvents`'s watchdog exists to end. Neither file could import the
 * other: the CLI reaching into the daemon would drag the whole server graph into
 * `dist/cli.js`. A module with no imports but the kit's derivations has no such
 * graph, so both halves import this one.
 *
 * ⛔ **AND THE WATCHDOG IS DERIVED FROM GLAMOUR'S OWN HEARTBEAT, NEVER COPIED
 * FROM A SIBLING.** This is Phase 1a's rule and it is the whole reason the file
 * exists rather than a shared constant somewhere: astrolabe beats at 10 s and
 * magpie at 15 s, so a hard-coded watchdog is correct for at most one of them.
 * Astrolabe measured what a copied number does — a 45 s watchdog against an
 * env-tuned heartbeat produced reconnects at +47.4 s, +92.6 s and +137.9 s
 * against a perfectly healthy daemon, harmless only because an unrelated third
 * constant absorbed the churn. `tailIdleMs(SSE_HEARTBEAT_MS)` cannot drift from
 * the beat it is watching, whatever the beat becomes.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the seam closes.
 */

import {
  DEFAULT_HEARTBEAT_MS,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/**
 * Bun's maximum. This is glamour's own measured value, not an inherited one:
 * `server.ts` carried `idleTimeout: 255` with a comment recording that Bun's
 * default 10 s closes a held SSE connection before the 15 s keepalive ever
 * fires. Glamour does not env-tune it — a session daemon's connection lifetime
 * is not something a caller has ever needed to shorten.
 */
export const IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;

/** The house default, and glamour's own literal before this file existed. */
export const SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;

/**
 * The tail watchdog: three missed beats, DERIVED.
 *
 * ⚠ 45,000 ms today, which is the same number `cmdOpen`'s `--start-timeout`
 * default happens to be. They are UNRELATED — one bounds a first bundle build,
 * the other bounds a silent socket — and the coincidence is named here so nobody
 * later "de-duplicates" them into one constant.
 */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

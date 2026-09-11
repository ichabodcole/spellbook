/**
 * scriptorium's connection-timing constants — THE ONE COPY, imported by both
 * halves (`cli.ts`'s tail watchdog, `server.ts`'s SSE heartbeat and idle
 * timeout). Kit verdict `heartbeat`: SUBJECT — the seam exists because the CLI
 * and the daemon are two processes that must agree on one invariant
 * (`idleTimeout > heartbeat`, `watchdog > heartbeat`), and neither may import
 * the other.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, `dist/cli.js` drags the server graph and the seam closes.
 */

import {
  DEFAULT_HEARTBEAT_MS,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/** Bun's maximum: a held SSE tail must outlive Bun's 10 s default. */
export const IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;

/** The house default. */
export const SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;

/** The tail watchdog: three missed beats of THIS daemon's heartbeat, derived. */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

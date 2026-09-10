/**
 * Magpie's connection-timing constants — THE ONE COPY, imported by both halves
 * of the spell.
 *
 * ⛔ THIS FILE IS THE SEAM. Before Phase 1b the heartbeat was a LITERAL 15,000
 * inside the daemon's `sseResponse` and a second literal 15,000 in `cli.ts`,
 * under a comment naming the file and the function the first one lived in.
 * That is the shape a shared spine exists to end: the CLI could not import the
 * daemon without dragging the whole server graph into `dist/cli.js`, so the
 * only available fix was a sentence asking the next author to remember.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE — see astrolabe's twin for why.
 */

import {
  DEFAULT_HEARTBEAT_MS,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/** Bun's maximum. Magpie does not env-tune this — a session daemon's connection
 *  lifetime is not something a caller has ever needed to shorten. */
export const IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;

/** The house default. */
export const SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;

/** The tail watchdog: three missed beats, DERIVED rather than chosen. */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

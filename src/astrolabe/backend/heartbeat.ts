/**
 * Astrolabe's connection-timing constants — THE ONE COPY, imported by both
 * halves of the spell.
 *
 * ⛔ THIS FILE IS THE SEAM. Before Phase 1b these three expressions existed
 * TWICE: once in the daemon, which uses them to configure `Bun.serve` and its
 * SSE heartbeat, and once hand-mirrored in `cli.ts`, which needs the same
 * numbers to size the tail watchdog. Both copies carried a comment saying so —
 * "an edit there is an edit here" — because the CLI could not import the daemon
 * without dragging the whole server graph into `dist/cli.js`.
 *
 * A module with no imports but the kit's derivations has no such graph, so both
 * halves import it and the mirroring is gone. This is the phase's cleanest
 * proof that the seam is real: a value that could not previously cross it.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the mirroring
 * comes back with it.
 */

import { heartbeatMs, idleTimeoutSec, tailIdleMs } from "../../kit/wire/heartbeat.ts";

/** Held SSE and WS connections die without this — see `kit/wire/heartbeat.ts`.
 *  Env-tunable because the daemon's own tests drive a short window. */
export const IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.ASTROLABE_IDLE_TIMEOUT);

/** Astrolabe beats faster than the house default (10 s, not 15 s) because
 *  `join` carries PRESENCE: a card in a human's view goes idle when the tail
 *  drops, so this spell buys a wider margin against the idle timeout than the
 *  session spells need. Clamped to half the idle timeout for any configured
 *  value, which is the invariant the clamp exists to hold. */
export const SSE_HEARTBEAT_MS = heartbeatMs(
  process.env.ASTROLABE_HEARTBEAT_MS,
  IDLE_TIMEOUT_SEC,
  10_000,
);

/** The tail watchdog: three missed beats, DERIVED rather than chosen. */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

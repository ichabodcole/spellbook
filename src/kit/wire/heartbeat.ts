/**
 * The heartbeat / idle-timeout / tail-watchdog triple — three numbers that are
 * ONE invariant, written once.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * ── WHY THIS MODULE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The three numbers are chained, and the chain is what nobody could see:
 *
 *     server idleTimeout  >  SSE heartbeat  ·  tail watchdog  >  SSE heartbeat
 *
 * - **`idleTimeout` > heartbeat**, or Bun closes a held SSE connection before
 *   the keepalive that was supposed to preserve it ever fires. MEASURED: Bun's
 *   default request `idleTimeout` is 10 s and a SERVER-SENT heartbeat does not
 *   reset it, so a 15 s `: hb` arrives five seconds after the thing it was
 *   keeping alive is gone — which is why raising the heartbeat RATE would not
 *   have helped. Four spells had hit this and repaired it, three had not.
 * - **watchdog > heartbeat**, or a healthy-but-quiet tail aborts and reconnects
 *   forever. MEASURED on astrolabe: with a hard-coded 45 s watchdog and an
 *   env-tuned heartbeat, reconnects landed at +47.4 s, +92.6 s and +137.9 s
 *   against a perfectly healthy daemon. It was harmless only because a THIRD
 *   constant — a presence debounce with no relationship to either — happened to
 *   absorb the churn.
 *
 * ⛔ **AND THE SEAM IS THE POINT.** Until Phase 1b the watchdog lived in each
 * spell's CLI and the heartbeat in each spell's daemon, and BOTH files carried a
 * comment saying the expressions were hand-mirrored across a boundary the CLI
 * could not cross — importing the daemon would have dragged the whole server
 * graph into `dist/cli.js`. This module is the crossing: it holds no spell's
 * numbers, only the derivations, and each spell's own tiny `heartbeat.ts`
 * beside its daemon holds the values that BOTH halves then import. A value that
 * could not previously cross the seam now crosses it.
 */

/** Bun's maximum `idleTimeout`, in seconds. `0` is not "disabled" — it is the
 *  default — so the way to hold a connection open is to ask for the maximum. */
export const MAX_IDLE_TIMEOUT_SEC = 255;

/** The house default heartbeat, in ms. Six of the eight daemons write 15 s. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/** How many missed beats the tail watchdog tolerates before it aborts and
 *  reconnects. Three, everywhere, and it is a floor not a taste: holding the
 *  connection open IS a `join`'s presence signal, so every watchdog fire flaps a
 *  card in a human's view. It still wants a watchdog — a wedged half-open socket
 *  shows a card as permanently present, which is the worse lie. */
export const MISSED_BEATS = 3;

/**
 * The smallest beat this module will hand back, in ms — the FLOOR half of the
 * clamp whose ceiling is `idleTimeout / 2`.
 *
 * ⛔ IT EXISTS BECAUSE `intOr` PARSES WITH `parseInt`, AND `parseInt` IS LENIENT
 * WHERE IT MATTERS MOST. `intOr` falls back safely on everything that LOOKS
 * hostile — `""`, `"0"`, `"-1"`, `"abc"`, `"NaN"`, `"Infinity"` all take the
 * fallback — and then reads `"1e9"`, the most plausible spelling of "make it
 * huge", as **1**. MEASURED at grapevine's Phase 6 repair, before this floor:
 * `GRAPEVINE_HEARTBEAT_MS=1e9` put ~528 keepalive comments into every open SSE
 * client in 528 ms. `"3.9"` gives 3 ms and `"5abc"` gives 5 ms the same way.
 * A knob whose fastest setting is spelled like its slowest is a flood.
 *
 * ⚠ **THE FLOOR IS HERE AND NOT IN `intOr` — that is the ruling, not an
 * accident of where it was easy to write** (D76). `intOr` is the general parser
 * behind every env knob in the kit; there is no single roster-correct minimum
 * for "a positive integer", and tightening its PARSE (rejecting `1e9` outright)
 * would change what every other knob accepts, silently, for values nobody has
 * audited. `heartbeatMs` already owns one end of this invariant, and 500 was
 * already written into it as the smallest ceiling it would compute. The floor
 * belongs beside the ceiling, where the quantity is known.
 */
export const MIN_HEARTBEAT_MS = 500;

/** Parse a positive integer from an env value, falling back on anything that is
 *  absent, empty, non-numeric or non-positive. ⚠ `parseInt` semantics: `"1e9"`
 *  is 1 and `"5abc"` is 5. Any caller with a known safe minimum must clamp —
 *  see `MIN_HEARTBEAT_MS`. */
function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The server's `idleTimeout`, in SECONDS, clamped to what Bun accepts. */
export function idleTimeoutSec(raw?: string | undefined, fallback = MAX_IDLE_TIMEOUT_SEC): number {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}

/**
 * The SSE heartbeat, in ms, CLAMPED AT BOTH ENDS: never above half the idle
 * timeout, never below `MIN_HEARTBEAT_MS`.
 *
 * The ceiling is astrolabe's, and the census named it convergence target #4:
 * the other daemons hard-code 15 s against 255 s and write the relationship
 * only in prose, which holds at the default and at no other value. Enforcing
 * `heartbeat <= idleTimeout / 2` makes the invariant true for ANY configured
 * pair, which is exactly the invariant whose violation caused the bug above.
 *
 * ⚠ The floor cannot fight the ceiling: the ceiling expression is itself
 * `Math.max(500, …)`, so it is never below `MIN_HEARTBEAT_MS` and the two
 * clamps can never cross.
 */
export function heartbeatMs(
  raw: string | undefined,
  idleSec: number,
  fallback = DEFAULT_HEARTBEAT_MS,
): number {
  const ceiling = Math.max(MIN_HEARTBEAT_MS, Math.floor((idleSec * 1000) / 2));
  return Math.min(Math.max(intOr(raw, fallback), MIN_HEARTBEAT_MS), ceiling);
}

/** The tail-side watchdog for a given heartbeat: three missed beats. */
export function tailIdleMs(beatMs: number): number {
  return beatMs * MISSED_BEATS;
}

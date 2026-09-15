/**
 * Mind-mapper's connection-timing constants — THE ONE COPY, imported by both
 * halves of the spell, and THE ONE PLACE THE ENV IS READ.
 *
 * ⛔ THIS FILE IS THE SEAM, AND FOR MIND-MAPPER THE SEAM WAS REAL AND
 * HAND-MIRRORED. Before Phase 7 the keepalive was a literal `15_000` inside
 * `server.ts`'s `keepaliveMs()`, `idleTimeout: 255` was a second literal a
 * hundred lines away with the relationship written only in prose, and the
 * CLI's tail carried a HARD-CODED `45_000` watchdog under a comment saying
 * "≈ 3 missed server keepalives (15s tick, Claim F)" — three numbers, two
 * files, and the arithmetic tying them together living in a sentence. Neither
 * file could import the other: the CLI reaching into the daemon would drag the
 * whole 23-module server graph into `dist/cli.js`. A module whose only imports
 * are the kit's derivations has no such graph, so both halves import this one.
 * **A value that could not previously cross the seam now crosses it**, and the
 * "≈" in that comment is now an `=`.
 *
 * ⛔ **AND THE WATCHDOG IS DERIVED FROM MIND-MAPPER'S OWN HEARTBEAT, NEVER
 * COPIED FROM A SIBLING.** This is the rule astrolabe paid for: a hard-coded
 * 45 s watchdog against an env-tuned heartbeat produced reconnects at +47.4 s,
 * +92.6 s and +137.9 s against a perfectly healthy daemon, harmless only
 * because an unrelated third constant absorbed the churn. ⚠ Mind-mapper is the
 * spell that was ONE ENV VAR away from that exact defect: its keepalive already
 * took `MIND_MAPPER_KEEPALIVE_MS` (its own presence suite drives it at 25 ms)
 * while the watchdog was a literal, so any keepalive above 15 s already broke
 * every tail and any keepalive below it made the watchdog tolerate far more
 * than three missed beats. `tailIdleMs(SSE_HEARTBEAT_MS)` cannot drift from the
 * beat it is watching, whatever the beat becomes.
 *
 * ⛔ **THE ENV IS RESOLVED HERE AND NOWHERE ELSE (D75), AND FOR THIS SPELL THAT
 * RULE IS LOAD-BEARING RATHER THAN TIDY.** Grapevine's port shipped the beat's
 * knob in `daemon.ts` and left its seam file deriving the watchdog from the
 * LITERAL default: the daemon's beat was tunable and the CLI's watchdog was
 * not, and any value above the default broke every tail — invisible at the
 * default, which is why it shipped. The generalisation: **an env knob must be
 * resolved at the LOWEST point every consumer of the derived value can see.**
 * `process.env` is ambient in both halves, which is exactly why this file — and
 * not `server.ts` — can hold the resolution, and reading it here is not the
 * kind of import that closes the seam.
 *
 * ⛔ **AND THE DERIVATION SUPPLIES THE DEFAULT, NOT THE VALUE (D82).** The two
 * tail knobs below are the reason: `backend/tail.test.ts` is the repo's ONLY
 * executable tail specification, it is this port's ORACLE, and all four of its
 * cells drive `MIND_MAPPER_TAIL_IDLE_MS=200` / `MIND_MAPPER_TAIL_RETRY_MS=50`.
 * Written glamour's way — three plain `export const`s with no override anywhere
 * — the idle-watchdog cell FAILS (a 45,000 ms watchdog cannot fire inside its
 * 5 s deadline, and it reads as a broken watchdog) and the keepalive cell
 * **PASSES VACUOUSLY**: it asserts that nothing was aborted, and 45 s cannot
 * abort anything inside its 800 ms window. A green cell that lost its subject
 * is worse than a red one. ⚠ And the knob cannot be routed through the BEAT
 * instead: the kit floors `heartbeatMs` at `MIN_HEARTBEAT_MS = 500` (D76 — the
 * floor lives at the derivation), so the smallest watchdog reachable through
 * `tailIdleMs` is 1,500 ms and **200 ms is unreachable that way by
 * construction.** `tailIdleMs` carries no floor of its own, so a direct
 * override reaches it.
 *
 * ⚠ **The mapping below was written eight months early and addressed to
 * nobody** — `phase-1-journal.md:151-155` named `MIND_MAPPER_TAIL_IDLE_MS` →
 * `idleMs` and `MIND_MAPPER_TAIL_RETRY_MS` → `retry.initialMs` and concluded
 * "a spell whose tests drive a short window will need one, and it should be
 * that spell's env var, not the kit's". This is that spell (D84).
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
 * A positive integer from an env value, or the fallback.
 *
 * ⚠ THE KIT'S `intOr` IS NOT EXPORTED, deliberately — it is the private parser
 * behind `heartbeatMs`/`idleTimeoutSec`, and D76 ruled that a knob with a known
 * safe minimum clamps at its DERIVATION rather than in the shared parser. So
 * this is mind-mapper's own copy of the same three lines, with the same
 * `parseInt` semantics the kit documents (`"1e9"` is 1, `"5abc"` is 5) and the
 * same "absent, empty, non-numeric or non-positive takes the fallback" rule.
 * It is the expression the CLI's own `envMs` used before this file existed.
 *
 * ⛔ AND THE TWO TAIL KNOBS BELOW DELIBERATELY HAVE NO FLOOR. A watchdog and a
 * reconnect delay are the two values this spell's own test suite must be able
 * to drive DOWN to 200 ms and 50 ms; a floor here would make the oracle
 * unreachable, which is the defect D82 was written about. The floor exists
 * where the flood risk is — on the BEAT, in the kit.
 */
function intOr(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Bun's maximum `idleTimeout`, in seconds. Mind-mapper's own measured value,
 * not an inherited one: `server.ts` carried `idleTimeout: 255` under a comment
 * recording that SSE and WS connections on `/events` sit idle between emits by
 * design, that Bun's default 10 s would reset a quiet stream, and that `0` is
 * not "disabled" — it stalls the initial response — so the way to hold a
 * connection open is to ask for the maximum.
 *
 * ⚠ `MIND_MAPPER_IDLE_TIMEOUT_SEC` is accepted so the PAIR can be tuned
 * together, and the clamp in `heartbeatMs` below is what keeps them a pair.
 */
export const IDLE_TIMEOUT_SEC = idleTimeoutSec(
  process.env.MIND_MAPPER_IDLE_TIMEOUT_SEC,
  MAX_IDLE_TIMEOUT_SEC,
);

/** The house default heartbeat, and mind-mapper's own literal (Claim F's 15 s
 *  tick) before this file existed — the DEFAULT, before the env is consulted. */
export const DEFAULT_SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;

/**
 * The SSE keepalive, in ms, env-resolved and clamped at both ends by the kit:
 * never above `IDLE_TIMEOUT_SEC / 2` (or Bun closes the connection the
 * keepalive was preserving), never below `MIN_HEARTBEAT_MS`.
 *
 * ⛔ THE FLOOR IS NOT DECORATION (D76). `MIND_MAPPER_KEEPALIVE_MS` is a knob
 * mind-mapper's own presence suite drives, and `parseInt` reads `"1e9"` — the
 * most plausible spelling of "make it huge" — as **1**. Driven at grapevine's
 * repair before the floor existed: a 1 ms beat put ~528 keepalive comments into
 * every open SSE client in 528 ms.
 *
 * ⚠ AND FOR THIS SPELL THE BEAT ALSO BOUNDS A HUMAN-VISIBLE NUMBER. Presence
 * (Claim C) is counted at SSE subscribe/unsubscribe and a dead socket is only
 * reclaimed when the next keepalive write fails, so raising this knob makes the
 * agent count in the board's activity indicator staler, not just quieter.
 */
export const SSE_HEARTBEAT_MS = heartbeatMs(
  process.env.MIND_MAPPER_KEEPALIVE_MS,
  IDLE_TIMEOUT_SEC,
  DEFAULT_SSE_HEARTBEAT_MS,
);

/**
 * The tail watchdog: three missed beats, DERIVED. 45,000 ms at the default —
 * which is the number `cli.ts` used to hard-code, so the port changes no
 * default while making the relationship true at every other value.
 *
 * ⛔ DERIVED FROM THE RESOLVED BEAT, NEVER FROM THE DEFAULT — grapevine's
 * repair chapter is what the difference cost. And the env override is the
 * FALLBACK's replacement, not the derivation's: the derivation is what the knob
 * falls back to, so an untuned tail still watches three of this daemon's beats.
 */
export const TAIL_IDLE_MS = intOr(
  process.env.MIND_MAPPER_TAIL_IDLE_MS,
  tailIdleMs(SSE_HEARTBEAT_MS),
);

/**
 * The reconnect backoff's FIRST delay, in ms. 1,000 today, which is what
 * `cli.ts`'s `retryMs` defaulted to.
 *
 * ⛔ AND THE SHAPE CHANGES EVEN THOUGH THE NUMBER DOES NOT: the hand-rolled
 * loop slept this long after EVERY failed attempt, flat, forever — a
 * constant-interval reconnect storm, and mind-mapper is the spell
 * `tailEvents`'s own warning about that branch was written about. The kit
 * doubles it to `maxMs` and RESETS on a successful open, so a dead daemon is
 * backed off from instead of hammered.
 */
export const TAIL_RETRY_MS = intOr(process.env.MIND_MAPPER_TAIL_RETRY_MS, 1_000);

/** The backoff ceiling, the kit's default, stated here so both halves can see
 *  the whole retry shape in one place rather than half of it. */
export const TAIL_RETRY_MAX_MS = 5_000;

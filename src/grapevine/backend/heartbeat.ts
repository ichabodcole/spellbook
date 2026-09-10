/**
 * Grapevine's connection-timing constants — THE ONE COPY, imported by both
 * halves of the spell, and THE ONE PLACE THE ENV IS READ.
 *
 * ⛔ THIS FILE IS THE SEAM, AND FOR GRAPEVINE THE SEAM IS REAL — the first time
 * in four ports (playbook B8, entry-block question 3). Before Phase 6 the
 * heartbeat was a LITERAL `3000` inside `daemon.ts`'s SSE stream, `idleTimeout:
 * 255` was a second literal ten lines away with the relationship written only in
 * prose, and `cli.ts`'s tail had NO watchdog at all — it blocked on
 * `reader.read()` forever, which is the failure the kit's watchdog exists to
 * end. Neither file could import the other: the CLI reaching into the daemon
 * would drag the whole server graph into `dist/cli.js`. A module with no imports
 * but the kit's derivations has no such graph, so both halves import this one.
 * A value that could not previously cross the seam now crosses it.
 *
 * ⛔ **AND THE WATCHDOG IS DERIVED FROM GRAPEVINE'S OWN HEARTBEAT, NEVER COPIED
 * FROM A SIBLING.** This is the rule astrolabe paid for: a hard-coded 45 s
 * watchdog against an env-tuned heartbeat produced reconnects at +47.4 s,
 * +92.6 s and +137.9 s against a perfectly healthy daemon, harmless only because
 * an unrelated third constant absorbed the churn. ⚠ Grapevine is the spell that
 * makes the point sharpest: it beats at **3 s**, a fifth of the house default,
 * so a copied 45,000 would tolerate FIFTEEN missed beats where every sibling
 * tolerates three. `tailIdleMs(SSE_HEARTBEAT_MS)` cannot drift from the beat it
 * is watching, whatever the beat becomes.
 *
 * ⛔ **AND "WHATEVER THE BEAT BECOMES" IS WHY THE ENV IS RESOLVED HERE AND
 * NOWHERE ELSE (D75). THE PORT RE-CREATED ASTROLABE'S DEFECT IN THIS FILE.**
 * Chapter 2 shipped `HEARTBEAT_MS = heartbeatMs(process.env.GRAPEVINE_HEARTBEAT_MS,
 * …)` at `daemon.ts:112` while this file kept `tailIdleMs(SSE_HEARTBEAT_MS)`
 * against the LITERAL 3,000: the daemon's beat was tunable and the CLI's
 * watchdog was not, so **any value above 3,000 broke every tail.** MEASURED at
 * `GRAPEVINE_HEARTBEAT_MS=20000` against a healthy daemon, before the repair: a
 * real `cli.ts tail` re-subscribed **4 times in 30 s** (~9 s apart, its watchdog
 * firing before a single 20 s beat could land — **0 keepalives arrived**), and
 * `/channels/wd/subscribers` reported `count: 2, connections: 2, named: 2` for
 * **one** live tail, because the abandoned streams are not reaped until the
 * now-20 s beat fails to enqueue. That is the astrolabe scar two paragraphs up,
 * re-created inside the file that documents it. **One half of the pair tunable
 * and the other a constant IS the defect** — the derivation only holds if it
 * derives from the value that actually shipped.
 *
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the seam closes.
 * `process.env` is not such an import: it is ambient in both halves, which is
 * exactly why this file — and not `daemon.ts` — can hold the resolution. (This
 * is bounty's shape, unchanged: `src/bounty/backend/heartbeat.ts` resolves
 * `BOUNTY_IDLE_TIMEOUT_SEC` and `BOUNTY_HEARTBEAT_MS` in the seam file for the
 * same reason.)
 */

import {
  heartbeatMs,
  idleTimeoutSec,
  MAX_IDLE_TIMEOUT_SEC,
  tailIdleMs,
} from "../../kit/wire/heartbeat.ts";

/**
 * Bun's maximum, in seconds. Grapevine's own measured value, not an inherited
 * one: `daemon.ts` carried `idleTimeout: 255` under a comment recording that
 * Bun's default 10 s closes a held SSE connection before the keepalive that was
 * supposed to preserve it ever fires — and that `0` is not "disabled", it is the
 * default.
 *
 * ⚠ `GRAPEVINE_IDLE_TIMEOUT_SEC` is accepted so the PAIR can be tuned together,
 * and the clamp below is what keeps them a pair. (This file used to say
 * grapevine "does not env-tune it" while `daemon.ts` env-tuned it ten lines from
 * where it imported this constant — the same one-half-tunable split as the beat,
 * and corrected in the same chapter.)
 */
export const IDLE_TIMEOUT_SEC = idleTimeoutSec(
  process.env.GRAPEVINE_IDLE_TIMEOUT_SEC,
  MAX_IDLE_TIMEOUT_SEC,
);

/**
 * The SSE keepalive, in ms — the DEFAULT, before the env is consulted.
 * ⚠ **3 s, and it is NOT the house default of 15 s** — grapevine is the only
 * spell in the roster that beats this fast, and the number is load-bearing
 * rather than incidental: the beat is also grapevine's dead-subscriber probe. A
 * tail whose socket has gone away is discovered when the enqueue fails, and
 * until it is discovered `who`, `/presence` and every send's recipient count
 * report a ghost. Every other spell's heartbeat only has to keep a connection
 * open; this one also has to keep a ROSTER honest, which is a human-visible
 * number in the watch surface. ⛔ **So raising this knob makes presence
 * staler, not just quieter** — it is the one thing an operator tuning it should
 * know.
 */
export const DEFAULT_SSE_HEARTBEAT_MS = 3_000;

/**
 * The beat as it will actually be used, env-resolved and clamped at both ends by
 * the kit: never above `IDLE_TIMEOUT_SEC / 2` (or Bun closes the connection the
 * keepalive was preserving), never below `MIN_HEARTBEAT_MS`.
 *
 * ⛔ THE FLOOR IS NOT DECORATION (D76). `intOr` parses with `parseInt`, which
 * reads `"1e9"` — the most plausible spelling of "make it huge" — as **1**.
 * Driven before the floor existed: `GRAPEVINE_HEARTBEAT_MS=1e9` put ~528
 * keepalive comments into every open SSE client in 528 ms. `"3.9"` → 3 ms and
 * `"5abc"` → 5 ms arrive the same way. The floor lives in the kit's
 * `heartbeatMs` beside the ceiling it cannot cross, NOT in `intOr`, which every
 * other knob in the house shares.
 */
export const SSE_HEARTBEAT_MS = heartbeatMs(
  process.env.GRAPEVINE_HEARTBEAT_MS,
  IDLE_TIMEOUT_SEC,
  DEFAULT_SSE_HEARTBEAT_MS,
);

/**
 * The tail watchdog: three missed beats, DERIVED. 9,000 ms at the default.
 *
 * ⛔ **THE TAIL HAD NO WATCHDOG AT ALL BEFORE THIS.** `cmdTail`'s inner loop
 * awaited `reader.read()` with nothing bounding it, so a half-open socket after
 * laptop sleep, a NAT rebind or a SIGKILLed daemon parked the tail FOREVER — and
 * a parked tail is indistinguishable from a quiet channel, which is the state
 * grapevine's callers spend most of their time in.
 *
 * ⚠ 9 s is aggressive by house standards (45 s everywhere else) and that is the
 * derivation working, not a mistake: it is three of THIS spell's beats. Holding
 * the connection open IS a tail's presence signal, so every watchdog fire flaps
 * a name in a human's roster — which is why it is three beats and not two.
 *
 * ⛔ DERIVED FROM THE RESOLVED BEAT, NEVER FROM THE DEFAULT. It is
 * `SSE_HEARTBEAT_MS` above and not `DEFAULT_SSE_HEARTBEAT_MS` on purpose; the
 * repair chapter is what the difference cost.
 */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

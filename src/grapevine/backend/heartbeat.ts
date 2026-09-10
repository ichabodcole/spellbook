/**
 * Grapevine's connection-timing constants — THE ONE COPY, imported by both
 * halves of the spell.
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
 * ⚠ KEEP IT A LEAF-SHAPED FILE. The moment this imports anything of the
 * daemon's, the CLI is back to dragging the server graph and the seam closes.
 */

import { MAX_IDLE_TIMEOUT_SEC, tailIdleMs } from "../../kit/wire/heartbeat.ts";

/**
 * Bun's maximum, in seconds. Grapevine's own measured value, not an inherited
 * one: `daemon.ts` carried `idleTimeout: 255` under a comment recording that
 * Bun's default 10 s closes a held SSE connection before the keepalive that was
 * supposed to preserve it ever fires — and that `0` is not "disabled", it is the
 * default. Grapevine does not env-tune it; a broker's connection lifetime is not
 * something a caller has ever needed to shorten.
 */
export const IDLE_TIMEOUT_SEC = MAX_IDLE_TIMEOUT_SEC;

/**
 * The SSE keepalive, in ms. ⚠ **3 s, and it is NOT the house default of 15 s** —
 * grapevine is the only spell in the roster that beats this fast, and the number
 * is load-bearing rather than incidental: the beat is also grapevine's
 * dead-subscriber probe. A tail whose socket has gone away is discovered when
 * the enqueue fails, and until it is discovered `who`, `/presence` and every
 * send's recipient count report a ghost. Every other spell's heartbeat only has
 * to keep a connection open; this one also has to keep a ROSTER honest, which is
 * a human-visible number in the watch surface.
 *
 * It sits well under `IDLE_TIMEOUT_SEC / 2`, which is the invariant the kit's
 * `heartbeatMs` clamp enforces — asserted rather than assumed, at the daemon.
 */
export const SSE_HEARTBEAT_MS = 3_000;

/**
 * The tail watchdog: three missed beats, DERIVED. 9,000 ms today.
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
 */
export const TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

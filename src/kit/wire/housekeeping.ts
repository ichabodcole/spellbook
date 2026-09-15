/**
 * The house's ONE daemon lifecycle tail: the idle-close decision, the sweep
 * that makes it, and the bounded teardown.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * Converged 2026-09-08 (Phase 1b chapter 2) TOWARD bounty — the census's
 * convergence target #3 — with astrolabe's `timeoutMs > 0` guard folded in,
 * which is the one thing bounty's copy does not express.
 *
 * ── ⛔ GRAPEVINE ADOPTS `drainAndStop` AND NOTHING ELSE HERE — SPLIT PER EXPORT
 *
 * Ruled at grapevine's port (Phase 6, 2026-09-09; D68), and it is written down
 * because a row is a MODULE and "partial" is not an answer until it says which
 * exports. Grapevine is long-running, so nothing about its lifecycle makes this
 * module read as inapplicable — and two of its three exports still have no
 * subject there:
 *
 *   `shouldIdleClose`      NO SUBJECT. Grapevine runs no idle sweep and has no
 *   `startHousekeeping`    `--timeout`; it is a broker that stands until `stop`
 *                          (`DELETE /`) or a signal, and it takes no snapshot.
 *                          Adopting the pair-manager would mean writing a no-op
 *                          `touch` and a `subscriberCount` that exists only to
 *                          return a number nobody acts on — two lies to gain a
 *                          `clearInterval`.
 *   `drainAndStop`         ADOPTED, and it is a DE-DUPLICATION rather than a
 *                          gain: grapevine's teardown already WAS
 *                          `Promise.race([server.stop(true), 200 ms])`, which is
 *                          `stopMs` exactly.
 *
 * ⚠ **AND IT IS CALLED WITH NO `clients`, WHICH IS A MEASUREMENT, NOT AN
 * OVERSIGHT.** This module closes a held connection by calling `client.close()`;
 * grapevine's subscriber records are `{alias, human, lurk, send}` and carry no
 * `close` — its per-stream teardown is a closure stashed on the ReadableStream
 * controller, reachable only from `cancel()`. There is nothing to hand the
 * argument. `sse.ts`'s header carries the rest of that ruling, including the
 * widening not done and its cost (six artifacts across five spells).
 *
 * ⚠ Grapevine also passes `graceMs: 0`. Not a disagreement with the grace
 * period: it emits no farewell frame at daemon shutdown, and its `DELETE /`
 * already returns the response and schedules the teardown 10 ms later, so its
 * flush window sits at the route rather than in the drain.
 */

import type { SseClients } from "./sse.ts";

/**
 * Should the daemon idle-close?
 *
 * ⛔ **`subscriberCount` IS A REQUIRED ARGUMENT, AND THAT IS THE WHOLE POINT.**
 * This closes census defect **L1** by construction: glamour, imago and magpie
 * counted their idle floor down while an agent held a tail open, so an agent
 * watching a quiet board was killed WITH ITS CONNECTION OPEN. There is no
 * overload of this function that cannot see its subscribers, so the defect
 * cannot be re-expressed by a caller who forgets.
 *
 * ⛔ **AND THE SCAR IT CAME WITH, re-homed from bounty verbatim in substance:**
 * a board only counts its idle floor down while UNWATCHED. A live subscriber —
 * a browser WebSocket, or an agent SSE tail on `/events` — keeps it open
 * indefinitely. So `timeout` means "linger this long after the LAST subscriber
 * leaves", NOT "maximum idle while connected". The sweep below also touches the
 * activity clock on every tick while watched, so once unwatched the floor
 * counts from that last disconnect and not from the last request.
 *
 * ⚠ `timeoutMs <= 0` means NEVER, which is astrolabe's standing-observatory
 * default and is why the guard is here rather than at its one call site: a
 * singleton daemon is meant to stand until it is explicitly closed, and a
 * `>= 0` comparison would close it on the first tick.
 *
 * Clock-free and fs-free, so it is testable without a daemon.
 */
export function shouldIdleClose(
  subscriberCount: number,
  idleMs: number,
  timeoutMs: number,
): boolean {
  if (timeoutMs <= 0) return false;
  if (subscriberCount > 0) return false;
  return idleMs >= timeoutMs;
}

export interface HousekeepingOptions {
  /** ⛔ REQUIRED. See `shouldIdleClose` — this is what closes L1. */
  subscriberCount: () => number;
  /** Milliseconds since the last activity. */
  idleMs: () => number;
  /** Reset the activity clock. Called on every tick that has a subscriber. */
  touch: () => void;
  /** The configured idle timeout in ms; `0` (or less) means never. */
  timeoutMs: number;
  /** Fired once when the daemon should close itself. */
  onIdleClose: () => void;
  /** The debounced snapshot, if the spell has one. */
  snapshot?: {
    dirty: () => boolean;
    clear: () => void;
    write: () => void | Promise<void>;
  };
  /** Sweep interval; both adopting daemons used 250 ms. */
  tickMs?: number;
  /** Snapshot interval; both adopting daemons used 1000 ms. */
  snapshotMs?: number;
}

/**
 * Start the two standing timers every session daemon runs — the idle sweep and
 * the debounced snapshot — and return the function that stops both.
 *
 * They are ONE call because they have always been one lifetime: every copy
 * cleared both in the same two lines after `await done`, and the pair that gets
 * forgotten is the pair whose timers keep a process alive after teardown.
 */
export function startHousekeeping(opts: HousekeepingOptions): () => void {
  const tickMs = opts.tickMs ?? 250;
  const snapshotMs = opts.snapshotMs ?? 1000;

  const idleTimer = setInterval(() => {
    const subscribers = opts.subscriberCount();
    if (subscribers > 0) opts.touch();
    if (shouldIdleClose(subscribers, opts.idleMs(), opts.timeoutMs)) opts.onIdleClose();
  }, tickMs);

  const snap = opts.snapshot;
  const snapTimer = snap
    ? setInterval(() => {
        if (!snap.dirty()) return;
        snap.clear();
        void snap.write();
      }, snapshotMs)
    : null;

  return () => {
    clearInterval(idleTimer);
    if (snapTimer !== null) clearInterval(snapTimer);
  };
}

export interface DrainOptions {
  /** The bound server. Typed structurally so the kit stays free of `bun`. */
  server: { stop(closeActiveConnections?: boolean): unknown };
  /** Live SSE tails; every registered closer is invoked. */
  clients?: SseClients;
  /** Live WebSockets. */
  sockets?: Iterable<{ close(): void }>;
  /** How long queued frames get to flush before anything is closed. */
  graceMs?: number;
  /** How long the graceful stop gets before teardown proceeds regardless. */
  stopMs?: number;
}

/**
 * Close every held connection and stop the server, in bounded time.
 *
 * ⛔ **THE GRACE PERIOD IS NOT POLITENESS.** A `closed` frame emitted and then
 * followed immediately by an aggressive `server.stop(true)` is a frame the
 * client never sees — the queue goes with the socket. The 150 ms is what turns
 * "the daemon told you why it died" from a hope into an observation, and every
 * one of the eight daemons converged on that number independently.
 *
 * ⛔ **AND THE STOP IS RACED, BECAUSE A SLOW SOCKET MUST NOT BE ABLE TO HANG
 * TEARDOWN.** `server.stop(true)` awaits its connections; one wedged peer is
 * enough to park it forever, which is how a 23-minute hang shipped once.
 *
 * ⚠ **WHAT IS DELIBERATELY NOT HERE: bounty's shutdown watchdog.** Bounty arms
 * a REF'd `setTimeout` that calls `process.exit` if teardown does not finish,
 * and the census is right that it is the corpus's only unconditional
 * termination guarantee. It belongs to bounty's TEARDOWN — the stretch where
 * nothing bounds what is being waited on. ⛔ **THIS PARAGRAPH SAID "SIGNAL
 * PATH" UNTIL D53, AND THE CODE AGREED WITH IT, WHICH WAS THE DEFECT.** Bounty
 * has FOUR ways into one teardown (a signal, a `close` verb, the browser's
 * close over the WebSocket, an idle timeout) and only the signal one armed the
 * timer, while the comment above it claimed the ending was unconditional.
 * Driven with a planted hang: the other three ran past 10 s, the idle one
 * included — the orphan-daemon class the 23-minute hang came from. The arming
 * now lives in the RESOLVE that all four entries pass through. **The lesson for
 * an adopter is the count, not the placement: enumerate every entry into the
 * teardown before you believe a guarantee covers it.** The two
 * daemons adopting this module register no signal handlers, and their whole
 * teardown is bounded by the two numbers above; adding an exit here would put
 * the house's only unconditional `process.exit` inside a module every spell is
 * about to bundle, one phase after D8 took exactly that hazard OUT of `die`.
 *
 * ⛔ **AND THE SENTENCE THAT USED TO END THAT PARAGRAPH WAS A PREDICTION, WHICH
 * BOUNTY'S OWN PORT FALSIFIED.** It read: "when a spell with a signal path
 * adopts this, the watchdog arrives as an option on these arguments and the
 * reasoning is already written down." bounty adopted `drainAndStop` on
 * 2026-09-09 (Phase 4) and the option was NOT added, because the window is
 * wrong. **A `watchdogMs` on these arguments would arm at DRAIN time; bounty's
 * arms at SIGNAL time**, and the whole reason it exists is the stretch BETWEEN
 * those two points — `await done`, an fs append to the daemon log, a full
 * snapshot write that can rotate and COPY a backup of a large board, a `closed`
 * frame and a broadcast. `drainAndStop`'s own body is already bounded by the two
 * numbers above, so a watchdog scoped to it would guard the one stretch that
 * cannot hang and abandon the stretch that can: it would READ as adoption and
 * BE a narrowing of the corpus's only unconditional termination guarantee. The
 * 23-minute hang this project keeps citing happened in the unbounded stretch.
 *
 * ⚠ **SO THE RULE FOR THE NEXT SPELL, WHICH IS THE TRANSFERABLE HALF:** the
 * question is never "does this module have a place to put a watchdog" but
 * "does the watchdog's window coincide with this module's". Where a spell's
 * teardown has unbounded work BEFORE the drain, the watchdog belongs at the
 * spell, wrapped around all of it — and around EVERY WAY IN, which is the half
 * D53 had to repair after this header was written. If a spell ever appears whose signal path
 * enters `drainAndStop` immediately, add the option THEN — and the option must
 * take an `onExpire` callback rather than exiting, so the `process.exit` stays
 * outside a module every spell bundles.
 */
export async function drainAndStop(opts: DrainOptions): Promise<void> {
  const graceMs = opts.graceMs ?? 150;
  const stopMs = opts.stopMs ?? 200;

  await new Promise((r) => setTimeout(r, graceMs));

  if (opts.clients) {
    for (const client of [...opts.clients]) client.close();
  }
  if (opts.sockets) {
    for (const ws of [...opts.sockets]) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }

  await Promise.race([
    Promise.resolve(opts.server.stop(true)),
    new Promise((r) => setTimeout(r, stopMs)),
  ]);
}

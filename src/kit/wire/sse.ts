/**
 * The house's ONE server side of the SSE tail — the daemon-side twin of
 * `tailEvents.ts`. That module decides what a caller observes; this one decides
 * what a caller is sent.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/` — except its
 * own sibling types, which is still inside the leaf.
 *
 * Converged 2026-09-08 (Phase 1b chapter 2) TOWARD mind-mapper's `sseResponse`,
 * the census's convergence target #1: the only one of the seven with a
 * once-only teardown funnel, the only one wired to `req.signal`, and the only
 * one whose comment records a MEASURED result rather than a belief.
 *
 * ── ⛔ THE SCAR, RE-HOMED: `try { enqueue } catch` DOES NOT DETECT A DEAD
 *    CLIENT. MEASURED ON BUN 1.3.14 ─────────────────────────────────────────
 *
 * Six daemons write a heartbeat as `try { controller.enqueue(...) } catch {}`
 * with a comment saying the catch is how a departed client is noticed. It is
 * not: enqueue on an orphaned stream BUFFERS SILENTLY and never throws, so the
 * catch never fires and those daemons' dead-client detection rests on a
 * mechanism their own comments describe incorrectly. What actually reclaims the
 * connection is the stream's `cancel()` — and, for a client that never closes
 * the socket, `req.signal`.
 *
 * So the funnel below is the load-bearing part. `teardown()` runs AT MOST ONCE
 * from every path there is — `cancel()`, an abort on the request signal, and
 * the belt-and-braces enqueue catch — and it is where the subscriber count and
 * any presence decrement ride. Bounding presence accuracy is bounding that
 * funnel.
 *
 * ⚠ Known hole, accepted and inherited: Bun's own `fetch()` reader `.cancel()`
 * closes nothing client-side and the server cannot see it. Real clients close
 * the socket.
 */

import type { EventLog, Frame } from "./eventLog.ts";

/**
 * One open SSE stream, as the daemon can act on it: end it, or push a frame to
 * it that did not come out of the log.
 *
 * ⛔ IT IS NOT A CONTROLLER. The copies held
 * `Set<ReadableStreamDefaultController>` and closed them directly at teardown,
 * which bypasses the teardown funnel above — the heartbeat interval for that
 * stream was cleared only because a second `Set` of timers was kept in parallel
 * and swept separately. Everything here goes through the funnel, and a `send`
 * after teardown is a no-op rather than a throw.
 *
 * ⚠ **`send` ARRIVED IN PHASE 2, FROM THE FIRST CONSUMER THAT WAS NOT ONE OF THE
 * TWO THIS MODULE WAS DESIGNED AGAINST.** astrolabe and magpie announce presence
 * over their browser WEBSOCKET, so a registry of bare closers was sufficient and
 * the boundary looked right. glamour announces it on the AGENT's SSE tail —
 * `{type:"connected"}` / `{type:"disconnected"}`, deliberately unlogged, so a
 * reconnecting agent does not re-see every past connect and so the frame never
 * advances a tail cursor. That is not a glamour quirk; it is the general shape
 * of "tell the live subscribers something that is not part of the history", and
 * a registry that can only END a stream cannot express it. Without this the
 * spell would have had to keep its own parallel `Set` of controllers, which is
 * exactly the drift this registry exists to remove.
 */
export type SseClient = {
  /** End this stream, through the teardown funnel, at most once. */
  close(): void;
  /** Write one raw SSE chunk to this stream. No-op once torn down. */
  send(chunk: string): void;
};

/**
 * The live-tail registry. `size` is the daemon's SSE subscriber count — the
 * number `shouldIdleClose` must see — and closing every entry is what a drain
 * does.
 */
export type SseClients = Set<SseClient>;

export interface SseOptions<T extends object> {
  /** The log to replay from and subscribe to. */
  log: EventLog<T>;
  /** The caller's resume cursor. Absent or unparseable replays from the start. */
  since: number;
  /** Heartbeat comment interval. MUST stay well under the server's
   *  `idleTimeout` — see `heartbeat.ts`, which is where that pair lives. */
  heartbeatMs: number;
  /** Liveness registry; the stream adds itself on open and removes itself in
   *  the teardown funnel. */
  clients?: SseClients;
  /** `req.signal` — the only thing that reclaims a client that went away
   *  without cancelling the stream. */
  signal?: AbortSignal;
  /** Server-side filter. A rejected frame is not sent; the client still
   *  advances its cursor past it, which is `tailEvents`'s documented rule. */
  filter?: (frame: Frame<T>) => boolean;
  /** Run after the stream is subscribed (presence up, activity touch). */
  onOpen?: () => void;
  /** Run exactly once, from whichever teardown path fires first. */
  onClose?: () => void;
}

export function sseResponse<T extends object>(opts: SseOptions<T>): Response {
  const { log, since, heartbeatMs, clients, signal, filter, onOpen, onClose } = opts;

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // The registry entry for THIS stream. Its methods are filled in by `start`,
  // which is where the controller exists; the object identity is stable from
  // here so `teardown` can remove exactly this entry.
  const client: SseClient = { close: () => {}, send: () => {} };

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (keepalive !== null) clearInterval(keepalive);
    unsubscribe?.();
    clients?.delete(client);
    onClose?.();
  };

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      client.close = () => {
        teardown();
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };
      // ⛔ `send` GOES THROUGH `safeEnqueue`, so an out-of-band frame obeys the
      // same closed-check and the same teardown-on-throw as a logged one. A
      // daemon must not be able to write to a stream this module has torn down.
      client.send = safeEnqueue;

      // ⛔ AN OPENING COMMENT, BEFORE ANYTHING ELSE. It flushes the response
      // headers immediately: some HTTP clients — Bun's own `fetch()` included —
      // buffer until the first byte of body arrives, so a genuinely quiet SSE
      // stream would otherwise leave the caller's `fetch()` unresolved. Every
      // house tail client reads `:` lines as comments and drops them.
      safeEnqueue(": connected\n\n");

      unsubscribe = log.subscribe(since, (frame) => {
        if (filter && !filter(frame)) return;
        safeEnqueue(`data: ${JSON.stringify(frame)}\n\n`);
      });

      keepalive = setInterval(() => safeEnqueue(": hb\n\n"), heartbeatMs);
      signal?.addEventListener("abort", teardown, { once: true });
      clients?.add(client);
      onOpen?.();
    },
    cancel() {
      teardown();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

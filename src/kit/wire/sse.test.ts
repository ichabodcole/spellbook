import { describe, expect, test } from "bun:test";
import { createEventLog } from "./eventLog.ts";
import { type SseClients, sseResponse } from "./sse.ts";

/** Read whatever the stream has produced so far, then cancel it. */
async function readAvailable(res: Response, chunks = 1): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let out = "";
  for (let i = 0; i < chunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return out;
}

describe("sseResponse", () => {
  test("the headers are the SSE contract", () => {
    const res = sseResponse({ log: createEventLog(), since: -1, heartbeatMs: 60_000 });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("⛔ IT OPENS WITH A COMMENT, and the replay follows in the same read", async () => {
    // The opening comment flushes the response headers: Bun's own `fetch()`
    // buffers until the first body byte, so a genuinely quiet stream would
    // otherwise leave the caller's `fetch()` unresolved. This cell is also the
    // reason astrolabe's release-serve test now looks for the first `data:`
    // line rather than the first LINE.
    const log = createEventLog<{ type: string }>();
    log.emit({ type: "ready" });
    const text = await readAvailable(sseResponse({ log, since: -1, heartbeatMs: 60_000 }), 2);
    expect(text.startsWith(": connected\n\n")).toBe(true);
    expect(text).toContain('data: {"id":1,"type":"ready"}');
  });

  test("a filter drops frames server-side", async () => {
    const log = createEventLog<{ type: string }>();
    log.emit({ type: "keep" });
    log.emit({ type: "drop" });
    const text = await readAvailable(
      sseResponse({
        log,
        since: -1,
        heartbeatMs: 60_000,
        filter: (f) => f.type === "keep",
      }),
      2, // the opening comment + the one frame that survives the filter
    );
    expect(text).toContain('"type":"keep"');
    expect(text).not.toContain('"type":"drop"');
  });

  test("the registry counts live tails, and the closer removes exactly one", async () => {
    const log = createEventLog<{ type: string }>();
    const clients: SseClients = new Set();
    const a = sseResponse({ log, since: -1, heartbeatMs: 60_000, clients });
    const b = sseResponse({ log, since: -1, heartbeatMs: 60_000, clients });
    // The stream body is lazy — nothing registers until it is read.
    await readAvailable(a);
    expect(clients.size).toBe(1);
    await readAvailable(b);
    expect(clients.size).toBe(0); // `a` was cancelled by readAvailable
  });

  test("⛔ TEARDOWN RUNS AT MOST ONCE, from whichever path fires first", async () => {
    // The funnel is the load-bearing part: `try { enqueue } catch` does NOT
    // detect a departed client on Bun (enqueue buffers silently), so presence
    // accuracy is bounded by this funnel and by nothing else. A double-fire
    // would decrement a presence refcount twice and flip a card idle under a
    // live watcher.
    const log = createEventLog<{ type: string }>();
    const clients: SseClients = new Set();
    let closes = 0;
    let opens = 0;
    const controller = new AbortController();
    const res = sseResponse({
      log,
      since: -1,
      heartbeatMs: 60_000,
      clients,
      signal: controller.signal,
      onOpen: () => {
        opens += 1;
      },
      onClose: () => {
        closes += 1;
      },
    });
    await readAvailable(res); // opens, then cancels
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    controller.abort(); // the second path
    for (const c of clients) c.close(); // and the third
    expect(closes).toBe(1);
    expect(clients.size).toBe(0);
  });

  test("closing from the registry ends the stream for the reader", async () => {
    const log = createEventLog<{ type: string }>();
    const clients: SseClients = new Set();
    const res = sseResponse({ log, since: -1, heartbeatMs: 60_000, clients });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the opening comment; registers the closer
    expect(clients.size).toBe(1);
    for (const c of clients) c.close();
    expect((await reader.read()).done).toBe(true);
  });

  test("⛔ an out-of-band `send` reaches the live stream, is NOT logged, and dies with the stream", async () => {
    // glamour's presence frames (Phase 2): the agent's tail is told a browser
    // connected, the replay log is untouched, and no cursor moves. A registry of
    // bare closers could not express this and the spell would have kept its own
    // parallel Set of controllers — the drift this module exists to remove.
    const log = createEventLog<{ type: string }>();
    const clients: SseClients = new Set();
    const res = sseResponse({ log, since: -1, heartbeatMs: 60_000, clients });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the opening comment; registers the client
    for (const c of clients) c.send(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toBe('data: {"type":"connected"}\n\n');
    // …and it left no trace in the log: the cursor is untouched, so a
    // reconnecting tail neither replays it nor skips past a real event.
    expect(log.cursor()).toBe(0);

    // After teardown, `send` is a no-op rather than a throw — a daemon
    // announcing presence must not be able to crash on a departed subscriber.
    for (const c of [...clients]) {
      c.close();
      expect(() => c.send("data: {}\n\n")).not.toThrow();
    }
  });

  test("the heartbeat fires on its interval", async () => {
    const log = createEventLog<{ type: string }>();
    const res = sseResponse({ log, since: -1, heartbeatMs: 10 });
    const text = await readAvailable(res, 2);
    expect(text).toContain(": hb\n\n");
  });
});

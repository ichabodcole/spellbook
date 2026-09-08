// The shared SSE tail client, driven against a scripted fake server.
//
// These are UNIT cells over the client itself. The behavioural specification of
// a tail — watchdog, abort, epoch, first-connect grounding — is
// `plugins/spellbook/skills/mind-mapper/scripts/tail.test.ts`, which drives a
// real CLI end to end and is deliberately left pointed at mind-mapper's own
// loop until a later phase re-points it here. These cells cover the same
// properties one level down, plus the frame parser the spec question turned on.
import { afterEach, describe, expect, test } from "bun:test";
import { parseSseFrame, type Sink, tailEvents } from "./tailEvents";

type Conn = {
  since: string | null;
  url: URL;
  push: (chunk: string) => void;
  end: () => void;
};

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function fakeSse(onConnection: (conn: Conn, index: number) => void) {
  let index = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/events") return new Response("nope", { status: 404 });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const conn: Conn = {
            since: url.searchParams.get("since"),
            url,
            push: (chunk) => {
              try {
                controller.enqueue(enc.encode(chunk));
              } catch {
                /* client gone */
              }
            },
            end: () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
          };
          onConnection(conn, index++);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  const port = server.port;
  if (port === undefined) throw new Error("fake SSE server did not bind a TCP port");
  return { port, base: `http://127.0.0.1:${port}` };
}

function collector(): Sink & { lines: () => string[] } {
  let buf = "";
  return {
    write(chunk: string) {
      buf += chunk;
      return true;
    },
    lines: () => buf.split("\n").filter((l) => l.length > 0),
  };
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("parseSseFrame — the spec algorithm, not either house dialect", () => {
  test("strips exactly one leading space and accepts the spec-legal spaceless form", () => {
    expect(parseSseFrame("data: {}").frame?.data).toBe("{}");
    // ⛔ The `startsWith("data: ")` dialect drops this frame ENTIRELY and does
    // not advance its cursor. It is legal SSE.
    expect(parseSseFrame("data:{}").frame?.data).toBe("{}");
    // Only ONE space is a delimiter; the rest is payload. The `.slice(5).trim()`
    // dialect eats all of it.
    expect(parseSseFrame("data:   x").frame?.data).toBe("  x");
  });

  test("accumulates multi-line data with newlines and keeps the event name", () => {
    const { frame: f } = parseSseFrame("event: subscribed\ndata: a\ndata: b");
    expect(f).toEqual({ event: "subscribed", data: "a\nb" });
  });

  test("a comment-only frame yields no frame but does yield its comment", () => {
    const r = parseSseFrame(": hb");
    expect(r.frame).toBeNull();
    expect(r.comments).toEqual([" hb"]);
  });
});

describe("tailEvents", () => {
  test("resolve is called before EVERY attempt, so a moved daemon is followed", async () => {
    const first = fakeSse((conn) => {
      conn.push(frame({ id: 1 }));
      conn.end();
    });
    const second = fakeSse((conn) => {
      conn.push(frame({ id: 2, type: "closed" }));
    });
    const out = collector();
    const bases = [first.base, second.base];
    let calls = 0;
    const code = await tailEvents<{ id?: number; type?: string }>({
      resolve: () => bases[Math.min(calls++, 1)] ?? null,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out,
    });
    expect(code).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(out.lines().map((l) => JSON.parse(l).id)).toEqual([1, 2]);
  });

  test("the idle watchdog aborts a silent connection and resumes from the cursor", async () => {
    const sinces: Array<string | null> = [];
    const server = fakeSse((conn, index) => {
      sinces.push(conn.since);
      // First connection goes deliberately silent after one event: no
      // keepalive, no close. Only the watchdog can free the client.
      conn.push(frame({ id: index === 0 ? 3 : 4, type: index === 0 ? "x" : "closed" }));
    });
    const out = collector();
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      idleMs: 150,
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out,
    });
    expect(sinces).toEqual(["0", "3"]);
  });

  test("keepalive comments feed the watchdog — a quiet but live stream survives", async () => {
    let connections = 0;
    const server = fakeSse((conn) => {
      connections += 1;
      const timer = setInterval(() => conn.push(": hb\n\n"), 40);
      cleanup.push(() => clearInterval(timer));
      // Close the watch only after we have proved the connection was held.
      setTimeout(() => conn.push(frame({ id: 1, type: "closed" })), 500);
    });
    const seen: string[] = [];
    const out = collector();
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      idleMs: 150,
      onComment: (text) => seen.push(text),
      signals: false,
      out,
    });
    expect(connections).toBe(1);
    expect(seen.length).toBeGreaterThan(1);
  });

  test("a filtered event still advances the cursor", async () => {
    const sinces: Array<string | null> = [];
    const server = fakeSse((conn, index) => {
      sinces.push(conn.since);
      if (index === 0) {
        conn.push(frame({ id: 7, by: "me" })); // filtered as self-echo
        conn.end();
      } else {
        conn.push(frame({ id: 8, type: "closed" }));
      }
    });
    const out = collector();
    await tailEvents<{ id?: number; by?: string; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      accept: (ev) => ev.by !== "me",
      terminal: (ev) => ev.type === "closed",
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out,
    });
    expect(sinces).toEqual(["0", "7"]);
    expect(out.lines().map((l) => JSON.parse(l).id)).toEqual([8]);
  });

  test("the cursor is monotonic by default — a replayed frame cannot regress it", async () => {
    const sinces: Array<string | null> = [];
    const server = fakeSse((conn, index) => {
      sinces.push(conn.since);
      if (index === 0) {
        conn.push(frame({ id: 9 }));
        conn.push(frame({ id: 2 })); // out of order / replayed
        conn.end();
      } else {
        conn.push(frame({ id: 10, type: "closed" }));
      }
    });
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out: collector(),
    });
    expect(sinces).toEqual(["0", "9"]);
  });

  test("an epoch change resets the cursor and emits the synthesized notice", async () => {
    const sinces: Array<string | null> = [];
    const server = fakeSse((conn, index) => {
      sinces.push(conn.since);
      if (index === 0) {
        conn.push(frame({ seq: 5, epoch: "a" }));
        conn.end();
      } else if (index === 1) {
        conn.push(frame({ seq: 1, epoch: "b" }));
        conn.end();
      } else {
        conn.push(frame({ seq: 2, epoch: "b", type: "closed" }));
      }
    });
    const out = collector();
    await tailEvents<{ seq?: number; epoch?: string; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.seq,
      epochOf: (ev) => ev.epoch,
      onEpochChange: (next) => JSON.stringify({ kind: "epoch.changed", epoch: next }),
      terminal: (ev) => ev.type === "closed",
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out,
    });
    const parsed = out.lines().map((l) => JSON.parse(l));
    expect(parsed[1]).toEqual({ kind: "epoch.changed", epoch: "b" });
    // The cursor reset lands AFTER the detection, so attempt 3 resumes from the
    // new epoch's own seq, not from the old daemon's 5.
    expect(sinces).toEqual(["0", "5", "1"]);
  });

  test("query sees firstConnect, so a first-connect-only window never re-backfills", async () => {
    const urls: URL[] = [];
    const server = fakeSse((conn, index) => {
      urls.push(conn.url);
      if (index === 0) conn.end();
      else conn.push(frame({ id: 1, type: "closed" }));
    });
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      query: (cursor, firstConnect): Record<string, string> =>
        firstConnect ? { since: String(cursor), last: "5" } : { since: String(cursor) },
      terminal: (ev) => ev.type === "closed",
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out: collector(),
    });
    expect(urls[0]?.searchParams.get("last")).toBe("5");
    expect(urls[1]?.searchParams.get("last")).toBeNull();
  });

  test("onUnresolved 'stop' ends the watch at 0 and reports what was seen", async () => {
    const seen: Array<{ everResolved: boolean; everConnected: boolean }> = [];
    const code = await tailEvents({
      resolve: () => null,
      onUnresolved: (s) => {
        seen.push(s);
        return "stop";
      },
      path: "/events",
      since: 0,
      signals: false,
      out: collector(),
    });
    expect(code).toBe(0);
    expect(seen).toEqual([{ everResolved: false, everConnected: false }]);
  });

  test("a caller's abort ends the watch at 0 rather than exiting the process", async () => {
    const server = fakeSse((conn) => {
      conn.push(frame({ id: 1 }));
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const out = collector();
    const code = await tailEvents<{ id?: number }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      idleMs: 0,
      signal: ac.signal,
      signals: false,
      out,
    });
    expect(code).toBe(0);
    expect(out.lines()).toEqual(['{"id":1}']);
  });

  test("a malformed frame is skipped by default and can be surfaced by hook", async () => {
    const server = fakeSse((conn) => {
      conn.push("data: {not json\n\n");
      conn.push(frame({ id: 1, type: "closed" }));
    });
    const bad: string[] = [];
    const out = collector();
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      onMalformed: (f) => {
        bad.push(f.data);
        return null;
      },
      terminal: (ev) => ev.type === "closed",
      signals: false,
      out,
    });
    expect(bad).toEqual(["{not json"]);
    expect(out.lines().length).toBe(1);
  });

  test("onHttpError may throw, so a refusal is not retried forever", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("no such project", { status: 404 }),
    });
    cleanup.push(() => server.stop(true));
    await expect(
      tailEvents({
        resolve: () => `http://127.0.0.1:${server.port}`,
        path: "/events",
        since: 0,
        onHttpError: (res) => {
          throw new Error(`refused: ${res.status}`);
        },
        retry: { initialMs: 5, maxMs: 20 },
        signals: false,
        out: collector(),
      }),
    ).rejects.toThrow("refused: 404");
  });
});

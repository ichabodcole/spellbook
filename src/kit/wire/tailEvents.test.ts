// The shared SSE tail client, driven against a scripted fake server.
//
// These are UNIT cells over the client itself. The behavioural specification of
// a tail — watchdog, abort, epoch, first-connect grounding — is
// `src/mind-mapper/backend/tail.test.ts`, which drives a real CLI end to end.
//
// ⛔ THIS COMMENT USED TO SAY THAT FILE WAS "deliberately left pointed at
// mind-mapper's own loop until a later phase RE-POINTS IT HERE", AND BOTH
// HALVES OF THAT WERE WRONG (D82, D83's shape). It has no import to re-point:
// it imports nothing from the spell and reaches the CLI by `Bun.spawn` against
// a scripted fake server, so it is a black-box PROCESS contract and not an
// import graph. And the cells were never going to move here — a `tailEvents`
// unit cell cannot assert what a spell's PROCESS writes, which is the whole
// property that made that file the backend port's acceptance oracle. Phase 7
// swapped mind-mapper's hand-rolled loop for this module and the file stayed
// where it is, green either side; its assertions now read as claims about how
// that spell CONFIGURES this client, which is the right thing for them to be.
// The correct action on this sentence was to FIX IT, not to act on it.
//
// These cells cover the same properties one level down, plus the frame parser
// the spec question turned on.
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
      onComment: (text) => {
        seen.push(text);
        return null;
      },
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

  // ── the stop path, which is what a human does to a tail ───────────────────

  test("⛔ a stop DURING BACKOFF returns at once, not at the end of the sleep", async () => {
    // The regression this cell exists for: `stop` aborted the in-flight attempt
    // but left the reconnect sleeping on a bare timer, so Ctrl-C during backoff
    // waited out `retry.maxMs`. Measured on a real CLI at 2.80s where the
    // hand-written loop took 0.13s — and repeat signals did not help, because
    // they all hit the same sleeping timer.
    //
    // Nothing is listening on this port, so the tail is in backoff within ms.
    const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = dead.port;
    dead.stop(true);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const started = Date.now();
    const code = await tailEvents({
      resolve: () => `http://127.0.0.1:${port}`,
      path: "/events",
      since: 0,
      // A backoff far longer than the test's patience: if the sleep is not
      // woken, this cell cannot finish inside its own timeout.
      retry: { initialMs: 10_000, maxMs: 10_000 },
      signal: ac.signal,
      signals: false,
      out: collector(),
      err: collector(),
    });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  }, 15000);

  // ── the exit path both adopters depend on ─────────────────────────────────

  test("terminal ends the watch at 0 and the terminal frame is emitted", async () => {
    const server = fakeSse((conn) => {
      conn.push(frame({ id: 1 }));
      conn.push(frame({ id: 2, type: "closed" }));
      conn.push(frame({ id: 3 })); // after the end: must never be read
    });
    const out = collector();
    const code = await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      signals: false,
      out,
    });
    expect(code).toBe(0);
    expect(out.lines().map((l) => JSON.parse(l).id)).toEqual([1, 2]);
  });

  test("a FILTERED terminal frame still ends the watch, and is emitted only when asked", async () => {
    // astrolabe's exact shape: a `closed` frame the scope predicate rejects must
    // still end the tail at 0, and must NOT reach stdout.
    const run = async (terminalEmitsFiltered: boolean) => {
      const server = fakeSse((conn) => {
        conn.push(frame({ id: 1, type: "closed", by: "me" }));
      });
      const out = collector();
      const code = await tailEvents<{ id?: number; type?: string; by?: string }>({
        resolve: () => server.base,
        path: "/events",
        since: 0,
        cursorOf: (ev) => ev.id,
        accept: (ev) => ev.by !== "me",
        terminal: (ev) => ev.type === "closed",
        terminalEmitsFiltered,
        signals: false,
        out,
      });
      return { code, lines: out.lines() };
    };
    expect(await run(false)).toEqual({ code: 0, lines: [] });
    expect((await run(true)).lines.length).toBe(1);
  });

  // ── B5: the branch that lost its growth line ──────────────────────────────

  test("an empty response grows the backoff (B5) instead of storming at a constant interval", async () => {
    const at: number[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        at.push(Date.now());
        // ⚠ MEASURED, AND IT CORRECTS THE DEFECT'S OWN DESCRIPTION. B5 is
        // written up as "a 200 with no body sleeps without growing the
        // backoff", and `!res.body` is the branch that reads like. But Bun's
        // fetch hands the client an EMPTY-BUT-PRESENT body for both a
        // null-body 200 AND a 204 — checked both — so `!res.body` is
        // unreachable from a Bun client and survives only as a types-level
        // guard. The LIVE path for an empty response is the read loop ending
        // at once, i.e. `stream-end`. Same branch to get wrong, same fix, and
        // this drives the one that actually runs.
        return new Response(null, { status: 204 });
      },
    });
    cleanup.push(() => server.stop(true));
    const ac = new AbortController();
    const causes: string[] = [];
    const err = collector();
    setTimeout(() => ac.abort(), 900);
    await tailEvents({
      resolve: () => `http://127.0.0.1:${server.port}`,
      path: "/events",
      since: 0,
      retry: { initialMs: 40, maxMs: 5000 },
      onDisconnect: ({ cause }) => {
        causes.push(cause);
        return null;
      },
      signal: ac.signal,
      signals: false,
      out: collector(),
      err,
    });
    expect(causes.every((c) => c === "stream-end")).toBe(true);
    expect(at.length).toBeGreaterThanOrEqual(4);
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number));
    // Each wait is at least (nearly) double the one before — the property, not
    // the timings: a constant-interval storm has gaps that never widen.
    const last = gaps.at(-1) as number;
    const first = gaps[0] as number;
    expect(last).toBeGreaterThan(first * 2);
  }, 15000);

  // ── the diagnostics sink ──────────────────────────────────────────────────

  test("every diagnostic goes to err and NOTHING but data goes to out", async () => {
    let attempts = 0;
    const server = fakeSse((conn) => {
      attempts += 1;
      conn.push(": hb\n\n");
      conn.push("data: {not json\n\n");
      if (attempts === 1) {
        conn.end(); // → stream-end
      } else {
        conn.push(frame({ id: 1, type: "closed" }));
      }
    });
    const out = collector();
    const err = collector();
    const causes: string[] = [];
    await tailEvents<{ id?: number; type?: string }>({
      resolve: () => server.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      onComment: () => ": keepalive",
      onMalformed: (f) => `# bad sse data: ${f.data}`,
      onDisconnect: ({ cause }) => {
        causes.push(cause);
        return `# ${cause}`;
      },
      retry: { initialMs: 5, maxMs: 20 },
      signals: false,
      out,
      err,
    });
    // stdout carries the one data line and nothing else.
    expect(out.lines()).toEqual(['{"id":1,"type":"closed"}']);
    expect(err.lines()).toEqual([
      ": keepalive",
      "# bad sse data: {not json",
      "# stream-end",
      ": keepalive",
      "# bad sse data: {not json",
    ]);
    expect(causes).toEqual(["stream-end"]);
  });

  test("onDisconnect names a refused connection and an HTTP status", async () => {
    const seen: Array<{ cause: string; status?: number }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 503 }),
    });
    cleanup.push(() => server.stop(true));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await tailEvents({
      resolve: () => `http://127.0.0.1:${server.port}`,
      path: "/events",
      since: 0,
      retry: { initialMs: 20, maxMs: 40 },
      onDisconnect: ({ cause, status }) => {
        seen.push({ cause, status });
        return null;
      },
      signal: ac.signal,
      signals: false,
      out: collector(),
      err: collector(),
    });
    expect(seen[0]).toEqual({ cause: "http", status: 503 });
  }, 10000);
});

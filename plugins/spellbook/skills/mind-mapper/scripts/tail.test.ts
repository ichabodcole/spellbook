// Claim F (T3) — the cli tail's self-healing loop, driven against a scripted
// fake SSE server (not the real daemon: the scenarios need a server that goes
// deliberately silent, closes streams, and switches epochs on cue).
//
// The fake writes the discovery files the cli reads (port + THIS test
// process's pid, so the liveness probe passes) into a temp
// MIND_MAPPER_HOME.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const CLI_SCRIPT = join(SCRIPT_DIR, "cli.ts");

type Conn = { since: number; push: (chunk: string) => void; end: () => void };

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

// A scripted SSE endpoint: each incoming /events connection is handed to
// onConnection with push/end controls plus the since it arrived with.
function fakeSseServer(onConnection: (conn: Conn, index: number) => void) {
  let index = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/events") return new Response("nope", { status: 404 });
      const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const conn: Conn = {
            since: Number.isFinite(since) ? since : 0,
            push: (chunk) => {
              try {
                controller.enqueue(encoder.encode(chunk));
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
          conn.push(": connected\n\n");
          onConnection(conn, index++);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  cleanup.push(() => server.stop(true));
  const { port } = server;
  if (port === undefined) throw new Error("fake SSE server did not bind a TCP port");
  return { port };
}

function mintHome(port: number): string {
  const home = mkdtempSync(join(tmpdir(), "mind-mapper-tail-test-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "daemon.port"), String(port));
  writeFileSync(join(home, "daemon.pid"), String(process.pid));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function spawnTail(home: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "tail", ...args], {
    env: {
      ...process.env,
      MIND_MAPPER_HOME: home,
      MIND_MAPPER_TAIL_IDLE_MS: "200",
      MIND_MAPPER_TAIL_RETRY_MS: "50",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => proc.kill());
  return proc;
}

function event(seq: number, epoch: string): string {
  return `data: ${JSON.stringify({ seq, epoch, kind: "doc.added", payload: { id: `d${seq}` } })}\n\n`;
}

async function readLines(proc: ReturnType<typeof spawnTail>, n: number, ms: number) {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (buf.split("\n").length <= n && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
    ]);
    if (chunk === null || chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return buf.split("\n").filter((l) => l.length > 0);
}

test("idle watchdog aborts a silent connection and reconnects with the last-seen seq", async () => {
  const sinces: number[] = [];
  const server = fakeSseServer((conn, index) => {
    sinces.push(conn.since);
    if (index === 0) {
      // one event, then dead silence — no keepalives, no close: only the
      // watchdog can free the client from this connection.
      conn.push(event(3, "epoch-a"));
    } else {
      conn.push(event(4, "epoch-a"));
    }
  });
  const home = mintHome(server.port);
  const proc = spawnTail(home);

  const lines = await readLines(proc, 2, 5000);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 3 });
  expect(JSON.parse(lines[1] as string)).toMatchObject({ seq: 4 });
  // The reconnect resumed from the last-seen seq, not from 0.
  expect(sinces[0]).toBe(0);
  expect(sinces[1]).toBe(3);
});

test("keepalive comments feed the watchdog: a quiet-but-kept-alive stream is NOT aborted", async () => {
  let connections = 0;
  const server = fakeSseServer((conn) => {
    connections += 1;
    conn.push(event(1, "epoch-a"));
    // keepalive comments every 80ms — under the 200ms watchdog, so the
    // connection must survive even though no data frames flow.
    const timer = setInterval(() => conn.push(": keepalive\n\n"), 80);
    cleanup.push(() => clearInterval(timer));
  });
  const home = mintHome(server.port);
  spawnTail(home);

  await new Promise((r) => setTimeout(r, 800));
  expect(connections).toBe(1);
});

test("an epoch change on reconnect resets the cursor and synthesizes epoch.changed on stdout", async () => {
  const sinces: number[] = [];
  const server = fakeSseServer((conn, index) => {
    sinces.push(conn.since);
    if (index === 0) {
      // old daemon: one event at seq 5, then the stream closes (restart).
      conn.push(event(5, "epoch-a"));
      conn.end();
    } else {
      // new daemon: fresh epoch, seq restarts at 1.
      conn.push(event(1, "epoch-b"));
      const timer = setInterval(() => conn.push(": keepalive\n\n"), 80);
      cleanup.push(() => clearInterval(timer));
    }
  });
  const home = mintHome(server.port);
  const proc = spawnTail(home);

  const lines = await readLines(proc, 3, 5000);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  expect(JSON.parse(lines[0] as string)).toMatchObject({ seq: 5, epoch: "epoch-a" });
  // The synthesized line lands BEFORE the new-epoch event, and is exactly
  // {kind, epoch} — no seq, it is not a bus event.
  expect(JSON.parse(lines[1] as string)).toEqual({ kind: "epoch.changed", epoch: "epoch-b" });
  expect(JSON.parse(lines[2] as string)).toMatchObject({ seq: 1, epoch: "epoch-b" });
  // First reconnect still carried the stale seq (detection happens via the
  // received epoch, not the request); the cursor reset lands after.
  expect(sinces[0]).toBe(0);
  expect(sinces[1]).toBe(5);
});

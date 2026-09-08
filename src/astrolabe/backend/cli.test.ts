// ⛔ B1 — THE DEFECT THIS PHASE EXISTS TO MAKE UNREACHABLE.
//
// astrolabe binds an EPHEMERAL port and writes it to `$ASTROLABE_HOME/daemon.port`.
// The tail resolved that base ONCE and reconnected to the fixed URL forever, so
// after any daemon restart — a crash, a `close` and reopen, a machine waking up
// — `join`, the verb designed to run for hours carrying presence, spun silently
// against a dead port. Nothing on stdout, nothing on stderr, exit code never
// arrives: the agent holding the watch believes it is watching.
//
// The repair is not a patch at the reconnect site. The shared client
// (`src/kit/wire/tailEvents.ts`) takes `resolve` as a CALLBACK CALLED BEFORE
// EVERY CONNECT ATTEMPT and never captures its answer, so a moved daemon is
// followed by construction.
//
// ⚠ THIS TEST WAS RUN AGAINST THE UNFIXED CLI FIRST AND FAILED — it timed out
// waiting for the second line, which is the defect exactly. A test that never
// failed is not evidence.
//
// The tail is driven against a SCRIPTED FAKE DAEMON, not the real one: the
// scenario needs a daemon that dies and comes back on a DIFFERENT port on cue.
// The fake answers `/state` so the CLI's own start-up handshake is satisfied
// and no real daemon is ever spawned.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

type Conn = { since: number; push: (chunk: string) => void; end: () => void };

/** A fake astrolabe daemon: `/state` for the CLI's handshake + project check,
 *  `/events` as a scripted SSE stream. */
function fakeDaemon(onConnection: (conn: Conn, index: number) => void, avoidPort?: number) {
  let index = 0;
  const serve = () =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 255,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/state") {
          return Response.json({ state: { projects: [{ id: "proj" }] } });
        }
        if (url.pathname !== "/events") return new Response("nope", { status: 404 });
        const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            onConnection(
              {
                since: Number.isFinite(since) ? since : -1,
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
              },
              index++,
            );
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      },
    });

  // The restarted daemon MUST land on a different port or the test proves
  // nothing — the OS is free to hand back the one just released.
  let server = serve();
  const spare: Array<ReturnType<typeof serve>> = [];
  while (avoidPort !== undefined && server.port === avoidPort) {
    spare.push(server);
    server = serve();
  }
  for (const s of spare) s.stop(true);
  cleanup.push(() => server.stop(true));
  const port = server.port;
  if (port === undefined) throw new Error("fake daemon did not bind a TCP port");
  return { port, stop: () => server.stop(true) };
}

function event(id: number): string {
  return `data: ${JSON.stringify({ id, type: "status", projectId: "proj", by: "someone" })}\n\n`;
}

/** Read up to `n` newline-terminated stdout lines, or give up after `ms`. */
async function readLines(stdout: ReadableStream<Uint8Array>, n: number, ms: number) {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (buf.split("\n").length <= n && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
    ]);
    if (chunk === null || chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return buf.split("\n").filter((l) => l.length > 0);
}

test("join follows the daemon to a NEW port after a restart (B1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-b1-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));

  const first = fakeDaemon((conn) => {
    conn.push(event(1));
  });
  writeFileSync(join(home, "daemon.port"), String(first.port));

  const proc = Bun.spawn(["bun", "run", CLI, "join", "proj", "--since", "0"], {
    env: { ...process.env, ASTROLABE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => proc.kill());

  // The watch is live on the first daemon.
  const before = await readLines(proc.stdout as ReadableStream<Uint8Array>, 1, 5000);
  expect(before.map((l) => JSON.parse(l).id)).toEqual([1]);

  // The daemon dies and comes back on a DIFFERENT ephemeral port, exactly as a
  // restart does. Everything the CLI can observe about "where is the daemon"
  // is in the pointer file, and it is current.
  const sinces: number[] = [];
  first.stop();
  const second = fakeDaemon((conn) => {
    sinces.push(conn.since);
    conn.push(event(2));
  }, first.port);
  expect(second.port).not.toBe(first.port);
  writeFileSync(join(home, "daemon.port"), String(second.port));

  // ⛔ THE ASSERTION. Against the unfixed CLI this read returns EMPTY after the
  // full 15s: the tail is still dialling the dead port and has no way to learn
  // otherwise. (`after` continues the same stdout stream, so it holds only what
  // arrived since the read above.)
  const after = await readLines(proc.stdout as ReadableStream<Uint8Array>, 1, 15000);
  expect(after.map((l) => JSON.parse(l).id)).toEqual([2]);
  // ...and it resumed from the cursor rather than replaying from the start.
  expect(sinces[0]).toBe(1);
}, 30000);

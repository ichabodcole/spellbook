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
import { cli } from "./cli.ts";

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

// D2 (feat/tail-quiet-handoff): the handoff line prints the bookmark as
// `--since N@<epoch>`. A restarted daemon whose NEW log is already past N sends
// only what lies above N, so without the epoch the new log's start was skipped
// silently. `join` must notice the epoch change and re-read from 0.
test("join --since N@epoch from a restarted log re-reads the new log from 0 (D2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-d2-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const sinces: number[] = [];
  const d = fakeDaemon((conn) => {
    sinces.push(conn.since);
    for (let id = 1; id <= 5; id++)
      if (id > conn.since)
        conn.push(
          `data: ${JSON.stringify({ id, epoch: "epoch-new", type: "status", projectId: "proj", by: "someone" })}\n\n`,
        );
  });
  writeFileSync(join(home, "daemon.port"), String(d.port));
  const proc = Bun.spawn(["bun", "run", CLI, "join", "proj", "--since", "4@epoch-old"], {
    env: { ...process.env, ASTROLABE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => proc.kill());
  const lines = await readLines(proc.stdout as ReadableStream<Uint8Array>, 6, 5000);
  expect(sinces.slice(0, 2)).toEqual([4, 0]);
  expect(lines.map((l) => JSON.parse(l).id ?? JSON.parse(l).type)).toEqual([
    "epoch.changed",
    1,
    2,
    3,
    4,
    5,
  ]);
}, 30000);

// The handoff line's command names no launcher and no path, and the line
// carries `spell` (Cole's ruling, 2026-09-24): the agent runs it with its own
// launcher. A spell that put `bun <path>` back would fail here.
test("join's printed re-arm is the verb and its arguments, with spell, and no launcher", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-printed-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const d = fakeDaemon((conn) => {
    if (conn.since < 1)
      conn.push(
        `data: ${JSON.stringify({ id: 1, epoch: "epoch-x", type: "status", projectId: "proj", by: "someone" })}\n\n`,
      );
  });
  writeFileSync(join(home, "daemon.port"), String(d.port));
  const env: Record<string, string | undefined> = {
    ...process.env,
    ASTROLABE_HOME: home,
    SPELLBOOK_TAIL_WINDOW_MS: "600",
  };
  delete env.ASTROLABE_AS;
  const proc = Bun.spawn(["bun", "run", CLI, "join", "proj", "--as", "me", "--since", "0"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanup.push(() => proc.kill());
  const lines = await readLines(proc.stdout as ReadableStream<Uint8Array>, 2, 5000);
  const last = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  expect([last.type, last.spell, last.command]).toEqual([
    "tail.window",
    "astrolabe",
    "join proj --as me --since 1@epoch-x",
  ]);
}, 30000);

// ── register A1 · the declaration is bound to the behaviour ──────────────────
//
// The dispatcher, help, `choices` and `schema` are all the kit registry's walk
// of ONE table (`cli` in `./cli.ts`), so the old "VERBS is the dispatch switch"
// source-parse has nothing left to bind. What remains worth pinning: the roster
// is the table, `schema` declares every verb, and each verb's set is its own.
test("the roster is the registry's table, and schema declares every verb (A1)", () => {
  expect([...cli.verbs].sort()).toEqual(
    [
      "add",
      "attention",
      "close",
      "help",
      "info",
      "join",
      "list",
      "open",
      "poke",
      "remove",
      "schema",
      "state",
      "status",
      "tail",
      "version",
    ].sort(),
  );
  const declared = cli
    .declaration()
    .commands.map((c) => c.path.join(" "))
    .filter((p) => p !== "");
  expect(declared.sort()).toEqual([...cli.verbs].sort());
});

// Per-verb sets: `--as`/`--from` ride every verb that writes an event or holds
// a watch, and none that only reads.
test("each verb's accepted flags are its own row's (per-verb sets)", () => {
  expect(cli.flagsFor("open")).toEqual(["--no-open", "--timeout"]);
  expect(cli.flagsFor("add")).toEqual([
    "--as",
    "--avatar",
    "--description",
    "--from",
    "--id",
    "--path",
    "--stdin",
  ]);
  expect(cli.flagsFor("status")).toEqual(["--as", "--from", "--phase", "--stdin"]);
  expect(cli.flagsFor("attention")).toEqual(["--as", "--clear", "--from", "--question"]);
  expect(cli.flagsFor("join")).toEqual(["--as", "--from", "--since"]);
  expect(cli.flagsFor("tail")).toEqual(["--as", "--from", "--since"]);
  for (const v of ["remove", "poke", "close"]) expect(cli.flagsFor(v)).toEqual(["--as", "--from"]);
  for (const v of ["state", "list", "info"]) expect(cli.flagsFor(v)).toEqual([]);
});

// ⚠ THE DEFAULTED FLAGS. `clear`, `stdin` and `no-open` declare `default:
// false`; a row that does not list them must not be refused over a default it
// never saw, and a refusal must name only the row's own set. Every call below
// throws in the parse stage, before a row runs, so no daemon is contacted.
test("a defaulted flag never trips a row that does not list it", async () => {
  await expect(cli.dispatch(["poke", "p1", "--clear"])).rejects.toMatchObject({
    kind: "usage",
    extra: { choices: ["--as", "--from"] },
  });
  // No flag given: the arity check is the only refusal, not a stray default.
  await expect(cli.dispatch(["remove"])).rejects.toMatchObject({
    message: "remove: missing required <id>",
  });
  await expect(cli.dispatch(["remove", "a", "b"])).rejects.toMatchObject({ kind: "usage" });
});

// ⚠ FLAG-DEPENDENT ARITY: status's summary is positional OR --stdin.
test("status: <summary> is declared optional (the check carries the rest)", async () => {
  const row = cli.declaration().commands.find((c) => c.path.join(" ") === "status");
  expect(row?.positionals).toEqual([
    { name: "id", required: true },
    { name: "summary", required: false, variadic: true },
  ]);
  await expect(cli.dispatch(["status", "p1"])).rejects.toMatchObject({ kind: "usage" });
});

// acc A6: a value after `--` is a positional, never an option.
test("a token after -- is a positional, never an option (A6)", async () => {
  await expect(cli.dispatch(["--", "--bogus"])).rejects.toMatchObject({ kind: "usage" });
  await expect(cli.dispatch(["remove", "--", "--clear", "extra"])).rejects.toMatchObject({
    message: expect.stringContaining("unexpected argument"),
  });
});

// ── s5-8 · `close` with nothing to close is a benign no-op ───────────────────
//
// It printed `{ok:true, applied:false, error:"no daemon running"}` at exit 0 —
// a rejection's shape at a success's exit, the two faults cancelling. And a
// live close returned on the ACK, before the daemon was down, so `close; close`
// answered applied:true twice: a check written that way passed vacuously (the
// item's fixture trap). The daemon-down precondition is therefore ASSERTED
// below as its own step, not assumed.

async function runClose(home: string) {
  const proc = Bun.spawn(["bun", "run", CLI, "close"], {
    env: { ...process.env, ASTROLABE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

/** A fake daemon that acks `close` and then goes down `downAfterMs` later
 *  (removing its port file, as the real one does) — or never, when null. */
function closingDaemon(home: string, downAfterMs: number | null) {
  const portFile = join(home, "daemon.port");
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/state") return Response.json({ state: { projects: [] } });
      if (url.pathname === "/cmd" && req.method === "POST") {
        const body = (await req.json()) as { type?: string };
        if (body.type === "close" && downAfterMs !== null)
          setTimeout(() => {
            server.stop(true);
            rmSync(portFile, { force: true });
          }, downAfterMs);
        return Response.json({ ok: true, applied: true });
      }
      return new Response("nope", { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  writeFileSync(portFile, String(server.port));
  return server;
}

async function answers(port: number | undefined): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/state`)).ok;
  } catch {
    return false;
  }
}

function expectAlreadyClosed(r: { out: string; err: string; code: number }) {
  expect(r.code).toBe(0);
  expect(r.err).toBe("");
  const env = JSON.parse(r.out) as Record<string, unknown>;
  expect(env).toEqual({ ok: true, applied: false, outcome: "already-closed" });
  // Presence, not value: a no-op carries NO `error` key at all.
  expect("error" in env).toBe(false);
}

test("close with no daemon is a no-op: exit 0, a noun, no error (s5-8)", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-close-none-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  expectAlreadyClosed(await runClose(home));
});

test("close with a stale port file (daemon killed, file left) is the same no-op", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-close-stale-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  // Bind, record, and kill — the port file now names a port nothing answers on.
  const dead = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  writeFileSync(join(home, "daemon.port"), String(dead.port));
  dead.stop(true);
  expect(await answers(dead.port)).toBe(false); // precondition: nothing answers
  expectAlreadyClosed(await runClose(home));
});

test("close waits until the daemon is down, so close; close is applied then the no-op", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-close-twice-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  // Teardown takes 500 ms after the ack — longer than the old CLI waited (0).
  const d = closingDaemon(home, 500);
  expect(await answers(d.port)).toBe(true);

  const first = await runClose(home);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.out)).toEqual({ ok: true, applied: true });

  // ⛔ THE PRECONDITION, ASSERTED: the first close returned only once the
  // daemon was down. Against the old CLI this fails — it returned on the ack.
  expect(await answers(d.port)).toBe(false);

  expectAlreadyClosed(await runClose(home));
}, 15000);

test("close reports a daemon still answering at the bound as a failure, not success", async () => {
  const home = mkdtempSync(join(tmpdir(), "astrolabe-close-wedged-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  closingDaemon(home, null); // acks close, never goes down
  const r = await runClose(home);
  expect(r.code).toBe(1);
  expect(r.out).toBe("");
  const env = JSON.parse(r.err) as { ok: boolean; error: { kind: string; message: string } };
  expect(env.ok).toBe(false);
  expect(env.error.kind).toBe("internal");
  expect(env.error.message).toContain("still answering");
}, 15000);

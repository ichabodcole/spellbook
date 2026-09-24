// The tail's handoff (feat/tail-quiet-handoff): the pure decision "given how
// the tail ended, which line do I print", the client closing its connection on
// a terminal frame, and the wrapper that runs the window and `--once`.
//
// Unit cells over a scripted fake server. The same properties on a REAL daemon
// through a real CLI are `src/scriptorium/backend/tail-handoff.integration.test.ts`.
// No cell waits minutes: the window is injected in milliseconds.
import { afterEach, describe, expect, test } from "bun:test";
import { type Sink, tailEvents } from "./tailEvents";
import {
  commandLine,
  DEFAULT_WINDOW_MS,
  type HandoffCommands,
  handoff,
  LOST_AFTER_REFUSALS,
  parseBookmark,
  readSince,
  resolveWindowMs,
  tailCommand,
  tailWithHandoff,
} from "./tailHandoff";

const CMD: HandoffCommands = {
  tail: ({ since, once, epoch }) =>
    `tail --session s1 --since ${since}${epoch ? `@${epoch}` : ""}${once ? " --once" : ""}`,
  comeBack: () => "open --restore s1",
};

describe("handoff — which line, given how the tail ended (pure)", () => {
  test("quiet window: nothing on the log → a background one-shot, bookmark included", () => {
    expect(
      handoff(
        { spell: "demo", end: "window", mode: "watch", events: 0, cursor: 7, presence: false },
        CMD,
      ),
    ).toEqual({
      type: "tail.quiet",
      spell: "demo",
      events: 0,
      cursor: 7,
      next: "background",
      command: "tail --session s1 --since 7 --once",
      hint: "nothing on the log this window; run bun <this skill's directory>/scripts/cli.ts <command> as a background Bash task (run_in_background) — it exits on the next event",
    });
  });

  test("active window: it saw events → re-arm Monitor from the bookmark", () => {
    expect(
      handoff(
        {
          spell: "demo",
          end: "window",
          mode: "watch",
          events: 3,
          cursor: 12,
          presence: false,
        },
        CMD,
      ),
    ).toEqual({
      type: "tail.window",
      spell: "demo",
      events: 3,
      cursor: 12,
      next: "monitor",
      command: "tail --session s1 --since 12",
      hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) running bun <this skill's directory>/scripts/cli.ts <command>",
    });
  });

  test("presence spell, quiet window: STILL Monitor, never the one-shot", () => {
    expect(
      handoff(
        { spell: "demo", end: "window", mode: "watch", events: 0, cursor: 4, presence: true },
        CMD,
      ),
    ).toEqual({
      type: "tail.window",
      spell: "demo",
      events: 0,
      cursor: 4,
      next: "monitor",
      command: "tail --session s1 --since 4",
      hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) running bun <this skill's directory>/scripts/cli.ts <command>",
    });
  });

  test("once woke on an event → back to Monitor from the bookmark", () => {
    expect(
      handoff(
        { spell: "demo", end: "event", mode: "once", events: 1, cursor: 8, presence: false },
        CMD,
      ),
    ).toEqual({
      type: "tail.woke",
      spell: "demo",
      events: 1,
      cursor: 8,
      next: "monitor",
      command: "tail --session s1 --since 8",
      hint: "handle the event above, then arm Monitor (timeout_ms 1800000) running bun <this skill's directory>/scripts/cli.ts <command>",
    });
  });

  test("closed → stop, naming how to come back — not a re-arm", () => {
    expect(
      handoff(
        { spell: "demo", end: "closed", mode: "once", events: 1, cursor: 9, presence: false },
        CMD,
      ),
    ).toEqual({
      type: "tail.closed",
      spell: "demo",
      events: 1,
      cursor: 9,
      next: "stop",
      command: "open --restore s1",
      hint: "the session closed; there is nothing left to watch. To bring it back, run bun <this skill's directory>/scripts/cli.ts <command>; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)",
    });
  });

  test("disconnected (lost) → stop, naming how to come back — not a re-arm", () => {
    expect(
      handoff(
        { spell: "demo", end: "lost", mode: "watch", events: 0, cursor: 2, presence: false },
        CMD,
      ),
    ).toEqual({
      type: "tail.lost",
      spell: "demo",
      events: 0,
      cursor: 2,
      next: "stop",
      command: "open --restore s1",
      hint: "lost the daemon (it crashed or was killed); nothing is listening. To bring it back, run bun <this skill's directory>/scripts/cli.ts <command>; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)",
    });
  });

  test("a signal or a caller's abort prints nothing", () => {
    expect(
      handoff(
        {
          spell: "demo",
          end: "stopped",
          mode: "watch",
          events: 5,
          cursor: 5,
          presence: false,
        },
        CMD,
      ),
    ).toBeNull();
  });

  test("the window: 60 s inside the cap by default, injectable, 0 turns it off", () => {
    expect(DEFAULT_WINDOW_MS).toBe(1_740_000);
    expect(resolveWindowMs(undefined)).toBe(1_740_000);
    expect(resolveWindowMs("1500")).toBe(1500);
    expect(resolveWindowMs("0")).toBe(0);
    expect(resolveWindowMs("soon")).toBe(1_740_000);
    expect(resolveWindowMs("-5")).toBe(1_740_000);
  });

  test("a negative bookmark is spelled --since=-1, which the parsers accept", () => {
    expect(tailCommand(["bun", "cli.ts", "tail"], -1, true)).toBe(
      "bun cli.ts tail --since=-1 --once",
    );
    expect(tailCommand(["bun", "cli.ts", "tail"], 0, false)).toBe("bun cli.ts tail --since 0");
  });

  test("readSince: every tail's --since reads the same way, and refuses with the accepted forms named", () => {
    expect(readSince("12", { epoch: false })).toEqual({ ok: true, since: 12 });
    expect(readSince("-1", { epoch: false })).toEqual({ ok: true, since: -1 });
    expect(readSince("12@e1", { epoch: true })).toEqual({ ok: true, since: 12, epoch: "e1" });
    // ⛔ An epoch bookmark on a spell whose log stamps none: refused, never read as 12.
    expect(readSince("12@e1", { epoch: false })).toEqual({
      ok: false,
      message:
        '--since: "12@e1" is not a bookmark this tail accepts — give an event id (an integer; -1 for everything); this spell\'s log stamps no epoch, so pass the id without the "@…" part',
    });
    expect(readSince("abc", { epoch: true })).toEqual({
      ok: false,
      message:
        '--since: "abc" is not a bookmark this tail accepts — give an event id (an integer; -1 for everything), or <id>@<epoch> as a handoff line prints it',
    });
    expect(readSince("-1", { epoch: false, min: 0 })).toEqual({
      ok: false,
      message:
        '--since: "-1" is not a bookmark this tail accepts — give an event id (an integer, 0 or more)',
    });
    expect(readSince("1.5", { epoch: false }).ok).toBe(false);
  });

  test("the printed command names no launcher and no path — the agent supplies its own", () => {
    const line = handoff(
      { spell: "demo", end: "window", mode: "watch", events: 0, cursor: 7, presence: false },
      {
        tail: ({ since, once }) => tailCommand(["tail", "--session", "s1"], since, once),
        comeBack: () => "open --restore s1 --no-open",
      },
    );
    expect(line?.spell).toBe("demo");
    expect(line?.command).toBe("tail --session s1 --since 7 --once");
    expect(line?.hint).toContain("bun <this skill's directory>/scripts/cli.ts <command>");
  });

  test("a printed command runs as printed: arguments that need it are quoted", () => {
    expect(commandLine(["bun", "/a b/cli.ts", "tail", "--as", "o'brien", "--since", "3"])).toBe(
      "bun '/a b/cli.ts' tail --as 'o'\\''brien' --since 3",
    );
  });
});

// ── the fake daemon ─────────────────────────────────────────────────────────

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

type Conn = {
  since: string | null;
  push: (ev: unknown) => void;
  end: () => void;
};

/** A scripted SSE server that ALSO records when a client closes its stream —
 *  the observable half of adjustment 1. */
function fakeDaemon(onConnection: (conn: Conn, index: number) => void) {
  let index = 0;
  const state = { cancelled: 0, open: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);
      const enc = new TextEncoder();
      state.open += 1;
      const stream = new ReadableStream({
        start(controller) {
          onConnection(
            {
              since: url.searchParams.get("since"),
              push: (ev) => {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
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
        cancel() {
          state.cancelled += 1;
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  cleanup.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, state };
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

const until = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) return false;
    await Bun.sleep(10);
  }
  return true;
};

type Ev = { id?: number; type?: string; kind?: string; by?: string };

describe("adjustment 1 — a terminal frame closes the connection", () => {
  test("⛔ the client cancels a stream the server keeps open (the silent --once hang)", async () => {
    // The server sends a terminal frame and then keeps the stream OPEN, which is
    // exactly what a daemon does for `--once`'s first event. Before the fix the
    // client returned and left this stream open, so the process never exited.
    const d = fakeDaemon((conn) => conn.push({ id: 1, type: "closed" }));
    const code = await tailEvents<Ev>({
      resolve: () => d.base,
      path: "/events",
      since: 0,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      signals: false,
      out: collector(),
    });
    expect(code).toBe(0);
    expect(await until(() => d.state.cancelled === 1)).toBe(true);
  });

  test("onEnd reports the final cursor and why it ended", async () => {
    const d = fakeDaemon((conn) => {
      conn.push({ id: 4 });
      conn.push({ id: 5, type: "closed" });
    });
    const ends: unknown[] = [];
    await tailEvents<Ev>({
      resolve: () => d.base,
      path: "/events",
      since: 3,
      cursorOf: (ev) => ev.id,
      terminal: (ev) => ev.type === "closed",
      signals: false,
      out: collector(),
      onEnd: (e) => ends.push(e),
    });
    expect(ends).toEqual([{ cursor: 5, epoch: null, reason: "terminal" }]);
  });
});

const base = (
  d: { base: string },
  out: Sink,
  over: Partial<Parameters<typeof tailEvents<Ev>>[0]> = {},
) => ({
  resolve: () => d.base,
  path: "/events",
  since: 2,
  cursorOf: (ev: Ev) => ev.id,
  terminal: (ev: Ev) => ev.type === "closed",
  signals: false,
  out,
  err: collector(),
  ...over,
});

describe("tailWithHandoff — the window and --once over the real client", () => {
  test("a quiet window self-ends and names the background one-shot", async () => {
    const d = fakeDaemon(() => {});
    const out = collector();
    const code = await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "watch",
      presence: false,
      windowMs: 150,
      commands: CMD,
    });
    expect(code).toBe(0);
    expect(out.lines().map((l) => JSON.parse(l))).toEqual([
      {
        type: "tail.quiet",
        spell: "demo",
        events: 0,
        cursor: 2,
        next: "background",
        command: "tail --session s1 --since 2 --once",
        hint: "nothing on the log this window; run bun <this skill's directory>/scripts/cli.ts <command> as a background Bash task (run_in_background) — it exits on the next event",
      },
    ]);
    expect(await until(() => d.state.cancelled === 1)).toBe(true);
  });

  test("an active window names the Monitor re-arm from the last id; grounding frames do not count", async () => {
    const d = fakeDaemon((conn) => {
      conn.push({ kind: "grounding" });
      conn.push({ id: 3, type: "message" });
      conn.push({ id: 4, type: "waiting" });
    });
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "watch",
      presence: false,
      windowMs: 200,
      counts: (ev) => ev.kind !== "grounding",
      commands: CMD,
    });
    const last = JSON.parse(out.lines().at(-1) ?? "{}");
    expect(out.lines()).toHaveLength(4);
    expect([last.type, last.events, last.cursor, last.command]).toEqual([
      "tail.window",
      2,
      4,
      "tail --session s1 --since 4",
    ]);
  });

  test("a window with ONLY a grounding frame is quiet", async () => {
    const d = fakeDaemon((conn) => conn.push({ kind: "grounding" }));
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "watch",
      presence: false,
      windowMs: 150,
      counts: (ev) => ev.kind !== "grounding",
      commands: CMD,
    });
    expect(JSON.parse(out.lines().at(-1) ?? "{}").type).toBe("tail.quiet");
  });

  test("a presence spell's quiet window still names Monitor", async () => {
    const d = fakeDaemon(() => {});
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "watch",
      presence: true,
      windowMs: 100,
      commands: CMD,
    });
    expect(JSON.parse(out.lines().at(-1) ?? "{}").next).toBe("monitor");
  });

  test("--once ends on the first delivered frame, closes the stream, names Monitor", async () => {
    const d = fakeDaemon((conn) => {
      setTimeout(() => {
        conn.push({ id: 3, type: "message" });
        conn.push({ id: 4, type: "message" }); // same burst: left for the re-arm
      }, 50);
    });
    const out = collector();
    const code = await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "once",
      presence: false,
      windowMs: 50, // ignored in once mode: a one-shot has no window
      commands: CMD,
    });
    expect(code).toBe(0);
    expect(out.lines().map((l) => JSON.parse(l))).toEqual([
      { id: 3, type: "message" },
      {
        type: "tail.woke",
        spell: "demo",
        events: 1,
        cursor: 3,
        next: "monitor",
        command: "tail --session s1 --since 3",
        hint: "handle the event above, then arm Monitor (timeout_ms 1800000) running bun <this skill's directory>/scripts/cli.ts <command>",
      },
    ]);
    expect(await until(() => d.state.cancelled === 1)).toBe(true);
  });

  test("--once does not wake on a frame its own filter rejects (a self-echo)", async () => {
    const d = fakeDaemon((conn) => {
      conn.push({ id: 3, by: "me" });
      setTimeout(() => conn.push({ id: 4, by: "human" }), 50);
    });
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out, { accept: (ev) => ev.by !== "me" }), {
      spell: "demo",
      mode: "once",
      presence: false,
      commands: CMD,
    });
    expect(out.lines().map((l) => JSON.parse(l).cursor ?? JSON.parse(l).id)).toEqual([4, 4]);
  });

  test("--once on a closed session: the closed frame, then tail.closed naming the way back", async () => {
    const d = fakeDaemon((conn) => conn.push({ id: 3, type: "closed" }));
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "once",
      presence: false,
      commands: CMD,
    });
    const last = JSON.parse(out.lines().at(-1) ?? "{}");
    expect([last.type, last.next, last.command]).toEqual([
      "tail.closed",
      "stop",
      "open --restore s1",
    ]);
  });

  test("a pinned session that vanishes is closed, not a silent exit", async () => {
    let n = 0;
    const d = fakeDaemon((conn) => conn.end());
    const out = collector();
    await tailWithHandoff<Ev>(
      base(d, out, {
        resolve: () => (n++ === 0 ? d.base : null),
        onUnresolved: ({ everResolved }) => (everResolved ? "stop" : "retry"),
        retry: { initialMs: 5, maxMs: 5 },
      }),
      { spell: "demo", mode: "once", presence: false, commands: CMD },
    );
    expect(JSON.parse(out.lines().at(-1) ?? "{}").type).toBe("tail.closed");
  });

  test(`a dead daemon (${LOST_AFTER_REFUSALS} refusals in a row) ends a session spell's tail with tail.lost ON STDOUT`, async () => {
    const d = fakeDaemon(() => {});
    const dead = d.base;
    cleanup.shift()?.(); // stop the server: the port now refuses
    const out = collector();
    const code = await tailWithHandoff<Ev>(
      base({ base: dead }, out, { retry: { initialMs: 5, maxMs: 5 } }),
      { spell: "demo", mode: "once", presence: false, commands: CMD },
    );
    expect(code).toBe(0);
    expect(out.lines().map((l) => JSON.parse(l).type)).toEqual(["tail.lost"]);
  });

  test("a presence spell keeps retrying a dead daemon (its window still ends it)", async () => {
    const d = fakeDaemon(() => {});
    const dead = d.base;
    cleanup.shift()?.();
    const out = collector();
    await tailWithHandoff<Ev>(base({ base: dead }, out, { retry: { initialMs: 5, maxMs: 5 } }), {
      spell: "demo",
      mode: "watch",
      presence: true,
      windowMs: 200,
      commands: CMD,
    });
    expect(out.lines().map((l) => JSON.parse(l).type)).toEqual(["tail.window"]);
  });

  test("a caller's abort prints no handoff line", async () => {
    const d = fakeDaemon(() => {});
    const out = collector();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await tailWithHandoff<Ev>(base(d, out, { signal: ac.signal }), {
      spell: "demo",
      mode: "watch",
      presence: false,
      windowMs: 10_000,
      commands: CMD,
    });
    expect(out.lines()).toEqual([]);
  });

  // ── the verifier's defects (D1–D4) ────────────────────────────────────────

  test("D1: re-armed at a session that is gone (never resolved) → tail.closed, not a silent retry", async () => {
    const out = collector();
    const code = await tailWithHandoff<Ev>(
      base({ base: "unused" }, out, {
        resolve: () => null,
        // The spell's rule: a tail given a bookmark or --session is re-arming
        // an EXISTING session, so not finding it means it closed.
        onUnresolved: () => "stop",
      }),
      { spell: "demo", mode: "once", presence: false, commands: CMD },
    );
    expect(code).toBe(0);
    expect(out.lines().map((l) => JSON.parse(l).type)).toEqual(["tail.closed"]);
  });

  test("D2: a bookmark from a restarted log is dropped — the replay resets the cursor", async () => {
    // A restarted daemon: its ids began again at 1, so it answers since=8 by
    // replaying WHOLE (the kit's event log, point 3).
    const d = fakeDaemon((conn) => {
      expect(conn.since).toBe("8");
      conn.push({ id: 1, type: "ready" });
      conn.push({ id: 2, type: "message" });
    });
    const out = collector();
    await tailWithHandoff<Ev>(
      base(d, out, {
        since: 8,
        onEpochChange: (e) => JSON.stringify({ type: "epoch.changed", epoch: e }),
      }),
      { spell: "demo", mode: "watch", presence: false, windowMs: 200, commands: CMD },
    );
    const lines = out.lines().map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["epoch.changed", "ready", "message", "tail.window"]);
    expect(lines.at(-1).command).toBe("tail --session s1 --since 2");
  });

  test("D2: a --once on a restarted log wakes ONCE and names the new cursor, not the stale one", async () => {
    const d = fakeDaemon((conn) => {
      conn.push({ id: 1, type: "ready" });
      conn.push({ id: 2, type: "message" });
    });
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out, { since: 8 }), {
      spell: "demo",
      mode: "once",
      presence: false,
      commands: CMD,
    });
    expect(JSON.parse(out.lines().at(-1) ?? "{}").cursor).toBe(1);
  });

  test("D2 gap: a bookmark that carries its epoch re-reads a NEW log from 0 — nothing is skipped", async () => {
    // The new log is already PAST the old bookmark (ids 1..5, bookmark 4), so
    // the daemon believes the cursor and sends only id 5. Its early frames — a
    // human message at new id 2 — were skipped with no notice.
    const sinces: Array<string | null> = [];
    const d = fakeDaemon((conn) => {
      sinces.push(conn.since);
      const from = Number(conn.since);
      for (let id = 1; id <= 5; id++)
        if (id > from) conn.push({ id, epoch: "new", type: id === 2 ? "message" : "x" });
    });
    const out = collector();
    await tailWithHandoff<Ev & { epoch?: string }>(
      base(d, out, {
        since: 4,
        sinceEpoch: "old",
        epochOf: (ev: Ev & { epoch?: string }) => ev.epoch,
        onEpochChange: (e) => JSON.stringify({ type: "epoch.changed", epoch: e }),
      }) as Parameters<typeof tailWithHandoff<Ev & { epoch?: string }>>[0],
      { spell: "demo", mode: "watch", presence: false, windowMs: 250, commands: CMD },
    );
    const lines = out.lines().map((l) => JSON.parse(l));
    expect(sinces).toEqual(["4", "0"]);
    expect(lines.map((l) => l.id ?? l.type)).toEqual([
      "epoch.changed",
      1,
      2,
      3,
      4,
      5,
      "tail.window",
    ]);
    expect(lines.at(-1).command).toBe("tail --session s1 --since 5@new");
  });

  test("D2 gap: a presence tail whose reconnect lands past its cursor in a new epoch re-reads from 0", async () => {
    const sinces: Array<string | null> = [];
    const d = fakeDaemon((conn, i) => {
      sinces.push(conn.since);
      if (i === 0) {
        conn.push({ id: 5, epoch: "a" });
        conn.end();
      } else if (i === 1) {
        conn.push({ id: 7, epoch: "b" }); // restarted, and already past 5
      } else {
        for (let id = 1; id <= 7; id++) conn.push({ id, epoch: "b" });
      }
    });
    const out = collector();
    await tailWithHandoff<Ev & { epoch?: string }>(
      base(d, out, {
        since: 0,
        retry: { initialMs: 5, maxMs: 5 },
        epochOf: (ev: Ev & { epoch?: string }) => ev.epoch,
      }) as Parameters<typeof tailWithHandoff<Ev & { epoch?: string }>>[0],
      { spell: "demo", mode: "watch", presence: true, windowMs: 300, commands: CMD },
    );
    expect(sinces.slice(0, 3)).toEqual(["0", "5", "0"]);
    expect(out.lines().map((l) => JSON.parse(l).id ?? JSON.parse(l).type)).toEqual([
      5,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      "tail.window",
    ]);
  });

  test("D2 gap: the bookmark syntax — N@epoch parses, a bare id still does, junk does not", () => {
    expect(parseBookmark("12@abc-1")).toEqual({ since: 12, epoch: "abc-1" });
    expect(parseBookmark("-1@e")).toEqual({ since: -1, epoch: "e" });
    expect(parseBookmark("7")).toEqual({ since: 7 });
    expect(parseBookmark("x")).toBeNull();
    expect(parseBookmark("7@")).toBeNull();
    expect(tailCommand(["bun", "c", "tail"], 3, true, "e1")).toBe("bun c tail --since 3@e1 --once");
    expect(tailCommand(["bun", "c", "tail"], -1, false, "e1")).toBe("bun c tail --since=-1@e1");
  });

  test("a stop that lands while resolve is awaited opens no connection (the reviewer's race)", async () => {
    const d = fakeDaemon(() => {});
    const out = collector();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await tailEvents<Ev>({
      resolve: async () => {
        await Bun.sleep(150);
        return d.base;
      },
      path: "/events",
      since: 0,
      signals: false,
      out,
      signal: ac.signal,
    });
    await Bun.sleep(100);
    expect(d.state.open).toBe(0);
  });

  test("D3: an id-less ping is not on the log — it neither counts nor wakes a --once", async () => {
    const d = fakeDaemon((conn) => {
      conn.push({ type: "connected" });
      conn.push({ type: "disconnected" });
      setTimeout(() => conn.push({ id: 3, type: "message" }), 50);
    });
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "once",
      presence: false,
      commands: CMD,
    });
    const last = JSON.parse(out.lines().at(-1) ?? "{}");
    expect([last.type, last.events, last.cursor]).toEqual(["tail.woke", 1, 3]);
  });

  test("D3: a window that saw only id-less pings is quiet", async () => {
    const d = fakeDaemon((conn) => conn.push({ type: "connected" }));
    const out = collector();
    await tailWithHandoff<Ev>(base(d, out), {
      spell: "demo",
      mode: "watch",
      presence: false,
      windowMs: 150,
      commands: CMD,
    });
    expect(JSON.parse(out.lines().at(-1) ?? "{}").type).toBe("tail.quiet");
  });

  test("D4: windowMs 0 (a human at a terminal) never ends the watch by itself", async () => {
    const d = fakeDaemon(() => {});
    const out = collector();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await tailWithHandoff<Ev>(base(d, out, { signal: ac.signal }), {
      spell: "demo",
      mode: "watch",
      presence: true,
      windowMs: 0,
      commands: CMD,
    });
    expect(out.lines()).toEqual([]);
  });
});

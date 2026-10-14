// The daemon substrate end to end, in one process: a throwaway `Bun.serve` on
// loopback, built from `origin`, `sse`, `eventLog`, `heartbeat`, `housekeeping`
// and `discovery`, driven by the real tail client and handoff.
//
// Detaching a daemon (`startDaemon`) is covered in `detach.test.ts`; here the
// server runs in-process so the test can inspect it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPointer, readPointer } from "./discovery.ts";
import { createEventLog } from "./eventLog.ts";
import { drainAndStop } from "./housekeeping.ts";
import { refuseForeignOrigin } from "./origin.ts";
import { type SseClients, sseResponse } from "./sse.ts";
import { type HandoffLine, tailCommand, tailWithHandoff } from "./tailHandoff.ts";

type Ev = { type: string; text?: string };

function startDaemon() {
  const log = createEventLog<Ev>({ epoch: "run-1" });
  const clients: SseClients = new Set();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
      if (refused) return refused;
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
        return sseResponse({ log, since, heartbeatMs: 1000, clients, signal: req.signal });
      }
      if (url.pathname === "/state") return Response.json({ cursor: log.cursor() });
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  return { log, clients, server, base };
}

let daemon: ReturnType<typeof startDaemon> | null = null;
const dirs: string[] = [];
afterEach(async () => {
  if (daemon) await drainAndStop({ server: daemon.server, clients: daemon.clients, graceMs: 0 });
  daemon = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("a throwaway daemon on 127.0.0.1", () => {
  test("refuses a foreign Origin, allows its own page and a caller with none", async () => {
    daemon = startDaemon();
    const foreign = await fetch(`${daemon.base}/state`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ ok: false, error: "foreign origin refused" });

    const own = await fetch(`${daemon.base}/state`, { headers: { Origin: daemon.base } });
    expect(own.status).toBe(200);
    const none = await fetch(`${daemon.base}/state`);
    expect(none.status).toBe(200);

    // The refusal covers every path, not a list of dangerous ones.
    const events = await fetch(`${daemon.base}/events?since=0`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(events.status).toBe(403);
  });

  test("GET /events?since=0 streams the event log as SSE", async () => {
    daemon = startDaemon();
    daemon.log.emit({ type: "one" });
    daemon.log.emit({ type: "two" });

    const res = await fetch(`${daemon.base}/events?since=0`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"two"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    const frames = text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as { id: number; epoch: string; type: string });
    // `since=0` is "after id 0", which is everything; ids are monotonic and stamped with the epoch.
    expect(frames.map((f) => [f.id, f.type, f.epoch])).toEqual([
      [1, "one", "run-1"],
      [2, "two", "run-1"],
    ]);
  });

  test("a tail reads the log and closes with a tail.window line naming the bookmark", async () => {
    daemon = startDaemon();
    daemon.log.emit({ type: "one" });
    const { base, log } = daemon;

    const out: string[] = [];
    const code = await tailWithHandoff<{ id: number; epoch: string } & Ev>(
      {
        resolve: () => base,
        path: "/events",
        since: 0,
        cursorOf: (e) => e.id,
        epochOf: (e) => e.epoch,
        out: { write: (s) => out.push(s) },
        err: { write: () => {} },
        signals: false,
        idleMs: 0,
      },
      {
        spell: "demo",
        mode: "watch",
        presence: false,
        windowMs: 150,
        commands: {
          tail: ({ since, once, epoch }) => tailCommand(["demo", "tail"], since, once, epoch),
          comeBack: () => "demo open --restore",
        },
      },
    );
    expect(code).toBe(0);
    const lines = out.join("").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: 1, type: "one" });
    const last = JSON.parse(lines[lines.length - 1] ?? "") as HandoffLine;
    expect(last).toMatchObject({
      type: "tail.window",
      spell: "demo",
      next: "monitor",
      cursor: 1,
      events: 1,
      command: "demo tail --since 1@run-1",
    });
    expect(log.cursor()).toBe(1);
  });

  test("a daemon that stops answering ends the tail with tail.lost", async () => {
    daemon = startDaemon();
    daemon.log.emit({ type: "one" });
    const base = daemon.base;
    // Stop the daemon: the next tail sees refused connections only.
    await drainAndStop({ server: daemon.server, clients: daemon.clients, graceMs: 0 });
    daemon = null;

    const out: string[] = [];
    const code = await tailWithHandoff<{ id: number }>(
      {
        resolve: () => base,
        path: "/events",
        since: 1,
        cursorOf: (e) => e.id,
        out: { write: (s) => out.push(s) },
        err: { write: () => {} },
        signals: false,
        retry: { initialMs: 5, maxMs: 10 },
      },
      {
        spell: "demo",
        mode: "watch",
        presence: false,
        windowMs: 0,
        commands: {
          tail: ({ since }) => `demo tail --since ${since}`,
          comeBack: () => "demo open --restore",
        },
      },
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("").trim())).toMatchObject({
      type: "tail.lost",
      next: "stop",
      command: "demo open --restore",
    });
  });

  test("the daemon publishes a pointer a CLI can find, per spell", async () => {
    daemon = startDaemon();
    const tmp = mkdtempSync(join(tmpdir(), "daemon-test-"));
    dirs.push(tmp);
    const port = daemon.server.port ?? 0;
    publishPointer(
      "demo",
      { url: daemon.base, port, session_id: "s1", dir: "/tmp/s1", pid: process.pid },
      { tmp },
    );
    const found = readPointer("demo", undefined, { tmp });
    expect(found?.url).toBe(daemon.base);
    const res = await fetch(`${found?.url}/state`);
    expect(await res.json()).toEqual({ cursor: 0 });
  });
});

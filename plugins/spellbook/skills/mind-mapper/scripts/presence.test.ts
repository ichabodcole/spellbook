// Claim C (T8) — presence + activity against a live daemon on shortened
// ticks (keepalive 25ms, activity TTL 150ms). This rig also proves the F→C
// coupling end-to-end: an abruptly-destroyed SSE socket must decrement
// presence via the teardown funnel (req.signal abort — the measured
// dead-socket signal in Bun 1.3.14; enqueue on an orphaned stream never
// throws, so the ratified enqueue-throw clause is corrected here).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

let proc: Bun.Subprocess<"ignore", "pipe", "inherit">;
let home: string;
let url = "";
let port = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mind-mapper-presence-test-"));
  proc = Bun.spawn(
    [process.execPath, "run", join(SCRIPT_DIR, "server.ts"), "--no-open", "--port", "0"],
    {
      cwd: SURFACE_CWD,
      env: {
        ...process.env,
        MIND_MAPPER_HOME: home,
        MIND_MAPPER_KEEPALIVE_MS: "25",
        MIND_MAPPER_ACTIVITY_TTL_MS: "150",
      },
      stdout: "pipe",
    },
  );
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not print ready line")), 10_000);
    (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          clearTimeout(timer);
          resolve(buf.slice(0, nl));
          return;
        }
      }
      reject(new Error("daemon stdout closed before ready line"));
    })();
  });
  const ready = JSON.parse(line) as { url: string; port: number };
  url = ready.url;
  port = ready.port;
  // Round 3: no auto-mint — presence attribution's default-project clause is
  // "the daemon-resolved default IF one exists", so this rig creates it (the
  // legacy-store shape unscoped connections attribute to).
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "default", title: "Default" }),
  });
});

afterAll(() => {
  proc.kill();
  rmSync(home, { recursive: true, force: true });
});

async function agents(project?: string): Promise<number> {
  const qs = project ? `?project=${project}` : "";
  const state = (await (await fetch(`${url}/state${qs}`)).json()) as {
    presence: { agents: number };
  };
  return state.presence.agents;
}

async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

// Collects WS events (the browser's transport) so tests can assert what the
// SURFACE would see, project-scoped. Connects at the CURRENT cursor so a
// prior test's events don't replay into this collector.
async function collectWs(project?: string): Promise<{
  events: Array<Record<string, unknown>>;
  close: () => void;
}> {
  const stateQs = project ? `?project=${project}` : "";
  const { cursor } = (await (await fetch(`${url}/state${stateQs}`)).json()) as { cursor: number };
  const params = new URLSearchParams({ since: String(cursor) });
  if (project) params.set("project", project);
  const ws = new WebSocket(`${url.replace("http://", "ws://")}/events?${params}`);
  const events: Array<Record<string, unknown>> = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  return { events, close: () => ws.close() };
}

test("/state carries presence {agents}; an SSE tail counts, a browser WS does not", async () => {
  expect(await agents()).toBe(0);

  const watcher = await collectWs();
  await new Promise((r) => setTimeout(r, 100));
  expect(await agents()).toBe(0); // WS alone: presence is agents-only, ruled

  // Disconnects use AbortController — what the cli tail's watchdog really
  // does. (Bun-client quirk, measured: reader.cancel() alone closes nothing
  // and is invisible to the server.)
  const ac = new AbortController();
  const tail = await fetch(`${url}/events`, { signal: ac.signal });
  const reader = (tail.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // opening frame — subscription is live
  expect(await until(async () => (await agents()) === 1, 2000)).toBe(true);

  // The surface saw the project-scoped presence.changed with the new count.
  expect(
    watcher.events.some(
      (e) => e.kind === "presence.changed" && (e.payload as { agents: number }).agents === 1,
    ),
  ).toBe(true);

  ac.abort(); // disconnect → decrement via the teardown funnel
  expect(await until(async () => (await agents()) === 0, 2000)).toBe(true);
  expect(
    watcher.events.some(
      (e) => e.kind === "presence.changed" && (e.payload as { agents: number }).agents === 0,
    ),
  ).toBe(true);
  watcher.close();
});

test("an abruptly-destroyed SSE socket is detected (req.signal abort → teardown funnel → decrement)", async () => {
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  socket.write("GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
  await new Promise<void>((resolve) => socket.once("data", () => resolve()));
  expect(await until(async () => (await agents()) === 1, 2000)).toBe(true);

  socket.destroy(); // no clean close — only a failing keepalive write can discover this
  expect(await until(async () => (await agents()) === 0, 3000)).toBe(true);
});

test("presence is project-scoped, and an unscoped tail attributes to the daemon-resolved default project", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "presence-side", title: "Presence Side" }),
  });

  const scopedAc = new AbortController();
  const scoped = await fetch(`${url}/events?project=presence-side`, { signal: scopedAc.signal });
  await (scoped.body as ReadableStream<Uint8Array>).getReader().read();
  const unscopedAc = new AbortController();
  const unscoped = await fetch(`${url}/events`, { signal: unscopedAc.signal });
  await (unscoped.body as ReadableStream<Uint8Array>).getReader().read();

  expect(await until(async () => (await agents("presence-side")) === 1, 2000)).toBe(true);
  expect(await agents()).toBe(1); // the unscoped tail landed on default, not on presence-side

  scopedAc.abort();
  unscopedAc.abort();
  expect(await until(async () => (await agents()) === 0, 2000)).toBe(true);
  expect(await until(async () => (await agents("presence-side")) === 0, 2000)).toBe(true);
});

test("POST /activity emits agent.activity, and the TTL fires a synthetic idle; bad state 400s", async () => {
  const watcher = await collectWs();
  await new Promise((r) => setTimeout(r, 100));

  const res = await fetch(`${url}/activity`, {
    method: "POST",
    body: JSON.stringify({ state: "thinking" }),
  });
  expect(res.status).toBe(200);

  const activityStates = () =>
    watcher.events
      .filter((e) => e.kind === "agent.activity")
      .map((e) => (e.payload as { state: string }).state);
  expect(await until(async () => activityStates().includes("thinking"), 2000)).toBe(true);
  // The TTL (150ms) turns thinking-silence into a synthetic idle (ACT1: only
  // `received` escalates to stalled; thinking decays quietly).
  expect(await until(async () => activityStates().includes("idle"), 2000)).toBe(true);
  expect(activityStates()).not.toContain("stalled");
  watcher.close();

  const bad = await fetch(`${url}/activity`, {
    method: "POST",
    body: JSON.stringify({ state: "pondering" }),
  });
  expect(bad.status).toBe(400);
});

// Round 4 (ACT1) — the CHANGED TTL rig: `received` older than the TTL
// escalates to a daemon-synthesized `stalled` that PERSISTS (no decay to
// idle/blank) until an agent write resolves it.
test("received older than the TTL escalates to stalled, which persists until an agent write resolves it", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "act1-stall", title: "Stall" }),
  });
  const watcher = await collectWs("act1-stall");
  await new Promise((r) => setTimeout(r, 100));
  const activityStates = () =>
    watcher.events
      .filter((e) => e.kind === "agent.activity")
      .map((e) => (e.payload as { state: string }).state);

  await fetch(`${url}/activity?project=act1-stall`, {
    method: "POST",
    body: JSON.stringify({ state: "received" }),
  });
  expect(await until(async () => activityStates().includes("stalled"), 2000)).toBe(true);
  // Stalled persists: wait out several more TTL windows — no synthetic idle,
  // no second stalled (the escalation timer does not re-arm).
  await new Promise((r) => setTimeout(r, 500));
  expect(activityStates()).toEqual(["received", "stalled"]);

  // An agent write (a role:agent send) resolves it to idle.
  await fetch(`${url}/send?project=act1-stall`, {
    method: "POST",
    body: JSON.stringify({ role: "agent", text: "sorry, was digging" }),
  });
  expect(await until(async () => activityStates().includes("idle"), 2000)).toBe(true);
  watcher.close();
});

test("POST /activity rejects stalled — daemon-synthesized vocabulary only", async () => {
  const res = await fetch(`${url}/activity`, {
    method: "POST",
    body: JSON.stringify({ state: "stalled" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("daemon-synthesized");
});

// ACT1 auto-flip: a role:user send while an agent tail is connected emits
// received (source auto) AFTER message.posted — two seqs, ordered. No tail →
// no flip.
test("a user send with an agent tail connected auto-emits received after message.posted; no tail, no flip", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "act1-auto", title: "Auto" }),
  });
  const watcher = await collectWs("act1-auto");
  await new Promise((r) => setTimeout(r, 100));

  // No agent tail yet: no flip.
  await fetch(`${url}/send?project=act1-auto`, {
    method: "POST",
    body: JSON.stringify({ role: "user", text: "anyone home?" }),
  });
  expect(
    await until(async () => watcher.events.some((e) => e.kind === "message.posted"), 2000),
  ).toBe(true);
  await new Promise((r) => setTimeout(r, 100));
  expect(watcher.events.filter((e) => e.kind === "agent.activity")).toHaveLength(0);

  // Connect an agent tail; now a user send flips received, ordered after the
  // message.posted seq.
  const ac = new AbortController();
  const tail = await fetch(`${url}/events?project=act1-auto`, { signal: ac.signal });
  await (tail.body as ReadableStream<Uint8Array>).getReader().read();
  expect(await until(async () => (await agents("act1-auto")) === 1, 2000)).toBe(true);

  await fetch(`${url}/send?project=act1-auto`, {
    method: "POST",
    body: JSON.stringify({ role: "user", text: "now?" }),
  });
  expect(
    await until(
      async () =>
        watcher.events.some(
          (e) =>
            e.kind === "agent.activity" && (e.payload as { state: string }).state === "received",
        ),
      2000,
    ),
  ).toBe(true);
  const posted = watcher.events.filter((e) => e.kind === "message.posted").at(-1) as {
    seq: number;
  };
  const received = watcher.events.find(
    (e) => e.kind === "agent.activity" && (e.payload as { state: string }).state === "received",
  ) as { seq: number };
  expect(received.seq).toBe(posted.seq + 1); // emitted AFTER message.posted, both seq-consuming

  ac.abort();
  watcher.close();
});

test("an agent send resolves explicit thinking to idle before the TTL (the turn's terminal act)", async () => {
  await fetch(`${url}/projects`, {
    method: "POST",
    body: JSON.stringify({ id: "act1-turn", title: "Turn" }),
  });
  const watcher = await collectWs("act1-turn");
  await new Promise((r) => setTimeout(r, 100));

  await fetch(`${url}/activity?project=act1-turn`, {
    method: "POST",
    body: JSON.stringify({ state: "thinking" }),
  });
  await fetch(`${url}/send?project=act1-turn`, {
    method: "POST",
    body: JSON.stringify({ role: "agent", text: "here's what I found" }),
  });
  expect(
    await until(
      async () =>
        watcher.events.some(
          (e) => e.kind === "agent.activity" && (e.payload as { state: string }).state === "idle",
        ),
      2000,
    ),
  ).toBe(true);
  // Exactly one idle — the resolve, not a later TTL duplicate.
  await new Promise((r) => setTimeout(r, 400));
  const idles = watcher.events.filter(
    (e) => e.kind === "agent.activity" && (e.payload as { state: string }).state === "idle",
  );
  expect(idles).toHaveLength(1);
  watcher.close();
});

test("an explicit idle clears the TTL timer: no duplicate synthetic idle later", async () => {
  const watcher = await collectWs();
  await new Promise((r) => setTimeout(r, 100));

  await fetch(`${url}/activity`, { method: "POST", body: JSON.stringify({ state: "received" }) });
  await fetch(`${url}/activity`, { method: "POST", body: JSON.stringify({ state: "idle" }) });
  // Wait out where the TTL would have fired.
  await new Promise((r) => setTimeout(r, 400));

  const idles = watcher.events.filter(
    (e) => e.kind === "agent.activity" && (e.payload as { state: string }).state === "idle",
  );
  expect(idles).toHaveLength(1); // the explicit one only — no synthetic follow-up
  watcher.close();
});

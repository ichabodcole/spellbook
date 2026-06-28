// Subprocess integration test for the magpie daemon (server.ts).
//
// Spawns the real Bun-served daemon in an isolated MAGPIE_HOME + TMPDIR, then
// drives the load-bearing contract over the live channels:
//   - GET  /state[?lean=1] — the canonical projection
//   - POST /cmd            — an AgentCommand → mutate → readback
//   - WebSocket /ws        — a ClientToServer gesture → mutate + SSE
//   - GET  /events?since=  — assert the emitted agent event
//
// Isolation: each daemon gets its own MAGPIE_HOME + TMPDIR under a per-run
// tmpdir, so snapshots / discovery files never touch the real ~/.magpie or
// shared /tmp. All procs are killed in afterAll.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(SCRIPT_DIR, "..", "scripts", "server.ts");

// a real 1×1 PNG data-URL → the daemon materializes it (Bun.Image reads its size)
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Spawned = {
  proc: ReturnType<typeof Bun.spawn>;
  url: string;
  port: number;
  sessionId: string;
  home: string;
  tmp: string;
};
const spawned: Spawned[] = [];

async function spawnDaemon(args: string[] = []): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "magpie-home-"));
  const tmp = mkdtempSync(join(tmpdir(), "magpie-tmp-"));
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--timeout", "30", ...args],
    cwd: join(SCRIPT_DIR, ".."),
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, MAGPIE_HOME: home, TMPDIR: tmp },
  });
  // The daemon signals it's bound by writing magpie-latest.json into its TMPDIR.
  const latest = join(tmp, "magpie-latest.json");
  let info: { url: string; port: number; session_id: string } | null = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      info = JSON.parse(await Bun.file(latest).text());
      if (info?.port) break;
    } catch {
      /* not written yet */
    }
    await Bun.sleep(50);
  }
  if (!info?.port) {
    const err = await new Response(proc.stderr).text();
    proc.kill();
    throw new Error(`daemon did not write discovery file${err ? `\n${err}` : ""}`);
  }
  const rec: Spawned = {
    proc,
    url: info.url,
    port: info.port,
    sessionId: info.session_id,
    home,
    tmp,
  };
  spawned.push(rec);
  return rec;
}

afterAll(async () => {
  for (const s of spawned) {
    try {
      s.proc.kill();
    } catch {}
    try {
      await s.proc.exited;
    } catch {}
    try {
      rmSync(s.home, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(s.tmp, { recursive: true, force: true });
    } catch {}
  }
});

type ObservedState = {
  title: string;
  intent: string;
  phase: string;
  source: { path: string; size: [number, number]; sha: string } | null;
  elements: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    bbox: number[];
    flagged?: boolean;
    versions?: Array<{ id: string; model: string; path: string; rev: number }>;
    chosenVersionId?: string;
  }>;
  conversation: Array<{ role: string; text: string; action?: { label: string; command: unknown } }>;
  status: { busy: boolean; text: string };
  backdrop: string;
  bundle?: { name: string; count: number };
};

async function getState(s: Spawned, lean = false): Promise<ObservedState> {
  const res = await fetch(`http://127.0.0.1:${s.port}/state${lean ? "?lean=1" : ""}`);
  const body = (await res.json()) as { state: ObservedState; cursor: number };
  return body.state;
}

async function postCmd(s: Spawned, msg: Record<string, unknown>): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${s.port}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
  if (res.status !== 200) throw new Error(`/cmd ${msg.type} failed: ${res.status}`);
  await res.text();
}

async function waitForState(
  s: Spawned,
  predicate: (st: ObservedState) => boolean,
  maxMs = 3000,
): Promise<ObservedState> {
  const deadline = Date.now() + maxMs;
  let last = {} as ObservedState;
  while (Date.now() < deadline) {
    last = await getState(s);
    if (predicate(last)) return last;
    await Bun.sleep(40);
  }
  throw new Error(`state never matched; last=${JSON.stringify(last).slice(0, 400)}`);
}

async function openWs(s: Spawned): Promise<{ send: (m: object) => void; close: () => void }> {
  const ws = new WebSocket(`${s.url.replace(/^http/, "ws")}/ws`);
  await new Promise<void>((r, rej) => {
    ws.addEventListener("open", () => r(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws error")), { once: true });
  });
  return { send: (m: object) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

async function fetchCursor(s: Spawned): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${s.port}/state`);
  const body = (await res.json()) as { cursor: number };
  return body.cursor;
}

async function collectEvents(
  s: Spawned,
  since: number,
  predicate: (e: Record<string, unknown>) => boolean,
  maxMs = 2000,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
  if (!res.body) throw new Error("/events returned no body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: Record<string, unknown>[] = [];
  const deadline = Date.now() + maxMs;
  try {
    while (Date.now() < deadline) {
      const timed = Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => ({ done: true, value: undefined }) as const),
      ]);
      const { done, value } = await timed;
      if (value) buf += dec.decode(value as Uint8Array, { stream: true });
      if (done) break;
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            seen.push(JSON.parse(line.slice(5).trim()));
          } catch {}
        }
      }
      if (seen.some(predicate)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return seen;
}

// ── the contract ─────────────────────────────────────────────────────────────

test("GET /state returns the seeded default shape", async () => {
  const s = await spawnDaemon();
  const st = await getState(s);
  expect(st.title).toBe("magpie");
  expect(st.elements).toEqual([]);
  expect(st.source).toBeNull();
  expect(st.backdrop).toBe("transparent");
});

test("POST /cmd source.set + elements.set mutate state; readback over /state", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "source.set",
    path: "/tmp/board.png",
    size: [1408, 768],
    sha: "deadbeefdeadbeef",
  });
  await postCmd(s, {
    type: "elements.set",
    elements: [
      { id: "e1", name: "icon_mammoth", type: "icon", bbox: [61, 518, 142, 606] },
      { id: "e2", name: "wordmark", type: "wordmark", bbox: [0, 0, 400, 80] },
    ],
  });
  const st = await waitForState(s, (x) => x.elements.length === 2 && x.source !== null);
  expect(st.source?.size).toEqual([1408, 768]);
  // elements.set defaults a missing status to "proposed"
  expect(st.elements.map((e) => e.status)).toEqual(["proposed", "proposed"]);
  expect(st.elements[0].name).toBe("icon_mammoth");
});

test("POST /cmd status round-trips", async () => {
  const s = await spawnDaemon();
  await postCmd(s, { type: "status", busy: true, text: "discovering…" });
  const st = await waitForState(s, (x) => x.status.busy === true);
  expect(st.status.text).toBe("discovering…");
});

// ── editing the breakdown is AMBIENT: it mutates state + (sometimes) logs a
// gesture for the human, but is NEVER pushed to the agent SSE. The agent reads
// the current boxes from /state when an imperative (extract) fires. These tests
// lock that "no agent event" contract — mirror the backdrop.set test below.

test("WS element.judge mutates status + logs a gesture, but emits NO agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "element.judge", id: "e1", status: "confirmed" });

  const st = await waitForState(s, (x) => x.elements[0]?.status === "confirmed");
  expect(st.conversation.some((m) => m.role === "user")).toBe(true); // gesture logged

  expect((await evP).filter((e) => e.type === "element.judge")).toEqual([]);
  ws.close();
});

test("WS source.import materializes the board, sets source, emits source.added", async () => {
  const s = await spawnDaemon();
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "source.added");
  const ws = await openWs(s);
  ws.send({ type: "source.import", name: "board.png", dataUrl: PNG_DATA_URL });

  const st = await waitForState(s, (x) => x.source !== null);
  expect(st.source?.size).toEqual([1, 1]);
  expect(st.source?.sha).toHaveLength(16);
  expect(st.source?.path).toContain("board.png");

  const added = (await evP).find((e) => e.type === "source.added") as
    | { path?: string; size?: number[] }
    | undefined;
  expect(added?.path).toContain("board.png");
  expect(added?.size).toEqual([1, 1]);
  ws.close();
});

test("WS element.add materializes a region + logs a gesture, but emits NO agent event", async () => {
  const s = await spawnDaemon();
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "element.add", element: { bbox: [10, 20, 30, 40] } });

  const st = await waitForState(s, (x) => x.elements.length === 1);
  expect(st.elements[0].name).toBe("region_1");
  expect(st.elements[0].status).toBe("confirmed");
  expect(st.conversation.some((m) => m.role === "user" && m.text.startsWith("drew "))).toBe(true);

  expect((await evP).filter((e) => e.type === "element.add")).toEqual([]);
  ws.close();
});

test("WS element.update mutates silently (no agent event); bbox leaves no chat, rename logs a gesture", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  // a bbox move → mutate, NO conversation message, NO agent event
  const c1 = (await fetchCursor(s)) - 1;
  const ev1 = collectEvents(s, c1, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "element.update", id: "e1", patch: { bbox: [5, 5, 20, 20] } });
  const st1 = await waitForState(s, (x) => x.elements[0]?.bbox[0] === 5);
  expect(st1.conversation.length).toBe(0);
  expect((await ev1).filter((e) => e.type === "element.update")).toEqual([]);

  // a rename → mutate + a gesture message, still NO agent event
  const c2 = (await fetchCursor(s)) - 1;
  const ev2 = collectEvents(s, c2, () => false, 700);
  ws.send({ type: "element.update", id: "e1", patch: { name: "icon_mammoth" } });
  const st2 = await waitForState(s, (x) => x.elements[0]?.name === "icon_mammoth");
  expect(st2.conversation.some((m) => m.text.includes("renamed"))).toBe(true);
  expect((await ev2).filter((e) => e.type === "element.update")).toEqual([]);
  ws.close();
});

test("WS element.remove deletes the element + logs a gesture, but emits NO agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "element.remove", id: "e1" });

  const st = await waitForState(s, (x) => x.elements.length === 0);
  expect(st.conversation.some((m) => m.text.startsWith("removed icon"))).toBe(true);

  expect((await evP).filter((e) => e.type === "element.remove")).toEqual([]);
  ws.close();
});

test("WS element.flag flags an element + logs a gesture, but emits NO agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "element.flag", id: "e1", flagged: true });

  const st = await waitForState(s, (x) => x.elements[0]?.flagged === true);
  expect(st.conversation.some((m) => m.text.includes("flagged"))).toBe(true);

  expect((await evP).filter((e) => e.type === "element.flag")).toEqual([]);
  ws.close();
});

test("POST /cmd element.addVersion appends a version + sets chosen; no agent event", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  await postCmd(s, {
    type: "element.addVersion",
    id: "e1",
    version: { id: "vC", model: "crop", path: "/tmp/f/icon.png", rev: 0 },
  });
  const st = await waitForState(s, (x) => (x.elements[0]?.versions?.length ?? 0) === 1);
  expect(st.elements[0].versions?.[0].model).toBe("crop");
  expect(st.elements[0].chosenVersionId).toBe("vC");
});

test("WS removeBg IS an imperative — flips busy + emits an agent event with ids", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "removeBg");
  const ws = await openWs(s);
  ws.send({ type: "removeBg", ids: ["e1"] });

  const st = await waitForState(s, (x) => x.status.busy === true);
  expect(st.status.text).toContain("Removing");

  const ev = (await evP).find((e) => e.type === "removeBg") as { ids?: string[] } | undefined;
  expect(ev?.ids).toEqual(["e1"]);
  ws.close();
});

test("WS retryRemoval IS an imperative — emits with ids ONLY (no model)", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "retryRemoval");
  const ws = await openWs(s);
  ws.send({ type: "retryRemoval", ids: ["e1"] });

  const ev = (await evP).find((e) => e.type === "retryRemoval") as
    | { ids?: string[]; model?: unknown }
    | undefined;
  expect(ev?.ids).toEqual(["e1"]);
  expect(ev && "model" in ev).toBe(false); // model-agnostic — ids only
  ws.close();
});

test("WS extract IS an imperative — flips busy immediately + emits an agent event with ids", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);

  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "extract");
  const ws = await openWs(s);
  ws.send({ type: "extract", ids: ["e1"] });

  // the processing affordance: server flips busy on receipt, before any agent cut
  const st = await waitForState(s, (x) => x.status.busy === true);
  expect(st.status.text).toContain("Re-slicing");

  const ex = (await evP).find((e) => e.type === "extract") as { ids?: string[] } | undefined;
  expect(ex?.ids).toEqual(["e1"]);
  ws.close();
});

test("WS backdrop.set is ambient — mutates state, emits NO agent event", async () => {
  const s = await spawnDaemon();
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, () => false, 700);
  const ws = await openWs(s);
  ws.send({ type: "backdrop.set", backdrop: "black" });
  const st = await waitForState(s, (x) => x.backdrop === "black");
  expect(st.backdrop).toBe("black");
  const events = await evP;
  expect(events.filter((e) => e.type === "backdrop.set")).toEqual([]);
  ws.close();
});

// ── phase spine ──────────────────────────────────────────────────────────────

test("elements.set auto-advances intake → slice", async () => {
  const s = await spawnDaemon();
  expect((await getState(s)).phase).toBe("intake");
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  const st = await waitForState(s, (x) => x.phase === "slice");
  expect(st.phase).toBe("slice");
});

test("WS phase.advance IS an imperative — advances cursor + emits with the new phase", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.phase === "slice"); // auto-intake
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "phase.advance");
  const ws = await openWs(s);
  ws.send({ type: "phase.advance" });
  const st = await waitForState(s, (x) => x.phase === "remove");
  expect(st.phase).toBe("remove");
  const ev = (await evP).find((e) => e.type === "phase.advance") as { phase?: string } | undefined;
  expect(ev?.phase).toBe("remove");
  ws.close();
});

test("WS phase.set (back-nav) IS pushed — mutates + emits phase.set with the target phase", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.phase === "slice");
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "phase.set");
  const ws = await openWs(s);
  ws.send({ type: "phase.set", phase: "intake" });
  const st = await waitForState(s, (x) => x.phase === "intake");
  expect(st.phase).toBe("intake");
  const ev = (await evP).find((e) => e.type === "phase.set") as { phase?: string } | undefined;
  expect(ev?.phase).toBe("intake");
  ws.close();
});

// ── conversational advancement: actionable agent messages + agent phase.set ──

test("POST /cmd say carries an optional action CTA on the message", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "say",
    text: "Slices look clean — ready for background removal?",
    action: { label: "Move to Remove →", command: { type: "phase.advance" } },
  });
  const st = await waitForState(s, (x) => x.conversation.some((m) => m.role === "agent"));
  const m = st.conversation.find((x) => x.role === "agent");
  expect(m?.action?.label).toBe("Move to Remove →");
  expect((m?.action?.command as { type?: string })?.type).toBe("phase.advance");
});

test("POST /cmd phase.set (agent) advances the cursor on the user's request", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.phase === "slice");
  await postCmd(s, { type: "phase.set", phase: "remove" });
  const st = await waitForState(s, (x) => x.phase === "remove");
  expect(st.phase).toBe("remove");
});

// ── export ───────────────────────────────────────────────────────────────────

test("WS export IS an imperative — flips busy + emits an agent event with ids", async () => {
  const s = await spawnDaemon();
  await postCmd(s, {
    type: "elements.set",
    elements: [{ id: "e1", name: "icon", type: "icon", bbox: [0, 0, 10, 10] }],
  });
  await waitForState(s, (x) => x.elements.length === 1);
  const cursor = (await fetchCursor(s)) - 1;
  const evP = collectEvents(s, cursor, (e) => e.type === "export");
  const ws = await openWs(s);
  ws.send({ type: "export", ids: ["e1"] });
  const st = await waitForState(s, (x) => x.status.busy === true);
  expect(st.status.text).toContain("Building");
  const ev = (await evP).find((e) => e.type === "export") as { ids?: string[] } | undefined;
  expect(ev?.ids).toEqual(["e1"]);
  ws.close();
});

test("POST /cmd bundle.set records the bundle for the Export download", async () => {
  const s = await spawnDaemon();
  await postCmd(s, { type: "bundle.set", name: "magpie-bundle.zip", count: 3 });
  const st = await waitForState(s, (x) => x.bundle != null);
  expect(st.bundle?.name).toBe("magpie-bundle.zip");
  expect(st.bundle?.count).toBe(3);
});

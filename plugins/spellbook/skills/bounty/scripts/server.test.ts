// Tests for bounty server.ts (the daemon), cli.ts, and join.ts.
//
// Coverage:
//   - Pure state-mutation helpers (applyTaskAdd/Update/Remove/Move).
//   - parsePortFromSessionId (the relaunch-port-reuse contract).
//   - htmlEscape (the 5 interesting chars + ampersand-first ordering).
//   - The daemon HTTP surface: GET /state, POST /cmd, GET /events (SSE).
//   - End-to-end via subprocess for the bits that need a real server:
//       * submit broadcasts to all WS clients (browsers + joiners)
//       * cancel broadcasts a structured event to all WS clients
//       * task.edit rejects non-string titles silently
//       * task.add from browser rejects malformed task objects
//       * cli.ts ↔ daemon parity: state ack, --stdin quoting, tail
//         resume-from-cursor, idle-touch (the Phase A gate)
//       * join.ts discovers via bounty-latest.json when --url/--id omitted
//       * join.ts idle timeout reports reason: "timeout"

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyTaskAdd,
  applyTaskMove,
  applyTaskRemove,
  applyTaskUpdate,
  type BoardState,
  htmlEscape,
  parsePortFromSessionId,
  type Task,
  type TaskStatus,
  validateTask,
} from "./server.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// A decoded protocol frame as observed on stdout / the WebSocket. The
// helpers collect heterogeneous frames (ready, meta, task.*, submit, init,
// joined, disconnected, …); fields are optional and narrowed per assertion.
type WireMsg = {
  type?: string;
  task?: Task;
  tasks?: Task[];
  patch?: Partial<Task>;
  id?: string;
  status?: TaskStatus;
  index?: number;
  title?: string;
  text?: string;
  reason?: string;
  url?: string;
  port?: number;
  session_id?: string;
};
const SERVER = join(SCRIPT_DIR, "server.ts");
const JOIN = join(SCRIPT_DIR, "join.ts");

function freshState(): BoardState {
  return { title: "T", tasks: [] };
}

// ── Pure state mutation tests ────────────────────────────────────────────

describe("applyTaskAdd", () => {
  test("appends a task", () => {
    const s = freshState();
    expect(applyTaskAdd(s, { id: "a", title: "A", status: "todo" })).toBe(true);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0].id).toBe("a");
  });
  test("rejects duplicate id", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskAdd(s, { id: "a", title: "A2", status: "doing" })).toBe(false);
    expect(s.tasks).toHaveLength(1);
  });
});

describe("applyTaskUpdate", () => {
  test("applies a partial patch", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "doing" })).toBe(true);
    expect(s.tasks[0].status).toBe("doing");
    expect(s.tasks[0].title).toBe("A");
  });
  test("accepts the review status", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "review" })).toBe(true);
    expect(s.tasks[0].status).toBe("review");
  });
  test("drops invalid status quietly", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskUpdate(s, "a", { status: "bogus" as TaskStatus, title: "B" })).toBe(true);
    expect(s.tasks[0].status).toBe("todo");
    expect(s.tasks[0].title).toBe("B");
  });
  test("returns false for missing id", () => {
    expect(applyTaskUpdate(freshState(), "missing", { status: "done" })).toBe(false);
  });
});

describe("applyTaskRemove", () => {
  test("removes by id", () => {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    expect(applyTaskRemove(s, "a")).toBe(true);
    expect(s.tasks).toHaveLength(0);
  });
  test("returns false for missing id", () => {
    expect(applyTaskRemove(freshState(), "missing")).toBe(false);
  });
});

describe("applyTaskMove", () => {
  function seed(): BoardState {
    const s = freshState();
    applyTaskAdd(s, { id: "a", title: "A", status: "todo" });
    applyTaskAdd(s, { id: "b", title: "B", status: "todo" });
    applyTaskAdd(s, { id: "c", title: "C", status: "doing" });
    applyTaskAdd(s, { id: "d", title: "D", status: "doing" });
    return s;
  }

  test("intra-column reorder: move b to position 0", () => {
    const s = seed();
    expect(applyTaskMove(s, "b", "todo", 0)).not.toBe(-1);
    expect(s.tasks.map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
  });
  test("cross-column move to position 0", () => {
    const s = seed();
    expect(applyTaskMove(s, "a", "doing", 0)).not.toBe(-1);
    expect(s.tasks.filter((t) => t.status === "doing").map((t) => t.id)).toEqual(["a", "c", "d"]);
  });
  test("cross-column move to end (index past column length clamps)", () => {
    const s = seed();
    expect(applyTaskMove(s, "a", "doing", 99)).not.toBe(-1);
    expect(s.tasks.filter((t) => t.status === "doing").map((t) => t.id)).toEqual(["c", "d", "a"]);
  });
  test("move to empty column (status with no current tasks)", () => {
    const s = seed();
    applyTaskMove(s, "a", "done", 0);
    expect(s.tasks.find((t) => t.id === "a")?.status).toBe("done");
  });
  test("returns -1 for missing id", () => {
    expect(applyTaskMove(freshState(), "missing", "doing", 0)).toBe(-1);
  });
  test("status flips correctly on move", () => {
    const s = seed();
    applyTaskMove(s, "a", "done", 0);
    expect(s.tasks.find((t) => t.id === "a")?.status).toBe("done");
  });
});

// ── validateTask (the shared task-shape trust boundary) ──────────────────

describe("validateTask", () => {
  test("accepts a well-formed task and passes notes through", () => {
    expect(validateTask({ id: "a", title: "A", status: "doing", notes: "n" })).toEqual({
      id: "a",
      title: "A",
      status: "doing",
      notes: "n",
    });
  });
  test("accepts without notes (omits the field)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo" })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
    });
  });
  test("rejects missing id / title", () => {
    expect(validateTask({ title: "A", status: "todo" })).toBeNull();
    expect(validateTask({ id: "a", status: "todo" })).toBeNull();
  });
  test("rejects invalid / missing status", () => {
    expect(validateTask({ id: "a", title: "A", status: "bogus" })).toBeNull();
    expect(validateTask({ id: "a", title: "A" })).toBeNull();
  });
  test("rejects non-string notes", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", notes: 42 })).toBeNull();
  });
  test("carries an owner when present (string)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", owner: "worker1" })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
      owner: "worker1",
    });
  });
  test("rejects non-string owner", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", owner: 42 })).toBeNull();
  });
  test("carries blockedBy when present (string array)", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: ["b1", "b2"] })).toEqual({
      id: "a",
      title: "A",
      status: "todo",
      blockedBy: ["b1", "b2"],
    });
  });
  test("rejects non-array blockedBy or non-string members", () => {
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: "b1" })).toBeNull();
    expect(validateTask({ id: "a", title: "A", status: "todo", blockedBy: [1, 2] })).toBeNull();
  });
  test("rejects non-objects", () => {
    expect(validateTask(null)).toBeNull();
    expect(validateTask("nope")).toBeNull();
    expect(validateTask(undefined)).toBeNull();
  });
});

// ── parsePortFromSessionId ───────────────────────────────────────────────

describe("parsePortFromSessionId", () => {
  test("extracts trailing -p<port>", () => {
    expect(parsePortFromSessionId("bounty-abc-p54321")).toBe(54321);
  });
  test("returns null when no -p suffix", () => {
    expect(parsePortFromSessionId("bounty-abc")).toBeNull();
  });
  test("returns null for empty input", () => {
    expect(parsePortFromSessionId("")).toBeNull();
  });
  test("rejects out-of-range port", () => {
    expect(parsePortFromSessionId("bounty-abc-p99999")).toBeNull();
  });
});

// ── htmlEscape ───────────────────────────────────────────────────────────

describe("htmlEscape", () => {
  test("escapes the five interesting chars", () => {
    expect(htmlEscape(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#x27;");
  });
  test("ampersand-first ordering avoids double-escape", () => {
    expect(htmlEscape("<&>")).toBe("&lt;&amp;&gt;");
  });
});

// ── End-to-end subprocess tests ──────────────────────────────────────────

type ReadyInfo = { url: string; port: number; session_id: string };

// Spawn the daemon and wait until it's reachable. Readiness is discovered via
// the daemon's discovery file (`bounty-<id>.json`) + a /state probe — the
// daemon no longer prints a `ready` line on stdout (the SSE event log is the
// sole agent channel since the file-pump was retired).
async function spawnServerReady(
  args: string[] = [],
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ready: ReadyInfo }> {
  const id = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--id", id, ...args],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Isolate persistence to a throwaway dir — a test suite must NOT write
    // snapshots into the user's real ~/.bounty (the default BOUNTY_HOME).
    env: { ...process.env, BOUNTY_HOME: uniqHome() },
  });
  const discoveryFile = join(tmpdir(), `bounty-${id}.json`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(discoveryFile, "utf8")) as ReadyInfo;
      const r = await fetch(`${info.url}/state`);
      if (r.ok) return { proc, ready: info };
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  proc.kill();
  throw new Error("server did not become ready");
}

// Seed board state over the daemon's HTTP write path (replaces the retired
// stdin JSON-lines seeding).
async function seedCmd(url: string, body: unknown): Promise<void> {
  await fetch(`${url}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function collectStdout(
  proc: ReturnType<typeof Bun.spawn>,
  predicate: (m: WireMsg) => boolean,
  maxMs: number,
): Promise<WireMsg[]> {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: WireMsg[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as WireMsg;
      seen.push(m);
      if (predicate(m)) {
        reader.releaseLock();
        return seen;
      }
    }
    if (done) break;
  }
  reader.releaseLock();
  return seen;
}

// Helper: wait for either the WS to close OR a target message to arrive,
// whichever comes first. Returns when both are settled so we can assert.
async function collectWsUntilClose(ws: WebSocket): Promise<WireMsg[]> {
  const msgs: WireMsg[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      msgs.push(JSON.parse(ev.data) as WireMsg);
    } catch {
      /* skip */
    }
  });
  await new Promise<void>((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.addEventListener("close", () => r(), { once: true });
  });
  return msgs;
}

describe("close dismiss", () => {
  // The board is a conjuration ("stands until dismissed"). The old submit/cancel
  // pair collapsed to a single browser "Close board" dismiss: the daemon exits 0
  // (a clean dismiss, never the 130 a "cancel" used to mean), the canonical state
  // is already live to every consumer (+ snapshotted), and all clients get the
  // uniform "session ended" signal before the socket closes.
  test("browser close dismisses the board: exit 0 + session-ended to clients", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "dismiss-test",
      tasks: [{ id: "x", title: "X", status: "todo" }],
    });

    const browser = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => browser.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(browser);

    browser.send(JSON.stringify({ type: "close" }));
    const browserMsgs = await msgsP;
    const code = await proc.exited;

    // Clean dismiss = exit 0 (not 130).
    expect(code).toBe(0);
    // No "submit" or "cancel" frames anymore — the uniform end signal is the
    // "session ended" message broadcast before the socket closes.
    expect(browserMsgs.find((m) => m.type === "submit")).toBeUndefined();
    expect(browserMsgs.find((m) => m.type === "cancel")).toBeUndefined();
    const ended = browserMsgs.find(
      (m) => m.type === "message" && (m.text || "").startsWith("session ended:"),
    );
    expect(ended).toBeDefined();
  }, 15000);
});

describe("input validation from browser", () => {
  test("task.edit with non-string title is rejected silently", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedCmd(ready.url, {
      type: "init",
      title: "T",
      tasks: [{ id: "x", title: "original", status: "todo" }],
    });

    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(ws);

    // Bad edits — should all be silently dropped.
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: null }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: 42 }));
    ws.send(JSON.stringify({ type: "task.edit", id: "x" })); // missing title
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "" })); // empty
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "   " })); // whitespace
    // Good edit — should land.
    ws.send(JSON.stringify({ type: "task.edit", id: "x", title: "updated" }));
    ws.send(JSON.stringify({ type: "close" })); // dismiss to end the session
    const msgs = await msgsP;
    await proc.exited;

    const titleUpdates = msgs.filter(
      (m) => m.type === "task.update" && m.patch?.title !== undefined,
    );
    expect(titleUpdates).toHaveLength(1);
    expect(titleUpdates[0].patch.title).toBe("updated");
  }, 15000);

  test("task.add from browser with missing fields is rejected", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(ws);

    // All bad — should be silently dropped.
    ws.send(JSON.stringify({ type: "task.add", task: { id: "a" } })); // no title/status
    ws.send(JSON.stringify({ type: "task.add", task: { id: "b", title: "B" } })); // no status
    ws.send(JSON.stringify({ type: "task.add", task: { id: "c", title: "C", status: "bogus" } })); // bad status
    ws.send(JSON.stringify({ type: "task.add", task: { id: 42, title: "D", status: "todo" } })); // bad id type
    // Good — should land.
    ws.send(JSON.stringify({ type: "task.add", task: { id: "ok", title: "OK", status: "todo" } }));
    ws.send(JSON.stringify({ type: "close" })); // dismiss to end the session
    const msgs = await msgsP;
    await proc.exited;

    const adds = msgs.filter((m) => m.type === "task.add");
    expect(adds).toHaveLength(1);
    expect(adds[0].task.id).toBe("ok");
  }, 15000);
});

// ── Daemon HTTP surface (house pattern: /cmd + /state + /events) ──────────
//
// These exercise the agent-facing HTTP surface directly against a spawned
// server (fetch, not WebSocket). The WS path (browsers + join.ts) is unchanged
// and covered by the broadcast/validation suites above.

describe("GET /state", () => {
  test("returns { state, cursor } for a fresh board", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5", "--title", "state-test"]);
    const res = await fetch(`${ready.url}/state`);
    const body = (await res.json()) as { state?: BoardState; cursor?: number };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(200);
    expect(body.state).toBeDefined();
    expect(body.state?.title).toBe("state-test");
    expect(body.state?.tasks).toEqual([]);
    expect(typeof body.cursor).toBe("number");
  }, 15000);
});

describe("POST /cmd", () => {
  async function postCmd(url: string, body: unknown) {
    return fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("task.add is applied and reflected in /state (the #8 ack)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const res = await postCmd(ready.url, {
      type: "task.add",
      task: { id: "t1", title: "first task", status: "todo" },
    });
    const ack = (await res.json()) as { ok?: boolean };
    const stateRes = await fetch(`${ready.url}/state`);
    const body = (await stateRes.json()) as { state: BoardState; cursor: number };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(200);
    expect(ack.ok).toBe(true);
    expect(body.state.tasks).toHaveLength(1);
    expect(body.state.tasks[0]).toMatchObject({ id: "t1", title: "first task", status: "todo" });
  }, 15000);

  test("task.update patches an existing task", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "task.add",
      task: { id: "t1", title: "first", status: "todo" },
    });
    await postCmd(ready.url, { type: "task.update", id: "t1", patch: { status: "doing" } });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks[0].status).toBe("doing");
    expect(body.state.tasks[0].title).toBe("first");
  }, 15000);

  test("malformed JSON returns 400 { error }", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const res = await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await res.json()) as { error?: string };
    proc.kill();
    await proc.exited;

    expect(res.status).toBe(400);
    expect(body.error).toBeDefined();
  }, 15000);

  // The daemon is the canonical-state trust boundary: the agent /cmd path must
  // narrow task shapes as strictly as the browser WS path does, not just dedupe
  // ids / filter by status. (Review finding #1.)
  test("init filters malformed tasks (missing id/title), not just bad status", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "init",
      title: "guarded",
      tasks: [
        { id: "good", title: "Good", status: "todo" },
        { status: "todo" }, // no id/title — must be filtered
        { id: "x", status: "todo" }, // no title — must be filtered
        { id: "y", title: "bad status", status: "bogus" }, // invalid status — filtered
      ],
    });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(1);
    expect(body.state.tasks[0].id).toBe("good");
  }, 15000);

  test("task.add rejects a malformed task — nothing stored", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, { type: "task.add", task: {} });
    await postCmd(ready.url, { type: "task.add", task: { id: "n", status: "todo" } }); // no title
    await postCmd(ready.url, { type: "task.add", task: { id: "m", title: "T", status: "bogus" } });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(0);
  }, 15000);

  test("task.add accepts a well-formed task (with optional notes)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await postCmd(ready.url, {
      type: "task.add",
      task: { id: "ok", title: "fine", status: "doing", notes: "a note" },
    });
    const body = (await (await fetch(`${ready.url}/state`)).json()) as { state: BoardState };
    proc.kill();
    await proc.exited;

    expect(body.state.tasks).toHaveLength(1);
    expect(body.state.tasks[0]).toMatchObject({
      id: "ok",
      title: "fine",
      status: "doing",
      notes: "a note",
    });
  }, 15000);
});

describe("GET /events (SSE)", () => {
  // Read SSE `data:` frames from a /events stream until `predicate` matches or
  // `maxMs` elapses. Returns the decoded JSON frames seen (in order).
  async function collectEvents(
    url: string,
    since: number,
    predicate: (ev: Record<string, unknown>) => boolean,
    maxMs: number,
  ): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${url}/events?since=${since}`);
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: Record<string, unknown>[] = [];
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            seen.push(ev);
            if (predicate(ev)) {
              reader.cancel();
              return seen;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    reader.cancel();
    return seen;
  }

  test("a browser task.toggle emits a frame with monotonic id + taskId (no id collision)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Seed a task via /cmd so there's something to toggle.
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "t1", title: "T", status: "todo" } }),
    });

    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));

    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.toggle", 4000);
    // tiny delay so the SSE stream is subscribed before we mutate
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "task.toggle", id: "t1", status: "doing" }));

    const events = await evP;
    ws.close();
    proc.kill();
    await proc.exited;

    const toggle = events.find((e) => e.type === "task.toggle");
    expect(toggle).toBeDefined();
    // The envelope id is the monotonic event cursor — NOT the task id.
    expect(typeof toggle?.id).toBe("number");
    // The task identifier is carried as `taskId` (item-2 rename) so the spread
    // can't clobber the cursor.
    expect(toggle?.taskId).toBe("t1");
    expect(toggle?.status).toBe("doing");
    // Browser-origin frames are stamped by:"user".
    expect(toggle?.by).toBe("user");
  }, 15000);

  test("an agent /cmd write emits a frame stamped by:agent (Model B)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.add", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "a1", title: "A", status: "todo" } }),
    });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const add = events.find((e) => e.type === "task.add");
    expect(add).toBeDefined();
    // Model B: agent /cmd writes reach the event log so scoped tails (Phase C)
    // can wake on agent-to-agent coordination.
    expect(add?.by).toBe("agent");
    expect((add?.task as Task).id).toBe("a1");
    expect(typeof add?.id).toBe("number");
  }, 15000);

  test("replays only events with id > since (resume cursor)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Two writes before any tail connects.
    for (const id of ["c1", "c2"]) {
      await fetch(`${ready.url}/cmd`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "task.add", task: { id, title: id, status: "todo" } }),
      });
    }
    // Cursor after both writes.
    const { cursor } = (await (await fetch(`${ready.url}/state`)).json()) as { cursor: number };
    // A third write after we capture the cursor.
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "task.add", task: { id: "c3", title: "c3", status: "todo" } }),
    });
    // Connecting with since=cursor must replay only c3, not c1/c2.
    const events = await collectEvents(
      ready.url,
      cursor,
      (ev) => ev.type === "task.add" && (ev.task as Task)?.id === "c3",
      4000,
    );
    proc.kill();
    await proc.exited;

    const addIds = events.filter((e) => e.type === "task.add").map((e) => (e.task as Task).id);
    expect(addIds).toContain("c3");
    expect(addIds).not.toContain("c1");
    expect(addIds).not.toContain("c2");
  }, 15000);

  // Phase C: the `by` stamp carries the caller's --as identity (set up in A),
  // and task.* frames carry the affected task's owner so cli.ts tail can scope
  // client-side. by is a cooperative attribution, never a security boundary.
  test("/cmd stamps `by` from the caller's `as` and carries owner on the frame", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.add", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "task.add",
        as: "lead",
        task: { id: "o1", title: "owned", status: "todo", owner: "worker1" },
      }),
    });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const add = events.find((e) => e.type === "task.add");
    expect(add?.by).toBe("lead"); // actor identity, not the hardcoded "agent"
    expect(add?.owner).toBe("worker1"); // affected task's owner, on the frame
  }, 15000);

  test("a browser mutation carries the task's owner on the frame too", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await fetch(`${ready.url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "task.add",
        task: { id: "t1", title: "T", status: "todo", owner: "worker2" },
      }),
    });
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const evP = collectEvents(ready.url, 0, (ev) => ev.type === "task.toggle", 4000);
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: "task.toggle", id: "t1", status: "doing" }));
    const events = await evP;
    ws.close();
    proc.kill();
    await proc.exited;

    const toggle = events.find((e) => e.type === "task.toggle");
    expect(toggle?.by).toBe("user");
    expect(toggle?.owner).toBe("worker2"); // owner stamped so an owner-scoped tail wakes
  }, 15000);
});

describe("ownership claim guard (Phase C)", () => {
  async function cmd(url: string, body: unknown) {
    const res = await fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  async function state(url: string) {
    return (await (await fetch(`${url}/state`)).json()) as { state: BoardState };
  }

  test("a cooperative claim on an other-owned task is rejected + reported (apply-result)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, {
      type: "task.add",
      task: { id: "x", title: "X", status: "todo", owner: "alice" },
    });
    // bob tries to claim alice's task
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "bob",
      claim: true,
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    // /cmd reports the apply result so cli.ts can surface a rejection (#2 slice).
    expect(res.data.applied).toBe(false);
    expect(String(res.data.error)).toContain("alice");
    // State is unchanged — no silent steal.
    expect(s.state.tasks[0].owner).toBe("alice");
  }, 15000);

  test("claiming an unowned task succeeds", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, { type: "task.add", task: { id: "x", title: "X", status: "todo" } });
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "bob",
      claim: true,
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    expect(res.data.applied).toBe(true);
    expect(s.state.tasks[0].owner).toBe("bob");
  }, 15000);

  test("lead update --owner always wins (no claim flag) — reassignment", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await cmd(ready.url, {
      type: "task.add",
      task: { id: "x", title: "X", status: "todo", owner: "alice" },
    });
    // lead reassigns to bob — no claim flag, always applies
    const res = await cmd(ready.url, {
      type: "task.update",
      id: "x",
      patch: { owner: "bob" },
      as: "lead",
    });
    const s = await state(ready.url);
    proc.kill();
    await proc.exited;

    expect(res.data.applied).toBe(true);
    expect(s.state.tasks[0].owner).toBe("bob");
  }, 15000);
});

// ── cli.ts ↔ daemon parity (Phase A gate) ────────────────────────────────
//
// These drive the real cli.ts as a subprocess against a daemon it spawns —
// the agent-facing path that replaces bg.ts. Proving these green is the gate
// that lets bg.ts / watch-events.sh / the stdin reader be retired. Each test
// targets its daemon by explicit --session <id> (never the shared "latest"
// pointer) so concurrent/stale discovery files can't cross-wire the assertions.

const CLI = join(SCRIPT_DIR, "cli.ts");

// A fresh per-test BOUNTY_HOME so snapshot/discovery state never leaks between
// tests (Phase B writes snapshots here; Phase A keeps tests isolated up front).
function uniqHome(): string {
  return join(tmpdir(), `bounty-test-${crypto.randomUUID().slice(0, 8)}`);
}

type CliResult = { stdout: string; stderr: string; code: number };

async function runCli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, ...args],
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code } as CliResult;
}

describe("cli.ts ↔ daemon parity", () => {
  test("state read-back reflects an add then an update (the #8 ack)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "first task", "--id", "t1", "--session", session], { env });
      const s1 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
        cursor: number;
      };
      expect(s1.state.tasks).toHaveLength(1);
      expect(s1.state.tasks[0]).toMatchObject({ id: "t1", title: "first task", status: "todo" });
      expect(typeof s1.cursor).toBe("number");

      await runCli(["update", "t1", "--status", "doing", "--session", session], { env });
      const s2 = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      expect(s2.state.tasks[0].status).toBe("doing");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("add --stdin lands arbitrary text verbatim (the #7 quoting guard)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const nasty = `it's a "quoted" & <ok> $title \`x\``;
    try {
      await runCli(["add", "--stdin", "--id", "t1", "--session", session], { env, stdin: nasty });
      const s = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      // Character-for-character — no shell truncation, no escaping artifacts.
      expect(s.state.tasks[0].title).toBe(nasty);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("tail streams JSONL events and exits 0 on the closed frame", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Start a tail subprocess capturing stdout (the Monitor-wrapped path).
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    await new Promise((r) => setTimeout(r, 300)); // let the tail subscribe
    await runCli(["add", "tailed task", "--id", "tt", "--session", session], { env });
    await new Promise((r) => setTimeout(r, 300));
    await runCli(["close", "--session", session], { env });

    const out = await new Response(tail.stdout).text();
    const code = await tail.exited;

    const lines = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const add = lines.find((e) => e.type === "task.add");
    expect(add).toBeDefined();
    expect((add?.task as Task).id).toBe("tt");
    // Frames are monotonic on `id`; the closed frame ends the stream, exit 0.
    expect(lines.some((e) => e.type === "closed")).toBe(true);
    expect(code).toBe(0);
  }, 20000);

  test("tail --since <cursor> resumes: only newer events replay", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "early", "--id", "e1", "--session", session], { env });
      const { cursor } = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as { cursor: number };
      await runCli(["add", "late", "--id", "l1", "--session", session], { env });

      // A tail resuming from `cursor` must replay only the post-cursor add.
      const tail = Bun.spawn({
        cmd: ["bun", "run", CLI, "tail", "--since", String(cursor), "--session", session],
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...env },
      });
      await new Promise((r) => setTimeout(r, 500));
      tail.kill();
      const out = await new Response(tail.stdout).text();

      const addIds = out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((e) => e.type === "task.add")
        .map((e) => (e.task as Task).id);
      expect(addIds).toContain("l1");
      expect(addIds).not.toContain("e1");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 20000);

  test("agent activity keeps the daemon alive past the idle window (#6 idle-touch)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "1"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // Touch via /state every ~400ms for ~2s — well past the 1s idle window.
    for (let i = 0; i < 5; i++) {
      const r = await runCli(["state", "--session", session], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('"cursor"');
      await new Promise((res) => setTimeout(res, 400));
    }
    // Now go quiet — after genuine inactivity the daemon should exit 124 and
    // the session discovery file/port become unreachable.
    await new Promise((res) => setTimeout(res, 2000));
    const dead = await runCli(["state", "--session", session], { env });
    expect(dead.code).toBe(2); // cli.ts `die`s when the daemon is gone
  }, 25000);
});

// ── Ownership + scoping (Phase C) ────────────────────────────────────────
//
// The multi-agent value: a worker tailing its scope is woken by its own +
// claimable tasks, never the whole board; its own writes are suppressed; and a
// cooperative claim can't steal an already-owned task.

describe("ownership scoping (Phase C E2E)", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Run a scoped tail, mutate the board, return the JSONL frames the tail saw.
  async function tailFrames(
    session: string,
    env: Record<string, string>,
    scopeArgs: string[],
    mutate: () => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    const tail = Bun.spawn({
      cmd: ["bun", "run", CLI, "tail", "--since", "0", "--session", session, ...scopeArgs],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    await wait(400); // subscribe
    await mutate();
    await wait(400); // let frames arrive
    tail.kill();
    const out = await new Response(tail.stdout).text();
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  test("--owner scopes to owned, filters others, suppresses self-echo", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "Y", "--id", "Y", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(
      session,
      env,
      ["--owner", "worker1", "--as", "worker1"],
      async () => {
        // a third actor (lead) mutates worker1's X → should reach worker1's tail
        await runCli(["update", "X", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // lead mutates worker2's Y → filtered out (not worker1's)
        await runCli(["update", "Y", "--status", "doing", "--as", "lead", "--session", session], {
          env,
        });
        // worker1 mutates its OWN X → self-echo, suppressed from worker1's tail
        await runCli(["update", "X", "--notes", "mine", "--as", "worker1", "--session", session], {
          env,
        });
      },
    );
    await runCli(["close", "--session", session], { env });

    // Woken by the lead's mutation of an owned task.
    expect(frames.some((f) => f.taskId === "X" && f.by === "lead")).toBe(true);
    // Never woken by another owner's task.
    expect(frames.some((f) => f.taskId === "Y")).toBe(false);
    // Own writes suppressed.
    expect(frames.some((f) => f.by === "worker1")).toBe(false);
  }, 30000);

  test("--mine wakes on own + claimable (unowned), not another owner's", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "15"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "M", "--id", "M", "--owner", "worker1", "--session", session], { env });
    await runCli(["add", "U", "--id", "U", "--session", session], { env }); // unowned/claimable
    await runCli(["add", "Z", "--id", "Z", "--owner", "worker2", "--session", session], { env });

    const frames = await tailFrames(session, env, ["--mine", "--as", "worker1"], async () => {
      await runCli(["update", "M", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "U", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
      await runCli(["update", "Z", "--status", "doing", "--as", "lead", "--session", session], {
        env,
      });
    });
    await runCli(["close", "--session", session], { env });

    expect(frames.some((f) => f.taskId === "M" && f.type === "task.update")).toBe(true); // mine
    expect(frames.some((f) => f.taskId === "U" && f.type === "task.update")).toBe(true); // claimable
    expect(frames.some((f) => f.taskId === "Z" && f.type === "task.update")).toBe(false); // another's
  }, 30000);

  test("claim: rejected (visible, nonzero) on other-owned; succeeds on unowned", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "O", "--id", "O", "--owner", "alice", "--session", session], { env });
    await runCli(["add", "F", "--id", "F", "--session", session], { env });
    try {
      const rejected = await runCli(["claim", "O", "--as", "bob", "--session", session], { env });
      expect(rejected.code).toBe(1); // visible nonzero — not a silent {ok:true}
      expect(rejected.stderr).toContain("alice");

      const ok = await runCli(["claim", "F", "--as", "bob", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { owner?: string }).owner).toBe("bob");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);
});

// ── Dependencies (Phase D) — blockedBy, cycle guard, unblocked ───────────

describe("dependencies (Phase D)", () => {
  async function cmd(url: string, body: unknown) {
    const res = await fetch(`${url}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }
  async function state(url: string) {
    return (await (await fetch(`${url}/state`)).json()) as { state: BoardState };
  }
  const find = (s: { state: BoardState }, id: string) => s.state.tasks.find((t) => t.id === id);

  // Read SSE frames until predicate or timeout (local to this describe).
  async function collect(
    url: string,
    since: number,
    pred: (ev: Record<string, unknown>) => boolean,
    maxMs: number,
  ): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${url}/events?since=${since}`);
    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const seen: Record<string, unknown>[] = [];
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            seen.push(ev);
            if (pred(ev)) {
              reader.cancel();
              return seen;
            }
          } catch {
            /* skip */
          }
        }
      }
    }
    reader.cancel();
    return seen;
  }

  async function seedTasks(url: string, tasks: Record<string, unknown>[]) {
    for (const task of tasks) await cmd(url, { type: "task.add", task });
  }

  test("block adds edges; unblock removes them", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    await cmd(ready.url, { type: "task.block", id: "X", on: ["B1", "B2"] });
    let s = await state(ready.url);
    expect(find(s, "X")?.blockedBy?.sort()).toEqual(["B1", "B2"]);
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    s = await state(ready.url);
    expect(find(s, "X")?.blockedBy).toEqual(["B2"]);
    proc.kill();
    await proc.exited;
  }, 15000);

  test("cycle guard rejects self-ref / 2-node / 3-node, state unmutated", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "A", title: "A", status: "todo" },
      { id: "B", title: "B", status: "todo" },
      { id: "C", title: "C", status: "todo" },
    ]);
    // self-ref
    const selfRes = await cmd(ready.url, { type: "task.block", id: "A", on: ["A"] });
    expect(selfRes.data.applied).toBe(false);
    expect(String(selfRes.data.error).toLowerCase()).toContain("cycle");
    expect(find(await state(ready.url), "A")?.blockedBy).toBeUndefined();
    // 2-node: A on B (ok), then B on A (cycle)
    await cmd(ready.url, { type: "task.block", id: "A", on: ["B"] });
    const twoRes = await cmd(ready.url, { type: "task.block", id: "B", on: ["A"] });
    expect(twoRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "B")?.blockedBy).toBeUndefined();
    // 3-node: B on C (ok), then C on A (A→B→C→A cycle)
    await cmd(ready.url, { type: "task.block", id: "B", on: ["C"] });
    const threeRes = await cmd(ready.url, { type: "task.block", id: "C", on: ["A"] });
    expect(threeRes.data.applied).toBe(false);
    expect(find(await state(ready.url), "C")?.blockedBy).toBeUndefined();
    proc.kill();
    await proc.exited;
  }, 15000);

  test("blockedBy can't be set via a raw task.update (bypass closed)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo" },
      { id: "Y", title: "Y", status: "todo" },
    ]);
    await cmd(ready.url, {
      type: "task.update",
      id: "X",
      patch: { status: "doing", blockedBy: ["Y"] },
    });
    const x = find(await state(ready.url), "X");
    proc.kill();
    await proc.exited;
    expect(x?.status).toBe("doing"); // the rest of the patch still applies
    expect(x?.blockedBy).toBeUndefined(); // blockedBy stripped — guard stays load-bearing
  }, 15000);

  test("unblocked fires once when the LAST blocker reaches done, targets the owner", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "worker1", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "todo" },
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B2", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;

    const unblocked = events.filter((e) => e.type === "unblocked");
    expect(unblocked).toHaveLength(1); // not on B1, only when B2 (the last) clears; fired once
    expect(unblocked[0].taskId).toBe("X");
    expect(unblocked[0].owner).toBe("worker1"); // targeted via owner-on-frame
  }, 15000);

  test("removing the last remaining blocker edge also unblocks", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", owner: "w", blockedBy: ["B1", "B2"] },
      { id: "B1", title: "B1", status: "todo" },
      { id: "B2", title: "B2", status: "done" }, // already done
    ]);
    const evP = collect(ready.url, 0, (ev) => ev.type === "unblocked", 4000);
    await new Promise((r) => setTimeout(r, 150));
    // B2 already done; dropping the B1 edge leaves no live blocker → unblocked
    await cmd(ready.url, { type: "task.unblock", id: "X", on: ["B1"] });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.filter((e) => e.type === "unblocked" && e.taskId === "X")).toHaveLength(1);
  }, 15000);

  test("no unblocked for an already-done task", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "done", blockedBy: ["B1"] }, // X itself done
      { id: "B1", title: "B1", status: "todo" },
    ]);
    const evP = collect(
      ready.url,
      0,
      (ev) => ev.type === "task.update" && ev.taskId === "B1",
      3000,
    );
    await new Promise((r) => setTimeout(r, 150));
    await cmd(ready.url, { type: "task.update", id: "B1", patch: { status: "done" } });
    const events = await evP;
    proc.kill();
    await proc.exited;
    expect(events.some((e) => e.type === "unblocked")).toBe(false);
  }, 15000);

  test("/state derives `blocked` + `liveBlockers` (computed readback parity)", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    await seedTasks(ready.url, [
      { id: "X", title: "X", status: "todo", blockedBy: ["B1", "B2", "gone"] },
      { id: "B1", title: "Build engine", status: "review" },
      { id: "B2", title: "B2", status: "done" }, // done → not a live blocker
    ]);
    // 'gone' refers to no task → not live. B2 is done → not live. Only B1 lives.
    const raw = await (await fetch(`${ready.url}/state`)).json();
    const s = raw as { state: { tasks: Record<string, unknown>[] } };
    proc.kill();
    await proc.exited;

    const x = s.state.tasks.find((t) => t.id === "X");
    expect(x?.blocked).toBe(true);
    expect(x?.liveBlockers).toEqual([{ id: "B1", title: "Build engine", status: "review" }]);
    const b1 = s.state.tasks.find((t) => t.id === "B1");
    expect(b1?.blocked).toBe(false);
    expect(b1?.liveBlockers).toEqual([]);
  }, 15000);

  test("state --mine/--owner scopes the readback; a blocked task stays actionable", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "my task", "--id", "mine", "--owner", "w1", "--session", session], {
      env,
    });
    await runCli(["add", "other", "--id", "other", "--owner", "w2", "--session", session], { env });
    await runCli(["add", "free", "--id", "free", "--session", session], { env }); // unowned/claimable
    // 'mine' (w1's) is blocked on 'other' (w2's) — which is filtered out of w1's view
    await runCli(["block", "mine", "--on", "other", "--session", session], { env });
    type ST = { state: { tasks: Record<string, unknown>[] } };
    try {
      const sMine = JSON.parse(
        (await runCli(["state", "--mine", "--as", "w1", "--session", session], { env })).stdout,
      ) as ST;
      expect(sMine.state.tasks.map((t) => t.id).sort()).toEqual(["free", "mine"]); // own + claimable
      const mine = sMine.state.tasks.find((t) => t.id === "mine");
      expect(mine?.blocked).toBe(true);
      // liveBlockers survives the filter — actionable even though 'other' is hidden
      expect(mine?.liveBlockers).toEqual([{ id: "other", title: "other", status: "todo" }]);

      const sOwner = JSON.parse(
        (await runCli(["state", "--owner", "w2", "--session", session], { env })).stdout,
      ) as ST;
      expect(sOwner.state.tasks.map((t) => t.id)).toEqual(["other"]); // exactly w2's
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);

  test("cli block/unblock works; a cycle is rejected visibly (exit 1)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "X", "--id", "X", "--session", session], { env });
    await runCli(["add", "B", "--id", "B", "--session", session], { env });
    try {
      const ok = await runCli(["block", "X", "--on", "B", "--session", session], { env });
      expect(ok.code).toBe(0);
      expect((JSON.parse(ok.stdout) as { blocked?: string }).blocked).toBe("X");

      const cyc = await runCli(["block", "B", "--on", "X", "--session", session], { env });
      expect(cyc.code).toBe(1); // visible nonzero, like a rejected claim
      expect(cyc.stderr.toLowerCase()).toContain("cycle");

      const un = await runCli(["unblock", "X", "--on", "B", "--session", session], { env });
      expect(un.code).toBe(0);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 25000);
});

// ── Durability (Phase B) — snapshot + restore ────────────────────────────

describe("durability (Phase B)", () => {
  function snapshotPath(home: string, sessionId: string): string {
    return join(home, "snapshots", `${sessionId}.json`);
  }

  test("snapshots board state to $BOUNTY_HOME on close", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "persisted task", "--id", "p1", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const snapFile = snapshotPath(home, session);
    expect(existsSync(snapFile)).toBe(true);
    const snap = JSON.parse(readFileSync(snapFile, "utf8")) as BoardState;
    expect(snap.tasks.find((t) => t.id === "p1")).toBeDefined();
  }, 20000);

  test("open --restore <id> brings the seeded board back", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open1 = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open1.stdout) as { session_id: string }).session_id;
    await runCli(["add", "design", "--id", "a", "--status", "doing", "--session", session], {
      env,
    });
    await runCli(["add", "build", "--id", "b", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const open2 = await runCli(["open", "--no-open", "--timeout", "10", "--restore", session], {
      env,
    });
    const restored = (JSON.parse(open2.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.tasks.map((t) => t.id).sort()).toEqual(["a", "b"]);
      expect(s.state.tasks.find((t) => t.id === "a")?.status).toBe("doing");
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 25000);

  test("restores a legacy snapshot missing newer fields (merge-over-defaults)", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    // Hand-write a minimal snapshot — just { title, tasks }, no future optional
    // fields, with one invalid-status task that must be filtered on restore
    // (filter-and-keep-valid: the good task survives, the snapshot isn't rejected).
    const legacyId = "legacy-001";
    mkdirSync(join(home, "snapshots"), { recursive: true });
    writeFileSync(
      snapshotPath(home, legacyId),
      JSON.stringify({
        title: "Legacy Board",
        tasks: [
          { id: "ok", title: "valid", status: "todo" },
          { id: "bad", title: "filtered", status: "bogus" },
        ],
      }),
    );
    const open = await runCli(["open", "--no-open", "--timeout", "10", "--restore", legacyId], {
      env,
    });
    const restored = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const s = JSON.parse((await runCli(["state", "--session", restored], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.title).toBe("Legacy Board");
      expect(s.state.tasks.find((t) => t.id === "ok")).toBeDefined();
      expect(s.state.tasks.find((t) => t.id === "bad")).toBeUndefined();
    } finally {
      await runCli(["close", "--session", restored], { env });
    }
  }, 20000);

  test("sessions lists a saved snapshot", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "x", "--id", "x", "--session", session], { env });
    await runCli(["close", "--session", session], { env });

    const sessions = await runCli(["sessions"], { env });
    expect(sessions.stdout).toContain(session);
  }, 20000);
});

describe("join.ts", () => {
  test("discovers via bounty-latest.json when no --url/--id given", async () => {
    // Spawn a host first so bounty-latest.json is real.
    const { proc: hostProc, ready } = await spawnServerReady(["--timeout", "5"]);
    // Give the host time to write the discovery file (it writes synchronously
    // shortly after ready, but the file might race a fast joiner).
    await new Promise((r) => setTimeout(r, 100));

    const joiner = Bun.spawn({
      cmd: ["bun", "run", JOIN, "--timeout", "5"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const seen = await collectStdout(joiner, (m) => m.type === "joined", 5000);
    const joined = seen.find((m) => m.type === "joined");
    expect(joined).toBeDefined();
    expect(joined.session_id).toBe(ready.session_id);

    // Cleanup
    joiner.kill();
    hostProc.kill();
    await hostProc.exited;
    await joiner.exited;
  }, 15000);

  test("idle timeout reports reason 'timeout' (not 'server_closed')", async () => {
    const { proc: hostProc, ready } = await spawnServerReady(["--timeout", "10"]);
    // Joiner with very short timeout so it expires before host does.
    const joiner = Bun.spawn({
      cmd: ["bun", "run", JOIN, "--url", ready.url, "--timeout", "0.5"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const seen = await collectStdout(joiner, (m) => m.type === "disconnected", 5000);
    const disc = seen.find((m) => m.type === "disconnected");
    expect(disc).toBeDefined();
    expect(disc.reason).toBe("timeout");

    hostProc.kill();
    await hostProc.exited;
    await joiner.exited;
  }, 15000);
});

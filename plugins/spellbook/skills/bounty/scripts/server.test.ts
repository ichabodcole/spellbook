// Tests for bounty server.ts, bg.ts, and join.ts.
//
// Coverage:
//   - Pure state-mutation helpers (applyTaskAdd/Update/Remove/Move).
//   - parsePortFromSessionId (the relaunch-port-reuse contract).
//   - htmlEscape (the 5 interesting chars + ampersand-first ordering).
//   - End-to-end via subprocess for the bits that need a real server:
//       * submit broadcasts to all WS clients (browsers + joiners)
//       * cancel broadcasts a structured event to all WS clients
//       * task.edit rejects non-string titles silently
//       * task.add from browser rejects malformed task objects
//       * bg.ts emits a meta JSON line and creates the events/cmds files
//       * bg.ts forwards a commands-file append to the underlying server
//       * join.ts discovers via bounty-latest.json when --url/--id omitted
//       * join.ts idle timeout reports reason: "timeout"

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
  events_file?: string;
  cmds_file?: string;
};
const SERVER = join(SCRIPT_DIR, "server.ts");
const BG = join(SCRIPT_DIR, "bg.ts");
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

async function spawnServerReady(
  args: string[] = [],
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ready: ReadyInfo }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as WireMsg;
      if (m.type === "ready") {
        reader.releaseLock();
        return { proc, ready: m as unknown as ReadyInfo };
      }
    }
    if (done) break;
  }
  reader.releaseLock();
  throw new Error("server did not emit ready");
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

describe("submit broadcast", () => {
  test("submit reaches both host stdio and connected WS clients", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const enc = new TextEncoder();
    proc.stdin.write(
      enc.encode(
        `${JSON.stringify({
          type: "init",
          title: "submit-test",
          tasks: [{ id: "x", title: "X", status: "todo" }],
        })}\n`,
      ),
    );
    await new Promise((r) => setTimeout(r, 100));

    const browser = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => browser.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(browser);

    browser.send(JSON.stringify({ type: "submit" }));
    const browserMsgs = await msgsP;
    await proc.exited;

    const submitMsg = browserMsgs.find((m) => m.type === "submit");
    expect(submitMsg).toBeDefined();
    expect(submitMsg.tasks?.[0]?.id).toBe("x");
  }, 15000);
});

describe("cancel broadcast", () => {
  test("cancel reaches connected WS clients before disconnect", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const ws = new WebSocket(`${ready.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const msgsP = collectWsUntilClose(ws);

    ws.send(JSON.stringify({ type: "cancel" }));
    const msgs = await msgsP;
    const code = await proc.exited;

    expect(code).toBe(130);
    expect(msgs.find((m) => m.type === "cancel")).toBeDefined();
  }, 15000);
});

describe("input validation from browser", () => {
  test("task.edit with non-string title is rejected silently", async () => {
    const { proc, ready } = await spawnServerReady(["--timeout", "5"]);
    const enc = new TextEncoder();
    proc.stdin.write(
      enc.encode(
        `${JSON.stringify({
          type: "init",
          title: "T",
          tasks: [{ id: "x", title: "original", status: "todo" }],
        })}\n`,
      ),
    );
    await new Promise((r) => setTimeout(r, 100));

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
    ws.send(JSON.stringify({ type: "submit" }));
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
    ws.send(JSON.stringify({ type: "submit" }));
    const msgs = await msgsP;
    await proc.exited;

    const adds = msgs.filter((m) => m.type === "task.add");
    expect(adds).toHaveLength(1);
    expect(adds[0].task.id).toBe("ok");
  }, 15000);
});

describe("bg.ts wrapper", () => {
  test("emits meta JSON line + creates events/cmds files", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", BG, "--no-open", "--port", "0", "--timeout", "5"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const seen = await collectStdout(proc, (m) => m.type === "meta", 5000);
    const meta = seen.find((m) => m.type === "meta");
    expect(meta).toBeDefined();
    expect(typeof meta.url).toBe("string");
    expect(typeof meta.events_file).toBe("string");
    expect(typeof meta.cmds_file).toBe("string");
    expect(existsSync(meta.events_file)).toBe(true);
    expect(existsSync(meta.cmds_file)).toBe(true);

    // Let the idle timeout fire to clean up.
    await proc.exited;
  }, 15000);

  test("forwards appended cmds-file lines to the underlying server", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", BG, "--no-open", "--port", "0", "--timeout", "5"],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const seen = await collectStdout(proc, (m) => m.type === "meta", 5000);
    const meta = seen.find((m) => m.type === "meta");

    // Append an init via cmds_file — server should process it and we should
    // see the matching events show up in events_file.
    appendFileSync(
      meta.cmds_file,
      `${JSON.stringify({
        type: "init",
        title: "via cmds-file",
        tasks: [{ id: "z", title: "Z", status: "todo" }],
      })}\n`,
    );
    // Give the polling pump time to forward.
    await new Promise((r) => setTimeout(r, 500));

    // Connect a browser, submit, verify the seeded task lands in the submit
    // event we see via events_file.
    const ws = new WebSocket(`${meta.url.replace(/^http/, "ws")}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(JSON.stringify({ type: "submit" }));
    await proc.exited;

    const events = readFileSync(meta.events_file, "utf-8");
    const submitLine = events.split("\n").find((l) => l.startsWith('{"type":"submit"'));
    expect(submitLine).toBeDefined();
    if (submitLine === undefined) throw new Error("submit line not found in events file");
    const parsed = JSON.parse(submitLine) as WireMsg;
    expect(parsed.tasks?.find((t) => t.id === "z")).toBeDefined();
  }, 15000);
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

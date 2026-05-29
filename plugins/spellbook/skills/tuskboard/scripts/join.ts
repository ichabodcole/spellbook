#!/usr/bin/env bun

// tuskboard join — connect a second agent to a running tuskboard session.
//
// This is the symmetric counterpart to server.ts. Where server.ts is the
// host (spawns the HTTP/WS server, has stdio authority to push init/patch/
// message), join.ts is a participant — it opens a WebSocket to an existing
// session and bridges incoming events to stdout, outgoing commands from
// stdin. The joining agent talks to it via JSON-lines just like the host
// agent talks to server.ts; the mental model is identical, the side is
// flipped.
//
// Protocol — agent → join.ts (one JSON object per line on stdin):
//   {"type":"task.add",    "task": Task}              // browser-equivalent
//   {"type":"task.update", "id": "...", "patch": {...}} // status|title|notes
//   {"type":"task.move",   "id": "...", "status": "...", "index": N}
//   {"type":"task.remove", "id": "..."}
//   {"type":"close"}                                  // disconnect cleanly
//
// Note: "init", "patch" of arbitrary state, and "message" toasts are
// HOST-ONLY (server.ts via its spawning agent). Joining agents can only
// do what a browser can do. The server enforces this — it ignores any
// host-only message arriving via WS.
//
// Protocol — join.ts → agent (one JSON object per line on stdout):
//   {"type":"joined",       "url":"...", "session_id":"...", "title":"...",
//                           "tasks": Task[]}     // initial state from server
//   {"type":"event",        "payload": {...}}    // any incoming WS message
//                                                // (init|patch|message|task.*)
//   {"type":"disconnected", "reason":"server_closed|stdin_close|timeout|error"}
//
// Discovery: with no --url and no --id, reads <tmpdir>/tuskboard-latest.json
// (written by server.ts on startup). Use --id to look up a specific session
// (matches <tmpdir>/tuskboard-<id>.json), or --url to connect directly.
//
// Exit codes:
//   0   clean disconnect (server closed or agent sent close)
//   2   bad args, unresolvable discovery file, or connection refused

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Task } from "./server.ts";

type SessionInfo = { url: string; port: number; session_id: string; title: string };

type DisconnectReason = "server_closed" | "stdin_close" | "timeout" | "error";
type DoneResult = { code: number; reason: DisconnectReason };

// Agent → join.ts commands (mirror the browser-equivalent subset of the WS
// protocol that the server accepts from a joining participant).
type AgentMsg =
  | { type: "task.add"; task: Task }
  | { type: "task.update"; id: string; patch: Partial<Task> }
  | { type: "task.move"; id: string; status: string; index: number }
  | { type: "task.remove"; id: string }
  | { type: "close" };

// A WS frame from the server — `init` carries the board snapshot; everything
// else is a pass-through event. Untrusted wire data, narrowed at use.
type ServerFrame = {
  type?: string;
  title?: string;
  tasks?: Task[];
};

function emitToAgent(msg: object): void {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "EPIPE")) throw e;
  }
}

function discover(args: { url?: string; id?: string }): SessionInfo {
  if (args.url) {
    // URL provided directly — we need a session_id and title placeholder
    // for the joined event. The browser-side init message will overwrite
    // the title once we connect.
    return { url: args.url, port: 0, session_id: "(from --url)", title: "" };
  }
  const path = args.id
    ? join(tmpdir(), `tuskboard-${args.id}.json`)
    : join(tmpdir(), `tuskboard-latest.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    if (args.id) {
      throw new Error(`no session file for id '${args.id}' (looked at ${path})`);
    }
    throw new Error(
      `no tuskboard session found at ${path} — pass --url <url> or --id <session_id>, or start one with server.ts first`,
    );
  }
  try {
    return JSON.parse(raw) as SessionInfo;
  } catch {
    throw new Error(`session file ${path} is malformed`);
  }
}

async function* readJsonLines(): AsyncGenerator<AgentMsg | null> {
  if (process.stdin.isTTY) {
    yield null;
    return;
  }
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // Re-scan for the next newline each pass so the `continue` below
      // doesn't skip advancing past a consumed line.
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line) as AgentMsg;
        } catch (e) {
          process.stderr.write(
            `join: bad json on stdin: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
      if (done) {
        const final = buffer.trim();
        if (final) {
          try {
            yield JSON.parse(final) as AgentMsg;
          } catch (e) {
            process.stderr.write(
              `join: bad json on stdin (final): ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        }
        yield null;
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        id: { type: "string" },
        timeout: { type: "string", default: "1800" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;
  const timeout = parseFloat(v.timeout as string);

  let info: SessionInfo;
  try {
    info = discover({ url: v.url as string | undefined, id: v.id as string | undefined });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const wsUrl = `${info.url.replace(/^http/, "ws")}/ws`;

  // Open the WebSocket.
  const ws = new WebSocket(wsUrl);
  let resolveDone!: (val: DoneResult) => void;
  let settled = false;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = (v) => {
      if (settled) return;
      settled = true;
      res(v);
    };
  });

  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  let initialEmitted = false;
  ws.addEventListener("open", () => {
    touch();
  });
  ws.addEventListener("message", (ev) => {
    touch();
    let payload: ServerFrame;
    try {
      const data: string | ArrayBuffer | Uint8Array = ev.data;
      payload = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data),
      ) as ServerFrame;
    } catch (e) {
      process.stderr.write(
        `join: bad json from server: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return;
    }
    // The very first message from the server is `init` with the current
    // state — convert that into the joined-handshake event so the agent
    // can pick it up as a single coherent thing.
    if (!initialEmitted && payload?.type === "init") {
      initialEmitted = true;
      emitToAgent({
        type: "joined",
        url: info.url,
        session_id: info.session_id,
        title: payload.title ?? info.title,
        tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      });
      return;
    }
    emitToAgent({ type: "event", payload });
  });
  ws.addEventListener("close", () => {
    resolveDone({ code: 0, reason: "server_closed" });
  });
  ws.addEventListener("error", (e: Event) => {
    const detail =
      e && typeof e === "object" && "message" in e && typeof e.message === "string"
        ? e.message
        : "unknown";
    process.stderr.write(`join: ws error: ${detail}\n`);
    resolveDone({ code: 2, reason: "error" });
  });

  // Wait briefly for the connection to open; surface a clean error if it
  // refuses (most common cause: no host running at that URL).
  const openOk = await Promise.race([
    new Promise<boolean>((r) => ws.addEventListener("open", () => r(true), { once: true })),
    new Promise<boolean>((r) => ws.addEventListener("error", () => r(false), { once: true })),
    new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!openOk) {
    process.stderr.write(`error: could not connect to ${wsUrl} (no host running?)\n`);
    return 2;
  }

  // Stdin → WS pump.
  (async () => {
    for await (const msg of readJsonLines()) {
      if (msg === null) {
        // Stdin EOF — close cleanly.
        try {
          ws.close();
        } catch {}
        resolveDone({ code: 0, reason: "stdin_close" });
        return;
      }
      touch();
      if (msg.type === "close") {
        try {
          ws.close();
        } catch {}
        resolveDone({ code: 0, reason: "stdin_close" });
        return;
      }
      // task.add / task.update / task.move / task.remove pass through
      // verbatim — the server's WS handler accepts the same shapes.
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        process.stderr.write(`join: send failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  })();

  // Idle timeout: if neither side has spoken for `timeout` seconds,
  // exit. Less strict than the host's timeout — joiners are typically
  // long-lived listeners.
  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeout) {
      // Order matters: resolveDone BEFORE ws.close so the timeout reason
      // wins over the close handler's "server_closed" if the close event
      // fires synchronously.
      resolveDone({ code: 0, reason: "timeout" });
      try {
        ws.close();
      } catch {}
    }
  }, 1000);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  emitToAgent({ type: "disconnected", reason });
  return code;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export { discover, main };

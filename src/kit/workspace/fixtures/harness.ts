// What the daemon tests share: the surface's half played by a WebSocket client,
// the agent's tail read as parsed frames, and a polling wait.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterIo, LAST_LOOK_TURNS, lastLook, probed } from "../../lib/afterIo.ts";
import { AGENT_ONCE_PARAM, AGENT_TAIL_PARAM } from "../heartbeat";
import { type ClientOp, type PublicState, resolveAppState, type ServerOp } from "../protocol";

export type Ev = { id: number; epoch?: string; type: string; [key: string]: unknown };

export async function waitUntil<T>(
  what: string,
  probe: () => T | undefined | false | null,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const hit = probed(probe());
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) break;
    await Bun.sleep(15);
  }
  // Past the deadline: one last look after pending I/O has run, so an event that
  // arrived while the process was stalled still counts.
  const last = await lastLook(probe);
  if (last) return last;
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Make a write on disk, and make it again until the daemon has seen it.
 *
 * The daemon arms its watches (`node:fs` `watch`, FSEvents on macOS) as a
 * folder is added or a document opened, and a watch is not live the moment
 * `watch()` returns: a write made in the first few milliseconds is never
 * reported. Under a parallel run that happens to a write made straight after
 * `context.add` or `open` (measured 2026-10-09: 5 of 6 such writes lost under
 * load, none lost 50 ms later). No event says a watch is live, so a test whose
 * write may follow the arming closely writes again every `everyMs` until
 * `seen` holds. The write must be one that is harmless to repeat.
 */
export async function writeUntilSeen<T>(
  what: string,
  write: () => void,
  seen: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  { everyMs = 750, timeoutMs = 10_000 }: { everyMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  let wrote = 0;
  for (;;) {
    if (Date.now() - wrote >= everyMs) {
      write();
      wrote = Date.now();
    }
    const hit = await seen();
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) break;
    await Bun.sleep(15);
  }
  for (let i = 0; i < LAST_LOOK_TURNS; i++) {
    await afterIo();
    const hit = await seen();
    if (hit) return hit;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A stand-in for the surface: every frame it receives, and a way to wait for one. */
export class FakeSurface {
  frames: ServerOp[] = [];
  private ws!: WebSocket;

  async connect(port: number, origin?: string): Promise<void> {
    this.ws = origin
      ? new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin } } as never)
      : new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.onmessage = (ev) => this.frames.push(JSON.parse(String(ev.data)) as ServerOp);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("websocket refused"));
    });
  }

  send(msg: ClientOp | { op: string; [key: string]: unknown }): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(pred: (m: ServerOp) => boolean, timeoutMs = 5000): Promise<ServerOp> {
    return waitUntil("a surface frame", () => this.frames.find(pred), timeoutMs);
  }

  /**
   * The newest state, folded as a client folds it: a frame that marks the
   * app's view unchanged keeps the one before (`resolveAppState`).
   */
  get state(): PublicState {
    let state: PublicState | null = null;
    for (const f of this.frames) if (f.op === "state") state = resolveAppState(state, f.state);
    if (!state) throw new Error("no state frame yet");
    return state;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * A reader of `GET /events`, read into parsed frames, until stopped. `agent`
 * marks it as the agent's own tail, as the kit's `tail` verb does, so it counts
 * toward `agentListening`; without it, it is any other reader.
 */
export function collectEvents(
  base: string,
  since = -1,
  opts: { agent?: boolean; once?: boolean } = {},
) {
  const events: Ev[] = [];
  const ac = new AbortController();
  const finished = (async () => {
    try {
      const res = await fetch(
        `${base}/events?since=${since}${opts.agent ? `&${AGENT_TAIL_PARAM}=1` : ""}${
          opts.once ? `&${AGENT_ONCE_PARAM}=1` : ""
        }`,
        { signal: ac.signal },
      );
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const i = buf.indexOf("\n\n");
          if (i < 0) break;
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n"))
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)) as Ev);
        }
      }
    } catch {
      /* aborted, or the daemon closed */
    }
  })();
  return {
    events,
    of: (type: string) => events.filter((e) => e.type === type),
    waitFor: (pred: (e: Ev) => boolean, timeoutMs = 5000) =>
      waitUntil("an event", () => events.find(pred), timeoutMs),
    stop: async () => {
      ac.abort();
      await finished;
    },
  };
}

/** `POST /cmd`, returning the status and the body. */
export async function cmd(
  base: string,
  body: { op: string; [key: string]: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Whether a process is still alive. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wait until a process has exited, so no fixture daemon outlives the run. */
export async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`process ${pid} did not exit`);
    await Bun.sleep(25);
  }
}

/** The pid a session's discovery pointer names, or null when there is no pointer. */
export function pointerPid(file: string): number | null {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { pid: number }).pid;
  } catch {
    return null;
  }
}

/**
 * An empty folder to set as a test session's workspace (`workspace` in the
 * daemon's options): made inside `parent`, the test's own temp folder, beside
 * the folders it adds, so it holds none of them. Only a folder; nothing is
 * copied into it.
 */
export function testWorkspace(parent: string, name = "workspace"): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

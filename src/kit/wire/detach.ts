/**
 * Start a daemon that outlives the CLI that started it.
 *
 * This uses `node:child_process`, not `Bun.spawn`: Bun's spawn cannot fully
 * detach a child that survives its parent, so it cannot express a standing
 * daemon. The child runs in its own process group (`detached`), is `unref`'d so
 * the CLI can exit without waiting, and never inherits this process's stderr.
 * An inherited stderr pipe outlives the CLI inside the daemon, so any caller
 * reading the CLI's stderr to EOF (a test harness, a tool runner) would wait
 * for the whole session. The daemon's stderr goes to a log file instead, whose
 * tail a start failure quotes.
 *
 * The daemon announces itself by writing one JSON line to stdout once it is
 * listening (the ready line); `startDaemon` resolves with that line parsed.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * ⚠ NO SPELL IS ON IT YET. Each spell that detaches still spawns its own daemon
 * in its own code; moving one here is its own change, with that spell's tests.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type StartDaemonOptions = {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the daemon's stderr goes. Created, with its directory, if absent. */
  logFile: string;
  /** How long to wait for the ready line. Default 45 s. */
  startTimeoutMs?: number;
  /**
   * How long a daemon being killed after a failed start gets to leave on
   * SIGTERM before it is sent SIGKILL. Default 2 s.
   */
  killGraceMs?: number;
};

export type StartedDaemon<T> = {
  pid: number;
  /** The ready line, parsed. */
  ready: T;
};

/** What `startDaemon` spawns with. A test seam; callers leave it alone. */
export type StartDaemonDeps = { spawn?: typeof spawn };

/** The last few lines of a log file, for a start failure to quote. */
function tailOf(path: string, lines = 12): string {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Signal the child's process group, or the child alone when the group is gone.
 * False when neither is there to signal.
 */
function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Kill a daemon that never said ready: SIGTERM, then SIGKILL if it (or any
 * helper in its group) is still there after the grace. A daemon that ignores
 * SIGTERM must not outlive a failed start.
 */
async function killGroup(pid: number, graceMs: number): Promise<void> {
  if (!signal(pid, "SIGTERM")) return;
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    if (!signal(pid, 0)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  signal(pid, "SIGKILL");
}

/**
 * Spawn the daemon detached and wait for its ready line. Rejects when the
 * daemon cannot be spawned, exits first, does not say ready in time, prints a
 * line that is not JSON, or has no pid to report. On rejection the child is
 * left for the caller's pointer cleanup; a daemon that never said ready is
 * killed (its whole process group, SIGKILL after a grace).
 */
export async function startDaemon<T = Record<string, unknown>>(
  opts: StartDaemonOptions,
  deps: StartDaemonDeps = {},
): Promise<StartedDaemon<T>> {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const logFd = openSync(opts.logFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = (deps.spawn ?? spawn)(opts.command, [...opts.args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", logFd],
    });
  } finally {
    // The child holds its own copy; ours closes whether or not spawn threw.
    closeSync(logFd);
  }
  child.unref();

  const timeoutMs = opts.startTimeoutMs ?? 45_000;
  const graceMs = opts.killGraceMs ?? 2_000;
  return await new Promise<StartedDaemon<T>>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners("data");
      // Stop reading: the CLI must not keep the daemon's stdout pipe alive.
      child.stdout?.destroy();
      fn();
    };
    const fail = (message: string, kill: boolean) =>
      settle(() => {
        const pid = child.pid;
        // The child leads its own process group (`detached`), so the group is
        // signalled: a helper the daemon spawned must not outlive a failed start.
        const killed = kill && pid !== undefined ? killGroup(pid, graceMs) : Promise.resolve();
        void killed.then(() => {
          const log = tailOf(opts.logFile);
          reject(new Error(log ? `${message}\n${log}` : message));
        });
      });
    const timer = setTimeout(
      () => fail(`daemon start timeout (${timeoutMs / 1000}s)`, true),
      timeoutMs,
    );
    child.on("error", (e) => fail(`cannot start the daemon: ${e.message}`, false));
    child.on("exit", (code) => fail(`the daemon exited before it was ready (code ${code})`, false));
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let ready: T;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        ready = parsed as T;
      } catch {
        fail(`the daemon's first line was not a JSON object: ${line.slice(0, 200)}`, true);
        return;
      }
      const pid = child.pid;
      // A daemon with no pid cannot be stopped or found again: not a start.
      if (pid === undefined) fail("the daemon said ready but has no pid", false);
      else settle(() => resolve({ pid, ready }));
    });
  });
}

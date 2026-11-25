// Daemon discovery for the grapevine CLI: where this HOME's daemon says it is
// (the singleton `daemon.port` + `daemon.pid` pair) and whether it answers or
// is stuck, the upgrade hold beside them, the wait for a stopped daemon to go,
// and the classifier `doctor` and `reap` use for every grapevine daemon on the
// machine. Moved out of `cli.ts` to keep that file under its frozen line count;
// `cli.ts` imports everything back.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../../kit/wire/discovery.ts";
import { die as raise } from "../../kit/wire/errors.ts";

export const DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
export const PORT_FILE = join(DATA_DIR, "daemon.port");
export const PID_FILE = join(DATA_DIR, "daemon.pid");
export const HOLD_FILE = join(DATA_DIR, "daemon.hold");

// GET / — daemon liveness/info.
export type RootInfo = {
  ok?: boolean;
  pid?: number;
  started_at?: number;
  channels?: number;
  data_dir?: string;
  version?: string | null;
  error?: string;
};

/** A daemon whose pid is alive but that did not answer `GET /` in time. */
export type StuckDaemon = { pid: number; port: number };

/**
 * Refuse, naming the stuck daemon's pid and the act that clears it. A verb that
 * reads the daemon's port lands here rather than reporting "no daemon" (which
 * `stop` used to) or spawning a second one (which `start`, `restart` and `roll`
 * did).
 */
export function daemonStuck({ pid, port }: StuckDaemon): never {
  raise(
    `the daemon (pid ${pid}, port ${port}) is alive but did not answer within 3 s — paused ` +
      "(SIGSTOP) or wedged — so it was neither taken for gone nor joined by a second daemon: " +
      `${stuckAct(pid)}.`,
    "conflict",
    { token: "daemon_stuck", hint: `try: kill -CONT ${pid}` },
  );
}

/** The act that clears a stuck daemon, as one sentence every report shares. */
export function stuckAct(pid: number): string {
  return (
    `resume it with \`kill -CONT ${pid}\`; if it still does not answer, end it with ` +
    `\`kill -KILL ${pid}\`, and the next verb (or a waiting tail) starts a fresh daemon`
  );
}

/** The live port from `discoverDaemon`, or null; a stuck daemon is refused. */
export function livePortOrRefuse(found: number | { stuck: StuckDaemon } | null): number | null {
  if (found !== null && typeof found !== "number") daemonStuck(found.stuck);
  return found;
}

/** `GET /` on `port` within `ms`: answered ok, SILENT (took the connection,
 *  said nothing — a paused or wedged process), or anything else (refused). */
async function ping(port: number, ms: number): Promise<"ok" | "silent" | "other"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? "ok" : "other";
  } catch (e) {
    return (e as Error)?.name === "TimeoutError" ? "silent" : "other";
  }
}

/**
 * What this HOME's port and pid files say: the port of a daemon that answers
 * `GET /` (handed to `onLive` too), a STUCK daemon, or null.
 *
 * ⛔ A DAEMON THAT DOES NOT ANSWER IS NOT GONE WHILE ITS PID LIVES. This used to
 * remove both files whenever the ping timed out, so a paused (SIGSTOP) or
 * wedged daemon read as absent and `start` / `restart --force` spawned a second
 * daemon beside it (item grapevine-paused-daemon-reads-as-gone). Stuck means
 * SILENT: the port took the connection and never answered (the kernel accepts
 * for a stopped process), and the pid file names a live grapevine daemon. A
 * refused port, a dead pid, or a pid that is not a grapevine daemon (reused) is
 * a stale pair, removed as before. When `ps` cannot say, the pid is taken for
 * the daemon: refusing a spawn is the safe side of that doubt.
 *
 * ⚠ AND A LIVE PID GETS 3 S, NOT 500 MS, before it is called stuck. Once a
 * stuck daemon refuses every verb, a merely BUSY one must not read as stuck:
 * measured, the full suite's parallel load put a healthy daemon past 500 ms and
 * failed a dozen verbs. The fast path is unchanged — an answer in 500 ms — and
 * only a daemon that misses it, with its pid alive, waits the extra 2.5 s.
 */
export async function discoverDaemon(
  onLive?: (port: number) => void,
): Promise<number | { stuck: StuckDaemon } | null> {
  if (!existsSync(PORT_FILE)) return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port) return null;
  let answer = await ping(port, 500);
  if (answer === "silent") {
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) || 0;
    } catch {}
    if (pidAlive(pid) && (await isGrapevineDaemon(pid))) {
      answer = await ping(port, 2500);
      if (answer === "silent") return { stuck: { pid, port } };
    }
  }
  if (answer === "ok") {
    onLive?.(port);
    return port;
  }
  // Stale — clean up.
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
}

let stuckNoted: number | null = null;
/** A waiting tail's answer to a stuck daemon: say so once per pid, then retry (null). */
export function waitOnStuck({ pid }: StuckDaemon): null {
  if (stuckNoted !== pid) {
    stuckNoted = pid;
    process.stderr.write(
      `# daemon (pid ${pid}) is alive but not answering; waiting — ${stuckAct(pid)}\n`,
    );
  }
  return null;
}

/** Whether `pid` runs a grapevine daemon, by its command line; true when `ps` cannot say. */
async function isGrapevineDaemon(pid: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      const proc = spawn("ps", ["-p", String(pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
      proc.on("error", () => resolve(true));
      proc.on("close", (code) => {
        const line = Buffer.concat(chunks).toString("utf-8").trim();
        // No line: exit 1 is "no such process"; any other failure cannot say.
        resolve(line === "" ? code !== 0 && code !== 1 : isGrapevineDaemonCommand(line));
      });
    } catch {
      resolve(true);
    }
  });
}

/** A `ps` command line that runs grapevine's daemon. */
function isGrapevineDaemonCommand(line: string): boolean {
  return line.includes("daemon.ts") && line.toLowerCase().includes("grapevine");
}

/**
 * Wait, up to 5 s, until no daemon answers on the port file: a daemon told to
 * stop unlinks its port and pid files as it shuts down. For stop, restart and
 * roll alike. A daemon still answering after that is a failure, not a stop:
 * the verb refuses, names the daemon's pid, and points at `doctor`, which
 * reports it. (`reap` never kills the authoritative daemon, so it is not the
 * answer here.)
 */
export async function untilDaemonGone(
  verb: "stop" | "restart" | "roll",
  prefix: string, // cli.ts's invocationPrefix(), for the hint
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    // A dying daemon that stops answering while its pid lives is not gone yet.
    if ((await discoverDaemon()) === null) return;
  }
  let pid: number | null = null;
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
  } catch {}
  raise(
    `${verb}: the daemon${pid ? ` (pid ${pid})` : ""} was told to stop and still answers (or its pid lives) after 5 s, ` +
      `so ${verb === "stop" ? "it was not stopped" : "no new daemon was started"}. ` +
      `Stop it by its pid${pid ? ` (kill ${pid})` : ""}, then run ${verb} again.`,
    "internal",
    {
      token: "daemon_still_running",
      hint: prefix ? `try: ${prefix} doctor` : "try the `doctor` verb",
    },
  );
}

export function holdActive(): number | null {
  try {
    if (!existsSync(HOLD_FILE)) return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now()) return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {} // expired → clean
    return null;
  } catch {
    return null;
  }
}
export function releaseHold() {
  try {
    if (existsSync(HOLD_FILE)) unlinkSync(HOLD_FILE);
  } catch {}
}

// ── Daemon enumeration + classifier ──────────────────────────────────────────

/** All grapevine daemon.ts pids visible on this machine (via `ps`). */
export async function listGrapevineDaemonPids(): Promise<number[]> {
  const pids: number[] = [];
  try {
    const proc = spawn("ps", ["-eo", "pid,command"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
    await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
    const out = Buffer.concat(chunks).toString("utf-8");
    for (const line of out.split("\n")) {
      if (!isGrapevineDaemonCommand(line)) continue;
      // The pid group is mandatory; an unmatched line is skipped, as before.
      const digits = line.match(/^\s*(\d+)\s+/)?.[1];
      if (digits === undefined) continue;
      const pid = parseInt(digits, 10);
      if (pid) pids.push(pid);
    }
  } catch {
    // ps unavailable; return empty
  }
  return pids;
}

async function lsofListenPort(pid: number): Promise<number | null> {
  try {
    const proc = spawn("lsof", ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
    await new Promise<void>((r) => proc.on("exit", () => r()));
    // The port group is mandatory; no match is this function's own `null`.
    const digits = Buffer.concat(chunks)
      .toString("utf-8")
      .match(/127\.0\.0\.1:(\d+)/)?.[1];
    return digits === undefined ? null : parseInt(digits, 10);
  } catch {
    return null;
  }
}

export type DaemonStatus = "authoritative" | "orphan" | "unresponsive" | "unknown";

export async function classifyDaemon(pid: number): Promise<{
  pid: number;
  port: number | null;
  home?: string;
  version?: string | null;
  status: DaemonStatus;
  reapable: boolean;
}> {
  const port = await lsofListenPort(pid);
  if (!port) return { pid, port: null, status: "unknown", reapable: false };
  let info: RootInfo | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) info = (await res.json()) as RootInfo;
  } catch {}
  if (!info) return { pid, port, status: "unresponsive", reapable: false }; // reap only with --force (handled in cmdReap)
  const home = info.data_dir as string;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns
    ? {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "authoritative",
        reapable: false,
      }
    : {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "orphan",
        reapable: true,
      };
}

/**
 * Every grapevine daemon on the machine but `selfPid`, classified. Each entry
 * gains port/home/version/status/reapable so the operator has the full picture
 * without needing a separate `reap --dry-run`. (`doctor`'s enumeration.)
 */
export async function otherDaemonsThan(
  selfPid: number | undefined,
): Promise<Array<Awaited<ReturnType<typeof classifyDaemon>> & { command?: string }>> {
  const otherDaemons: Array<Awaited<ReturnType<typeof classifyDaemon>> & { command?: string }> = [];
  try {
    for (const pid of await listGrapevineDaemonPids()) {
      if (selfPid && pid === selfPid) continue;
      otherDaemons.push(await classifyDaemon(pid));
    }
  } catch {
    // ps unavailable; carry on with empty list
  }
  return otherDaemons;
}

/**
 * `reap`'s sweep: SIGTERM every reapable daemon on the machine (and, with
 * `force`, every unresponsive one), never `selfPid`, this HOME's own.
 */
export async function reapDaemons(
  selfPid: number | null,
  opts: { force?: boolean; dryRun?: boolean },
): Promise<{ kept: unknown[]; reaped: unknown[]; skipped: unknown[] }> {
  const pids = await listGrapevineDaemonPids();
  const kept: unknown[] = [],
    reaped: unknown[] = [],
    skipped: unknown[] = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap =
      !isSelf && (c.reapable || (c.status === "unresponsive" && opts.force === true));
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  return { kept, reaped, skipped };
}

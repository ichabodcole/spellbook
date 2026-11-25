// Daemon discovery for the grapevine CLI: where this HOME's daemon says it is
// (the singleton `daemon.port` + `daemon.pid` pair), the upgrade hold beside
// them, the wait for a stopped daemon to go, and the classifier `doctor` and
// `reap` use for every grapevine daemon on the machine. Moved out of `cli.ts`
// whole (behaviour unchanged) to keep that file under its frozen line count;
// `cli.ts` imports everything back.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/**
 * The port in this HOME's port file, if a daemon answers `GET /` on it within
 * 500 ms. Otherwise the pair is stale: both files are removed and the answer is
 * null. (`cli.ts`'s `readDaemonPort` adds the version-mismatch warning.)
 */
export async function answeringPort(): Promise<number | null> {
  if (!existsSync(PORT_FILE)) return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) return port;
  } catch {}
  // Stale — clean up.
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
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
    if ((await answeringPort()) === null) return;
  }
  let pid: number | null = null;
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
  } catch {}
  raise(
    `${verb}: the daemon${pid ? ` (pid ${pid})` : ""} was told to stop and still answers after 5 s, ` +
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
      if (!line.includes("daemon.ts")) continue;
      if (!line.toLowerCase().includes("grapevine")) continue;
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

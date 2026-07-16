#!/usr/bin/env bun

// mind-mapper — Phase 0 SPIKE cli. Two verbs, deliberately minimal:
//   open   spawn (or find) the daemon, print its url, open the browser
//   state  GET /state → the stub map JSON on stdout
// No stop verb in the spike: kill "$(cat ~/.mind-mapper/daemon.pid)" tears it
// down. The real verb set is V1 business.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
// The daemon serves a Bun-bundled React surface; Bun reads bunfig.toml (the
// Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be src/mind-mapper/
// (seams Contract 5 cwd-pin) — launched elsewhere, Tailwind is silently skipped.
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

const HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");

function livePort(): number | null {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port)) return null;
  try {
    process.kill(pid, 0); // liveness probe, no signal delivered
    return port;
  } catch {
    return null; // stale discovery files
  }
}

async function ensureDaemon(): Promise<number> {
  const running = livePort();
  if (running !== null) return running;
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: "ignore",
    cwd: SURFACE_CWD,
  });
  proc.unref();
  // Poll discovery until the daemon writes its port (cold Bun bundle can lag).
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port = livePort();
    if (port !== null) return port;
  }
  throw new Error("daemon did not come up within 10s");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

async function main(argv: string[]): Promise<number> {
  const verb = argv[0];

  if (verb === "open") {
    const port = await ensureDaemon();
    const url = `http://127.0.0.1:${port}`;
    openBrowser(url);
    process.stdout.write(`${JSON.stringify({ ok: true, url })}\n`);
    return 0;
  }

  if (verb === "state") {
    const port = livePort();
    if (port === null) {
      process.stderr.write("mind-mapper: no daemon running (use `open` first)\n");
      return 2;
    }
    const res = await fetch(`http://127.0.0.1:${port}/state`);
    process.stdout.write(`${await res.text()}\n`);
    return 0;
  }

  process.stderr.write(`usage: cli.ts <open|state>\n`);
  return 2;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

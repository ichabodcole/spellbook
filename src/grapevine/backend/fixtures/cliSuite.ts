// The shared harness of the grapevine CLI suite (cli.test.ts and its
// cli.*.test.ts siblings), moved here verbatim when the suite was split for
// parallel running. bun test evaluates it afresh for each test file, so HOME
// below is one private GRAPEVINE_HOME (and one daemon) per file, and each file
// registers stopSuiteProcesses with afterAll.
//
// The suite's original note:
//
// Integration tests for the grapevine CLI + daemon. Spawns a fresh daemon
// against a tmpdir GRAPEVINE_HOME, exercises the verbs end to end.
//
// Run with: bun test from this directory.

import { expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Read a value this test's own setup is contracted to have produced, or fail
 * NAMING that contract (type-debt T11/T22: LOCAL copies — a test under `src/`
 * imports nothing from `grimoire/`). Function declarations, not generic arrows:
 * the import-boundary ward's transpiler reads `<T>(` as JSX (Phase 4a).
 */
export function must<T>(v: T | null | undefined, invariant: string): T {
  if (v === undefined || v === null) throw new Error(`INVARIANT VIOLATED — ${invariant}`);
  return v;
}

export function at<T>(xs: readonly T[], i: number, what: string): T {
  return must(xs[i], `${what} has an element ${i}`);
}

/**
 * ⛔ THE SKILL ROOT IS FOUND BY A MARKER, NEVER BY COUNTING `..` (playbook B6).
 * This suite now lives at `src/grapevine/backend/` and the process it spawns
 * lives at `plugins/spellbook/skills/grapevine/scripts/` — different trees, so
 * no number of `..` reaches it. A marker fails LOUDLY and by name when it fails
 * at all; a wrong `..` fails as "the daemon never answered".
 */
export function repoRoot(from: string): string {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".anthill", "config.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error(`repo root marker (.anthill/config.json) not found above ${from}`);
}

export const HOME = mkdtempSync(join(tmpdir(), "grapevine-test-"));

/**
 * ⛔ THE LAUNCHER, NOT THE SOURCE (playbook B6.1). The contract this suite
 * asserts is what the PROCESS writes and exits with, and the process a caller
 * runs is `scripts/cli.ts` → `dist/cli.js`. It is also the path the CLI's own
 * runnable hints compose from their argument vector, which is why the
 * "run what stderr told you" cell below can execute one verbatim.
 *
 * ⚠ ONE CONSTANT, ONE JOB. bounty's suite used its `CLI` to spawn a process AND
 * to read the source with `Bun.file(CLI).text()`; re-pointing it at the launcher
 * re-pointed the source scans, which then read a comment block and failed as a
 * broken regex. This suite reads no source through this constant — checked at
 * the port — and must not start.
 */
export const CLI = join(
  repoRoot(import.meta.dir),
  "plugins",
  "spellbook",
  "skills",
  "grapevine",
  "scripts",
  "cli.ts",
);

/**
 * ⛔ THE DAEMON LAUNCHER, FOR THE TWO CELLS THAT SPAWN A DAEMON DIRECTLY. They
 * read `join(import.meta.dir, "daemon.ts")` before the port, which after it is
 * `src/grapevine/backend/daemon.ts` — a module with no `import.meta.main` block
 * (playbook B3), so the spawn would boot nothing, exit 0, and the two cells
 * would fail as "no such daemon on this machine": a wrong-file defect wearing a
 * missing-feature symptom. Both were RED at the move and both are fixed here.
 */
export const DAEMON = join(dirname(CLI), "daemon.ts");

// Track every long-lived child process we spawn (tails, the wait helper,
// etc.) so afterAll can SIGTERM them even if `bunRun(["stop"])` fails or
// is skipped. Prevents zombie daemons/tails from accumulating across runs.
export const TRACKED_PROCS = new Set<ReturnType<typeof spawn>>();

export function bunRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("exit", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      }),
    );
  });
}

// Like bunRun, but feeds `input` to the child's stdin (stdin is a pipe, not
// ignored). For exercising `send`'s stdin-reading paths without a real shell.
export function bunRunStdin(
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("exit", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      }),
    );
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export function spawnTail(
  name: string,
  extra: string[] = [],
): { proc: ReturnType<typeof spawn>; output: () => string } {
  const buf: Buffer[] = [];
  const proc = spawn(process.execPath, [CLI, "tail", name, ...extra], {
    env: { ...process.env, GRAPEVINE_HOME: HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => buf.push(b));
  TRACKED_PROCS.add(proc);
  proc.on("exit", () => TRACKED_PROCS.delete(proc));
  return { proc, output: () => Buffer.concat(buf).toString("utf-8") };
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** The suite's teardown, once the suite's single afterAll: every test file
 *  registers it, so each file stops its own tails and daemon and removes its
 *  own HOME. */
export async function stopSuiteProcesses() {
  // SIGTERM any tracked child processes first (tails etc.) so they can't
  // race-spawn a new daemon during teardown — same race that produced
  // today's zombie sweep.
  for (const proc of TRACKED_PROCS) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  TRACKED_PROCS.clear();
  await sleep(150);
  // Then ask the daemon to stop politely.
  await bunRun(["stop"]);
  await sleep(100);
  // Belt-and-suspenders: if the port file still points at a live process,
  // kill it directly. Catches the case where `stop` didn't reach the daemon.
  try {
    const pidPath = join(HOME, "daemon.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(require("node:fs").readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  } catch {}
  rmSync(HOME, { recursive: true, force: true });
}

/** The running daemon's port, read from the test HOME. Used by the handful of
 *  assertions that must hit a ROUTE rather than a verb — the daemon guard is
 *  the real fence, and a CLI-only test cannot tell the two apart. */
export function daemonPort(): number {
  return parseInt(readFileSync(join(HOME, "daemon.port"), "utf-8").trim(), 10);
}

/** Names in `grapevine list`. The second assertion of every no-resurrection
 *  test: refusing is not enough if the name came back anyway. */
/**
 * The failure envelope this CLI writes on stderr, parsed.
 *
 * ⛔ ADDED AT PHASE 6 CHAPTER 2, AND IT IS THE SHAPE OF THE DELTA. Before the
 * adoption of `src/kit/wire/errors.ts` every failure was PROSE at exit 2 —
 * `grapevine: <msg>`, sometimes with a second indented line — so the cells below
 * matched substrings and split sentences. After it there is ONE JSON document on
 * stderr with a `kind`, the taxonomy's exit code, the message, an optional
 * `hint` (the runnable recovery) and an optional `choices` (the enumeration that
 * used to be a prose marker). Matching a field is what the contract actually is;
 * matching prose is what "rewording must never break a caller" means.
 */
export function errorOf(stderr: string): {
  kind: string;
  exit_code: number;
  message: string;
  hint?: string;
  choices?: string[];
  server?: { error?: string; hint?: string };
} {
  const parsed = JSON.parse(stderr) as {
    ok: boolean;
    error: {
      kind: string;
      exit_code: number;
      message: string;
      hint?: string;
      choices?: string[];
      server?: { error?: string; hint?: string };
    };
    meta: { command: string | null };
  };
  expect(parsed.ok).toBe(false);
  return parsed.error;
}

export async function listedChannels(): Promise<string[]> {
  const { stdout } = await bunRun(["list"]);
  return (JSON.parse(stdout) as { channels: { name: string }[] }).channels.map((c) => c.name);
}

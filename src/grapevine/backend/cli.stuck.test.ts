// PART OF THE GRAPEVINE CLI SUITE (fixtures/cliSuite.ts): its own
// GRAPEVINE_HOME, its own daemon, both stopped after the last test.
//
// A daemon whose pid is alive but that does not answer (item
// grapevine-paused-daemon-reads-as-gone). Before the fix the CLI deleted the
// port and pid files whenever `GET /` took over 500 ms, so a SIGSTOPped daemon
// read as gone: `stop` said `daemon:false` and `start` / `restart --force`
// spawned a second daemon beside it. Now a live pid gets 3 s to answer before
// it is called stuck, so each refusal below takes about that long.
//
// ⛔ SAFETY: the only process this file ever signals is the daemon its own
// `start` spawned in its own temp HOME — its pid read from that HOME's pid file
// and confirmed by the daemon itself (`GET /` answers that pid and that HOME).
// Every pause is undone in a `finally`, and `afterAll` resumes and kills it
// before the suite's teardown, even when a test failed half-way.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bunRun,
  CLI,
  errorOf,
  HOME,
  sleep,
  stopSuiteProcesses,
  TRACKED_PROCS,
} from "./fixtures/cliSuite.ts";

/** Pids this file paused; each is resumed (and the suite's daemon stopped) at the end. */
const PAUSED = new Set<number>();
/** Every daemon pid this file proved its own. Killed at the end if still alive:
 *  without the fix a second daemon replaces the first in the pid file, and the
 *  suite's teardown would only ever reach the second. */
const OWNED = new Set<number>();

afterAll(async () => {
  for (const pid of PAUSED) {
    try {
      process.kill(pid, "SIGCONT");
    } catch {}
  }
  await stopSuiteProcesses();
  for (const pid of OWNED) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});

const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");
const files = () => ({
  port: readFileSync(PORT_FILE, "utf-8").trim(),
  pid: readFileSync(PID_FILE, "utf-8").trim(),
});

/** Start this file's daemon and return its pid, proven to be ours before anyone signals it. */
async function ownDaemon(): Promise<{ pid: number; port: number }> {
  expect(HOME.startsWith(tmpdir())).toBe(true);
  const started = JSON.parse((await bunRun(["start"])).stdout);
  const pid = Number(files().pid);
  const info = await (await fetch(`http://127.0.0.1:${started.port}/`)).json();
  expect(info.pid).toBe(pid);
  expect(info.data_dir).toBe(HOME);
  OWNED.add(pid);
  return { pid, port: started.port };
}

function pause(pid: number) {
  PAUSED.add(pid);
  process.kill(pid, "SIGSTOP");
}

function resume(pid: number) {
  try {
    process.kill(pid, "SIGCONT");
  } catch {}
  PAUSED.delete(pid);
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

describe("a daemon that is alive but does not answer", () => {
  test("is reported stuck with its pid and act, never removed and never doubled", async () => {
    const { pid, port } = await ownDaemon();
    const before = files();
    pause(pid);
    try {
      for (const verb of [["stop"], ["start"], ["restart", "--force"], ["roll", "--force"]]) {
        const r = await bunRun(verb);
        expect({ verb, code: r.code }).toEqual({ verb, code: 6 });
        const e = errorOf(r.stderr);
        expect(e.kind).toBe("conflict");
        expect(e.message).toContain(`pid ${pid}`);
        expect(e.message).toContain(`kill -KILL ${pid}`);
        expect(e.hint).toBe(`try: kill -CONT ${pid}`);
        // Still discoverable: the pair names the same daemon.
        expect(files()).toEqual(before);
      }

      // `doctor` names it as this HOME's stuck daemon, not as a stray elsewhere.
      const doc = JSON.parse((await bunRun(["doctor"])).stdout);
      expect(doc.authoritative).toBe(null);
      expect(doc.stuck).toEqual({ pid, port, hint: `try: kill -CONT ${pid}` });
      expect(doc.other_daemons_on_machine.some((d: { pid: number }) => d.pid === pid)).toBe(false);
      expect(doc.hints[0]).toContain(`kill -CONT ${pid}`);

      // No second daemon came up meanwhile: one would have rewritten the pair.
      await sleep(1000);
      expect(files()).toEqual(before);

      // Run the hint as printed — it is the recovery, so it must work.
      const hint = errorOf((await bunRun(["start"])).stderr).hint ?? "";
      const argv = hint.replace(/^try: /, "").split(" ");
      expect(argv).toEqual(["kill", "-CONT", String(pid)]); // our own daemon, nothing else
      expect(spawnSync(argv[0] as string, argv.slice(1)).status).toBe(0);
      PAUSED.delete(pid);
      const after = JSON.parse((await bunRun(["start"])).stdout);
      expect(after).toEqual({ ok: true, port, already_running: true });
    } finally {
      resume(pid);
    }
  }, 60_000);

  test("a tail waits on it, says so once, and resumes on it once it answers", async () => {
    const { pid } = await ownDaemon();
    await bunRun(["open", "stuck_tail"]);
    pause(pid);
    const err: Buffer[] = [];
    const out: Buffer[] = [];
    const t = spawn(process.execPath, [CLI, "tail", "stuck_tail", "--as", "watcher"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    TRACKED_PROCS.add(t);
    t.stdout.on("data", (b) => out.push(b));
    t.stderr.on("data", (b) => err.push(b));
    const stderr = () => Buffer.concat(err).toString("utf-8");
    try {
      const note = `# daemon (pid ${pid}) is alive but not answering; waiting`;
      expect(await until(() => stderr().includes(note), 8000)).toBe(true);
      // Several retries fit in 3 s; the note is said once, and the tail stays up.
      await sleep(3000);
      expect(t.exitCode).toBe(null);
      expect(stderr().split(note).length - 1).toBe(1);
      expect(stderr()).not.toContain("# subscribed to");
      expect(files().pid).toBe(String(pid)); // nobody spawned beside it

      resume(pid);
      expect(await until(() => stderr().includes("# subscribed to stuck_tail"), 10_000)).toBe(true);
      await bunRun(["send", "stuck_tail", "--from", "a", "back"]);
      expect(
        await until(() => Buffer.concat(out).toString("utf-8").includes('"text":"back"'), 5000),
      ).toBe(true);
      expect(files().pid).toBe(String(pid)); // it resumed on the same daemon
    } finally {
      resume(pid);
      t.kill("SIGTERM");
      TRACKED_PROCS.delete(t);
    }
  }, 30_000);

  test("a stale pair is still cleaned: a dead pid, or a live pid that is not a daemon", async () => {
    // A home of its own: its pair is written by hand, and the daemon `start`
    // spawns there is stopped (and, failing that, killed by its own pid) below.
    const home = mkdtempSync(join(tmpdir(), "grapevine-stalepair-"));
    const run = (args: string[]) =>
      spawnSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, GRAPEVINE_HOME: home },
        encoding: "utf-8",
      });
    const dead = spawnSync("true").pid; // exited before we look
    // A port that takes the connection and never answers, as a paused daemon's
    // does — so only the pid can tell these pairs from a stuck daemon.
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const silentPort = (silent.address() as AddressInfo).port;
    try {
      // The test runner's own pid is alive, but its command line is not a
      // grapevine daemon's: a reused pid.
      for (const pid of [dead, process.pid]) {
        writeFileSync(join(home, "daemon.port"), String(silentPort));
        writeFileSync(join(home, "daemon.pid"), String(pid));
        const r = run(["start"]);
        expect({ pid, code: r.status }).toEqual({ pid, code: 0 });
        const started = JSON.parse(r.stdout);
        expect(started.already_running).toBe(false);
        expect(Number(readFileSync(join(home, "daemon.pid"), "utf-8"))).not.toBe(pid);
        expect(run(["stop"]).status).toBe(0);
      }
    } finally {
      silent.close();
      const pidPath = join(home, "daemon.pid");
      if (existsSync(pidPath)) {
        const own = Number(readFileSync(pidPath, "utf-8").trim());
        if (own && own !== process.pid && own !== dead) {
          try {
            process.kill(own, "SIGKILL");
          } catch {}
        }
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

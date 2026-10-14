import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { fstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "./detach.ts";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "detach-"));
  dirs.push(d);
  return d;
};

describe("startDaemon", () => {
  test("resolves with the ready line and leaves the daemon running, detached", async () => {
    const dir = tmp();
    const { pid, ready } = await startDaemon<{ ready: boolean; pid: number }>({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ ready: true, pid: process.pid })); setInterval(() => {}, 1000);",
      ],
      logFile: join(dir, "logs", "daemon.log"),
    });
    pids.push(pid);
    expect(ready.ready).toBe(true);
    expect(ready.pid).toBe(pid);
    // Signal 0 tests existence: the daemon outlived the start call.
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  test("rejects, quoting the log, when the daemon exits before it is ready", async () => {
    const dir = tmp();
    const run = startDaemon({
      command: process.execPath,
      args: ["-e", 'console.error("no port for you"); process.exit(3);'],
      logFile: join(dir, "daemon.log"),
    });
    await expect(run).rejects.toThrow(
      /exited before it was ready \(code 3\)[\s\S]*no port for you/,
    );
  });

  test("rejects a first line that is not a JSON object and kills the daemon", async () => {
    const dir = tmp();
    const run = startDaemon({
      command: process.execPath,
      args: ["-e", 'console.log("hello"); setInterval(() => {}, 1000);'],
      logFile: join(dir, "daemon.log"),
    });
    await expect(run).rejects.toThrow(/not a JSON object/);
  });

  test("a ready line that is JSON but not an object is refused", async () => {
    for (const line of ["42", "null", "[1]", '"ok"']) {
      const dir = tmp();
      const run = startDaemon({
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(line)}); setInterval(() => {}, 1000);`],
        logFile: join(dir, "daemon.log"),
      });
      await expect(run).rejects.toThrow(/not a JSON object/);
    }
  });

  test("a start that fails kills the daemon's whole process group", async () => {
    const dir = tmp();
    const pidFile = join(dir, "helper.pid");
    // The daemon spawns a helper in its group, records the helper's pid, then
    // prints a bad first line.
    const script = `
      const { spawn } = require("node:child_process");
      const h = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(h.pid));
      setTimeout(() => console.log("bad"), 300);
      setInterval(() => {}, 1000);
    `;
    await expect(
      startDaemon({
        command: process.execPath,
        args: ["-e", script],
        logFile: join(dir, "daemon.log"),
      }),
    ).rejects.toThrow(/not a JSON object/);
    const helper = Number(readFileSync(pidFile, "utf8"));
    pids.push(helper);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(helper, 0)).toThrow();
  });

  test("a daemon that ignores SIGTERM after a start timeout is sent SIGKILL", async () => {
    const dir = tmp();
    const pidFile = join(dir, "daemon.pid");
    // Never says ready, and shrugs off SIGTERM.
    const script = `
      process.on("SIGTERM", () => {});
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    await expect(
      startDaemon({
        command: process.execPath,
        args: ["-e", script],
        logFile: join(dir, "daemon.log"),
        startTimeoutMs: 500,
        killGraceMs: 300,
      }),
    ).rejects.toThrow(/daemon start timeout/);
    // The grace was spent: SIGTERM did not end it, so the wait ran out.
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    const pid = Number(readFileSync(pidFile, "utf8"));
    pids.push(pid);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a spawn that throws synchronously rejects and does not leak the log fd", async () => {
    const dir = tmp();
    let fd: number | undefined;
    const throwing = ((_cmd: string, _args: string[], o: { stdio: unknown[] }) => {
      fd = o.stdio[2] as number;
      throw new Error("spawn exploded");
    }) as unknown as typeof spawn;
    await expect(
      startDaemon(
        { command: process.execPath, args: [], logFile: join(dir, "daemon.log") },
        { spawn: throwing },
      ),
    ).rejects.toThrow(/spawn exploded/);
    expect(typeof fd).toBe("number");
    expect(() => fstatSync(fd as number)).toThrow();
  });

  test("a daemon that says ready with no pid is a failed start, not pid -1", async () => {
    const dir = tmp();
    const noPid = ((...a: Parameters<typeof spawn>) => {
      const child = spawn(...a);
      if (child.pid !== undefined) pids.push(child.pid);
      Object.defineProperty(child, "pid", { value: undefined, configurable: true });
      return child;
    }) as typeof spawn;
    await expect(
      startDaemon(
        {
          command: process.execPath,
          args: [
            "-e",
            "console.log(JSON.stringify({ ready: true })); setInterval(() => {}, 1000);",
          ],
          logFile: join(dir, "daemon.log"),
        },
        { spawn: noPid },
      ),
    ).rejects.toThrow(/no pid/);
  });
});

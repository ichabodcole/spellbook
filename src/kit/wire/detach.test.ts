import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});

// PART OF THE GRAPEVINE CLI SUITE (fixtures/cliSuite.ts): its own
// GRAPEVINE_HOME, its own daemon, both stopped after the last test.
//
// The upgrade window — `stop --hold <s>`, swap, `roll` — end to end through the
// real CLI and daemon (item `grapevine-hold-has-no-way-out`). Before the fix
// `roll` was refused by the hold whose own refusal told you to run it, and a
// live tail that met the hold exited 6 with no `tail.*` line.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

afterAll(stopSuiteProcesses);

const HOLD_FILE = join(HOME, "daemon.hold");

/** A tail with stdout AND stderr captured, and an optional handoff window. */
function tail(name: string, extra: string[], windowMs?: number) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const proc = spawn(process.execPath, [CLI, "tail", name, ...extra], {
    env: {
      ...process.env,
      GRAPEVINE_HOME: HOME,
      ...(windowMs !== undefined ? { SPELLBOOK_TAIL_WINDOW_MS: String(windowMs) } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => out.push(b));
  proc.stderr.on("data", (b) => err.push(b));
  TRACKED_PROCS.add(proc);
  const exited = new Promise<number>((resolve) =>
    proc.on("exit", (code) => {
      TRACKED_PROCS.delete(proc);
      resolve(code ?? -1);
    }),
  );
  return {
    proc,
    exited,
    stdout: () => Buffer.concat(out).toString("utf-8"),
    stderr: () => Buffer.concat(err).toString("utf-8"),
  };
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

/** Message lines on a tail's stdout (not grounding or handoff lines). */
function messages(stdout: string): Array<{ id: number; text: string }> {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((j) => typeof j.id === "number" && j.kind === "message");
}

describe("the upgrade window: stop --hold, then roll", () => {
  test("a verb refused by the hold names `roll`, and running that hint ends the hold", async () => {
    await bunRun(["start"]);
    const stop = await bunRun(["stop", "--hold", "60"]);
    expect(stop.code).toBe(0);

    // `start` says the daemon is held, until when, and what ends it now.
    const held = JSON.parse((await bunRun(["start"])).stdout);
    expect(held.held).toBe(true);
    expect(held.held_until).toBeGreaterThan(Date.now() + 30_000);
    expect(held.hint).toContain("roll");

    // A verb that needs the daemon is refused (exit 6) and its hint is `roll`.
    const refused = await bunRun(["open", "hold_refused"]);
    expect(refused.code).toBe(6);
    const e = errorOf(refused.stderr);
    expect(e.kind).toBe("conflict");
    expect(e.message).toContain("roll");
    const hint = e.hint ?? "";
    expect(hint).toMatch(/^try: bun \S+ roll$/);

    // Run the hint exactly as printed: it is the recovery, so it must work.
    const argv = hint.replace(/^try: /, "").split(" ");
    const ran = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const p = spawn(process.execPath, argv.slice(1), {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      p.stdout.on("data", (b) => out.push(b));
      p.on("exit", (code) =>
        resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf-8") }),
      );
    });
    expect(ran.code).toBe(0);
    const rolled = JSON.parse(ran.stdout);
    expect(rolled.rolled).toBe(true);
    expect(rolled.port).toBeGreaterThan(0);
    expect(rolled.version_ok).toBe(true);

    // The hold is gone, not merely overridden once: the next verb just works.
    expect(existsSync(HOLD_FILE)).toBe(false);
    const after = JSON.parse((await bunRun(["start"])).stdout);
    expect(after.already_running).toBe(true);
    expect(after.port).toBe(rolled.port);
    expect((await bunRun(["open", "hold_refused"])).code).toBe(0);
    await bunRun(["stop"]);
  }, 20_000);

  test("a live tail waits out the hold and resumes, gap-free, on the daemon roll starts", async () => {
    await bunRun(["open", "hold_tail"]);
    await bunRun(["send", "hold_tail", "--from", "a", "before"]); // id 1
    const t = tail("hold_tail", ["--as", "watcher"]);
    expect(await until(() => t.stderr().includes("# subscribed to hold_tail"), 5000)).toBe(true);

    expect((await bunRun(["stop", "--hold", "60"])).code).toBe(0);
    // It says it is waiting on the hold — and it does NOT exit 6.
    expect(await until(() => t.stderr().includes("daemon held until"), 8000)).toBe(true);
    await sleep(1500);
    expect(t.proc.exitCode).toBe(null);

    // Close the window. No subscriber is connected (the daemon is down), so
    // roll needs no --force.
    const rolled = await bunRun(["roll"]);
    expect(rolled.code).toBe(0);
    // Sent before the tail has necessarily reconnected: the tail resumes from
    // its cursor, so it still gets it — and does not replay "before".
    await bunRun(["send", "hold_tail", "--from", "a", "after"]); // id 2
    expect(await until(() => messages(t.stdout()).some((m) => m.text === "after"), 10_000)).toBe(
      true,
    );
    expect(messages(t.stdout()).map((m) => m.text)).toEqual(["after"]);
    expect(t.proc.exitCode).toBe(null);

    t.proc.kill("SIGTERM");
    expect(await t.exited).toBe(0);
    await bunRun(["close", "hold_tail"]);
    await bunRun(["stop"]);
  }, 30_000);

  test("a tail whose window ends during a hold prints tail.window with --since <last id>", async () => {
    await bunRun(["open", "hold_window"]);
    const t = tail("hold_window", ["--as", "watcher"], 4000);
    expect(await until(() => t.stderr().includes("# subscribed to hold_window"), 3000)).toBe(true);
    await bunRun(["send", "hold_window", "--from", "a", "one"]); // id 1
    await bunRun(["send", "hold_window", "--from", "a", "two"]); // id 2
    expect(await until(() => messages(t.stdout()).length === 2, 3000)).toBe(true);

    expect((await bunRun(["stop", "--hold", "60"])).code).toBe(0);
    const code = await t.exited;
    expect(code).toBe(0); // the window's handoff, not the held conflict (6)

    const lines = t
      .stdout()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const last = lines.at(-1);
    expect(last.type).toBe("tail.window");
    expect(last.cursor).toBe(2);
    expect(last.command).toBe("tail hold_window --as watcher --since 2");
    expect(t.stderr()).toContain("daemon held until");

    await bunRun(["roll"]);
    await bunRun(["close", "hold_window"]);
    await bunRun(["stop"]);
  }, 20_000);

  test("a tail resumes by itself when the hold lapses", async () => {
    await bunRun(["open", "hold_lapse"]);
    const t = tail("hold_lapse", ["--as", "watcher"]);
    expect(await until(() => t.stderr().includes("# subscribed to hold_lapse"), 5000)).toBe(true);

    expect((await bunRun(["stop", "--hold", "2"])).code).toBe(0);
    expect(await until(() => t.stderr().includes("daemon held until"), 5000)).toBe(true);
    // No roll: once the hold lapses the tail's own reconnect starts a daemon.
    expect(
      await until(
        () => (t.stderr().match(/# subscribed to hold_lapse/g) ?? []).length >= 2,
        12_000,
      ),
    ).toBe(true);
    await bunRun(["send", "hold_lapse", "--from", "a", "back"]);
    expect(await until(() => messages(t.stdout()).some((m) => m.text === "back"), 5000)).toBe(true);
    expect(t.proc.exitCode).toBe(null);

    t.proc.kill("SIGTERM");
    await t.exited;
    await bunRun(["close", "hold_lapse"]);
    await bunRun(["stop"]);
  }, 30_000);
});

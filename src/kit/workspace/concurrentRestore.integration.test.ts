// One daemon per session, through the real launchers (kit-workspace-concurrent-restore).
//
// `open --restore` checks for a running daemon and then starts one, and two of
// them at the same moment both passed the check: two daemons on two ports, and
// the manifest kept one daemon's writes. The daemon now takes the session's
// lock (`../wire/daemonLock.ts`) before it reads the session or binds, so the
// second refuses, and its `open` says what a restore of a running session
// says: already running, at the winner's URL.
//
// Every daemon this file starts, it stops: by `close`, or (the killed daemon)
// by the pid its own pointer names.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_LOCK } from "../wire/daemonLock.ts";
import { alive, pointerPid, waitForExit } from "./fixtures/harness";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli.ts");
const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-lock-")));
const env = {
  ...process.env,
  KIT_FIXTURE_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
};
mkdirSync(join(root, "tmp"), { recursive: true });

/** Every daemon pid this file saw start, for the backstop below. */
const started = new Set<number>();
afterAll(async () => {
  for (const pid of started)
    if (alive(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForExit(pid);
    }
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    cwd: root,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}
const pointerFile = (id: string) => join(root, "tmp", `kit-fixture.${id}.json`);
const lockFile = (id: string) => join(root, "home", "sessions", id, DAEMON_LOCK);
const lockPid = (id: string) =>
  (JSON.parse(readFileSync(lockFile(id), "utf8")) as { pid: number }).pid;
const envelope = (r: { err: string }) =>
  (JSON.parse(r.err) as { error: { message: string; kind: string; hint?: string } }).error;

/** A saved session with no daemon: opened, then closed. */
async function savedSession(): Promise<string> {
  const r = await cli("open", "--no-open");
  expect(r.code).toBe(0);
  const id = (JSON.parse(r.out) as { session_id: string }).session_id;
  const pid = pointerPid(pointerFile(id)) as number;
  started.add(pid);
  // A new session takes the lock too, and a clean close releases it.
  expect(lockPid(id)).toBe(pid);
  expect((await cli("close", "--session", id)).code).toBe(0);
  await waitForExit(pid);
  expect(existsSync(lockFile(id))).toBe(false);
  return id;
}

describe("two restores of one session at once", () => {
  test("start one daemon: one open wins, the other is told it is already running, at the winner's URL", async () => {
    const id = await savedSession();
    // A few rounds: the race is real, so one round could pass by luck of timing.
    for (let round = 0; round < 3; round++) {
      const [a, b] = await Promise.all([
        cli("open", "--no-open", "--restore", id),
        cli("open", "--no-open", "--restore", id),
      ]);
      const wins = [a, b].filter((r) => r.code === 0);
      const losses = [a, b].filter((r) => r.code !== 0);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);
      const url = (JSON.parse(wins[0]?.out as string) as { url: string }).url;
      const pid = pointerPid(pointerFile(id)) as number;
      started.add(pid);
      const e = envelope(losses[0] as { err: string });
      expect(e.kind).toBe("conflict");
      expect(e.message).toBe(`session ${id} is already running at ${url}`);
      expect(e.hint).toBe(`use it: state --session ${id}`);
      // One daemon: the lock and the pointer name the same live process.
      expect(lockPid(id)).toBe(pid);
      expect(alive(pid)).toBe(true);
      expect((await cli("state", "--session", id)).code).toBe(0);
      expect((await cli("close", "--session", id)).code).toBe(0);
      await waitForExit(pid);
      expect(existsSync(lockFile(id))).toBe(false);
    }
  }, 120_000);
});

describe("a stale lock", () => {
  test("left by a killed daemon is recovered by the next restore", async () => {
    const id = await savedSession();
    expect((await cli("open", "--no-open", "--restore", id)).code).toBe(0);
    const pid = pointerPid(pointerFile(id)) as number;
    started.add(pid);
    expect(lockPid(id)).toBe(pid);
    // Killed: no teardown runs, so the lock stays, naming a dead pid.
    process.kill(pid, "SIGKILL");
    await waitForExit(pid);
    expect(lockPid(id)).toBe(pid);

    const r = await cli("open", "--no-open", "--restore", id);
    expect(r.code).toBe(0);
    const next = pointerPid(pointerFile(id)) as number;
    started.add(next);
    expect(next).not.toBe(pid);
    expect(lockPid(id)).toBe(next);
    expect((await cli("close", "--session", id)).code).toBe(0);
    await waitForExit(next);
    expect(existsSync(lockFile(id))).toBe(false);
  }, 60_000);
});

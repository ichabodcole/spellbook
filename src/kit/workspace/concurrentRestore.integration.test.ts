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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

describe("a held lock whose daemon cannot be found by its pointer", () => {
  test("a live daemon whose pointer went puts it back: the restore names its URL, and state reaches it", async () => {
    const id = await savedSession();
    const opened = await cli("open", "--no-open", "--restore", id);
    expect(opened.code).toBe(0);
    const url = (JSON.parse(opened.out) as { url: string }).url;
    const pid = pointerPid(pointerFile(id)) as number;
    started.add(pid);
    // The OS cleaned the temp folder under a long session.
    unlinkSync(pointerFile(id));
    unlinkSync(join(root, "tmp", "kit-fixture.latest.json"));
    const t0 = Date.now();
    const r = await cli("open", "--no-open", "--restore", id);
    // Not the start timeout: this daemon is not starting.
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.code).not.toBe(0);
    const e = envelope(r);
    expect(e.kind).toBe("conflict");
    expect(e.message).toBe(`session ${id} is already running at ${url}`);
    // The hint's verb works: no circle back to `open --restore`.
    expect(pointerPid(pointerFile(id))).toBe(pid);
    expect((await cli("state", "--session", id)).code).toBe(0);
    expect((await cli("close", "--session", id)).code).toBe(0);
    await waitForExit(pid);
  }, 60_000);

  test("a daemon that holds the lock and does not answer is named, with a way to stop it that works", async () => {
    const id = await savedSession();
    expect((await cli("open", "--no-open", "--restore", id)).code).toBe(0);
    const pid = pointerPid(pointerFile(id)) as number;
    started.add(pid);
    // Stuck: alive, holding the lock, answering nothing.
    process.kill(pid, "SIGSTOP");
    try {
      // It has held the lock longer than a start takes (20 s here), so it is
      // not starting: `open` does not wait a fresh start window on it.
      await Bun.sleep(21_000);
      const t0 = Date.now();
      const r = await cli("open", "--no-open", "--restore", id, "--start-timeout", "20");
      expect(Date.now() - t0).toBeLessThan(16_000);
      const e = envelope(r);
      expect(e.kind).toBe("conflict");
      expect(e.message).toContain(`held by another daemon (pid ${pid}`);
      expect(e.message).toContain(lockFile(id));
      expect(e.hint).toBe(
        `if that daemon is stuck, stop it with \`kill ${pid}\`, then \`open --restore ${id}\` (its lock is then recovered)`,
      );
    } finally {
      // The hint's act, on the daemon this test started (SIGKILL: it is stopped).
      process.kill(pid, "SIGKILL");
      await waitForExit(pid);
    }
    const again = await cli("open", "--no-open", "--restore", id);
    expect(again.code).toBe(0);
    const next = pointerPid(pointerFile(id)) as number;
    started.add(next);
    expect(lockPid(id)).toBe(next);
    expect((await cli("close", "--session", id)).code).toBe(0);
    await waitForExit(next);
  }, 90_000);
});

describe("a start that fails", () => {
  test("releases the lock: a restore refused for a corrupt manifest leaves none", async () => {
    const id = await savedSession();
    writeFileSync(join(root, "home", "sessions", id, "manifest.json"), "{ not json");
    const r = await cli("open", "--no-open", "--restore", id);
    expect(r.code).not.toBe(0);
    expect(envelope(r).message).toContain("not valid JSON");
    expect(existsSync(lockFile(id))).toBe(false);
  }, 60_000);

  test("an id that is not a session id is refused before any lock: `--restore ..` locks nothing above the sessions", async () => {
    // A live holder's lock in the sessions root's parent: a daemon that locked
    // `<sessions>/..` would refuse as held; one that checks the id first says 400.
    const home = join(root, "home");
    const planted = { pid: process.pid, nonce: "ab".repeat(12), at: Date.now() };
    writeFileSync(join(home, DAEMON_LOCK), `${JSON.stringify(planted)}\n`);
    const p = Bun.spawn(["bun", join(dirname(CLI), "server.ts"), "--restore", ".."], {
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd: root,
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const hs = JSON.parse(out.trim().split("\n")[0] as string) as { status: number };
    expect(hs.status).toBe(400);
    expect(JSON.parse(readFileSync(join(home, DAEMON_LOCK), "utf8")).nonce).toBe(planted.nonce);
    rmSync(join(home, DAEMON_LOCK));
  }, 30_000);
});

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
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  // The daemon puts a lost pointer back on this clock; 2 s (not 1) so that a
  // restore that did not wait for it fails (the pointer test).
  KIT_FIXTURE_ATTENTION_MS: "2000",
};
mkdirSync(join(root, "tmp"), { recursive: true });
/** A PATH with `bun` and nothing else: no `ps`, for the CLI and the daemon it starts. */
const noPs = join(root, "nops");
mkdirSync(noPs);
symlinkSync(process.execPath, join(noPs, "bun"));

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

const cli = (...args: string[]) => cliEnv(env, ...args);
async function cliEnv(
  e: Record<string, string | undefined>,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...e },
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
    const latest = join(root, "tmp", "kit-fixture.latest.json");
    // Older than its start window (5 s below), so only the wait for a pointer
    // to come back gives `open` the time to find it.
    await Bun.sleep(6000);
    // The OS cleaned the temp folder under a long session. Removed once and
    // waited for, so the next removal lands just after the daemon's check: the
    // pointer is then back a full attention period (2 s) later, after `open`
    // has been refused by its own daemon.
    unlinkSync(pointerFile(id));
    unlinkSync(latest);
    while (!existsSync(pointerFile(id))) await Bun.sleep(10);
    // Only the session's own pointer is put back, never `latest`.
    expect(existsSync(latest)).toBe(false);
    unlinkSync(pointerFile(id));
    const t0 = Date.now();
    const r = await cli("open", "--no-open", "--restore", id, "--start-timeout", "5");
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

// ⛔ An agent follows a hint as written: `kill <pid>` is offered only for a pid
// shown to be this session's daemon. These are the cases where it is not.
describe("a lock that names a process that is not this session's daemon", () => {
  /** A lock written by hand into a saved session: what a copy, a reuse or a crash leaves. */
  const plant = (id: string, rec: Record<string, unknown>) =>
    writeFileSync(lockFile(id), `${JSON.stringify({ nonce: "ab".repeat(12), ...rec })}\n`);
  const noKill = (r: { err: string }, pid: number, id: string) => {
    const e = envelope(r);
    expect(e.kind).toBe("conflict");
    expect(e.message).toContain(`locked by pid ${pid}`);
    expect(e.message).toContain(lockFile(id));
    expect(e.hint).toContain("do not stop it on this word");
    expect(e.hint).not.toMatch(/\bkill\b/);
  };

  test("a live session's folder copied with its lock: the copy restores; the live daemon is not named", async () => {
    const r0 = await cli("open", "--no-open");
    const live = (JSON.parse(r0.out) as { session_id: string }).session_id;
    const livePid = pointerPid(pointerFile(live)) as number;
    started.add(livePid);
    const copy = `${live}-copy`;
    cpSync(join(root, "home", "sessions", live), join(root, "home", "sessions", copy), {
      recursive: true,
    });
    // Its manifest says which session it is: make it the copy's, as a duplicate would be.
    const mf = join(root, "home", "sessions", copy, "manifest.json");
    writeFileSync(mf, readFileSync(mf, "utf8").replaceAll(live, copy));
    expect(lockPid(copy)).toBe(livePid);
    const r = await cli("open", "--no-open", "--restore", copy);
    expect(r.code).toBe(0);
    const copyPid = pointerPid(pointerFile(copy)) as number;
    started.add(copyPid);
    // The copied lock named the live session, so it held nothing here.
    expect(lockPid(copy)).toBe(copyPid);
    expect(alive(livePid)).toBe(true);
    for (const [id, pid] of [
      [copy, copyPid],
      [live, livePid],
    ] as const) {
      expect((await cli("close", "--session", id)).code).toBe(0);
      await waitForExit(pid);
    }
  }, 60_000);

  test("without ps, a lock naming an unrelated live process gives no kill verb", async () => {
    const id = await savedSession();
    const unrelated = Bun.spawn(["sleep", "120"], { env });
    try {
      plant(id, { pid: unrelated.pid, at: Date.now() - 3_600_000, session: id });
      const r = await cliEnv(
        { ...env, PATH: noPs },
        "open",
        "--no-open",
        "--restore",
        id,
        "--start-timeout",
        "5",
      );
      noKill(r, unrelated.pid, id);
      expect(envelope(r).hint).toContain("`ps` cannot say what it is");
      // With ps, the same lock is a reused pid's: recovered.
      const ok = await cli("open", "--no-open", "--restore", id);
      expect(ok.code).toBe(0);
      const pid = pointerPid(pointerFile(id)) as number;
      started.add(pid);
      expect((await cli("close", "--session", id)).code).toBe(0);
      await waitForExit(pid);
    } finally {
      unrelated.kill();
      await unrelated.exited;
    }
  }, 60_000);

  test("a lock naming another session's healthy daemon gives no kill verb, with ps or without", async () => {
    const a = await savedSession();
    const rb = await cli("open", "--no-open");
    const b = (JSON.parse(rb.out) as { session_id: string }).session_id;
    const bPid = pointerPid(pointerFile(b)) as number;
    started.add(bPid);
    // Restored, so its command line names its session.
    expect((await cli("close", "--session", b)).code).toBe(0);
    await waitForExit(bPid);
    expect((await cli("open", "--no-open", "--restore", b)).code).toBe(0);
    const bLive = pointerPid(pointerFile(b)) as number;
    started.add(bLive);
    // No ps: whatever the lock says, nothing confirms the pid.
    plant(a, { pid: bLive, at: Date.now() - 3_600_000 });
    noKill(
      await cliEnv(
        { ...env, PATH: noPs },
        "open",
        "--no-open",
        "--restore",
        a,
        "--start-timeout",
        "5",
      ),
      bLive,
      a,
    );
    // With ps, and a lock that even claims session a and a time after b's
    // daemon started (a hand-made lie): b's command line names session b.
    plant(a, { pid: bLive, at: Date.now(), session: a });
    const r = await cli("open", "--no-open", "--restore", a, "--start-timeout", "5");
    noKill(r, bLive, a);
    expect(envelope(r).hint).toContain(`it is the daemon of session ${b}`);
    expect(alive(bLive)).toBe(true);
    rmSync(lockFile(a));
    expect((await cli("close", "--session", b)).code).toBe(0);
    await waitForExit(bLive);
  }, 90_000);

  // One test per guard of `confirmHolder`: each case passes every other guard,
  // so only the one under test keeps the stop verb off.

  test("the daemon-entry guard: a lock for this session naming a live process that is no daemon gives no kill", async () => {
    const id = await savedSession();
    const other = Bun.spawn(["sleep", "120"], { env });
    try {
      // Running before the lock was written, so not a reused pid: held, with ps.
      await Bun.sleep(1500);
      plant(id, { pid: other.pid, at: Date.now(), session: id });
      const r = await cli("open", "--no-open", "--restore", id, "--start-timeout", "5");
      noKill(r, other.pid, id);
      expect(envelope(r).hint).toContain("it is not running");
      rmSync(lockFile(id));
    } finally {
      other.kill();
      await other.exited;
    }
  }, 60_000);

  test("the session guard: a lock that names no session gives no kill, even naming a live daemon of this app", async () => {
    const a = await savedSession();
    // A new session's daemon: its command line names no session.
    const rb = await cli("open", "--no-open");
    const b = (JSON.parse(rb.out) as { session_id: string }).session_id;
    const bPid = pointerPid(pointerFile(b)) as number;
    started.add(bPid);
    await Bun.sleep(1500);
    plant(a, { pid: bPid, at: Date.now() });
    const r = await cli("open", "--no-open", "--restore", a, "--start-timeout", "5");
    noKill(r, bPid, a);
    expect(envelope(r).hint).toContain("the lock does not say which session it was taken for");
    expect(alive(bPid)).toBe(true);
    rmSync(lockFile(a));
    expect((await cli("close", "--session", b)).code).toBe(0);
    await waitForExit(bPid);
  }, 60_000);

  test("the start-time guard: a process of this app's daemon entry started after the lock gives no kill", async () => {
    const id = await savedSession();
    // `ps` that answers the CLI and not the daemon: the daemon then trusts the
    // live pid and refuses, and only the CLI's own start-time check is left.
    const shim = join(root, "psshim");
    mkdirSync(shim, { recursive: true });
    writeFileSync(
      join(shim, "ps"),
      `#!/bin/sh\ncase "$(/bin/ps -ww -o command= -p $PPID)" in *fixtures/server.ts*) exit 1;; esac\nexec /bin/ps "$@"\n`,
    );
    chmodSync(join(shim, "ps"), 0o755);
    // Its command line carries the daemon entry; it is not a daemon.
    const entry = join(dirname(CLI), "server.ts");
    const fake = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1e6)", entry], { env });
    try {
      await Bun.sleep(500);
      // Written an hour before the process started: its pid was reused.
      plant(id, { pid: fake.pid, at: Date.now() - 3_600_000, session: id });
      const r = await cliEnv(
        { ...env, PATH: `${shim}:${process.env.PATH}` },
        "open",
        "--no-open",
        "--restore",
        id,
        "--start-timeout",
        "5",
      );
      noKill(r, fake.pid, id);
      expect(envelope(r).hint).toContain("it started after the lock was taken");
      rmSync(lockFile(id));
    } finally {
      fake.kill();
      await fake.exited;
    }
  }, 60_000);
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

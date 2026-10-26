// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKeyToId } from "./cli.ts";
import {
  type Backup,
  brokenPsDir,
  type CliResult,
  daemonPids,
  hermeticEnv,
  killBoard,
  liveTitles,
  onlyEnvelope,
  runCli,
  runCliAbs,
  SERVER,
  seedClosed,
  TEST_TMPDIR,
  titlesAt,
  uniqHome,
} from "./fixtures/serverSuite.ts";

describe("(a) one daemon per id", () => {
  test("N parallel keyed opens start exactly ONE daemon, and every open reports the same board", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `lock-${crypto.randomUUID().slice(0, 8)}`;
    const id = sessionKeyToId(key);
    try {
      const N = 5;
      // ⚠ NO `--timeout` (nor --title / --restore) ON THESE OPENS. A board
      // answers ~100 ms after spawn, so an open whose own process starts that
      // much late (a loaded CI runner starting five `bun`s at once) finds the
      // board LIVE at its entry check, takes the plain attach path, and #80.1
      // refuses there, exit 2, because `--timeout` cannot take effect on a
      // running board. That refusal is the ruled contract, not a lock bug: the
      // same open run a second later exits 2 the same way. With the flag, 60 ms
      // of start skew failed 95/100 races; without it, 0/200 at 300 ms. This
      // cell is about the LOCK, so it passes only the flags the attach honours;
      // `killBoard` below bounds the daemon instead.
      const opens = await Promise.all(
        Array.from({ length: N }, () =>
          runCli(["open", "--session-key", key, "--no-open"], { env }),
        ),
      );
      for (const o of opens) expect(o.code).toBe(0);
      const boards = opens.map((o) => JSON.parse(o.stdout) as { port: number; session_id: string });
      expect(new Set(boards.map((b) => b.session_id))).toEqual(new Set([id]));
      expect(new Set(boards.map((b) => b.port)).size).toBe(1);
      // Let any loser daemon finish booting (or dying) before counting.
      await Bun.sleep(1500);
      expect(daemonPids(id).length).toBe(1);
      const st = await fetch(`http://127.0.0.1:${boards[0]?.port}/state`);
      expect(st.ok).toBe(true);
      expect((await runCli(["close", "--session", id], { env })).code).toBe(0);
      await Bun.sleep(300);
      expect(daemonPids(id)).toEqual([]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("a second daemon for a live id exits before touching the snapshot", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `lock2-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["keep-a", "keep-b"], env);
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const snap = join(home, "snapshots", `${id}.json`);
      const before = readFileSync(snap, "utf8");
      // A second daemon for the same id, spawned the way `open` spawns one but
      // with no --restore: an EMPTY board, the orphan's shape.
      const second = Bun.spawn({
        cmd: ["bun", "run", SERVER, "--no-open", "--id", id, "--timeout", "30"],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...hermeticEnv(), BOUNTY_HOME: home },
      });
      const exited = await Promise.race([
        second.exited,
        Bun.sleep(5000).then(() => "RUNNING" as const),
      ]);
      if (exited === "RUNNING") second.kill("SIGKILL");
      expect(exited).not.toBe("RUNNING");
      expect(exited).not.toBe(0);
      expect(await new Response(second.stderr).text()).toContain("already running");
      expect(readFileSync(snap, "utf8")).toBe(before);
      expect(await liveTitles(id, env)).toEqual(["keep-a", "keep-b"]);
      expect(daemonPids(id).length).toBe(1);
      await runCli(["close", "--session", id], { env });
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("a STALE lock (its pid is dead) is taken over, and a clean exit releases it", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `lock3-${crypto.randomUUID().slice(0, 8)}`;
    const id = sessionKeyToId(key);
    // A pid that is certainly dead: a process that has already exited.
    const gone = Bun.spawnSync(["true"]).pid;
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(join(home, "locks", `${id}.lock`), JSON.stringify({ pid: gone, port: 1 }));
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const lock = JSON.parse(readFileSync(join(home, "locks", `${id}.lock`), "utf8")) as {
        pid: number;
        port: number;
      };
      expect(daemonPids(id)).toEqual([lock.pid]);
      expect(lock.port).toBe((JSON.parse(o.stdout) as { port: number }).port);
      await runCli(["close", "--session", id], { env });
      await Bun.sleep(300);
      expect(existsSync(join(home, "locks", `${id}.lock`))).toBe(false);
    } finally {
      killBoard(id);
    }
  }, 30000);

  test("a lock naming a LIVE pid that is not this board's daemon (a reused pid) is taken over", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `lock4-${crypto.randomUUID().slice(0, 8)}`;
    const id = sessionKeyToId(key);
    mkdirSync(join(home, "locks"), { recursive: true });
    // This test process is alive and is not a bounty daemon for `id`.
    writeFileSync(join(home, "locks", `${id}.lock`), JSON.stringify({ pid: process.pid }));
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      expect(daemonPids(id).length).toBe(1);
      await runCli(["close", "--session", id], { env });
    } finally {
      killBoard(id);
    }
  }, 30000);

  test("close, reopen and --fresh in quick succession: a dying daemon's lock never refuses its successor", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `lock5-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["one"], env);
    try {
      for (let i = 0; i < 3; i++) {
        const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
          env,
        });
        expect(o.code).toBe(0);
        expect(await liveTitles(id, env)).toEqual(["one"]);
        const f = await runCli(
          [
            "open",
            "--session-key",
            key,
            "--fresh",
            "--restore",
            id,
            "--no-open",
            "--timeout",
            "30",
          ],
          { env },
        );
        expect(f.code).toBe(0);
        expect(await liveTitles(id, env)).toEqual(["one"]);
        expect((await runCli(["close", "--session", id], { env })).code).toBe(0);
      }
      expect(daemonPids(id)).toEqual([]);
    } finally {
      killBoard(id);
    }
  }, 60000);
});

describe("(b) --fresh --restore <own id> on a live board restores the SNAPSHOT", () => {
  test("cell 6 — live 0 over snapshot 2: the board comes back with 2, and the copy is named", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `fr6-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["x", "y"], env);
    try {
      await runCli(["open", "--session-key", key, "--fresh", "--no-open", "--timeout", "30"], {
        env,
      });
      const snap = join(home, "snapshots", `${id}.json`);
      // PRECONDITION, its own cell: live 0, snapshot 2.
      expect(await liveTitles(id, env)).toEqual([]);
      expect(titlesAt(snap)).toEqual(["x", "y"]);

      const r = await runCli(
        ["open", "--session-key", key, "--fresh", "--restore", id, "--no-open", "--timeout", "30"],
        { env },
      );
      expect(r.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["x", "y"]);
      const hs = JSON.parse(r.stdout) as { snapshotBackups: Backup[] };
      const pre = hs.snapshotBackups.find((b) => b.kind === "pre-fresh");
      expect(pre).toBeDefined();
      expect(pre?.taskCount).toBe(2);
      expect(pre?.path).toContain(`${id}.pre-fresh-`);
      expect(titlesAt(pre?.path as string)).toEqual(["x", "y"]);
      expect(pre?.restore).toContain("--fresh --restore");
      await runCli(["close", "--session", id], { env });
      expect(titlesAt(snap)).toEqual(["x", "y"]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("cell 7a — a live board that DIFFERS at equal counts: the snapshot's board comes back, not the live one", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `fr7-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["old0", "old1"], env);
    try {
      await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
      await runCli(["add", "live-extra", "--session", id], { env });
      const first = (
        JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
          state: { tasks: { id: string }[] };
        }
      ).state.tasks[0]?.id as string;
      await runCli(["remove", first, "--session", id], { env });
      const snap = join(home, "snapshots", `${id}.json`);
      // PRECONDITION: they differ, at equal counts (acted inside the debounce).
      expect(await liveTitles(id, env)).toEqual(["old1", "live-extra"]);
      expect(titlesAt(snap)).toEqual(["old0", "old1"]);

      const r = await runCli(
        ["open", "--session-key", key, "--fresh", "--restore", id, "--no-open", "--timeout", "30"],
        { env },
      );
      expect(r.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["old0", "old1"]);
      // The restored board reaches its own snapshot on the debounce, not at its
      // first mutation: a SIGKILL now must not leave the torn-down board there.
      const flushed = Date.now() + 5000;
      while (Date.now() < flushed && titlesAt(snap).join() !== "old0,old1") await Bun.sleep(100);
      expect(titlesAt(snap)).toEqual(["old0", "old1"]);
      await runCli(["close", "--session", id], { env });
      expect(titlesAt(snap)).toEqual(["old0", "old1"]);
    } finally {
      killBoard(id);
    }
  }, 60000);
});

describe("(c) an unreadable snapshot is copied aside, never written over", () => {
  test("3d — a TRUNCATED snapshot: restoreFailed, the bytes copied aside, and the copy named on open", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `c3d-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["t0", "t1", "t2"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    const corrupt = readFileSync(snap, "utf8").slice(0, 60);
    writeFileSync(snap, corrupt);
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const hs = JSON.parse(o.stdout) as {
        restoreFailed: { path: string } | null;
        snapshotBackups: Backup[];
      };
      expect(hs.restoreFailed?.path).toBe(snap);
      const copy = hs.snapshotBackups.find((b) => b.kind === "unreadable");
      expect(copy).toBeDefined();
      expect(copy?.taskCount).toBeNull();
      expect(copy?.path).toContain(`${id}.unreadable-`);
      expect(readFileSync(copy?.path as string, "utf8")).toBe(corrupt);
      await runCli(["add", "new", "--session", id], { env });
      await runCli(["close", "--session", id], { env });
      expect(readFileSync(copy?.path as string, "utf8")).toBe(corrupt);
      const all = readdirSync(join(home, "snapshots")).filter((f) =>
        f.startsWith(`${id}.unreadable-`),
      );
      expect(all.length).toBe(1); // copied ONCE, not once per write
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("3e — valid JSON whose `tasks` is not an array is restoreFailed (not silently []), and is copied aside", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `c3e-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["t0", "t1", "t2"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    const s = JSON.parse(readFileSync(snap, "utf8")) as { tasks: unknown };
    s.tasks = { legacy: s.tasks };
    const odd = JSON.stringify(s);
    writeFileSync(snap, odd);
    try {
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      const hs = JSON.parse(o.stdout) as {
        restoreFailed: { path: string; reason: string } | null;
      };
      expect(hs.restoreFailed).not.toBeNull();
      expect(hs.restoreFailed?.path).toBe(snap);
      expect(hs.restoreFailed?.reason).toContain("tasks");
      await runCli(["close", "--session", id], { env });
      const copies = readdirSync(join(home, "snapshots")).filter((f) =>
        f.startsWith(`${id}.unreadable-`),
      );
      expect(copies.length).toBe(1);
      expect(readFileSync(join(home, "snapshots", copies[0] as string), "utf8")).toBe(odd);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("a board that never tried to restore still copies an unreadable file aside before its first write", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `c3x-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["t0"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    writeFileSync(snap, "{not json");
    try {
      // --fresh: no restore is attempted, so only saveSnapshot can protect it.
      await runCli(["open", "--session-key", key, "--fresh", "--no-open", "--timeout", "30"], {
        env,
      });
      await runCli(["add", "new", "--session", id], { env });
      const c = await runCli(["close", "--session", id], { env });
      const copies = readdirSync(join(home, "snapshots")).filter((f) =>
        f.startsWith(`${id}.unreadable-`),
      );
      expect(copies.length).toBe(1);
      expect(readFileSync(join(home, "snapshots", copies[0] as string), "utf8")).toBe("{not json");
      const closed = JSON.parse(c.stdout) as { snapshotBackups: Backup[] };
      expect(closed.snapshotBackups.map((b) => b.kind)).toEqual(["unreadable"]);
    } finally {
      killBoard(id);
    }
  }, 60000);
});

describe("(d) a backup this act made is named to the caller", () => {
  test("close names the shrink backup, with its task count and the act that recovers it", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `d1-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a", "b", "c"], env);
    try {
      await runCli(["open", "--session-key", key, "--fresh", "--no-open", "--timeout", "30"], {
        env,
      });
      await runCli(["add", "only", "--session", id], { env });
      const c = await runCli(["close", "--session-key", key], { env });
      expect(c.code).toBe(0);
      const e = JSON.parse(c.stdout) as { ok: boolean; snapshotBackups: Backup[] };
      expect(e.ok).toBe(true);
      expect(e.snapshotBackups.length).toBe(1);
      const b = e.snapshotBackups[0] as Backup;
      expect(b.kind).toBe("shrink");
      expect(b.taskCount).toBe(3);
      expect(titlesAt(b.path)).toEqual(["a", "b", "c"]);
      const bakId = (b.path.split("/").pop() as string).replace(/\.json$/, "");
      expect(b.restore).toBe(`open --session-key ${key} --fresh --restore ${bakId} --no-open`);
      // and the act works as printed
      const back = await runCli([...b.restore.split(" "), "--timeout", "30"], { env });
      expect(back.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["a", "b", "c"]);
      await runCli(["close", "--session", id], { env });
    } finally {
      killBoard(id);
    }
  }, 60000);

  // Found checking route 1's other kinds (2026-09-28): a shrink backup's
  // restore, run after newer work reached the snapshot, wrote the backup over
  // it with no copy (no count shrank), so the newer work was in no file.
  test("restoring a backup over a newer snapshot keeps the newer one first, and names it", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `d3-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["a", "b", "c"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    try {
      await runCli(["open", "--session-key", key, "--fresh", "--no-open", "--timeout", "30"], {
        env,
      });
      await runCli(["add", "newer", "--session", id], { env });
      const c = await runCli(["close", "--session-key", key], { env });
      const shrink = (JSON.parse(c.stdout) as { snapshotBackups: Backup[] }).snapshotBackups[0];
      expect(titlesAt(snap)).toEqual(["newer"]);
      const back = await runCli([...(shrink as Backup).restore.split(" "), "--timeout", "30"], {
        env,
      });
      expect(back.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["a", "b", "c"]);
      const named = (JSON.parse(back.stdout) as { snapshotBackups: Backup[] }).snapshotBackups;
      const kept = named.find((b) => titlesAt(b.path).includes("newer"));
      expect(kept).toBeDefined();
      expect(kept?.restore).toContain("--restore");
      await runCli(["close", "--session", id], { env });
      expect(titlesAt(snap)).toEqual(["a", "b", "c"]);
      expect(titlesAt(kept?.path as string)).toEqual(["newer"]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("a close that backed nothing up says so: snapshotBackups is PRESENT and empty", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const o = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const hs = JSON.parse(o.stdout) as { session_id: string; snapshotBackups: Backup[] };
    try {
      expect(hs.snapshotBackups).toEqual([]);
      await runCli(["add", "x", "--session", hs.session_id], { env });
      const c = await runCli(["close", "--session", hs.session_id], { env });
      expect(JSON.parse(c.stdout)).toEqual({
        ok: true,
        sent: "close",
        down: true,
        snapshotBackups: [],
      });
    } finally {
      // Unkeyed: its argv has no --id, so killBoard cannot see it. Close it.
      await runCli(["close", "--session", hs.session_id], { env });
    }
  }, 30000);
});

describe("liveness that cannot be checked is a clean refusal", () => {
  for (const variant of ["no ps on PATH", "a ps that runs and fails"] as const) {
    test(`${variant}: open refuses with one envelope naming the lock, the pid and why`, async () => {
      const home = uniqHome();
      const key = `nops-${crypto.randomUUID().slice(0, 8)}`;
      const id = sessionKeyToId(key);
      const lock = join(home, "locks", `${id}.lock`);
      mkdirSync(join(home, "locks"), { recursive: true });
      // A live pid that is not this board's daemon: without `ps`, nothing can tell.
      writeFileSync(lock, JSON.stringify({ pid: process.pid, port: 1 }));
      const PATH = variant === "no ps on PATH" ? "/nonexistent" : brokenPsDir();
      try {
        const r = await runCliAbs(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
          BOUNTY_HOME: home,
          PATH,
        });
        expect(r).not.toBe("HUNG");
        const res = r as CliResult;
        expect(res.stdout).toBe("");
        const env = onlyEnvelope(res.stderr);
        expect(env.error.kind).toBe("conflict");
        expect(res.code).toBe(6);
        expect(env.error.message).toContain(lock);
        expect(env.error.message).toContain(`pid ${process.pid}`);
        expect(env.error.message).toContain("ps");
        expect(env.error.hint ?? "").toContain(lock);
        expect(daemonPids(id)).toEqual([]);
        // Refusing never takes over a holder it cannot judge.
        expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({ pid: process.pid, port: 1 });
      } finally {
        killBoard(id);
      }
    }, 30000);
  }

  test("the daemon itself exits before touching anything, with a line in daemon.log", async () => {
    const home = uniqHome();
    const id = `nopsd-${crypto.randomUUID().slice(0, 8)}`;
    mkdirSync(join(home, "locks"), { recursive: true });
    mkdirSync(join(home, "snapshots"), { recursive: true });
    const snap = join(home, "snapshots", `${id}.json`);
    writeFileSync(snap, JSON.stringify({ title: "t", tasks: [] }));
    const before = readFileSync(snap, "utf8");
    writeFileSync(join(home, "locks", `${id}.lock`), JSON.stringify({ pid: process.pid }));
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", SERVER, "--no-open", "--id", id, "--restore", id],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...hermeticEnv(), BOUNTY_HOME: home, PATH: "/nonexistent" },
    });
    try {
      const exited = await Promise.race([
        proc.exited,
        Bun.sleep(8000).then(() => "RUNNING" as const),
      ]);
      expect(exited).toBe(6);
      expect(await new Response(proc.stderr).text()).toContain("cannot tell");
      const log = readFileSync(join(home, "daemon.log"), "utf8");
      expect(log).toContain('"reason":"lockLivenessUnknown"');
      expect(log).not.toContain("uncaughtException");
      expect(readFileSync(snap, "utf8")).toBe(before);
      expect(existsSync(join(TEST_TMPDIR, `bounty-${id}.json`))).toBe(false);
    } finally {
      proc.kill("SIGKILL");
      killBoard(id);
    }
  }, 30000);
});

describe("an unresponsive daemon is bounded, never waited on forever", () => {
  test("open and close against a SIGSTOPped daemon each end with an envelope naming the pid", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `stop-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "60"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    const pid = (
      JSON.parse(readFileSync(join(home, "locks", `${id}.lock`), "utf8")) as {
        pid: number;
      }
    ).pid;
    process.kill(pid, "SIGSTOP");
    try {
      const r = await runCliAbs(["open", "--session-key", key, "--no-open"], env, 25000);
      expect(r).not.toBe("HUNG");
      const res = r as CliResult;
      expect(res.stdout).toBe("");
      const e = onlyEnvelope(res.stderr);
      expect(e.error.message).toContain("not answering");
      expect(e.error.message).toContain(`pid ${pid}`);
      expect(res.code).toBe(e.error.exit_code);

      const c = await runCliAbs(["close", "--session-key", key], env, 25000);
      expect(c).not.toBe("HUNG");
      const cres = c as CliResult;
      expect(cres.stdout).toBe("");
      const ce = onlyEnvelope(cres.stderr);
      expect(ce.error.message).toContain(`pid ${pid}`);
      expect(cres.code).toBe(ce.error.exit_code);
      expect(cres.code).not.toBe(0);
      // Never two daemons for the board, stopped or not.
      expect(daemonPids(id)).toEqual([pid]);
    } finally {
      try {
        process.kill(pid, "SIGCONT");
      } catch {}
      killBoard(id);
    }
  }, 70000);
});

// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Backup,
  backupHolding,
  killBoard,
  type NamedBackupT,
  runCli,
  type SaveFailed,
  seedClosed,
  titlesAt,
  uniqHome,
} from "./fixtures/serverSuite.ts";

describe("a daemon never writes over a snapshot it has not read or kept", () => {
  test("route A: --fresh --restore <other> with snapshots/ read-only, then a heal: the old board is kept, with its restore", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const keyP = `ra-p-${crypto.randomUUID().slice(0, 8)}`;
    const keyQ = `ra-q-${crypto.randomUUID().slice(0, 8)}`;
    const pid = await seedClosed(keyP, ["p1-precious", "p2-precious"], env);
    const qid = await seedClosed(keyQ, ["q1"], env);
    const sn = join(home, "snapshots");
    const snap = join(sn, `${pid}.json`);
    try {
      chmodSync(sn, 0o555);
      const o = await runCli(
        [
          "open",
          "--session-key",
          keyP,
          "--fresh",
          "--restore",
          qid,
          "--no-open",
          "--timeout",
          "30",
        ],
        { env },
      );
      expect(o.code).toBe(0);
      await Bun.sleep(1600); // the debounced write of the restored board
      const st = JSON.parse((await runCli(["state", "--session", pid], { env })).stdout) as {
        snapshotSaveFailed: (SaveFailed & { fix: string }) | null;
      };
      // The write did not happen: the old board was never copied aside.
      expect(st.snapshotSaveFailed?.path).toBe(snap);
      expect(st.snapshotSaveFailed?.error ?? "").toContain("could not be copied aside");
      expect(st.snapshotSaveFailed?.fix ?? "").toContain(`make the folder ${sn} writable`);
      expect(titlesAt(snap)).toEqual(["p1-precious", "p2-precious"]);

      chmodSync(sn, 0o755);
      await runCli(["add", "q2", "--session", pid], { env });
      await Bun.sleep(1600);
      const c = await runCli(["close", "--session-key", keyP], { env });
      expect(c.code).toBe(0);
      expect(titlesAt(snap)).toEqual(["q1", "q2"]);
      const named = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      const kept = backupHolding(named, "p1-precious");
      expect(kept).toBeDefined();
      expect(kept?.kind).toBe("unread");
      expect(kept?.taskCount).toBe(2);
      expect(kept?.restore ?? "").toContain("--restore");
      expect(titlesAt(kept?.path as string)).toEqual(["p1-precious", "p2-precious"]);
    } finally {
      try {
        chmodSync(sn, 0o755);
      } catch {}
      killBoard(pid);
    }
  }, 60000);

  test("route B: a restore while the board's own snapshot is mode 000, then a heal: the old board is kept", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const keyP = `rb-p-${crypto.randomUUID().slice(0, 8)}`;
    const keyQ = `rb-q-${crypto.randomUUID().slice(0, 8)}`;
    const pid = await seedClosed(keyP, ["p1-precious", "p2-precious"], env);
    const qid = await seedClosed(keyQ, ["q1", "q2"], env);
    const snap = join(home, "snapshots", `${pid}.json`);
    try {
      chmodSync(snap, 0o000);
      const o = await runCli(
        [
          "open",
          "--session-key",
          keyP,
          "--fresh",
          "--restore",
          qid,
          "--no-open",
          "--timeout",
          "30",
        ],
        { env },
      );
      expect(o.code).toBe(0);
      await Bun.sleep(1600);
      chmodSync(snap, 0o644);
      await Bun.sleep(1600);
      const c = await runCli(["close", "--session-key", keyP], { env });
      expect(c.code).toBe(0);
      expect(titlesAt(snap)).toEqual(["q1", "q2"]);
      const named = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      const kept = backupHolding(named, "p1-precious");
      expect(kept?.kind).toBe("unread");
      expect(kept?.restore ?? "").toContain("--restore");
    } finally {
      try {
        chmodSync(snap, 0o644);
      } catch {}
      killBoard(pid);
    }
  }, 60000);

  test("respawn route: a keyed respawn over a mode-000 snapshot, work added, then a heal: the old board is kept", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rr-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["p1-precious", "p2-precious"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    try {
      chmodSync(snap, 0o000);
      const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect(o.code).toBe(0);
      await runCli(["add", "n1", "--session", id], { env });
      await runCli(["add", "n2", "--session", id], { env });
      await Bun.sleep(1600);
      chmodSync(snap, 0o644);
      await Bun.sleep(1600);
      const c = await runCli(["close", "--session-key", key], { env });
      expect(c.code).toBe(0);
      expect(titlesAt(snap)).toEqual(["n1", "n2"]);
      const named = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      const kept = backupHolding(named, "p1-precious");
      expect(kept?.kind).toBe("unread");
      expect(kept?.restore ?? "").toContain("--restore");
      // "superseded, nothing to do" is said only beside the kept copy's act.
      if (c.stderr.includes("superseded")) expect(c.stderr).toContain("recover with:");
    } finally {
      try {
        chmodSync(snap, 0o644);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  test("a restore whose board differs from the snapshot only in its title keeps the snapshot first", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rt-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(
      ["open", "--session-key", key, "--title", "Alpha", "--no-open", "--timeout", "30"],
      { env },
    );
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "t1", "--session", id], { env });
      await runCli(["close", "--session", id], { env });
      const snap = join(home, "snapshots", `${id}.json`);
      const board = JSON.parse(readFileSync(snap, "utf8")) as { title: string };
      expect(board.title).toBe("Alpha");
      const other = join(home, "beta.json");
      writeFileSync(other, JSON.stringify({ ...board, title: "Beta" }));
      const r = await runCli(
        ["open", "--session-key", key, "--restore", other, "--no-open", "--timeout", "30"],
        { env },
      );
      expect(r.code).toBe(0);
      const c = await runCli(["close", "--session", id], { env });
      expect((JSON.parse(readFileSync(snap, "utf8")) as { title: string }).title).toBe("Beta");
      const all = [
        ...(JSON.parse(r.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups,
        ...(JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups,
      ];
      const kept = all.find(
        (b) => (JSON.parse(readFileSync(b.path, "utf8")) as { title: string }).title === "Alpha",
      );
      expect(kept).toBeDefined();
      expect(kept?.restore ?? "").toContain("--restore");
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("--fresh over a snapshot, then a board that GROWS past it: the old board is kept once", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rf-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["old"], env);
    try {
      await runCli(["open", "--session-key", key, "--fresh", "--no-open", "--timeout", "30"], {
        env,
      });
      await runCli(["add", "x", "--session", id], { env });
      await runCli(["add", "y", "--session", id], { env });
      const c = await runCli(["close", "--session", id], { env });
      const named = (JSON.parse(c.stdout) as { snapshotBackups: NamedBackupT[] }).snapshotBackups;
      expect(named.map((b) => b.kind)).toEqual(["unread"]);
      expect(titlesAt(named[0]?.path as string)).toEqual(["old"]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  // The cost check: the rule fires only when the daemon did not read the file.
  test("no cost on the common paths: open/add/close and a keyed respawn/add/close back nothing up and leave no new file", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `rc-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    try {
      expect((JSON.parse(o.stdout) as { snapshotBackups: Backup[] }).snapshotBackups).toEqual([]);
      await runCli(["add", "a", "--session", id], { env });
      await Bun.sleep(1600); // a debounced write, then the close's
      const c1 = await runCli(["close", "--session", id], { env });
      expect((JSON.parse(c1.stdout) as { snapshotBackups: Backup[] }).snapshotBackups).toEqual([]);
      expect(readdirSync(join(home, "snapshots"))).toEqual([`${id}.json`]);

      const r = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], {
        env,
      });
      expect((JSON.parse(r.stdout) as { snapshotBackups: Backup[] }).snapshotBackups).toEqual([]);
      await runCli(["add", "b", "--session", id], { env });
      await Bun.sleep(1600);
      const c2 = await runCli(["close", "--session", id], { env });
      expect(c2.code).toBe(0);
      expect((JSON.parse(c2.stdout) as { snapshotBackups: Backup[] }).snapshotBackups).toEqual([]);
      expect(readdirSync(join(home, "snapshots"))).toEqual([`${id}.json`]);
      expect(titlesAt(join(home, "snapshots", `${id}.json`))).toEqual(["a", "b"]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("no cost unkeyed: open/add/close backs nothing up and leaves one file", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const o = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    await runCli(["add", "a", "--session", id], { env });
    await Bun.sleep(1600);
    const c = await runCli(["close", "--session", id], { env });
    expect((JSON.parse(c.stdout) as { snapshotBackups: Backup[] }).snapshotBackups).toEqual([]);
    expect(readdirSync(join(home, "snapshots"))).toEqual([`${id}.json`]);
  }, 30000);
});

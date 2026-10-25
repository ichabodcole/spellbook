// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  daemonPids,
  killBoard,
  liveTitles,
  onlyEnvelope,
  restoreFromHint,
  runCli,
  type SaveFailed,
  seedClosed,
  titlesAt,
  uniqHome,
} from "./fixtures/serverSuite.ts";

describe("a snapshot write that fails is reported, and the board is kept", () => {
  test("snapshot path is a DIRECTORY: state says so mid-session, close fails, and the printed restore brings the work back", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `sdir-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    const snap = join(home, "snapshots", `${id}.json`);
    try {
      mkdirSync(snap, { recursive: true });
      await runCli(["add", "new1", "--session", id], { env });
      await Bun.sleep(1600); // past the ~1s debounce
      // Mid-session: the failed debounced write is readable on `state`.
      const st = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        snapshotSaveFailed: SaveFailed;
      };
      expect(st.snapshotSaveFailed?.path).toBe(snap);
      const mid = st.snapshotSaveFailed?.unsaved as string;
      expect(mid).not.toBe(snap);
      expect(titlesAt(mid)).toEqual(["new1"]);

      const c = await runCli(["close", "--session-key", key], { env });
      expect(c.stdout).toBe("");
      const e = onlyEnvelope(c.stderr);
      expect(e.error.kind).toBe("conflict");
      expect(c.code).toBe(6);
      expect(e.error.message).toContain(snap);
      // The real cause, not the copy error from setting the old file aside.
      const why = (e.error.server as { snapshotSaveFailed: SaveFailed }).snapshotSaveFailed?.error;
      expect(why).not.toContain("copyfile");
      expect(why).toContain("EISDIR");
      expect(e.error.hint ?? "").toContain(`remove the directory ${snap}`);
      const server = e.error.server as { snapshotSaveFailed: SaveFailed };
      const unsaved = server.snapshotSaveFailed?.unsaved as string;
      expect(e.error.message).toContain(unsaved);
      expect(titlesAt(unsaved)).toEqual(["new1"]);
      expect(daemonPids(id)).toEqual([]);

      rmSync(snap, { recursive: true });
      const back = await runCli([...restoreFromHint(e.error.hint), "--timeout", "30"], { env });
      expect(back.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["new1"]);
      expect((await runCli(["close", "--session", id], { env })).code).toBe(0);
      expect(titlesAt(snap)).toEqual(["new1"]);
    } finally {
      killBoard(id);
    }
  }, 60000);

  test("snapshot NOT WRITABLE (mode 000): close fails and names the dump; the old snapshot is untouched", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `sperm-${crypto.randomUUID().slice(0, 8)}`;
    const id = await seedClosed(key, ["s1", "s2", "s3"], env);
    const snap = join(home, "snapshots", `${id}.json`);
    const before = readFileSync(snap, "utf8");
    chmodSync(snap, 0o000);
    try {
      await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
      await runCli(["add", "new1", "--session", id], { env });
      const c = await runCli(["close", "--session-key", key], { env });
      expect(c.stdout).toBe("");
      const e = onlyEnvelope(c.stderr);
      expect(e.error.kind).toBe("conflict");
      expect(c.code).toBe(6);
      const unsaved = (e.error.server as { snapshotSaveFailed: SaveFailed }).snapshotSaveFailed
        ?.unsaved as string;
      expect(titlesAt(unsaved)).toEqual(["new1"]);
      expect(e.error.hint ?? "").toContain("--restore");
      // The real cause, not the copy error from setting the old file aside.
      const why = (e.error.server as { snapshotSaveFailed: SaveFailed }).snapshotSaveFailed?.error;
      expect(why).not.toContain("copyfile");
      expect(why).toContain("EACCES");
      expect(e.error.hint ?? "").toContain(`make ${snap} readable and writable`);
      chmodSync(snap, 0o644);
      expect(readFileSync(snap, "utf8")).toBe(before);
    } finally {
      try {
        chmodSync(snap, 0o644);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  test("snapshots/ itself unusable: the dump lands in $BOUNTY_HOME; with nowhere to write, close refuses and the board stays up", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `shome-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    try {
      writeFileSync(join(home, "snapshots"), "not a directory");
      await runCli(["add", "new1", "--session", id], { env });
      // Nowhere at all to write: the close is refused and the board kept.
      chmodSync(home, 0o555);
      const refused = await runCli(["close", "--session-key", key], { env });
      chmodSync(home, 0o755);
      expect(refused.stdout).toBe("");
      expect(onlyEnvelope(refused.stderr).error.kind).toBe("conflict");
      // The act rides a hint, as every other refusal's does.
      const rHint = onlyEnvelope(refused.stderr).error.hint ?? "";
      expect(rHint).toContain(home);
      expect(rHint).toContain(`then run: close --session ${id}`);
      expect(refused.code).toBe(6);
      expect(await liveTitles(id, env)).toEqual(["new1"]);

      // $BOUNTY_HOME writable again: the dump lands there, outside snapshots/.
      const c = await runCli(["close", "--session-key", key], { env });
      const e = onlyEnvelope(c.stderr);
      expect(c.code).toBe(6);
      const unsaved = (e.error.server as { snapshotSaveFailed: SaveFailed }).snapshotSaveFailed
        ?.unsaved as string;
      expect(dirname(unsaved)).toBe(home);
      // The path that is actually wrong is snapshots/ itself, not the file in it.
      expect(e.error.hint ?? "").toContain(`${join(home, "snapshots")} is a file`);
      expect(e.error.hint ?? "").not.toContain(join(home, "snapshots", `${id}.json`));
      expect(titlesAt(unsaved)).toEqual(["new1"]);
      rmSync(join(home, "snapshots"));
      const back = await runCli([...restoreFromHint(e.error.hint), "--timeout", "30"], { env });
      expect(back.code).toBe(0);
      expect(await liveTitles(id, env)).toEqual(["new1"]);
      await runCli(["close", "--session", id], { env });
    } finally {
      try {
        chmodSync(home, 0o755);
      } catch {}
      killBoard(id);
    }
  }, 60000);

  // Verifier, 2026-09-28 (route 1): the save failed, the path healed, a task was
  // added, and `close` exited 0 with the full snapshot while still offering the
  // older `unsaved` dump's restore. Running it rolled the board back.
  test("a later successful save supersedes the unsaved dump: kept on disk, never offered as a restore", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `ssup-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
    const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
    const snap = join(home, "snapshots", `${id}.json`);
    try {
      await runCli(["add", "a", "--session", id], { env });
      await Bun.sleep(1600);
      chmodSync(snap, 0o000);
      await runCli(["add", "b", "--session", id], { env });
      await Bun.sleep(1600); // the failed write dumps [a, b]
      chmodSync(snap, 0o644);
      await runCli(["add", "c", "--session", id], { env });
      await Bun.sleep(1600); // this write succeeds: [a, b, c]
      const c = await runCli(["close", "--session-key", key], { env });
      expect(c.code).toBe(0);
      expect(titlesAt(snap)).toEqual(["a", "b", "c"]);
      const out = JSON.parse(c.stdout) as {
        snapshotBackups: {
          kind: string;
          path: string;
          restore: string | null;
          superseded?: string;
        }[];
      };
      const dump = out.snapshotBackups.find((b) => b.kind === "unsaved");
      expect(dump).toBeDefined();
      // Not an act: no restore, and a note saying why.
      expect(dump?.restore).toBeNull();
      expect(dump?.superseded ?? "").toContain(snap);
      expect(c.stderr).not.toContain("recover with: open --session-key");
      // Kept: deleting it is the caller's call.
      expect(titlesAt(dump?.path as string)).toEqual(["a", "b"]);
    } finally {
      try {
        chmodSync(snap, 0o644);
      } catch {}
      killBoard(id);
    }
  }, 60000);
});

// Verifier, 2026-09-28 (route 2): with nothing writable only `close` was
// guarded, so the idle timeout ended the daemon and the unsaved tasks with it.
describe("with nothing writable, no request to end the board drops its tasks", () => {
  /** Open a keyed board, save [a], then make nothing writable and add b. */
  async function unwritableBoard(prefix: string, timeout: string) {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const key = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", timeout], {
      env,
    });
    const ready = JSON.parse(o.stdout) as { session_id: string; url: string };
    const id = ready.session_id;
    await runCli(["add", "a", "--session", id], { env });
    await Bun.sleep(1600);
    chmodSync(join(home, "snapshots"), 0o555);
    chmodSync(home, 0o555);
    await runCli(["add", "b", "--session", id], { env });
    const heal = () => {
      chmodSync(home, 0o755);
      chmodSync(join(home, "snapshots"), 0o755);
    };
    return { home, env, key, id, url: ready.url, heal };
  }

  test("the idle timeout is held (logged, and on state) until a save works, then it ends the board", async () => {
    const b = await unwritableBoard("idleh", "2");
    const snap = join(b.home, "snapshots", `${b.id}.json`);
    try {
      await Bun.sleep(4500); // well past the 2 s timeout
      expect(daemonPids(b.id).length).toBe(1);
      const st = JSON.parse(
        (await runCli(["state", "--session", b.id], { env: b.env })).stdout,
      ) as {
        snapshotSaveFailed: (SaveFailed & { held?: string | null }) | null;
      };
      expect(st.snapshotSaveFailed?.unsaved).toBeNull();
      expect(st.snapshotSaveFailed?.held ?? "").toContain("idle timeout");
      expect(readFileSync(join(b.home, "daemon.log"), "utf8")).toContain(
        '"reason":"idleCloseHeld"',
      );
      b.heal();
      // The next idle check saves, and the board ends as a timeout.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && daemonPids(b.id).length) await Bun.sleep(200);
      expect(daemonPids(b.id)).toEqual([]);
      expect(titlesAt(snap)).toEqual(["a", "b"]);
    } finally {
      try {
        b.heal();
      } catch {}
      killBoard(b.id);
    }
  }, 60000);

  test("the browser's Close board is refused the same way, and says so to the board", async () => {
    const b = await unwritableBoard("wsh", "60");
    const snap = join(b.home, "snapshots", `${b.id}.json`);
    try {
      const ws = new WebSocket(`${b.url.replace(/^http/, "ws")}/ws`);
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      const said: string[] = [];
      ws.addEventListener("message", (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string; text?: string };
        if (msg.type === "message" && msg.text) said.push(msg.text);
      });
      ws.send(JSON.stringify({ type: "close" }));
      await Bun.sleep(1500);
      expect(daemonPids(b.id).length).toBe(1);
      expect(said.join("\n")).toContain("not closed");
      ws.close();
      b.heal();
      expect((await runCli(["close", "--session", b.id], { env: b.env })).code).toBe(0);
      expect(titlesAt(snap)).toEqual(["a", "b"]);
    } finally {
      try {
        b.heal();
      } catch {}
      killBoard(b.id);
    }
  }, 60000);
});

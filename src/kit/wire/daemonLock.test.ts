// The per-session daemon lock (`daemonLock.ts`): one holder, stale locks
// recovered (a dead pid, a reused pid, bytes that are not a lock), and stale
// recovery itself raced by many processes at once, of which exactly one wins.
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_LOCK,
  lockHeld,
  parseEtime,
  readDaemonLock,
  releaseDaemonLock,
  takeDaemonLock,
} from "./daemonLock.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "daemon-lock-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const d = join(root, `s${n++}`);
  mkdirSync(d);
  return d;
};

/** A pid that was ours and has exited: a killed daemon's. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"], { env: process.env });
  await p.exited;
  return p.pid;
}

const writeLock = (dir: string, rec: { pid: number; nonce: string; at: number }) =>
  writeFileSync(join(dir, DAEMON_LOCK), `${JSON.stringify(rec)}\n`);
const lockOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, DAEMON_LOCK), "utf8")) as { pid: number; nonce: string };

describe("the daemon lock", () => {
  test("parseEtime reads ps's forms", () => {
    expect(parseEtime("   00:07\n")).toBe(7);
    expect(parseEtime("01:02:03")).toBe(3723);
    expect(parseEtime("2-01:00:00")).toBe(2 * 86400 + 3600);
    expect(parseEtime("")).toBeNull();
  });

  test("taken once; a second take in the same process is refused, naming the holder; release frees it", () => {
    const dir = freshDir();
    const a = takeDaemonLock(dir);
    expect(a.ok).toBe(true);
    const b = takeDaemonLock(dir);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.holder.pid).toBe(process.pid);
    if (a.ok) releaseDaemonLock(a.lock);
    expect(existsSync(join(dir, DAEMON_LOCK))).toBe(false);
    const c = takeDaemonLock(dir);
    expect(c.ok).toBe(true);
    if (c.ok) releaseDaemonLock(c.lock);
    // Nothing left behind: no temp file, no reap guard.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a lock whose pid is gone (a killed daemon) is recovered", async () => {
    const dir = freshDir();
    writeLock(dir, { pid: await deadPid(), nonce: "aa".repeat(12), at: Date.now() - 5000 });
    const r = takeDaemonLock(dir);
    expect(r.ok).toBe(true);
    expect(lockOf(dir).pid).toBe(process.pid);
    if (r.ok) releaseDaemonLock(r.lock);
  });

  test("a live pid that started after the lock was written is a reused pid: stale", () => {
    const dir = freshDir();
    // Our parent is alive. The lock says it was taken an hour ago; `ps` says
    // the process has run ten seconds: not the process that wrote it.
    const rec = { pid: process.ppid, nonce: "bb".repeat(12), at: Date.now() - 3_600_000 };
    expect(lockHeld(rec, () => 10)).toBe(false);
    // The same pid, running since before the lock: held.
    expect(lockHeld(rec, () => 7200)).toBe(true);
    // `ps` cannot say: a live pid is trusted.
    expect(lockHeld(rec, () => null)).toBe(true);
    writeLock(dir, rec);
    const held = takeDaemonLock(dir, () => 7200);
    expect(held.ok).toBe(false);
    const r = takeDaemonLock(dir, () => 10);
    expect(r.ok).toBe(true);
    if (r.ok) releaseDaemonLock(r.lock);
  });

  test("the real ps says a live process that predates its lock holds it", () => {
    const dir = freshDir();
    const rec = { pid: process.ppid, nonce: "cc".repeat(12), at: Date.now() };
    writeLock(dir, rec);
    expect(takeDaemonLock(dir).ok).toBe(false);
    rmSync(join(dir, DAEMON_LOCK));
  });

  test("a lock this process wrote and no longer holds is stale (an earlier owner of our pid)", () => {
    const dir = freshDir();
    writeLock(dir, { pid: process.pid, nonce: "dd".repeat(12), at: Date.now() });
    const r = takeDaemonLock(dir);
    expect(r.ok).toBe(true);
    if (r.ok) releaseDaemonLock(r.lock);
  });

  test("bytes that are not a lock are stale and replaced", () => {
    const dir = freshDir();
    writeFileSync(join(dir, DAEMON_LOCK), "not json");
    const r = takeDaemonLock(dir);
    expect(r.ok).toBe(true);
    if (r.ok) releaseDaemonLock(r.lock);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a release does not remove a lock someone else took since", () => {
    const dir = freshDir();
    const a = takeDaemonLock(dir);
    if (!a.ok) throw new Error("not taken");
    rmSync(join(dir, DAEMON_LOCK));
    writeLock(dir, { pid: process.ppid, nonce: "ee".repeat(12), at: Date.now() });
    releaseDaemonLock(a.lock);
    expect(lockOf(dir).nonce).toBe("ee".repeat(12));
  });
});

// The two windows of stale recovery, opened on purpose. The stale lock here is
// a reused pid's (our parent, alive, that `elapsed` says started ten seconds
// ago, after a lock dated an hour ago), so `elapsed` runs exactly when a
// starter has read the stale lock and not yet acted on it.
describe("stale recovery's own race, step by step", () => {
  const stale = () => ({ pid: process.ppid, nonce: "ab".repeat(12), at: Date.now() - 3_600_000 });
  const other = () => ({ pid: process.ppid, nonce: "cd".repeat(12), at: Date.now() });

  test("another starter recovered and took the lock after we read it: we do not remove theirs", () => {
    const dir = freshDir();
    writeLock(dir, stale());
    let interleaved = false;
    const r = takeDaemonLock(dir, () => {
      // The other starter's whole recovery happens here, between our read and our reap.
      if (!interleaved) {
        interleaved = true;
        rmSync(join(dir, DAEMON_LOCK));
        writeLock(dir, other());
      }
      return 10;
    });
    expect(interleaved).toBe(true);
    expect(r.ok).toBe(false);
    expect(lockOf(dir).nonce).toBe("cd".repeat(12));
  });

  test("another starter holds the reap guard: we leave the stale lock to it", () => {
    const dir = freshDir();
    const s = stale();
    writeLock(dir, s);
    // A live starter mid-recovery (it never finishes here).
    writeFileSync(join(dir, `${DAEMON_LOCK}.reap-${s.nonce}`), `${JSON.stringify(other())}\n`);
    const r = takeDaemonLock(dir, () => 10);
    expect(r.ok).toBe(false);
    expect(lockOf(dir).nonce).toBe(s.nonce);
  });

  test("a reap guard left by a starter that died mid-recovery is recovered too", async () => {
    const dir = freshDir();
    const s = stale();
    writeLock(dir, s);
    const dead = { pid: await deadPid(), nonce: "ef".repeat(12), at: Date.now() - 5000 };
    writeFileSync(join(dir, `${DAEMON_LOCK}.reap-${s.nonce}`), `${JSON.stringify(dead)}\n`);
    const r = takeDaemonLock(dir, () => 10);
    expect(r.ok).toBe(true);
    if (r.ok) releaseDaemonLock(r.lock);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the session a lock was taken for", () => {
  test("is recorded; a lock naming another session holds nothing here, even with its holder alive", () => {
    const dir = freshDir();
    const a = takeDaemonLock(dir, () => 7200, "sess-a");
    if (!a.ok) throw new Error("not taken");
    expect(readDaemonLock(dir)?.session).toBe("sess-a");
    // Held for its own session, by this live process.
    expect(takeDaemonLock(dir, () => 7200, "sess-a").ok).toBe(false);
    releaseDaemonLock(a.lock);
    // The folder copied under another id: its lock names sess-a, held by our live parent.
    writeFileSync(
      join(dir, DAEMON_LOCK),
      `${JSON.stringify({ pid: process.ppid, nonce: "9a".repeat(12), at: Date.now(), session: "sess-a" })}\n`,
    );
    expect(takeDaemonLock(dir, () => 7200, "sess-a").ok).toBe(false);
    const b = takeDaemonLock(dir, () => 7200, "sess-b");
    expect(b.ok).toBe(true);
    if (b.ok) releaseDaemonLock(b.lock);
  });
});

describe("tidying after a take", () => {
  test("a crashed reaper's orphan guard is removed by the next take; a live starter's is left", async () => {
    const dir = freshDir();
    const orphan = `${DAEMON_LOCK}.reap-${"12".repeat(12)}`;
    const live = `${DAEMON_LOCK}.reap-${"34".repeat(12)}`;
    const dead = { pid: await deadPid(), nonce: "56".repeat(12), at: Date.now() - 5000 };
    writeFileSync(join(dir, orphan), `${JSON.stringify(dead)}\n`);
    writeFileSync(
      join(dir, live),
      `${JSON.stringify({ pid: process.ppid, nonce: "78".repeat(12), at: Date.now() })}\n`,
    );
    const r = takeDaemonLock(dir, () => 10);
    expect(r.ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([DAEMON_LOCK, live].sort());
    if (r.ok) {
      expect(readDaemonLock(dir)?.nonce).toBe(r.lock.record.nonce);
      releaseDaemonLock(r.lock);
    }
    expect(readDaemonLock(dir)).toBeNull();
  });
});

// A process that races for the lock at a fixed moment, holds what it won, says
// so, and exits without releasing (its lock is then a dead pid's).
const RACER = `
import { takeDaemonLock } from ${JSON.stringify(join(import.meta.dir, "daemonLock.ts"))};
const [dir, at] = process.argv.slice(2);
await Bun.sleep(Math.max(0, Number(at) - Date.now()));
const r = takeDaemonLock(dir);
console.log(JSON.stringify({ ok: r.ok, pid: process.pid }));
await Bun.sleep(1500);
`;

describe("stale recovery, raced", () => {
  test("many processes that all see the same stale lock: exactly one takes it", async () => {
    const racer = join(root, "racer.ts");
    writeFileSync(racer, RACER);
    for (let round = 0; round < 3; round++) {
      const dir = freshDir();
      writeLock(dir, { pid: await deadPid(), nonce: "ff".repeat(12), at: Date.now() - 5000 });
      const at = String(Date.now() + 1200);
      const procs = Array.from({ length: 8 }, () =>
        Bun.spawn(["bun", racer, dir, at], { stdout: "pipe", stderr: "pipe", env: process.env }),
      );
      const outs = await Promise.all(
        procs.map(async (p) => {
          const out = await new Response(p.stdout).text();
          await p.exited;
          return JSON.parse(out) as { ok: boolean; pid: number };
        }),
      );
      const winners = outs.filter((o) => o.ok);
      expect(winners.length).toBe(1);
      expect(lockOf(dir).pid).toBe(winners[0]?.pid as number);
      // No reap guard or temp file is left behind.
      expect(readdirSync(dir)).toEqual([DAEMON_LOCK]);
    }
  }, 30_000);
});

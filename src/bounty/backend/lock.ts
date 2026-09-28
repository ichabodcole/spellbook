// One daemon per board id: an exclusive lockfile under $BOUNTY_HOME/locks/.
//
// ⛔ WHY THIS EXISTS. Two concurrent `open --session-key K` both found no live
// board, both spawned, and both daemons ran with the same id. Only one owned
// the discovery file, so the other was an orphan no verb could reach. Its
// final save (on close, SIGTERM or idle timeout) later wrote its stale board
// over the newer one, with no backup: the shrink guard does not fire at equal
// or larger counts. Measured by the 2026-09-28 re-measure (cell 3g). The
// check-then-spawn in cli.ts cannot be made atomic from the CLI side, so the
// daemon takes the lock itself, at boot, before any snapshot write.
//
// The protocol:
//   - CREATE is `link(tmp, lock)`: atomic, fails with EEXIST if the lock is
//     there, and the lock's content is complete the moment it exists (an
//     `open(O_EXCL)` then `write` leaves a window where it is empty).
//   - The holder is LIVE when its pid is alive AND that pid's argv carries
//     `--id <id>`. A dead pid is stale; so is a live pid running something
//     else (a pid the OS reused after a SIGKILL left the lock behind). If
//     `ps` cannot answer, the holder counts as live: refusing to start is
//     recoverable, and a second daemon is the defect this file exists for.
//   - A STALE lock is renamed aside under the taker's own name, then checked:
//     if what was moved is a live holder's fresh lock (another taker won in
//     between), it is linked back and the taker loses.
//   - A holder that is SHUTTING DOWN marks `closing` in the lock. A contender
//     waits for it to release instead of losing to it, so `close` followed by
//     `open` (or `open --fresh`) never races the dying daemon's teardown.

import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LockHolder = { pid: number; port?: number; closing?: boolean };

export function lockPath(home: string, id: string): string {
  return join(home, "locks", `${id}.lock`);
}

export function readLock(path: string): LockHolder | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    return typeof raw.pid === "number" ? (raw as LockHolder) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is `holder` a running bounty daemon for board `id`? */
export function holderIsLive(holder: LockHolder, id: string): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  // Our own pid, left by a SIGKILLed daemon the OS gave this pid to before us.
  if (holder.pid === process.pid) return false;
  if (!pidAlive(holder.pid)) return false;
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(holder.pid)]);
  if (ps.exitCode !== 0 && ps.stdout.length === 0) {
    // `ps -p` exits 1 when the pid is gone; it raced us to dead.
    return pidAlive(holder.pid);
  }
  const argv = new TextDecoder().decode(ps.stdout);
  if (!argv.trim()) return true; // cannot tell: count it live (see header)
  return argv.includes(`--id ${id}`);
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export type Acquired = { ok: true } | { ok: false; holder: LockHolder | null };

/**
 * Take the lock for board `id`, or report the live holder. Waits up to
 * `closingWaitMs` for a holder that is shutting down.
 */
export async function acquireLock(
  path: string,
  id: string,
  opts: { closingWaitMs: number },
): Promise<Acquired> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid } satisfies LockHolder));
  const waitUntil = Date.now() + opts.closingWaitMs;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        linkSync(tmp, path);
        return { ok: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const holder = readLock(path);
      if (holder && holderIsLive(holder, id)) {
        if (holder.closing && Date.now() < waitUntil) {
          await Bun.sleep(50);
          continue;
        }
        return { ok: false, holder };
      }
      // Stale (dead pid, reused pid, or unreadable). Move it aside under our
      // own name so no other taker can unlink a lock that is not the one we
      // judged, then confirm what we moved.
      const aside = `${path}.stale.${process.pid}`;
      try {
        renameSync(path, aside);
      } catch {
        continue; // someone else moved it first; look again
      }
      const moved = readLock(aside);
      if (moved && holderIsLive(moved, id)) {
        // We moved a live holder's fresh lock. Put it back, and lose.
        try {
          linkSync(aside, path);
        } catch {}
        unlinkQuiet(aside);
        return { ok: false, holder: moved };
      }
      unlinkQuiet(aside);
    }
    return { ok: false, holder: readLock(path) };
  } finally {
    unlinkQuiet(tmp);
  }
}

/** Rewrite the lock's content (port once bound, `closing` at teardown). Only
 *  while it is still ours; atomic, by rename. */
export function updateLock(path: string, holder: LockHolder): void {
  if (readLock(path)?.pid !== process.pid) return;
  const tmp = `${path}.${process.pid}.upd`;
  try {
    writeFileSync(tmp, JSON.stringify(holder));
    renameSync(tmp, path);
  } catch {
    unlinkQuiet(tmp);
  }
}

/** Release the lock if it is still ours. */
export function releaseLock(path: string): void {
  if (readLock(path)?.pid === process.pid) unlinkQuiet(path);
}

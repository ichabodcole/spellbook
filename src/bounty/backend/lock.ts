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
//     `ps` cannot answer (missing from PATH, or it runs and fails), liveness
//     is UNKNOWN and the taker refuses, saying why: refusing to start is
//     recoverable, and a second daemon is the defect this file exists for.
//     An unknown holder is never taken over.
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

/**
 * Is `holder` a running bounty daemon for board `id`? Three answers, because
 * "cannot tell" is not "live": `unknown` carries why `ps` could not answer, so
 * the refusal it causes can say so (and name the act that recovers it).
 *
 * ⛔ `unknown` WAS A RAW STACK. `Bun.spawnSync` THROWS when the executable is
 * not on PATH, so with no `ps` both the daemon (an `uncaughtException`, exit 1)
 * and `open` (a Bun stack, no envelope) died here (verifier, 2026-09-28). A
 * `ps` that ran and failed while the pid was alive counted as live and reported
 * "already running", which was not known either.
 */
export type Liveness = { state: "live" } | { state: "stale" } | { state: "unknown"; why: string };

export function holderLiveness(holder: LockHolder, id: string): Liveness {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return { state: "stale" };
  // Our own pid, left by a SIGKILLed daemon the OS gave this pid to before us.
  if (holder.pid === process.pid) return { state: "stale" };
  if (!pidAlive(holder.pid)) return { state: "stale" };
  let ps: ReturnType<typeof Bun.spawnSync>;
  try {
    ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(holder.pid)]);
  } catch (e) {
    return {
      state: "unknown",
      why: `\`ps\` could not be run (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  const argv = new TextDecoder().decode(ps.stdout ?? new Uint8Array());
  if (ps.exitCode !== 0) {
    // `ps -p` exits 1 when the pid is gone: it raced us to dead.
    if (!pidAlive(holder.pid)) return { state: "stale" };
    const err = new TextDecoder().decode(ps.stderr ?? new Uint8Array()).trim();
    return {
      state: "unknown",
      why: `\`ps\` exited ${ps.exitCode}${err ? ` (${err.split("\n")[0]})` : ""} for a pid that is alive`,
    };
  }
  if (!argv.trim()) return { state: "unknown", why: "`ps` answered with no command line" };
  return argv.includes(`--id ${id}`) ? { state: "live" } : { state: "stale" };
}

/** `holderLiveness`, with `unknown` counted live (see the header): the
 *  callers that only need "may I take this lock?". */
export function holderIsLive(holder: LockHolder, id: string): boolean {
  return holderLiveness(holder, id).state !== "stale";
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

/** `unknown` is set when the holder's liveness could not be checked, with why. */
export type Acquired = { ok: true } | { ok: false; holder: LockHolder | null; unknown?: string };

/**
 * The refusal for a holder whose liveness cannot be checked, worded once for
 * the daemon's log line and `open`'s envelope. The recovery is the operator's
 * judgment, so the hint names both halves of it: fix `ps`, or, having checked
 * the pid is not this board's daemon, remove the lock.
 */
export function unknownHolderRefusal(
  path: string,
  id: string,
  pid: number,
  why: string,
): { message: string; hint: string } {
  return {
    message: `board ${id} cannot start: its lock ${path} is held by pid ${pid}, which is alive, and bounty cannot tell whether it is this board's daemon because ${why}; refusing rather than risk two daemons for one board`,
    hint: `put a working \`ps\` on PATH and run open again; or, if pid ${pid} is not a bounty daemon for ${id} (check: ps -o command= -p ${pid}), remove the lock (rm ${path}) and run open again`,
  };
}

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
      const live = holder ? holderLiveness(holder, id) : null;
      if (holder && live && live.state !== "stale") {
        if (holder.closing && Date.now() < waitUntil) {
          await Bun.sleep(50);
          continue;
        }
        return live.state === "unknown"
          ? { ok: false, holder, unknown: live.why }
          : { ok: false, holder };
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
      const movedLive = moved ? holderLiveness(moved, id) : null;
      if (moved && movedLive && movedLive.state !== "stale") {
        // We moved a live holder's fresh lock (or one we cannot judge). Put it
        // back, and lose.
        try {
          linkSync(aside, path);
        } catch {}
        unlinkQuiet(aside);
        return movedLive.state === "unknown"
          ? { ok: false, holder: moved, unknown: movedLive.why }
          : { ok: false, holder: moved };
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

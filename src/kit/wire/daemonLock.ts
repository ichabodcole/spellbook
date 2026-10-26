/**
 * One daemon per session: an exclusive lock file in the session's folder.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * Why (kit-workspace-concurrent-restore): the CLI's "already running" check
 * reads the session's pointer and then starts a daemon, and nothing stopped two
 * `open --restore <id>` at the same moment both passing it. Both daemons
 * started, on two ports, and the manifest kept only one of them's writes. The
 * lock is taken by the daemon itself, before it reads or writes the session or
 * binds a port, so the second one refuses whatever the CLI saw.
 *
 * The file is `<session>/daemon.lock`, JSON `{pid, nonce, at, session}`. It appears
 * whole or not at all: written to a temp file opened exclusively, then
 * hard-linked to its name, which fails if the name exists. A link is the one
 * create-if-absent that also publishes content atomically, so a reader never
 * sees a half-written lock.
 *
 * A lock is HELD while its pid is alive and is the process that wrote it. It
 * is STALE when the pid is gone (a killed daemon) or belongs to a process that
 * started after the lock was written (the pid was reused). A process's start
 * is read from `ps -o etime=`; where `ps` cannot answer, a live pid counts as
 * held: refusing a restore is recoverable, two daemons on one session are not.
 * A lock naming this very process is held only while this process has it
 * (`heldHere`): an in-process daemon (a test, an app's own embedding) that
 * stopped released it, so one left behind is a reused pid's.
 *
 * ⛔ STALE RECOVERY HAS ITS OWN RACE. Two starters that both see the same stale
 * lock must not both remove it and both take it: the second one's remove would
 * delete the first one's fresh lock. So a stale lock is removed only by
 * whoever takes `<lock>.reap-<nonce>`, a guard named by the stale lock's own
 * nonce: of the starters that saw that lock, exactly one takes the guard. The
 * guard's holder reads the lock again and removes it only if it still carries
 * that nonce (nothing else removes a dead daemon's lock), and every starter
 * then races for the free name again, where `link` lets exactly one win. A
 * guard left by a starter that died mid-recovery is itself a stale lock,
 * recovered the same way, one level down.
 */

import { randomBytes } from "node:crypto";
import { linkSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The lock's file name inside a session's folder. */
export const DAEMON_LOCK = "daemon.lock";

/**
 * `session`: the session the lock was taken for. A session folder copied with
 * its lock (a backup, a duplicate made by hand) carries a lock naming the
 * session it was copied from, whose daemon is not this session's holder.
 */
export type LockRecord = { pid: number; nonce: string; at: number; session?: string };

const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export type DaemonLock = { readonly path: string; readonly record: LockRecord };

export type TakeLockResult =
  | { ok: true; lock: DaemonLock }
  | { ok: false; holder: LockRecord; path: string };

/** How long a process has run, in seconds, or null where that cannot be read. */
export type Elapsed = (pid: number) => number | null;

/** Nonces of locks this process holds now. */
const heldHere = new Set<string>();

/** Rounds of take, find stale, reap, before the name counts as held. */
const MAX_ROUNDS = 50;
/** The pause before the next round while another starter holds the reap guard. */
const REAP_WAIT_MS = 20;
/** How deep a chain of guards left by crashed recoverers is followed. */
const MAX_REAP_DEPTH = 4;
/** `etime` counts whole seconds, so a holder's start reads up to a second late. */
const START_SLACK_MS = 1500;

function readRecord(path: string): LockRecord | "absent" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    const r = JSON.parse(raw) as Partial<LockRecord>;
    if (
      Number.isInteger(r.pid) &&
      (r.pid as number) > 0 &&
      typeof r.nonce === "string" &&
      /^[a-f0-9]{8,64}$/.test(r.nonce) &&
      typeof r.at === "number" &&
      (r.session === undefined || (typeof r.session === "string" && SESSION_ID.test(r.session)))
    )
      return {
        pid: r.pid as number,
        nonce: r.nonce,
        at: r.at,
        ...(r.session !== undefined ? { session: r.session } : {}),
      };
  } catch {
    /* falls through */
  }
  return "unreadable";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `[[dd-]hh:]mm:ss`, as `ps -o etime=` prints it, in seconds; null if it is not that. */
export function parseEtime(s: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(s);
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(mi)) * 60 + Number(se);
}

/** Seconds the process has run, from `ps`, or null where `ps` cannot say. */
export const elapsedSeconds: Elapsed = (pid) => {
  try {
    const ps = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    return parseEtime(ps.stdout.toString());
  } catch {
    return null;
  }
};

/**
 * Whether the record's writer still holds it for `session` (when given): taken
 * for this session, its pid alive, and that process the one that wrote it.
 */
export function lockHeld(
  r: LockRecord,
  elapsed: Elapsed = elapsedSeconds,
  session?: string,
): boolean {
  // A lock copied in with the folder of another session holds nothing here.
  if (session !== undefined && r.session !== undefined && r.session !== session) return false;
  if (r.pid === process.pid) return heldHere.has(r.nonce);
  if (!alive(r.pid)) return false;
  const e = elapsed(r.pid);
  // Unknown: a live pid is trusted. A reused pid's process started after the lock was written.
  if (e === null) return true;
  return startedBy(e, r.at);
}

/** Whether a process that has run `elapsedS` seconds was already running at `at`. */
export const startedBy = (elapsedS: number, at: number, now: number = Date.now()): boolean =>
  now - elapsedS * 1000 <= at + START_SLACK_MS;

/** The process's command line, from `ps`, or null where `ps` cannot say. */
export function processCommand(pid: number): string | null {
  try {
    const ps = Bun.spawnSync(["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    const out = ps.stdout.toString().trim();
    return ps.exitCode === 0 && out !== "" ? out : null;
  } catch {
    return null;
  }
}

function newRecord(session?: string): LockRecord {
  return {
    pid: process.pid,
    nonce: randomBytes(12).toString("hex"),
    at: Date.now(),
    ...(session !== undefined ? { session } : {}),
  };
}

/** Create `path` holding `record`, whole, only if nothing is there. False when something is. */
function createWhole(path: string, record: LockRecord): boolean {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}

const sameRecord = (path: string, nonce: string) => (): boolean => {
  const now = readRecord(path);
  return typeof now === "object" && now.nonce === nonce;
};

/**
 * Remove the stale lock at `path`, keyed `key`, under its reap guard, and only
 * while `stillSame()` says it is the lock that was seen. Returns without
 * removing when another starter holds the guard: the caller's next round sees
 * what that starter left.
 */
function reap(
  path: string,
  key: string,
  stillSame: () => boolean,
  elapsed: Elapsed,
  depth = 0,
): void {
  const guard = `${path}.reap-${key}`;
  const mine = newRecord();
  if (!createWhole(guard, mine)) {
    // Another starter is reaping this lock (give it a moment), or died doing it.
    const g = readRecord(guard);
    if (typeof g === "object" && !lockHeld(g, elapsed)) {
      if (depth < MAX_REAP_DEPTH)
        reap(guard, g.nonce, sameRecord(guard, g.nonce), elapsed, depth + 1);
    } else Bun.sleepSync(REAP_WAIT_MS);
    return;
  }
  heldHere.add(mine.nonce);
  try {
    if (stillSame()) unlinkSync(path);
  } catch {
    /* already gone */
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      /* gone */
    }
    heldHere.delete(mine.nonce);
  }
}

/**
 * Take the session's daemon lock in `dir` (the session folder, which must
 * exist). Refused with the holder when a live daemon has it; a stale one is
 * recovered. A lock that is not this format names no live holder, so it is
 * stale too, and its reapers key their guard on its bytes. `session` is
 * recorded in the lock, and a lock naming another session is stale.
 */
export function takeDaemonLock(
  dir: string,
  elapsed: Elapsed = elapsedSeconds,
  session?: string,
): TakeLockResult {
  if (session !== undefined && !SESSION_ID.test(session))
    throw new Error(`invalid session id: ${session}`);
  const path = join(dir, DAEMON_LOCK);
  let last: LockRecord | null = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const record = newRecord(session);
    if (createWhole(path, record)) {
      heldHere.add(record.nonce);
      tidyGuards(dir, elapsed);
      return { ok: true, lock: { path, record } };
    }
    const seen = readRecord(path);
    if (seen === "absent") continue;
    if (seen === "unreadable") {
      let raw: Buffer;
      try {
        raw = readFileSync(path);
      } catch {
        continue;
      }
      const same = (): boolean => {
        try {
          return readFileSync(path).equals(raw);
        } catch {
          return false;
        }
      };
      reap(path, Bun.hash(raw).toString(16), same, elapsed);
      continue;
    }
    if (lockHeld(seen, elapsed, session)) return { ok: false, holder: seen, path };
    last = seen;
    reap(path, seen.nonce, sameRecord(path, seen.nonce), elapsed);
  }
  // Every round found the name taken again: someone holds it now.
  const now = readRecord(path);
  return { ok: false, holder: typeof now === "object" ? now : (last ?? newRecord()), path };
}

/**
 * Reap guards left by starters that died mid-recovery, removed by whoever next
 * takes the lock. Every guard is keyed on a lock that is gone now (the lock is
 * ours), so none can be acted on again; only those whose writer is gone are
 * removed, so a live starter's guard is left for it to remove itself. A temp
 * file a crashed starter left is not touched: a live one's is in use until its
 * link, and nothing tells the two apart.
 */
function tidyGuards(dir: string, elapsed: Elapsed): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${DAEMON_LOCK}.reap-`) || name.endsWith(".tmp")) continue;
    const r = readRecord(join(dir, name));
    if (typeof r === "object" && lockHeld(r, elapsed)) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* gone */
    }
  }
}

/**
 * The lock record in a session folder, or null when there is none or it is not
 * one. Read-only: what `open` reads to tell a daemon still starting from one
 * that has held the session a while.
 */
export function readDaemonLock(dir: string): LockRecord | null {
  const r = readRecord(join(dir, DAEMON_LOCK));
  return typeof r === "object" ? r : null;
}

/** Release a lock this process took: removed only while it still carries our nonce. */
export function releaseDaemonLock(lock: DaemonLock): void {
  // Removed while still held here: nobody reaps a lock whose holder holds it.
  try {
    if (sameRecord(lock.path, lock.record.nonce)()) unlinkSync(lock.path);
  } catch {
    /* gone */
  }
  heldHere.delete(lock.record.nonce);
}

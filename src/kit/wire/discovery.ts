/**
 * The two primitives under BOTH of the house's daemon-discovery conventions.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/`.
 *
 * D3 ruled that the conventions themselves — per-session tmpdir JSON (bounty,
 * glamour, imago, magpie) and singleton `$HOME/daemon.port` + `daemon.pid`
 * (astrolabe, grapevine, mind-mapper) — both survive, because they encode
 * genuinely different models (concurrent sessions vs a standing singleton) and
 * picking one is a product decision, not a factoring one. What IS one
 * implementation is the pair below, which is also exactly where census defect
 * **L3** lives.
 *
 * ── THE SESSION POINTER, PORTED FROM STORY STUDIO'S KIT ──────────────────────
 *
 * Above the pair sits the per-session convention as one API: a daemon publishes
 * a pointer file in the OS temp directory so a stateless CLI can find it,
 * `<spell>.<id>.json` for one session and `<spell>.latest.json` for the most
 * recent one. Each spell has its own pair, so several spells (and several
 * sessions of one spell) run at once without finding each other's daemons. The
 * pointer says where the daemon is: `url`, `port`, `session_id`, `dir` and the
 * daemon's `pid`.
 *
 * Reading is strict about absence: `null` means "no such pointer" (ENOENT) and
 * nothing else. A pointer that exists but cannot be read or parsed throws, so a
 * caller never mistakes a fault for "no session". Removal is conservative: it
 * goes through `unlinkIfMatches`, so a newer daemon's pointer is never taken
 * down by an older one exiting late.
 *
 * ⚠ NO SPELL IS ON IT YET. The per-session spells still name their own files
 * (`<spell>-<id>.json`, a dash where this uses a dot, and no `latest`), so
 * moving one onto this API changes the path its CLI looks for.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a running daemon says it is. */
export type SessionPointer = {
  url: string;
  port: number;
  session_id: string;
  dir: string;
  pid: number;
};

export type DiscoveryOptions = {
  /** The directory pointers live in. Default: the OS temp directory. */
  tmp?: string;
};

const SPELL_NAME = /^[a-z][a-z0-9-]*$/;

/** The pointer path for one session, or the spell's latest when `id` is omitted. */
export function pointerPath(spell: string, id?: string, opts: DiscoveryOptions = {}): string {
  if (!SPELL_NAME.test(spell)) throw new Error(`invalid spell name for discovery: ${spell}`);
  if (id !== undefined && (!/^[A-Za-z0-9_.-]+$/.test(id) || id.toLowerCase() === "latest")) {
    throw new Error(`invalid session id for discovery: ${id}`);
  }
  // `.` separates spell from id (spell names never contain one), so `a-b` with id
  // `c` and `a` with id `b-c` cannot collide; `latest` is reserved for the pointer.
  return join(opts.tmp ?? tmpdir(), `${spell}.${id ?? "latest"}.json`);
}

/** Publish a session's pointer, and make it the spell's latest. */
export function publishPointer(
  spell: string,
  pointer: SessionPointer,
  opts: DiscoveryOptions = {},
): { session: string; latest: string } {
  const session = pointerPath(spell, pointer.session_id, opts);
  const latest = pointerPath(spell, undefined, opts);
  const text = JSON.stringify(pointer);
  writeFileAtomic(session, text);
  writeFileAtomic(latest, text);
  return { session, latest };
}

/**
 * Read a session's pointer, or the spell's latest when `id` is omitted. `null`
 * means there is no such pointer, and nothing else does.
 */
export function readPointer(
  spell: string,
  id?: string,
  opts: DiscoveryOptions = {},
): SessionPointer | null {
  const path = pointerPath(spell, id, opts);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      // The latest pointer goes when the session it named closes, even while an
      // earlier session is still up: fall back to the newest live one.
      return id === undefined ? newestLivePointer(spell, opts) : null;
    throw new Error(`cannot read the ${spell} pointer: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the ${spell} pointer is not valid JSON: ${path}`);
  }
  if (!isPointer(parsed)) throw new Error(`the ${spell} pointer has the wrong shape: ${path}`);
  return parsed;
}

/** Whether a process is alive: signal 0 only checks. EPERM means it exists and is not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The newest session pointer of `spell` whose daemon is still alive, or null. A pointer
 * that cannot be read or parsed, or names a dead pid, is not a candidate: this is a
 * fallback for a missing `latest`, so it never throws.
 */
function newestLivePointer(spell: string, opts: DiscoveryOptions): SessionPointer | null {
  const dir = opts.tmp ?? tmpdir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { pointer: SessionPointer; at: number } | null = null;
  for (const name of names) {
    if (!name.startsWith(`${spell}.`) || !name.endsWith(".json")) continue;
    if (name === `${spell}.latest.json`) continue;
    const path = join(dir, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isPointer(parsed) || !pidAlive(parsed.pid)) continue;
      const at = statSync(path).mtimeMs;
      if (!best || at > best.at) best = { pointer: parsed, at };
    } catch {
      /* unreadable, gone, or not a pointer: not a candidate */
    }
  }
  return best?.pointer ?? null;
}

function isPointer(v: unknown): v is SessionPointer {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.url === "string" &&
    typeof p.port === "number" &&
    typeof p.session_id === "string" &&
    typeof p.dir === "string" &&
    typeof p.pid === "number"
  );
}

/** Remove a session's pointer, and the latest one only when it names this session. */
export function removePointer(spell: string, id: string, opts: DiscoveryOptions = {}): void {
  const session = pointerPath(spell, id, opts);
  const latest = pointerPath(spell, undefined, opts);
  unlinkIfMatches(session, id, pointerSessionId);
  unlinkIfMatches(latest, id, pointerSessionId);
}

function pointerSessionId(raw: string): string | null {
  try {
    const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Write `text` to `target` atomically: write beside it, then rename.
 *
 * ⛔ **L3, CLOSED BY CONSTRUCTION.** A bare `writeFileSync` is not atomic, so a
 * CLI reading while the daemon writes can observe a HALF-WRITTEN pointer. Under
 * a best-effort reader that surfaced as "no running session" — absence reported
 * for what was really a torn read, which is the exact conflation the house's
 * `null`-not-`0` rule exists to prevent. Rename within one directory is atomic,
 * so a reader sees either the previous pointer or the new one, never a partial
 * file.
 *
 * Fixed in glamour 2026-09-07, found standing in three siblings the next day by
 * the duplication recon, and repaired in all of them the only way that does not
 * need finding again: there is now one implementation.
 *
 * ⚠ The temp name carries the pid, so two daemons racing to publish the same
 * pointer cannot clobber each other's intermediate file — and it is removed on
 * a failed write rather than left as litter beside the real one.
 */
export function writeFileAtomic(target: string, text: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the temp file is already gone, or was never created */
    }
    throw err;
  }
}

/**
 * Delete `path` iff it still names US. Returns whether it was deleted.
 *
 * ⛔ **"STILL OURS" IS THE WHOLE FUNCTION.** A daemon that unlinks its discovery
 * file unconditionally at exit deletes the pointer a SUCCESSOR has already
 * written — the successor can then no longer be found and the next CLI verb spawns a
 * third daemon. Both conventions have this hazard and both express it
 * differently: astrolabe compares the pid file's bytes to its own pid,
 * magpie parses the JSON pointer and compares `session_id`. `identify` is what
 * makes those one function — it turns the file's bytes into the identity to
 * compare, and it defaults to the trimmed bytes themselves.
 *
 * ⚠ Every failure is swallowed and reported as `false`: the file being gone,
 * unreadable, or unparseable all mean the same thing here — it is not ours to
 * remove. An unparseable pointer is deliberately NOT treated as ours, which is
 * the conservative half of the same `null`-not-`0` rule.
 */
export function unlinkIfMatches(
  path: string,
  expected: string,
  identify: (raw: string) => string | null = (raw) => raw.trim(),
): boolean {
  try {
    if (!existsSync(path)) return false;
    if (identify(readFileSync(path, "utf8")) !== expected) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

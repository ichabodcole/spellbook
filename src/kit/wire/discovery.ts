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
 */

import { existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";

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

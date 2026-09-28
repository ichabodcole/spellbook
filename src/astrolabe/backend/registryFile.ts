// The registry FILE — `$ASTROLABE_HOME/registry.json` — as both halves read it.
//
// ⛔ ONE READER, TWO CALLERS. The daemon restores from this file on boot and
// the CLI refuses from it when no daemon is up (one-act-one-answer), so the
// read, the verdict on a file that cannot be read, and the wording of what to
// do about it live here once. `state.ts` keeps the pure half (the shape check
// and `restoreRegistry`); this module is the half that touches the disk.
//
// ── AN UNREADABLE REGISTRY IS NOT AN EMPTY ONE (data-you-cant-get-back) ──────
//
// Invalid JSON, the wrong shape, a directory where the file should be: all of
// these used to read as the EMPTY board. The daemon booted from it and its
// next save wrote over the file, so every registered project was gone with no
// word; the CLI refused "unknown project" with `choices: []`. Now:
//
//   - `readRegistry` says `unreadable` (with why), and never guesses empty;
//   - the daemon's boot `setAside`s the thing — a RENAME, so the bytes (or the
//     directory) are kept whole under `registry.json.unreadable-<ts>` — before
//     anything could write to `registry.json`. Nothing here deletes or writes
//     over it;
//   - while such a file exists it is a FACT, not an event: `listSetAside` finds
//     it on every call, and the CLI reports it until the human deals with it
//     (moves it back, or deletes it). No flag remembers "already told".
//
// It raises nothing: the CLI owns its envelopes (and the census counts them
// there), the daemon owns its boot.

import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  emptyState,
  type ObservatoryState,
  registryShapeError,
  restoreRegistry,
} from "../../../plugins/spellbook/skills/astrolabe/scripts/state.ts";

/**
 * WHY a registry could not be read — which decides the act that repairs it.
 * "Fix the JSON" is the wrong advice for a valid file nobody may read, and for
 * a directory (verifier, data-you-cant-get-back): `json` covers invalid JSON,
 * the wrong shape, and any read error that is neither of the other two.
 */
export type UnreadableCause = "json" | "permissions" | "directory";

export type RegistryRead =
  | { ok: true; state: ObservatoryState }
  | { ok: false; reason: string; cause: UnreadableCause };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function causeOfReadError(e: unknown): UnreadableCause {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EISDIR") return "directory";
  if (code === "EACCES" || code === "EPERM") return "permissions";
  return "json";
}

/**
 * The board `file` holds. No file is the empty board — nothing was ever
 * registered. A file that cannot be read, parsed, or recognised as a registry
 * is `ok: false`, and its caller must not treat it as empty.
 */
export function readRegistry(file: string, title?: string): RegistryRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, state: emptyState(title) };
    return { ok: false, reason: errMessage(e), cause: causeOfReadError(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errMessage(e)}`, cause: "json" };
  }
  const shape = registryShapeError(parsed);
  if (shape) return { ok: false, reason: shape, cause: "json" };
  return { ok: true, state: restoreRegistry(parsed, title) };
}

/**
 * The repair for an unreadable `path`, as an imperative clause, worded by its
 * cause. Used for the file still in place (the cold refusal) and for a
 * set-aside copy (`recoverAct`), so the two can't advise different acts.
 */
export function repairAct(path: string, cause: UnreadableCause): string {
  switch (cause) {
    case "permissions":
      return `fix the permissions on ${path} so you can read it (e.g. \`chmod u+rw ${path}\`)`;
    case "directory":
      return `${path} is a directory, not a file: move its contents out (a registry file inside it can be put back in its place) or delete it`;
    case "json":
      return `fix the JSON in ${path}`;
  }
}

const MARK = ".unreadable-";

/**
 * Move an unreadable `file` (or directory) aside and return where it went. A
 * rename, never a copy-and-delete: the bytes are not touched. Throws if the
 * move fails, and the daemon then refuses to boot rather than write over it.
 */
export function setAside(file: string, now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let dest = `${file}${MARK}${stamp}`;
  for (let n = 1; existsSync(dest); n++) dest = `${file}${MARK}${stamp}-${n}`;
  renameSync(file, dest);
  return dest;
}

/** Every set-aside copy of `file` still on disk, oldest first. */
export function listSetAside(file: string): string[] {
  const prefix = `${basename(file)}${MARK}`;
  try {
    return readdirSync(dirname(file))
      .filter((n) => n.startsWith(prefix))
      .sort()
      .map((n) => join(dirname(file), n));
  } catch {
    return [];
  }
}

/**
 * The act that recovers a set-aside registry, in words. The daemon saves over
 * `registry.json` on `close`, so it must be closed BEFORE the file is moved
 * back, and moving it back replaces whatever was registered since.
 *
 * The repair step is worded by why `aside` can't be read, found by reading it
 * NOW — the copy on disk is the state, so a copy the human has already made
 * readable gets no repair step, and nothing remembers the boot's verdict.
 */
export function recoverAct(aside: string, file: string): string {
  const read = readRegistry(aside);
  const keep = `or, to keep the current board, delete ${aside}`;
  const back = `(this replaces anything registered since) and run \`cli.ts open\``;
  if (!read.ok && read.cause === "directory")
    return `run \`cli.ts close\`; ${aside} is a directory, not a file: move its contents out (a registry file inside it can be moved to ${file} ${back}); ${keep}`;
  const repair = read.ok ? "" : `${repairAct(aside, read.cause)}, `;
  return `run \`cli.ts close\`, ${repair}then move it back to ${file} ${back}; ${keep}`;
}

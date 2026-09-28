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

export type RegistryRead = { ok: true; state: ObservatoryState } | { ok: false; reason: string };

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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
    return { ok: false, reason: errMessage(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errMessage(e)}` };
  }
  const shape = registryShapeError(parsed);
  if (shape) return { ok: false, reason: shape };
  return { ok: true, state: restoreRegistry(parsed, title) };
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
 */
export function recoverAct(aside: string, file: string): string {
  return `run \`cli.ts close\`, fix the JSON in ${aside}, then move it back to ${file} (this replaces anything registered since) and run \`cli.ts open\`; or, to keep the current board, delete ${aside}`;
}

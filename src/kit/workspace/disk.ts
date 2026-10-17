/**
 * ⛔ EVERY DISK WRITE THE WORKSPACE MAKES GOES THROUGH HERE.
 *
 * The kit's workspace (`src/kit/workspace`) and the apps on it
 * (`src/scriptorium/backend/kit`) never call a raw `node:fs` write. They ask
 * one of two writers, and each writer checks every path it is given at the
 * moment of the syscall, whatever the caller checked before:
 *
 * - `worldDisk`: a write to the world the sets show (a document, a folder, a
 *   drop, a sidecar, a link rewrite, a Save). Refused when the target is
 *   among the app's sessions or in its app home, compared as written and as
 *   the disk resolves it (`inOwnPlaces`). What a write takes away (a rename's
 *   source, a removal) is refused also when it holds them. The one place
 *   inside them it may reach is a home-workspace app's own `imported/`
 *   folder, and only while that folder really is this session's own
 *   (`OwnPlaces.exceptReal`; never through a link).
 * - `sessionDisk`: a write to the session's own files (its manifest, its
 *   version files, its thumbnails, a conversion's kept copy). Refused unless
 *   the target is inside the session's folder as written AND as the disk
 *   resolves it, against the folder's realpath taken when the session was
 *   opened (a session folder swapped for a link since is refused).
 *
 * Why one module: a guard at each call site was tried, and a re-verifier found
 * four writes that had none (a frontmatter edit, an image's description, a
 * link rewrite, a version delete). A write that is not through here cannot be
 * written: `grimoire/kit-disk-write-ward.test.ts` fails on any raw `node:fs`
 * write in those folders outside this file, with a short allow-list of the
 * app's own fixed files (its log, its prefs), each with its reason.
 *
 * A refusal throws the error the caller's `refuse` makes (the session's 409),
 * or a `DiskRefusal` (status 409) by default. Nothing is written.
 */

import {
  type CopySyncOptions,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  type WriteFileOptions,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "../wire/discovery.ts";
import { holdsOwnPlaces, inOwnPlaces, type OwnPlaces, onDisk, within } from "./noHome";

/** A write the disk guard refused: nothing was written. */
export class DiskRefusal extends Error {
  readonly status = 409;
}

/** Makes the error a refusal throws: the session's own (`SessionError`, 409) or a `DiskRefusal`. */
export type Refuse = (message: string) => Error;

const defaultRefuse: Refuse = (message) => new DiskRefusal(message);

/** The writes the workspace makes, each checked at the syscall. Same shapes as `node:fs`. */
export type Disk = {
  /** Why a write to `path` would be refused, or null: the check alone, nothing written. */
  refusal(path: string): string | null;
  writeFile(path: string, data: string | Uint8Array, opts?: WriteFileOptions): void;
  /** Written to a temporary name beside it, then renamed in place. */
  writeAtomic(path: string, text: string): void;
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  rename(from: string, to: string): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  /** `to` is checked; `from` is only read. */
  cp(from: string, to: string, opts: CopySyncOptions): void;
  /** `to` is checked; `from` is only read. */
  copyFile(from: string, to: string, mode?: number): void;
};

/**
 * A writer from two checks: `target` for every path written to, `source` for
 * every path a write takes away (a rename's from, a removal). Each check says
 * why, or null.
 */
function guarded(
  target: (p: string) => string | null,
  source: (p: string) => string | null,
  refuse: Refuse,
): Disk {
  const to = (p: string): string => {
    const why = target(p);
    if (why !== null) throw refuse(why);
    return p;
  };
  const from = (p: string): string => {
    const why = source(p);
    if (why !== null) throw refuse(why);
    return p;
  };
  return {
    refusal: target,
    writeFile: (p, data, opts) => writeFileSync(to(p), data, opts),
    writeAtomic: (p, text) => writeFileAtomic(to(p), text),
    mkdir: (p, opts) => {
      mkdirSync(to(p), opts);
    },
    rename: (a, b) => {
      from(a);
      renameSync(a, to(b));
    },
    rmdir: (p) => rmdirSync(from(p)),
    unlink: (p) => unlinkSync(from(p)),
    rm: (p, opts) => rmSync(from(p), opts),
    cp: (a, b, opts) => cpSync(a, to(b), opts),
    copyFile: (a, b, mode) => copyFileSync(a, to(b), mode),
  };
}

/**
 * The world's writer: never among the sessions or in the app home (`own`, read
 * at every write, so a later `setAppHome` or pin counts), as written and as
 * the disk resolves it. A source is refused also when it holds them.
 */
export function worldDisk(own: () => OwnPlaces, refuse: Refuse = defaultRefuse): Disk {
  const target = (p: string): string | null => {
    const why = inOwnPlaces(p, own());
    return why === null ? null : `${why}: nothing is written or moved there from here`;
  };
  const source = (p: string): string | null => {
    const inside = target(p);
    if (inside !== null) return inside;
    const holds = holdsOwnPlaces(p, own());
    return holds === null ? null : `${holds}: it is not moved, renamed or removed from here`;
  };
  return guarded(target, source, refuse);
}

/** Where a session's own files may go: its folder, and that folder's realpath when it was opened. */
export type SessionPlace = { dir: string; realDir?: string };

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Why `path` is not one of the session's own files, or null: it must be in
 * the session's folder as written and as the disk resolves it, and the folder
 * must still lead where it did when the session was opened.
 */
export function notInSession(path: string, at: SessionPlace): string | null {
  const dir = resolve(at.dir);
  if (at.realDir !== undefined) {
    const now = realOr(dir);
    if (now !== at.realDir)
      return `the session folder ${dir} now leads to ${now}, not where this session was opened (${at.realDir}): nothing was written`;
  }
  const real = at.realDir ?? onDisk(dir);
  if (!within(resolve(path), dir) || !within(onDisk(path), real))
    return `${path} is not inside this session's folder (${dir}): nothing was written`;
  return null;
}

/**
 * The session's own writer: only inside its folder (`notInSession`), read at
 * every write. A link anywhere on the way that leads out is refused.
 */
export function sessionDisk(at: () => SessionPlace, refuse: Refuse = defaultRefuse): Disk {
  const check = (p: string) => notInSession(p, at());
  return guarded(check, check, refuse);
}

/**
 * A writer for one session folder named by its path alone, for code that has
 * no session object (a thumbnail, a conversion's kept copy): the folder's
 * realpath is taken now, so a link inside it that leads out is refused.
 */
export function sessionDiskAt(dir: string, refuse: Refuse = defaultRefuse): Disk {
  let realDir: string | undefined;
  try {
    // A folder that is itself a link is not a session's own: pinned to its
    // path as written, which its realpath never equals, so every write is refused.
    realDir = lstatSync(dir).isSymbolicLink() ? resolve(dir) : realpathSync(dir);
  } catch {
    /* not there yet: checked as the disk resolves its parent */
  }
  return sessionDisk(() => (realDir !== undefined ? { dir, realDir } : { dir }), refuse);
}

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
 *   opened (a session folder swapped for a link since is refused). A file
 *   written there that is a link, or has a second name (a hard link), is
 *   refused outright.
 *
 * Every path is judged where the write would really land: a link that leads
 * nowhere yet is followed to its target (`onDisk`), and temporary files are
 * made fresh under random names (`stage`), never at a name a link could hold.
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

import { randomBytes } from "node:crypto";
import {
  type CopySyncOptions,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  type WriteFileOptions,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
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
  /** Written to a fresh file beside it (`stage`), then renamed in place. */
  writeAtomic(path: string, text: string): void;
  /**
   * `data` written to a NEW file beside `near` and that file's path returned,
   * for the caller to rename in place (`rename(staged, near)`) or remove. Its
   * name is `<near>.<8 random hex>.<suffix>`, made with `O_CREAT|O_EXCL`, so
   * nothing already at a name (a link planted there) is ever written through.
   */
  stage(near: string, data: string | Uint8Array, suffix?: string): string;
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

/** A check: why a path is refused, or null. */
type Check = (p: string) => string | null;

/** `O_NOFOLLOW` where the platform has it: a link at the name fails the open, never followed. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * A new file beside `near` that nothing else names. ⛔ The old temp name
 * (`<path>.<pid>.tmp`, and the edit's `<path>.<pid>.edit`) was predictable,
 * and only the target was checked: a link planted at the temp name sent the
 * write anywhere (another session's manifest). Now the name is random and the
 * open is `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, which fails on anything
 * already there, a link included. Written whole and synced before it is
 * returned; removed again when the write fails.
 */
function stageBeside(near: string, data: string | Uint8Array, suffix: string): string {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  for (let tries = 0; ; tries++) {
    const tmp = `${near}.${randomBytes(4).toString("hex")}.${suffix}`;
    let fd: number;
    try {
      fd = openSync(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
        0o666,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && tries < 8) continue;
      throw e;
    }
    try {
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } catch (e) {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw e;
    }
    closeSync(fd);
    return tmp;
  }
}

/** A plain file's `stat` (following links), or null when nothing is there or it is no plain file. */
function fileAt(p: string): { nlink: number; dev: number } | null {
  try {
    const st = statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** Whether the leaf itself is a link, dangling or not. */
function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A check that cannot run is a refusal, never a pass. */
const safely =
  (check: Check): Check =>
  (p) => {
    try {
      return check(p);
    } catch (e) {
      return `${p} could not be checked (${(e as NodeJS.ErrnoException).code ?? String(e)}): nothing was written`;
    }
  };

/**
 * A writer from three checks: `target` for every path written to, `source`
 * for every path a write takes away (a rename's from, a removal), and
 * `inPlace` for an existing file written INTO, its bytes replaced where they
 * are (a write that is not `wx`, a copy onto it). That is where a hard link
 * matters: every other name for the file sees the new bytes. A rename over a
 * file only changes this name, so it is not in place.
 */
function guarded(target: Check, source: Check, inPlace: Check, refuse: Refuse): Disk {
  const checkTarget = safely(target);
  const checkSource = safely(source);
  const checkInPlace = safely(inPlace);
  const to = (p: string): string => {
    const why = checkTarget(p);
    if (why !== null) throw refuse(why);
    return p;
  };
  const from = (p: string): string => {
    const why = checkSource(p);
    if (why !== null) throw refuse(why);
    return p;
  };
  const into = (p: string): string => {
    to(p);
    const why = checkInPlace(p);
    if (why !== null) throw refuse(why);
    return p;
  };
  const stage = (near: string, data: string | Uint8Array, suffix = "tmp"): string =>
    stageBeside(to(near), data, suffix);
  return {
    refusal: checkTarget,
    writeFile: (p, data, opts) => {
      // `wx` makes a new file or fails (on a link too): nothing is written into.
      const flag = typeof opts === "object" && opts !== null ? opts.flag : undefined;
      const fresh = typeof flag === "string" && flag.includes("x");
      writeFileSync(fresh ? to(p) : into(p), data, opts);
    },
    writeAtomic: (p, text) => {
      const tmp = stage(p, text);
      try {
        renameSync(tmp, to(p));
      } catch (e) {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone */
        }
        throw e;
      }
    },
    stage,
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
    cp: (a, b, opts) => cpSync(a, into(b), opts),
    copyFile: (a, b, mode) => copyFileSync(a, into(b), mode),
  };
}

/** The device a path is on: its own, or that of the nearest folder above it that exists. */
function deviceOf(p: string): number | null {
  let at = resolve(p);
  for (;;) {
    try {
      return statSync(at).dev;
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/**
 * The world's writer: never among the sessions or in the app home (`own`, read
 * at every write, so a later `setAppHome` or pin counts), as written and as
 * the disk resolves it. A source is refused also when it holds them.
 *
 * A document that is a link the human made on purpose still saves: the link
 * is followed to its last target, dangling or not (`onDisk`), and that target
 * is what is judged. Only a link that leads among the sessions or into the
 * app home is refused.
 *
 * ⛔ HARD LINKS. A file with more than one name (`nlink > 1`) may be a second
 * name for another session's version or manifest, and nothing on disk says
 * where the other name is. A hard link never crosses devices, so a write INTO
 * such a file is refused only when it lies on the same device as the sessions
 * root or the app home, the only places a twin among them could be. A
 * hard-linked note on another device (an external disk) still saves. A
 * rename over it, or a removal, changes only this name and stays allowed.
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
  const inPlace = (p: string): string | null => {
    const st = fileAt(p);
    if (st === null || st.nlink <= 1) return null;
    const places = own();
    const roots = [places.sessionsRoot, ...(places.appHome !== undefined ? [places.appHome] : [])];
    if (!roots.some((r) => deviceOf(r) === st.dev)) return null;
    return `${p} is a hard link (one file with ${st.nlink} names) on the disk that holds the sessions, and another of its names may be one of theirs: it is not written in place. Make it a file of its own (copy it) to save it`;
  };
  return guarded(target, source, inPlace, refuse);
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
  // ⛔ A session's own file is never a link: nothing the kit writes there is
  // one, so a link at a name it writes to was planted, and is refused outright,
  // wherever it leads. Removing one (a source) only removes the link.
  const target = (p: string) =>
    check(p) ??
    (isLink(p) ? `${p} is a link, and a session's own file never is: nothing was written` : null);
  // ⛔ Nor has it a second name: every file the kit makes there has one, so a
  // hard link to one (from the world, or another session) is never written into.
  const inPlace = (p: string) => {
    const st = fileAt(p);
    return st !== null && st.nlink > 1
      ? `${p} has another name on disk (a hard link), which may be anywhere: it is not written in place`
      : null;
  };
  return guarded(target, check, inPlace, refuse);
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

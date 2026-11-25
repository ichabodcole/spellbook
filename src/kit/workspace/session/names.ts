/**
 * Names, ids and how a path reads: content hashes, session ids, timestamps,
 * fitting a name to the disk's limit, the names of copies and bundles. Tier 0
 * of the session parts (docs/architecture/workspace-session.md). `tilde` and
 * `entryAt` live here rather than in `paths.ts`, so `paths` imports `names`
 * and never the other way.
 */

import { lstatSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { bundleDisplayName } from "../../lib/bundles.ts";
import { homeDir } from "../../lib/home.ts";
import type { DiffSide } from "../protocol";
import { readBundleInfo } from "../tree";
import { SessionError } from "./errors.ts";

/**
 * Whether the disk holding `path` ignores case, asked of the disk itself: the
 * same file under the other case of its name (or of a folder above it). A path
 * with no cased letter anywhere falls back to the platform's default.
 */
export function caseInsensitiveAt(path: string): boolean {
  const flip = (s: string) => {
    const up = s.toUpperCase();
    return up !== s ? up : s.toLowerCase();
  };
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    const name = basename(p);
    const other = flip(name);
    if (other === name) continue;
    try {
      const a = statSync(p);
      const b = statSync(join(dirname(p), other));
      return a.ino === b.ino && a.dev === b.dev;
    } catch {
      return false;
    }
  }
  return process.platform === "darwin" || process.platform === "win32";
}

export const contentHash = (text: string): string => Bun.hash(text).toString(16);

export const randHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const newSessionId = (): string => randHex(4);

/**
 * A session id is one plain folder name, and not `latest`, which is the
 * discovery pointer's own word. `open --restore ../elsewhere` must not read a
 * manifest from outside the sessions folder.
 */
export function checkSessionId(id: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) || id.toLowerCase() === "latest")
    throw new SessionError(
      `"${id}" is not a session id (letters, numbers, dashes; not "latest")`,
      400,
    );
  return id;
}

/** An ISO 8601 timestamp, now. */
export const nowIso = (): string => new Date().toISOString();

/** The most bytes one file name may have on the disks the studio runs on. */
export const NAME_MAX_BYTES = 255;

/**
 * `stem` and then `tail` (a number and the extension, kept whole), with the
 * stem shortened, a whole character at a time, until the name fits in
 * NAME_MAX_BYTES of UTF-8: a taken name at the limit still gets a free one.
 */
export function fitName(stem: string, tail: string): string {
  const room = NAME_MAX_BYTES - Buffer.byteLength(tail);
  const chars = [...stem];
  while (chars.length > 0 && Buffer.byteLength(chars.join("")) > room) chars.pop();
  return `${chars.join("").trimEnd()}${tail}`;
}

/** A path as the app shows it in words: the home folder as `~`. */
export function tilde(abs: string): string {
  const home = homeDir();
  return abs === home ? "~" : abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
}

/**
 * Whether anything is at `abs`, a dangling link included: what a name a
 * create or a copy is about to take is checked with. `existsSync` follows a
 * link, and calls a dangling one free.
 */
export function entryAt(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** How far `freeName` counts from 2 before a default name is refused. */
export const FREE_NAME_TRIES = 100_000;

/** How far `copyName` counts after "copy" before a copy is refused. */
const COPY_NAME_TRIES = 100_000;

/** A copy suffix at a stem's end: ` copy`, ` copy 2`. */
const COPY_SUFFIX = / copy(?: \d+)?$/;

/** A name without the copy suffix it ends in: `Ch 4` for `Ch 4 copy 2`, and for `Ch 4`. */
export function uncopied(stem: string): string {
  return stem.replace(COPY_SUFFIX, "") || stem;
}

/**
 * The name a copy of `name` takes in `dir`, as Finder names one: the stem
 * without any copy suffix it has, then ` copy`, else ` copy N` with N the
 * first free number from 2, then `ext` (a bundle's own; `""` for a folder).
 * `Ch 4.md` gives `Ch 4 copy.md`, then `Ch 4 copy 2.md`; a copy of `Ch 4
 * copy.md` is the next free `Ch 4 copy N.md`, never `Ch 4 copy copy.md`. A
 * long stem is shortened to fit the name limit, never the suffix. `suffix`
 * is what followed the stem (` copy 2`), for a bundle's title. Bounded:
 * past COPY_NAME_TRIES it is refused rather than counted further.
 */
export function copyName(dir: string, name: string, ext: string): { name: string; suffix: string } {
  const own = ext ? name.slice(0, name.length - ext.length) : name;
  const stem = uncopied(own);
  for (let i = 1; i < 1 + COPY_NAME_TRIES; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    const n = fitName(stem, `${suffix}${ext}`);
    if (!entryAt(join(dir, n))) return { name: n, suffix };
  }
  throw new SessionError(`no free name for a copy of ${name} is left in ${tilde(dir)}`, 409);
}

/** A name as a slug reads it: lower case, runs of anything but letters, digits, `_` and `-` as one `-`. */
export function slugBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** A bundle's name as its row shows it, read from its `info.json` on disk. */
export function bundleNameAt(abs: string): string {
  const title = readBundleInfo(abs)?.title;
  return bundleDisplayName(basename(abs), typeof title === "string" ? title : undefined);
}

/**
 * How a comparison side reads in a message to a human or an agent. The file is
 * named, not described: "the original" sounds temporal when the thing is
 * locational, and "save to the saved file" says nothing. So it gets its own
 * name, `note.md`.
 *
 * `file` is the document's name when the caller knows it; without one this falls
 * back to a generic, for contexts that have no document in hand.
 */
export function sideName(side: DiffSide, file?: string): string {
  if (side !== "original") return `v${side}`;
  return file ?? "the saved file";
}

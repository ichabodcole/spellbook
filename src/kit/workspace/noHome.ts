/**
 * An app with no home workspace (`AppDeclaration.homeWorkspace: false`): new
 * files and folders go only where the caller points.
 *
 * In apps with a home workspace (the kit's default), a create,
 * drop or import that names no folder lands in the session's workspace folder.
 * An app that declares none has no such folder: every create names its place
 * (a set, or a folder inside one), and one that names none is refused with the
 * way to name one. Nothing is written to a place nobody chose.
 *
 * The words live here so the session and the CLI say the same thing. They are
 * plain data: `session.ts` wraps them in its `SessionError`.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homeDir } from "../lib/home.ts";

/** What an app says about a home workspace. Read off the app declaration. */
export type HomeDeclaration = {
  name: string;
  /** `false`: no home workspace. Absent or `true`: the kit's home workspace. */
  homeWorkspace?: boolean;
  /**
   * With `homeWorkspace: false`: how this app's caller names a place, or makes
   * one, in the words of its own verbs. Said as the hint of every refusal for
   * want of a location. Absent: the kit's own words (`DEFAULT_LOCATION_HINT`).
   */
  locationHint?: string;
};

/** Whether the app keeps a home workspace: true unless it declares `homeWorkspace: false`. */
export const hasHomeWorkspace = (app: HomeDeclaration): boolean => app.homeWorkspace !== false;

/** The kit's own way to name a place, for an app that gives none of its own. */
export const DEFAULT_LOCATION_HINT =
  "name a folder inside a set (`state` lists the sets), or add a folder that exists with `add <folder>`";

/** The hint every refusal for want of a location carries. */
export const locationHint = (app: HomeDeclaration): string =>
  app.locationHint ?? DEFAULT_LOCATION_HINT;

/** A create, drop or import that named no folder, in an app with no home workspace. */
export function noLocation(app: HomeDeclaration): { message: string; hint: string } {
  return {
    message: `no location was named: ${app.name} has no default folder, so a new file or folder goes only where you point`,
    hint: locationHint(app),
  };
}

/** A folder named for a create that is not one of the session's, in an app with no home workspace. */
export function notALocation(
  app: HomeDeclaration,
  shown: string,
): { message: string; hint: string } {
  return {
    message: `${shown} is not a folder in this session: a new file or folder goes in a set or a folder inside one`,
    hint: locationHint(app),
  };
}

/** Setting the workspace, in an app that has none. */
export function noWorkspaceToSet(app: HomeDeclaration): { message: string; hint: string } {
  return {
    message: `${app.name} has no workspace folder to set: a new file or folder goes where you point`,
    hint: locationHint(app),
  };
}

/** A structure op that makes something in the folder its `dir` names. */
const MAKES_IN_DIR = new Set(["doc.create", "folder.create", "bundle.create"]);

/**
 * A create that came with no folder (`dir` missing, or not text): refused with
 * the app's hint, on every route (`/cmd` and the surface's socket), whatever
 * the app. Null for any other op, or one that names its folder.
 */
export function missingDir(
  app: HomeDeclaration,
  cmd: { op?: unknown; dir?: unknown },
): { message: string; hint: string } | null {
  if (typeof cmd.op !== "string" || !MAKES_IN_DIR.has(cmd.op) || typeof cmd.dir === "string")
    return null;
  return {
    message: `${cmd.op}: no location was named (dir): nothing was applied`,
    hint: locationHint(app),
  };
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Why a folder is no place to mirror whole as a set the human did not pick, or
 * null when it is one: the home folder or one above it, the top of the disk, a
 * folder that holds the app's sessions or lies among them, or the app's own
 * home (`appHome`, the folder its sessions and settings live under) or a
 * folder inside it. A set there would mirror the session's own manifest and
 * versions. Compared by where each really is.
 */
export function notAddedWhole(path: string, sessionsRoot: string, appHome?: string): string | null {
  const at = realOr(path);
  const home = realOr(homeDir());
  if (at === home) return `${path} is your home folder, which is not added whole`;
  if (at === dirname(at) || home.startsWith(at + sep))
    return `${path} holds your home folder, which is not added whole`;
  const sessions = realOr(sessionsRoot);
  if (at === sessions || at.startsWith(sessions + sep))
    return `${path} is among the sessions' own folders`;
  if (sessions.startsWith(at + sep)) return `${path} holds the sessions' own folders`;
  if (appHome !== undefined) {
    const own = realOr(appHome);
    if (at === own || at.startsWith(own + sep))
      return `${path} is in the app's own folder (${appHome}), where its sessions live`;
  }
  return null;
}

/** More links than any disk follows on one path: past it, the path cannot be written through. */
const MAX_LINKS = 40;

/**
 * A path as the disk resolves it: the realpath of its nearest folder that
 * exists, with the rest appended, so a symlink anywhere above it is followed
 * even when the path itself is not there yet.
 *
 * ⛔ A LINK THAT LEADS NOWHERE YET IS FOLLOWED TOO. `realpath` fails on a
 * dangling link exactly as on a missing file, so the nearest folder that
 * resolves is the one the link sits in. The next name down is read with
 * `lstat`: when it is a link, its target (`readlink`, relative to the folder
 * it sits in) takes its place and the walk starts again, link after link. A
 * write to that path lands where the last link leads (a new file made in
 * another session), so that is where it is judged. After `MAX_LINKS` links
 * the path is returned as it stands: no write follows that many (`ELOOP`).
 */
export function onDisk(p: string): string {
  let abs = resolve(p);
  for (let hops = 0; hops < MAX_LINKS; hops++) {
    let at = abs;
    let real: string;
    for (;;) {
      try {
        real = realpathSync(at);
        break;
      } catch {
        const up = dirname(at);
        if (up === at) return abs;
        at = up;
      }
    }
    if (at === abs) return real;
    const rest = relative(at, abs).split(sep);
    const next = join(real, rest[0] as string);
    let target: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) target = readlinkSync(next);
    } catch {
      /* not there: the rest is appended as written */
    }
    if (target === undefined) return join(real, ...rest);
    abs = join(resolve(real, target), ...rest.slice(1));
  }
  return abs;
}

/** `p` is `root`, or inside it (both absolute). */
export function within(p: string, root: string): boolean {
  const r = relative(root, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/**
 * The app's own places: its sessions root and, when it names one, its app
 * home (where its sessions, settings and logs live). `except` is the one
 * folder inside them a write may still reach: a home-workspace app's own
 * `imported/` folder in the session, its default workspace.
 */
export type OwnPlaces = {
  sessionsRoot: string;
  appHome?: string;
  except?: string;
  /**
   * Where `except` must really be for the exception to hold: the session
   * folder's realpath at open, joined with the folder's name. Absent: its
   * parent's realpath now. ⛔ The exception never follows a link: an `except`
   * that is a link, or that leads anywhere else (another session's folder),
   * is no exception at all.
   */
  exceptReal?: string;
};

/**
 * The exception, as written and as the disk resolves it, when it holds: not a
 * link itself, and really where `exceptReal` says. Null when it does not.
 */
function exceptionOf(own: OwnPlaces): { written: string; real: string } | null {
  if (own.except === undefined) return null;
  const written = resolve(own.except);
  try {
    if (lstatSync(written).isSymbolicLink()) return null;
  } catch {
    /* not there yet: where it would be is checked below */
  }
  const real = onDisk(written);
  const expected = own.exceptReal ?? join(onDisk(dirname(written)), basename(written));
  return real === expected ? { written, real } : null;
}

const ownRoots = (own: OwnPlaces): string[] => [
  own.sessionsRoot,
  ...(own.appHome !== undefined ? [own.appHome] : []),
];

const ownName = (root: string, own: OwnPlaces): string =>
  root === own.sessionsRoot ? "the sessions' own folders" : `the app's own folder (${root})`;

/**
 * Why `path` is inside the app's own places, or null. Compared both as
 * written and as the disk resolves it, so a link into the sessions is caught
 * as well as a spelling with `..` in it.
 */
export function inOwnPlaces(path: string, own: OwnPlaces): string | null {
  // Each form is excused only by the same form of the exception: the path as
  // written by the folder as written, the path on disk by where the folder
  // really is. A link inside the exception that leads to another session is
  // caught by its disk form.
  const exc = exceptionOf(own);
  const forms: [string, string | undefined][] = [
    [resolve(path), exc?.written],
    [onDisk(path), exc?.real],
  ];
  for (const root of ownRoots(own))
    for (const r of [resolve(root), onDisk(root)])
      for (const [f, x] of forms)
        if (within(f, r) && !(x !== undefined && within(f, x)))
          return root === own.sessionsRoot
            ? `${path} is among the sessions' own folders`
            : `${path} is in the app's own folder (${root}), where its sessions live`;
  return null;
}

/** Why `path` holds the app's sessions root or app home (a folder above one), or null. */
export function holdsOwnPlaces(path: string, own: OwnPlaces): string | null {
  const at = [resolve(path), onDisk(path)];
  for (const root of ownRoots(own))
    for (const r of [resolve(root), onDisk(root)])
      if (at.some((a) => a !== r && within(r, a))) return `${path} holds ${ownName(root, own)}`;
  return null;
}

/**
 * Why `path` may not become a set or a listed entry, on every route that
 * makes one (`add`, the undo of a hide, `add-folder`, `make-set`, a new item
 * that gets an entry of its own), or null when it may.
 *
 * ⛔ THE RULE. Refused: a path among the sessions or in the app home (its
 * manifests and versions would be shown, and written, as documents); the top
 * of the disk and every folder above the home folder; and a folder that holds
 * the sessions or the app home, unless the way down to them passes through a
 * dot-folder. The tree scan never shows a dot-folder, so `add ~` with the
 * default `~/.<app>` shows none of it and stays allowed, as the shipped
 * Scriptorium allows it. A home that is not a dot-folder (a scratch one) is in
 * plain sight, and a folder holding it is refused. Compared as written and as
 * the disk resolves it.
 */
export function notASet(path: string, own: OwnPlaces): string | null {
  const inside = inOwnPlaces(path, own);
  if (inside !== null) return inside;
  const at = onDisk(path);
  const home = onDisk(homeDir());
  if (at === dirname(at)) return `${path} is the top of the disk, which is not added whole`;
  if (at !== home && within(home, at))
    return `${path} holds your home folder, which is not added whole`;
  for (const root of ownRoots(own))
    for (const r of [resolve(root), onDisk(root)])
      for (const a of [resolve(path), at]) {
        if (a === r || !within(r, a)) continue;
        if (
          !relative(a, r)
            .split(sep)
            .some((part) => part.startsWith("."))
        )
          return `${path} holds ${ownName(root, own)} in plain sight, which no set may show`;
      }
  return null;
}

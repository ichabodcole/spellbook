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

import { realpathSync } from "node:fs";
import { dirname, sep } from "node:path";
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

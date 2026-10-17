/**
 * An app with no home workspace (`AppDeclaration.homeWorkspace: false`): new
 * files and folders go only where the caller points.
 *
 * With a home workspace (the default, and Story Studio's model), a create,
 * drop or import that names no folder lands in the session's workspace folder.
 * An app that declares none has no such folder: every create names its place
 * (a set, or a folder inside one), and one that names none is refused with the
 * way to name one. Nothing is written to a place nobody chose.
 *
 * The words live here so the session and the CLI say the same thing. They are
 * plain data: `session.ts` wraps them in its `SessionError`.
 */

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

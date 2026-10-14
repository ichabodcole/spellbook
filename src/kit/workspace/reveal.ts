/**
 * Showing a path in the platform's file manager, the human's "Reveal in Finder"
 * and the agent's `reveal` verb.
 *
 * Which path may be revealed is the session's rule (`WorkspaceSession.revealTarget`);
 * this module is only the argv. It is an argv and never a shell string: the path
 * is data, whatever it holds.
 */

import { dirname } from "node:path";

/**
 * The command that reveals `path`, or null where there is no file manager to
 * ask. macOS selects the item in a Finder window (`open -R`); Linux has no
 * "select" that every desktop honours, so it opens the parent folder.
 */
export function revealCommand(platform: string, path: string): string[] | null {
  if (platform === "darwin") return ["open", "-R", path];
  if (platform === "linux") return ["xdg-open", dirname(path)];
  return null;
}

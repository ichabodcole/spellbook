/**
 * Moving a file or folder to the operating system's Trash, the human's Delete in
 * the sidebar. Never `unlink`: a mistake is undone from the Trash, outside the
 * app.
 *
 * Which path may go is the session's rule (`WorkspaceSession.trashPreview`);
 * this module is only the argv and running it. It is an argv and never a shell
 * string: the path is data, whatever it holds, and it is always absolute, so it
 * cannot be read as an option.
 *
 * Per platform:
 * - macOS 15 and later ship `/usr/bin/trash`, which moves items to the Trash the
 *   way Finder does. `-s` is stop-on-error: a move that fails stops it and exits
 *   non-zero.
 * - Older macOS: `osascript` running JavaScript for Automation that asks
 *   `NSFileManager` to trash the item. The path is the script's argument, not
 *   part of its text. No Finder scripting, so no Automation permission prompt.
 * - Linux: `gio trash` (GLib, on most desktops), else `trash-put` (trash-cli),
 *   both of which follow the freedesktop.org Trash spec.
 * - Anything else, or Linux with neither: no command, and the daemon refuses in
 *   words. It never falls back to deleting.
 */

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Where macOS 15+ keeps its Trash command. */
export const MAC_TRASH = "/usr/bin/trash";

/**
 * JavaScript for Automation: trash `argv[0]` through NSFileManager. Throwing
 * makes osascript exit non-zero with the message on stderr.
 */
export const MAC_TRASH_JXA = [
  "function run(argv) {",
  // `ObjC.import` spelled with brackets: the import-boundary ward's text scanner
  // reads `.import(` in a string as a dynamic import. Same call in JavaScript.
  "  ObjC['import']('Foundation');",
  "  const url = $.NSURL.fileURLWithPath(argv[0]);",
  "  const error = $();",
  "  const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, $(), error);",
  "  if (!ok) throw new Error(error.localizedDescription.js);",
  "}",
].join("\n");

/** What `trashCommand` needs to know about the machine; a test passes its own. */
export type TrashHost = {
  platform: string;
  /** Whether an absolute path exists (for `/usr/bin/trash`). */
  exists?: (path: string) => boolean;
  /** A command's path on `PATH`, or null. */
  which?: (cmd: string) => string | null;
};

/**
 * The command that moves `path` to the Trash, or null where there is no Trash
 * this daemon knows how to use. `path` must be absolute.
 */
export function trashCommand(host: TrashHost, path: string): string[] | null {
  if (!isAbsolute(path)) throw new Error(`trash: not an absolute path: ${path}`);
  const exists = host.exists ?? existsSync;
  const which = host.which ?? ((c: string) => Bun.which(c));
  if (host.platform === "darwin") {
    if (exists(MAC_TRASH)) return [MAC_TRASH, "-s", path];
    return ["osascript", "-l", "JavaScript", "-e", MAC_TRASH_JXA, path];
  }
  if (host.platform === "linux") {
    const gio = which("gio");
    if (gio) return [gio, "trash", "--", path];
    const trashPut = which("trash-put");
    if (trashPut) return [trashPut, "--", path];
  }
  return null;
}

/** Moves one absolute path to the Trash, or throws saying why it could not. */
export type TrashFn = (path: string) => Promise<void>;

/**
 * The real Trash, for `platform`. Runs the command, and then checks the path is
 * gone: a command that exits 0 and leaves the file where it was has not done it.
 */
export function systemTrash(platform: string): TrashFn {
  return async (path) => {
    const cmd = trashCommand({ platform }, path);
    if (!cmd)
      throw new Error(
        platform === "linux"
          ? "no Trash command on this system (install gio or trash-cli): delete it in your file manager instead"
          : `no Trash this app can use on this system (${platform}): delete it in your file manager instead`,
      );
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0)
      throw new Error(
        `could not move it to the Trash (exit ${code}): ${err.trim() || "no reason given"}`,
      );
    if (existsSync(path)) throw new Error("the Trash did not take it: it is still there");
  };
}

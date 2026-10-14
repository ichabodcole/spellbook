/**
 * The native file picker: the affordance a web page cannot have.
 *
 * A browser's own `<input type="file">` and `showOpenFilePicker()` both hand
 * back file content and a name, never a path, so a copy is all a page can do
 * with that, which is what a drop already does. The daemon is a local process:
 * it can ask the OS for its own open dialog and get back a real filesystem
 * path, so "Choose..." links the real file instead of copying it. The same
 * dialog serves an app's export, which asks where to save.
 *
 * Everything here is pure: which argv to run, and how to read what it printed.
 * The spawning (and the one-at-a-time rule) is the daemon's.
 */

/** `save` asks where to write (the dialog confirms an overwrite); the others ask what to open. */
export type PickKind = "file" | "folder" | "save";

/** An AppleScript that puts one POSIX path per line on stdout. */
function appleScript(kind: PickKind, prompt: string, defaultName?: string): string {
  const quoted = prompt.replace(/["\\]/g, "");
  if (kind === "save") {
    const name = (defaultName ?? "").replace(/["\\\n]/g, "");
    return [
      `set chosen to choose file name with prompt "${quoted}"${name ? ` default name "${name}"` : ""}`,
      "return POSIX path of chosen",
    ].join("\n");
  }
  const choose =
    kind === "file"
      ? `choose file with prompt "${quoted}" with multiple selections allowed`
      : `{choose folder with prompt "${quoted}"}`;
  return [
    `set chosen to ${choose}`,
    'set out to ""',
    "repeat with f in chosen",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out",
  ].join("\n");
}

/**
 * The command that opens the OS's picker, or null where there is none — the
 * caller then says so rather than hanging on a dialog nobody will see.
 * `zenityAt` is where a Linux zenity was found (the caller looks it up).
 */
export function pickerCommand(
  platform: string,
  kind: PickKind,
  prompt: string,
  zenityAt?: string | null,
  defaultName?: string,
): string[] | null {
  if (platform === "darwin") return ["osascript", "-e", appleScript(kind, prompt, defaultName)];
  if (platform === "win32") return null; // PowerShell's dialog needs a STA host; not written until asked for
  if (zenityAt && kind === "save")
    return [
      zenityAt,
      "--file-selection",
      "--save",
      "--confirm-overwrite",
      ...(defaultName ? [`--filename=${defaultName}`] : []),
      `--title=${prompt}`,
    ];
  if (zenityAt)
    return [
      zenityAt,
      "--file-selection",
      ...(kind === "folder" ? ["--directory"] : ["--multiple"]),
      "--separator=\n",
      `--title=${prompt}`,
    ];
  return null;
}

/** The paths a picker printed: one per line, blanks dropped, order kept. */
export function parsePickerOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/"))
    .map((l) => (l.length > 1 && l.endsWith("/") ? l.slice(0, -1) : l));
}

/** A cancelled dialog is not a failure — osascript exits 1, zenity exits 1, and nothing was chosen. */
export function wasCancelled(exitCode: number, stdout: string): boolean {
  return exitCode !== 0 && parsePickerOutput(stdout).length === 0;
}

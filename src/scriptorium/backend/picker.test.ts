import { expect, test } from "bun:test";
import { parsePickerOutput, pickerCommand, wasCancelled } from "./picker";

test("macOS gets an osascript that prints one POSIX path per line", () => {
  const cmd = pickerCommand("darwin", "file", "Add documents") as string[];
  expect(cmd[0]).toBe("osascript");
  expect(cmd[1]).toBe("-e");
  expect(cmd[2]).toContain('choose file with prompt "Add documents"');
  expect(cmd[2]).toContain("with multiple selections allowed");
  expect(cmd[2]).toContain("POSIX path of f");
  // A folder pick is wrapped in a list, so the same loop reads it.
  expect(String((pickerCommand("darwin", "folder", "Pick one") as string[])[2])).toContain(
    '{choose folder with prompt "Pick one"}',
  );
});

test("a prompt cannot break out of the script's string", () => {
  const script = String((pickerCommand("darwin", "file", 'say "hi" \\ then') as string[])[2]);
  expect(script).toContain('with prompt "say hi  then"');
  expect(script.split("\n")[0]).toContain("choose file");
});

test("Linux uses zenity when there is one; nothing where there is no picker", () => {
  expect(pickerCommand("linux", "folder", "Pick", "/usr/bin/zenity")).toEqual([
    "/usr/bin/zenity",
    "--file-selection",
    "--directory",
    "--separator=\n",
    "--title=Pick",
  ]);
  expect(pickerCommand("linux", "file", "Pick", null)).toBeNull();
  expect(pickerCommand("win32", "file", "Pick")).toBeNull();
});

test("output is one path per line, trimmed, non-paths and a trailing slash dropped", () => {
  expect(parsePickerOutput("/Users/x/a.md\n/Users/x/b Notes.md\n\n")).toEqual([
    "/Users/x/a.md",
    "/Users/x/b Notes.md",
  ]);
  expect(parsePickerOutput("/Users/x/notes/\n")).toEqual(["/Users/x/notes"]);
  expect(parsePickerOutput("User canceled.\n")).toEqual([]);
  expect(parsePickerOutput("/")).toEqual(["/"]);
});

test("a cancelled dialog is not a failure", () => {
  expect(wasCancelled(1, "")).toBe(true);
  expect(wasCancelled(1, "execution error: User canceled. (-128)")).toBe(true);
  expect(wasCancelled(0, "/Users/x/a.md\n")).toBe(false);
});

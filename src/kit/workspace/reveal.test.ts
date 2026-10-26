// How "reveal in the file manager" is asked of each platform.
import { expect, test } from "bun:test";
import { revealCommand } from "./reveal";

test("macOS selects the item in Finder; Linux opens the parent folder", () => {
  expect(revealCommand("darwin", "/w/set/a.md")).toEqual(["open", "-R", "/w/set/a.md"]);
  expect(revealCommand("linux", "/w/set/a.md")).toEqual(["xdg-open", "/w/set"]);
});

test("a platform with no file manager to ask gets nothing, so the caller can say so", () => {
  expect(revealCommand("win32", "/w/set/a.md")).toBeNull();
});

test("the path is one argv element, whatever it holds", () => {
  const nasty = "/w/a b; rm -rf ~/$(x).md";
  expect(revealCommand("darwin", nasty)?.[2]).toBe(nasty);
  expect(revealCommand("darwin", nasty)).toHaveLength(3);
});

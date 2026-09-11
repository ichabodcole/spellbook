// Paths typed in the surface: the page has no working directory, so `~` is
// expanded by the daemon and a relative path is refused — never resolved
// against the daemon's cwd (Cole, 2026-09-11: `~/Documents/…` added from the
// path box failed as ".../skills/scriptorium/~/Documents/…").
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { surfacePath } from "./server";
import { SessionError } from "./session";

test("~ and ~/… expand to the user's home", () => {
  expect(surfacePath("~")).toBe(homedir());
  expect(surfacePath("~/Documents/Operator")).toBe(join(homedir(), "Documents", "Operator"));
  expect(surfacePath("  ~/notes/a.md ")).toBe(join(homedir(), "notes", "a.md"));
});

test("an absolute path passes through, normalised", () => {
  expect(surfacePath("/tmp/x/../y")).toBe("/tmp/y");
});

test("a relative path is refused rather than resolved against the daemon's cwd", () => {
  for (const p of ["Documents/a.md", "./a.md", "~user/a.md"]) {
    let err: unknown;
    try {
      surfacePath(p);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).status).toBe(400);
  }
});

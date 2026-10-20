// `gitRootOf` on the kit path (moved from the shipped `session.ts`,
// scriptorium-kit-keepers): the shipped `structure.test.ts` cell, copied so it
// outlives the shipped tests at the cutover.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../../kit/workspace/testing";
import { gitRootOf } from "./gitRoot";

let root: string;
beforeEach(() => {
  root = tempRoot("scriptorium-gitroot");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a .git FILE counts too: a worktree and a submodule have one", () => {
  const ws = join(root, "ws");
  mkdirSync(join(ws, "deep", "er"), { recursive: true });
  mkdirSync(join(root, "set"), { recursive: true });
  writeFileSync(join(ws, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  expect(gitRootOf(ws)).toBe(ws);
  expect(gitRootOf(join(ws, "deep", "er"))).toBe(ws);
  expect(gitRootOf(join(root, "set"))).toBeNull();
});

test("a .git folder is a working tree", () => {
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "repo", "a"), { recursive: true });
  expect(gitRootOf(join(root, "repo", "a"))).toBe(join(root, "repo"));
});

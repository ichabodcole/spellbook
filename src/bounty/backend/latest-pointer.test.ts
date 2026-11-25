// bounty-latest-pointer-and-list-title: closing a board hands `latest` to the
// newest board still running, and removes it only when none is.
//
// Driven through the real CLI and real daemons, all inside this file's private
// TMPDIR (fixtures/serverSuite.ts) with a private BOUNTY_HOME and a private cwd,
// so no `.bounty-session` walk-up and no machine-global pointer is involved.
// Every board is closed by its own session id; nothing is killed.
//
// Before the fix, step 3 below fails: closing the keyed board K deleted
// bounty-latest.json, and the unpinned `state` exited 5 "no running bounty
// session" while `list` still showed both unkeyed boards running.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, type CliResult, hermeticEnv, TEST_TMPDIR, uniqHome } from "./fixtures/serverSuite.ts";

const LATEST = join(TEST_TMPDIR, "bounty-latest.json");

function latestNames(): string | null {
  try {
    return (JSON.parse(readFileSync(LATEST, "utf8")) as { session_id?: string }).session_id ?? null;
  } catch {
    return null;
  }
}

async function cli(args: string[], home: string, cwd: string): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...hermeticEnv(), BOUNTY_HOME: home },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, code: await proc.exited };
}

async function open(args: string[], home: string, cwd: string): Promise<string> {
  const r = await cli(["open", "--no-open", "--timeout", "60", ...args], home, cwd);
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { session_id: string }).session_id;
}

// A closed daemon rewrites `latest` after it stops answering, so `close`
// returning is not yet the pointer's final state: wait until it no longer names
// the board that closed (absent counts as "no longer names").
async function latestLeaves(id: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && latestNames() === id) await Bun.sleep(50);
  expect(latestNames()).not.toBe(id);
}

describe("closing a board hands the latest pointer back", () => {
  test("to the newest board still running, and removes it only when none is", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "latest-"));
    const open_: string[] = [];
    try {
      // 1. Two unkeyed boards, then a keyed one, each taking `latest` at boot.
      const a1 = await open([], home, cwd);
      open_.push(a1);
      await Bun.sleep(20); // distinct discovery-file mtimes: a2 is the newer
      const a2 = await open([], home, cwd);
      open_.push(a2);
      const k = await open(["--session-key", `k-${crypto.randomUUID().slice(0, 8)}`], home, cwd);
      open_.push(k);
      expect(new Set([a1, a2, k]).size).toBe(3);
      expect(latestNames()).toBe(k);

      // 2. Close K. `latest` goes to a2, the newest board still running.
      expect((await cli(["close", "--session", k], home, cwd)).code).toBe(0);
      open_.splice(open_.indexOf(k), 1);
      await latestLeaves(k);
      expect(latestNames()).toBe(a2);

      // 3. The unpinned verbs the bug broke now reach a2.
      const add = await cli(["add", "after K closed", "--id", "t1"], home, cwd);
      expect(add.code).toBe(0);
      const state = await cli(["state"], home, cwd);
      expect(state.code).toBe(0);
      const tasks = (JSON.parse(state.stdout) as { state: { tasks: { id: string }[] } }).state
        .tasks;
      expect(tasks.map((t) => t.id)).toEqual(["t1"]);

      // 4. Close a2 unpinned: `latest` goes on to a1.
      expect((await cli(["close"], home, cwd)).code).toBe(0);
      open_.splice(open_.indexOf(a2), 1);
      await latestLeaves(a2);
      expect(latestNames()).toBe(a1);

      // 5. Close the last board: no board runs, so `latest` is removed.
      expect((await cli(["close"], home, cwd)).code).toBe(0);
      open_.splice(open_.indexOf(a1), 1);
      await latestLeaves(a1);
      expect(existsSync(LATEST)).toBe(false);
    } finally {
      for (const id of open_) await cli(["close", "--session", id], home, cwd);
    }
  }, 60000);
});

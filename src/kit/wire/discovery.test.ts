import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkIfMatches, writeFileAtomic } from "./discovery.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-discovery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  test("writes the file and leaves no temp behind", () => {
    const target = join(dir, "daemon.port");
    writeFileAtomic(target, "51423");
    expect(readFileSync(target, "utf8")).toBe("51423");
    expect(readdirSync(dir)).toEqual(["daemon.port"]);
  });

  test("replaces an existing pointer wholesale, never in place", () => {
    const target = join(dir, "latest.json");
    writeFileAtomic(target, '{"session_id":"a"}');
    writeFileAtomic(target, '{"session_id":"bb"}');
    expect(readFileSync(target, "utf8")).toBe('{"session_id":"bb"}');
    expect(readdirSync(dir)).toEqual(["latest.json"]);
  });

  test("⛔ A FAILED WRITE LEAVES NO LITTER BESIDE THE REAL POINTER", () => {
    // A `.tmp` left in the discovery directory is a file the next reader has to
    // know to ignore, and the readers here are globs.
    const target = join(dir, "missing", "daemon.port");
    expect(() => writeFileAtomic(target, "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("unlinkIfMatches", () => {
  test("removes the file when it still names us", () => {
    const pid = join(dir, "daemon.pid");
    writeFileSync(pid, `${process.pid}\n`); // trailing newline: the default trims
    expect(unlinkIfMatches(pid, String(process.pid))).toBe(true);
    expect(existsSync(pid)).toBe(false);
  });

  test("⛔ LEAVES A SUCCESSOR'S POINTER ALONE — the whole reason it is conditional", () => {
    const pid = join(dir, "daemon.pid");
    writeFileSync(pid, "99999");
    expect(unlinkIfMatches(pid, String(process.pid))).toBe(false);
    expect(existsSync(pid)).toBe(true);
  });

  test("an absent file is not an error, and is not a match", () => {
    expect(unlinkIfMatches(join(dir, "nope"), "x")).toBe(false);
  });

  test("`identify` carries the JSON convention — one predicate, both conventions", () => {
    const latest = join(dir, "latest.json");
    const sessionId = (raw: string): string | null => {
      try {
        const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    };
    writeFileSync(latest, JSON.stringify({ session_id: "magpie-abc" }));
    expect(unlinkIfMatches(latest, "magpie-other", sessionId)).toBe(false);
    expect(unlinkIfMatches(latest, "magpie-abc", sessionId)).toBe(true);
    expect(existsSync(latest)).toBe(false);
  });

  test("an unparseable pointer is NOT ours — declining is the conservative half", () => {
    const latest = join(dir, "latest.json");
    writeFileSync(latest, "{ half-writ");
    expect(unlinkIfMatches(latest, "anything", () => null)).toBe(false);
    expect(existsSync(latest)).toBe(true);
  });
});

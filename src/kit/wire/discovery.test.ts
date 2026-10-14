import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pointerPath,
  publishPointer,
  readPointer,
  removePointer,
  unlinkIfMatches,
  writeFileAtomic,
} from "./discovery.ts";

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

describe("per-spell pointers", () => {
  const pointer = (id: string, port = 4100) => ({
    url: `http://127.0.0.1:${port}`,
    port,
    session_id: id,
    dir: `/spellbook/sessions/${id}`,
    pid: 4242,
  });

  test("the files are <spell>.<id>.json and <spell>.latest.json in the temp directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    expect(pointerPath("magpie", "s1", { tmp: dir })).toBe(join(dir, "magpie.s1.json"));
    expect(pointerPath("magpie", undefined, { tmp: dir })).toBe(join(dir, "magpie.latest.json"));
    // With no override, the OS temp directory.
    expect(pointerPath("magpie", "s1")).toBe(join(tmpdir(), "magpie.s1.json"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("publish writes both files with the pointer shape, and reading takes the spell name", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    const p = pointer("s1");
    const { session, latest } = publishPointer("magpie", p, { tmp: dir });
    expect(JSON.parse(readFileSync(session, "utf8"))).toEqual(p);
    expect(JSON.parse(readFileSync(latest, "utf8"))).toEqual(p);
    expect(readPointer("magpie", "s1", { tmp: dir })).toEqual(p);
    expect(readPointer("magpie", undefined, { tmp: dir })).toEqual(p);
    rmSync(dir, { recursive: true, force: true });
  });

  test("two spells never see each other's daemons", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1", 4100), { tmp: dir });
    publishPointer("glamour", pointer("w1", 4200), { tmp: dir });
    expect(readPointer("magpie", undefined, { tmp: dir })?.port).toBe(4100);
    expect(readPointer("glamour", undefined, { tmp: dir })?.port).toBe(4200);
    expect(readPointer("glamour", "s1", { tmp: dir })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("absence is null; a corrupt pointer throws rather than reading as no session", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    expect(readPointer("magpie", "nope", { tmp: dir })).toBeNull();
    writeFileSync(pointerPath("magpie", "bad", { tmp: dir }), "{not json");
    expect(() => readPointer("magpie", "bad", { tmp: dir })).toThrow(/not valid JSON/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("remove deletes the session file, and latest only while it still names this session", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1"), { tmp: dir });
    publishPointer("magpie", pointer("s2", 4101), { tmp: dir });
    removePointer("magpie", "s1", { tmp: dir });
    expect(readPointer("magpie", "s1", { tmp: dir })).toBeNull();
    // `latest` names s2 now, so s1's exit leaves it alone.
    expect(readPointer("magpie", undefined, { tmp: dir })?.session_id).toBe("s2");
    removePointer("magpie", "s2", { tmp: dir });
    expect(readPointer("magpie", undefined, { tmp: dir })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("with `latest` gone, a read with no id falls back to the newest pointer whose daemon is alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    const live = (id: string, port: number) => ({ ...pointer(id, port), pid: process.pid });
    publishPointer("magpie", live("s1", 4100), { tmp: dir });
    await Bun.sleep(15);
    publishPointer("magpie", live("s2", 4101), { tmp: dir });
    // A session whose daemon is gone is not a candidate, however new its file is.
    await Bun.sleep(15);
    publishPointer("magpie", { ...pointer("dead", 4102), pid: 2_147_483_000 }, { tmp: dir });
    // The newest session closes: it takes `latest` with it, as `removePointer` does.
    rmSync(join(dir, "magpie.latest.json"));
    expect(readPointer("magpie", undefined, { tmp: dir })?.session_id).toBe("s2");
    removePointer("magpie", "s2", { tmp: dir });
    expect(readPointer("magpie", undefined, { tmp: dir })?.session_id).toBe("s1");
    // Another spell's pointers are never taken, and a named session is never substituted.
    expect(readPointer("glamour", undefined, { tmp: dir })).toBeNull();
    expect(readPointer("magpie", "s2", { tmp: dir })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a spell name or session id that is not a plain token is refused", () => {
    expect(() => pointerPath("../evil")).toThrow(/invalid spell name/);
    expect(() => pointerPath("magpie", "../x")).toThrow(/invalid session id/);
    expect(() => pointerPath("magpie", "latest")).toThrow(/invalid session id/);
  });

  test("a spell whose name ends where another's id begins does not collide", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    expect(pointerPath("a-b", "c", { tmp: dir })).not.toBe(pointerPath("a", "b-c", { tmp: dir }));
    rmSync(dir, { recursive: true, force: true });
  });

  test("a file that parses but is not a pointer throws, never reads as no pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    for (const body of [
      "null",
      "42",
      "[]",
      '{"url":"x"}',
      '{"url":"x","port":"1","session_id":"s","dir":"d","pid":1}',
    ]) {
      writeFileSync(pointerPath("magpie", "odd", { tmp: dir }), body);
      expect(() => readPointer("magpie", "odd", { tmp: dir })).toThrow(/wrong shape/);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

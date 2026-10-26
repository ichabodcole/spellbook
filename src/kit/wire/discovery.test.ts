import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAST_OPENED,
  pidAlive,
  pointerPath,
  publishPointer,
  readLastOpened,
  readPointer,
  recordLastOpened,
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

describe("the record of the session last started", () => {
  test("written and read back; absent is none", () => {
    expect(readLastOpened(dir)).toEqual({ kind: "none" });
    recordLastOpened(dir, "s1");
    expect(readLastOpened(dir)).toEqual({ kind: "ok", id: "s1" });
    recordLastOpened(dir, "s2");
    expect(readLastOpened(dir)).toEqual({ kind: "ok", id: "s2" });
    expect(statSync(join(dir, LAST_OPENED)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([LAST_OPENED]);
  });

  test("a symlink planted at its path is replaced, never written through", () => {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    symlinkSync(victim, join(dir, LAST_OPENED));
    // A planted link is not a record to trust...
    expect(readLastOpened(dir)).toEqual({ kind: "untrusted", why: "it is not a plain file" });
    recordLastOpened(dir, "s1");
    // ...and writing the record replaces the link: the file it pointed at is untouched.
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(lstatSync(join(dir, LAST_OPENED)).isSymbolicLink()).toBe(false);
    expect(readLastOpened(dir)).toEqual({ kind: "ok", id: "s1" });
  });

  test("a corrupt record, or one naming no session, is untrusted, never none", () => {
    for (const [body, why] of [
      ["{not json", "it is not valid JSON"],
      ["null", "it names no session"],
      ['{"session_id":"../x"}', "it names no session"],
      ['{"session_id":7}', "it names no session"],
    ]) {
      writeFileSync(join(dir, LAST_OPENED), body as string);
      expect(readLastOpened(dir)).toEqual({ kind: "untrusted", why: why as string });
    }
    expect(() => recordLastOpened(dir, "../x")).toThrow(/invalid session id/);
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
    // This process: alive, and ours. A made-up pid could be anyone's, and
    // reading `latest` checks its pid.
    pid: process.pid,
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

  /** A pid that is certainly dead: a child this test started, which has exited and been reaped. */
  const deadPid = (): number => {
    const p = Bun.spawnSync(["true"], { env: process.env });
    expect(p.exitCode).toBe(0);
    return p.pid;
  };

  test("a `latest` naming a dead daemon is the newest session, crashed: returned, never an older live one", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1", 4100), { tmp: dir });
    // The newest session crashed: its pointers stayed, naming a dead pid.
    const dead = deadPid();
    publishPointer("magpie", { ...pointer("s2", 4101), pid: dead }, { tmp: dir });
    expect(readPointer("magpie", undefined, { tmp: dir })).toMatchObject({
      session_id: "s2",
      pid: dead,
    });
    expect(pidAlive(dead)).toBe(false);
    // Its own pointer is read as it is too: the crash is the caller's to say.
    expect(readPointer("magpie", "s2", { tmp: dir })?.session_id).toBe("s2");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a pid of 0 or below is never alive: skipped in `latest` and the scan, and a session's own pointer throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1", 4100), { tmp: dir });
    for (const pid of [0, -1, 1.5]) {
      // A newer session pointer and `latest` both carry the bad pid.
      writeFileSync(
        pointerPath("magpie", "bad", { tmp: dir }),
        JSON.stringify({ ...pointer("bad", 4199), pid }),
      );
      writeFileSync(
        pointerPath("magpie", undefined, { tmp: dir }),
        JSON.stringify({ ...pointer("bad", 4199), pid }),
      );
      expect(readPointer("magpie", undefined, { tmp: dir })?.session_id).toBe("s1");
      expect(() => readPointer("magpie", "bad", { tmp: dir })).toThrow(/wrong shape/);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("a session pointer filed under another session's name is skipped in the scan, and throws when read by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1", 4100), { tmp: dir });
    rmSync(pointerPath("magpie", undefined, { tmp: dir }));
    // A newer file whose name says s9 but whose body says s1, at another port.
    writeFileSync(pointerPath("magpie", "s9", { tmp: dir }), JSON.stringify(pointer("s1", 4999)));
    expect(readPointer("magpie", undefined, { tmp: dir })?.port).toBe(4100);
    expect(() => readPointer("magpie", "s9", { tmp: dir })).toThrow(/names another session/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a pointer another user owns is not this user's daemon", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    publishPointer("magpie", pointer("s1", 4100), { tmp: dir });
    const getuid = process.getuid;
    if (getuid === undefined) return; // no uids here: every file is the user's
    // Every file now reads as someone else's: the files are this user's, the
    // reader is told it is another.
    const me = getuid();
    process.getuid = () => me + 1;
    try {
      expect(readPointer("magpie", undefined, { tmp: dir })).toBeNull();
      expect(() => readPointer("magpie", "s1", { tmp: dir })).toThrow(/another user's/);
    } finally {
      process.getuid = getuid;
    }
    expect(readPointer("magpie", undefined, { tmp: dir })?.session_id).toBe("s1");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a pointer is written through an unguessable temp opened exclusively: a planted symlink redirects nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "disc-"));
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "untouched");
    // The old, predictable temp name, planted ahead of the write.
    const target = pointerPath("magpie", "s1", { tmp: dir });
    symlinkSync(victim, `${target}.${process.pid}.tmp`);
    publishPointer("magpie", pointer("s1"), { tmp: dir });
    expect(readFileSync(victim, "utf8")).toBe("untouched");
    expect(readPointer("magpie", "s1", { tmp: dir })?.session_id).toBe("s1");
    // Readable by this user only, and no temp of ours left behind.
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([
      `magpie.s1.json.${process.pid}.tmp`,
    ]);
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

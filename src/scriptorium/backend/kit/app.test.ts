// The conversion dry run's guard (`kitMigrateRefusal`): the real sessions are
// refused by any spelling. Every "real home" here is a FAKE one this file
// stands up in a temp folder and hands in as `realHome`; nothing here names,
// reads or stats the account's actual ~/.scriptorium. HOME is the preload's
// scratch home throughout, as it would be for a caller who moved HOME.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir } from "../../../kit/lib/home";
import { kitMigrateRefusal } from "./app";

let root: string;
let realHome: string;
let realSessions: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-refusal-")));
  realHome = join(root, "Users", "someone");
  realSessions = join(realHome, ".scriptorium", "sessions");
  mkdirSync(join(realSessions, "s1"), { recursive: true });
  mkdirSync(join(root, "scratch"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const on = (home: string) => ({
  SCRIPTORIUM_KIT: "1",
  SCRIPTORIUM_KIT_MIGRATE: "1",
  SCRIPTORIUM_HOME: home,
});
const refused = (home: string) => kitMigrateRefusal(on(home), realHome);

describe("the dry run refuses the real sessions by any spelling", () => {
  test("HOME moved to scratch, SCRIPTORIUM_HOME the real home's .scriptorium spelled out", () => {
    // The guard does not get the real home from HOME: HOME is scratch here.
    expect(homeDir().startsWith(realHome)).toBe(false);
    expect(refused(join(realHome, ".scriptorium"))).toContain("will not convert the real sessions");
    // Spelled with a trailing slash and a detour, it is the same folder.
    expect(refused(`${join(realHome, ".scriptorium", "..", ".scriptorium")}/`)).toContain(
      "will not convert the real sessions",
    );
  });

  test("HOME moved to scratch, SCRIPTORIUM_HOME a symlink to the real .scriptorium", () => {
    const link = join(root, "scratch", "looks-like-a-copy");
    symlinkSync(join(realHome, ".scriptorium"), link);
    expect(refused(link)).toContain("will not convert the real sessions");
  });

  test("a scratch SCRIPTORIUM_HOME whose sessions is a symlink to the real sessions, or into them", () => {
    const a = join(root, "scratch", "a");
    mkdirSync(a);
    symlinkSync(realSessions, join(a, "sessions"));
    expect(refused(a)).toContain("will not convert the real sessions");
    const b = join(root, "scratch", "b");
    mkdirSync(b);
    symlinkSync(join(realSessions, "s1"), join(b, "sessions"));
    expect(refused(b)).toContain("will not convert the real sessions");
  });

  test("a symlink above the scratch home, to the real home, is followed though .scriptorium is not there yet", () => {
    rmSync(join(realHome, ".scriptorium"), { recursive: true });
    const link = join(root, "scratch", "up");
    symlinkSync(realHome, link);
    expect(refused(join(link, ".scriptorium"))).toContain("will not convert the real sessions");
  });

  test("a real scratch copy is allowed, and so is a sibling whose name only starts the same", () => {
    const copy = join(root, "scratch", "copy");
    mkdirSync(join(copy, "sessions", "s1"), { recursive: true });
    expect(refused(copy)).toBeNull();
    expect(refused(join(root, "scratch", "not-made-yet"))).toBeNull();
    const sib = join(root, "scratch", "sib");
    mkdirSync(sib);
    mkdirSync(join(realHome, ".scriptorium-old", "sessions"), { recursive: true });
    symlinkSync(join(realHome, ".scriptorium-old", "sessions"), join(sib, "sessions"));
    expect(refused(sib)).toBeNull();
  });

  test("off, or without the kit flag, nothing is refused; unset SCRIPTORIUM_HOME is", () => {
    expect(kitMigrateRefusal({ SCRIPTORIUM_HOME: join(realHome, ".scriptorium") }, realHome)).toBe(
      null,
    );
    expect(
      kitMigrateRefusal(
        { SCRIPTORIUM_KIT_MIGRATE: "1", SCRIPTORIUM_HOME: join(realHome, ".scriptorium") },
        realHome,
      ),
    ).toBeNull();
    expect(
      kitMigrateRefusal({ SCRIPTORIUM_KIT: "1", SCRIPTORIUM_KIT_MIGRATE: "1" }, realHome),
    ).toContain("SCRIPTORIUM_HOME is not set");
  });
});

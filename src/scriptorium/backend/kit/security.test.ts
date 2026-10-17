// The conversion dry run's guards (cycle security review): the converter never
// writes a slug, ext or workspace that names a place outside the session or
// among the sessions, and the real sessions are refused at boot and again at
// the write. Every "real home" here is a FAKE one stood up in a temp folder and
// handed in as `realHome`; nothing here names, reads or stats the account's
// actual ~/.scriptorium. HOME is the preload's scratch home throughout.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homeDir } from "../../../kit/lib/home";
import { PRE_MIGRATE_FILE } from "../../../kit/workspace/manifestMigrate";
import { type AppDeclaration, WorkspaceSession } from "../../../kit/workspace/session";
import { kitMigrateRefusal, kitMigrateWriteRefusal, scriptoriumApp } from "./app";
import { convertShippedManifest, WORKSPACE_ENTRY_ID } from "./convert";

let root: string;
let home: string;
let sessions: string;
let realHome: string;
let realSessions: string;
const T = 1_757_000_000_000;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-security-")));
  home = join(root, "scratch-home");
  sessions = join(home, "sessions");
  mkdirSync(join(sessions, "s1"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "d.md"), "# D\n");
  realHome = join(root, "Users", "someone");
  realSessions = join(realHome, ".scriptorium", "sessions");
  mkdirSync(join(realSessions, "s1"), { recursive: true });
  writeFileSync(join(realSessions, "s1", "manifest.json"), "REAL\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (id = "s1") => ({ sessionId: id, dir: join(sessions, id), sessionsRoot: sessions });
const shipped = (extra: Record<string, unknown> = {}) => ({
  format: 1,
  sessionId: "s1",
  createdAt: T,
  context: [],
  docs: [],
  openDoc: null,
  chat: [],
  ...extra,
});
const shippedDoc = (over: Record<string, unknown>) => ({
  slug: "x",
  name: "x.md",
  original: join(root, "docs", "d.md"),
  ext: ".md",
  versions: [{ n: 1, author: "human", createdAt: T }],
  active: 1,
  originalHash: "h",
  ...over,
});

describe("the converter never writes a path outside its session", () => {
  test("an unsafe slug or ext is unconvertible", () => {
    const bad: Record<string, unknown>[] = [
      { slug: "../../../escape" },
      { slug: "a/b" },
      { slug: "" },
      { ext: "/../../../../pwn.md" },
      { ext: ".m/d" },
    ];
    for (const over of bad)
      expect(() => convertShippedManifest(shipped({ docs: [shippedDoc(over)] }), at())).toThrow(
        /a shipped Scriptorium manifest, but `docs\[0\]\.(slug|ext)`/,
      );
    expect(convertShippedManifest(shipped({ docs: [shippedDoc({})] }), at())).not.toBeNull();
  });

  test("a relative context root is unconvertible", () => {
    const raw = shipped({
      context: [{ id: "c-x", root: "rel", label: "r", membership: "mirrored", nodes: [] }],
    });
    expect(() => convertShippedManifest(raw, at())).toThrow(
      /context\[0\]\.root` is not a full path/,
    );
  });

  test("scenC: the old workspace is added only where a set may be; the reason rides the chat line", () => {
    const scratchTmp = join(root, "tmp-like");
    mkdirSync(scratchTmp);
    const cases: [string, string][] = [
      ["/", "holds your home folder"],
      [dirname(homeDir()), "holds your home folder"],
      [homeDir(), "your home folder"],
      [`${homeDir()}/`, "your home folder"],
      [home, "holds the sessions' own folders"],
      [join(home, "logs"), "app's own folder"],
      [sessions, "among the sessions' own folders"],
      [join(sessions, "s1"), "among the sessions' own folders"],
      [root, "holds the sessions' own folders"],
      [".", "is not a full path"],
      ["sub", "is not a full path"],
    ];
    for (const [ws, why] of cases) {
      const r = convertShippedManifest(shipped({ workspace: ws }), at());
      const ids = (r?.manifest.context as { id: string }[]).map((e) => e.id);
      expect([ws, ids]).toEqual([ws, []]);
      expect(r?.note, ws).toContain(why);
    }
    // A folder that holds none of them (a /tmp of its own) is still added.
    const r = convertShippedManifest(shipped({ workspace: scratchTmp }), at());
    expect((r?.manifest.context as { id: string }[]).map((e) => e.id)).toEqual([
      WORKSPACE_ENTRY_ID,
    ]);
  });
});

const on = (h: string) => ({
  SCRIPTORIUM_KIT: "1",
  SCRIPTORIUM_KIT_MIGRATE: "1",
  SCRIPTORIUM_HOME: h,
});

describe("the boot refusal, with the cases the review found allowed", () => {
  const refused = (h: string) => kitMigrateRefusal(on(h), realHome);

  test("SCRIPTORIUM_HOME the real home itself, or inside the real .scriptorium", () => {
    expect(refused(realHome)).toContain("will not convert the real sessions");
    expect(refused(join(realHome, ".scriptorium", "sub"))).toContain("will not convert");
    expect(refused(join(realHome, ".scriptorium", "sessions", "s1"))).toContain("will not convert");
  });

  test("a scratch sessions folder linked to the real .scriptorium, the real home, or a folder in .scriptorium", () => {
    for (const [name, target] of [
      ["h4", join(realHome, ".scriptorium")],
      ["h5", realHome],
      ["h6", join(realHome, ".scriptorium", "sessions-old")],
    ] as const) {
      mkdirSync(target, { recursive: true });
      const h = join(root, name);
      mkdirSync(h);
      symlinkSync(target, join(h, "sessions"));
      expect([name, refused(h)]).toEqual([name, expect.stringContaining("will not convert")]);
    }
  });

  test("a plain scratch copy is still allowed", () => {
    expect(refused(home)).toBeNull();
  });
});

describe("the write-time refusal (kitMigrateWriteRefusal)", () => {
  const refusedAt = (dir: string, h = home) =>
    kitMigrateWriteRefusal(
      { dir, sessionsRoot: join(h, "sessions") },
      { ...on(h), HOME: process.env.HOME },
      realHome,
    );

  test("a plain session folder in the scratch copy is allowed", () => {
    writeFileSync(join(sessions, "s1", "manifest.json"), "{}");
    expect(refusedAt(join(sessions, "s1"))).toBeNull();
  });

  test("one session folder linked in from the real sessions (the known gap) is refused", () => {
    symlinkSync(join(realSessions, "s1"), join(sessions, "s2"));
    expect(refusedAt(join(sessions, "s2"))).toContain("leads outside the sessions folder");
  });

  test("one linked in from anywhere else is refused too", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(sessions, "s3"));
    expect(refusedAt(join(sessions, "s3"))).toContain("leads outside the sessions folder");
  });

  test("a hard-linked manifest is refused", () => {
    mkdirSync(join(sessions, "s4"));
    linkSync(join(realSessions, "s1", "manifest.json"), join(sessions, "s4", "manifest.json"));
    expect(refusedAt(join(sessions, "s4"))).toContain("hard link");
  });

  test("scenE: the sessions folder swapped for a link after boot is refused at the write", () => {
    expect(refusedAt(join(sessions, "s1"))).toBeNull();
    renameSync(sessions, `${sessions}.copy`);
    symlinkSync(realSessions, sessions);
    expect(refusedAt(join(sessions, "s1"))).toContain("will not convert the real sessions");
  });
});

describe("a restore in the dry run writes nothing to a session it may not convert", () => {
  const migrating = (): AppDeclaration => ({
    ...scriptoriumApp,
    migrateManifest: convertShippedManifest,
    migrateWriteRefusal: (a) =>
      kitMigrateWriteRefusal(a, { ...on(home), HOME: process.env.HOME }, realHome),
  });

  test("scenD: a session folder linked to the (fake) real one is refused, and the real one is untouched", () => {
    writeFileSync(
      join(realSessions, "s1", "manifest.json"),
      JSON.stringify(shipped({ workspace: join(root, "docs") })),
    );
    const before = readFileSync(join(realSessions, "s1", "manifest.json"), "utf8");
    rmSync(join(sessions, "s1"), { recursive: true });
    symlinkSync(join(realSessions, "s1"), join(sessions, "s1"));
    expect(() => WorkspaceSession.restore(sessions, migrating(), "s1")).toThrow(
      /leads outside the sessions folder/,
    );
    expect(readFileSync(join(realSessions, "s1", "manifest.json"), "utf8")).toBe(before);
    expect(readdirSync(join(realSessions, "s1"))).toEqual(["manifest.json"]);
  });

  test("a session it may convert is converted, with the original kept", () => {
    writeFileSync(
      join(sessions, "s1", "manifest.json"),
      JSON.stringify(shipped({ workspace: join(root, "docs") })),
    );
    WorkspaceSession.restore(sessions, migrating(), "s1");
    expect(existsSync(join(sessions, "s1", PRE_MIGRATE_FILE))).toBe(true);
  });
});

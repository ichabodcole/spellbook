// An app with no home workspace through a real daemon: the snapshot names no
// workspace, the agent's creates that name no place are refused 400 with the
// app's hint (and nothing is written), and those that name one go there.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureApp, fixtureDaemon, fixtureSessionsRoot } from "./fixtures/app";
import { cmd, FakeSurface } from "./fixtures/harness";
import type { PublicState } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { WorkspaceSession } from "./session";
import { seedDocs, tempRoot } from "./testing";

const HINT = "name a folder inside a set";

let root: string;
let docs: string;
let opened: string;
let daemon: WorkspaceDaemon | null = null;

beforeEach(() => {
  root = tempRoot("workspace-no-home-daemon");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  opened = join(root, "opened");
  mkdirSync(opened);
});

afterEach(async () => {
  if (daemon) await daemon.stop();
  daemon = null;
  rmSync(root, { recursive: true, force: true });
});

async function start(homeWorkspace?: false) {
  daemon = fixtureDaemon({
    app: {
      ...fixtureApp,
      ...(homeWorkspace === false ? { homeWorkspace, locationHint: HINT } : {}),
    },
    // What `open` passes as the folder it ran in.
    workspace: opened,
    tmp: join(root, "tmp"),
  });
  await daemon.start();
  const base = daemon.url;
  expect((await cmd(base, { op: "context.add", paths: [join(docs, "set")] })).status).toBe(200);
  return base;
}

const state = async (base: string) => (await (await fetch(`${base}/state`)).json()) as PublicState;

describe("no home workspace, through the daemon", () => {
  test("the snapshot names no workspace", async () => {
    const base = await start(false);
    expect("workspace" in (await state(base))).toBe(false);
  });

  test("a create, import or workspace.set that names no place of the session's is refused, with the hint", async () => {
    const base = await start(false);
    for (const body of [
      { op: "import", name: "dropped.md", text: "# D\n" },
      { op: "import", name: "dropped.md", text: "# D\n", dir: opened },
      { op: "doc.create", dir: opened, name: "new.md" },
      { op: "folder.create", dir: opened, name: "New" },
      { op: "workspace.set", path: opened },
    ]) {
      const r = await cmd(base, body);
      expect(r.status).toBe(400);
      expect(r.body.hint).toBe(HINT);
    }
    expect(readdirSync(opened)).toEqual([]);
    expect(existsSync(join(daemon?.dir ?? "", "imported"))).toBe(false);
  });

  test("named inside a set, it goes there", async () => {
    const base = await start(false);
    const set = join(docs, "set");
    expect((await cmd(base, { op: "doc.create", dir: set, name: "new.md" })).status).toBe(200);
    expect(
      (await cmd(base, { op: "import", name: "dropped.md", text: "# D\n", dir: set })).status,
    ).toBe(200);
    expect(existsSync(join(set, "new.md"))).toBe(true);
    expect(existsSync(join(set, "dropped.md"))).toBe(true);
    expect(readdirSync(opened)).toEqual([]);
  });
});

describe("a home app, through the daemon, is unchanged", () => {
  test("the snapshot names the workspace, and a drop with no folder lands in it", async () => {
    const base = await start();
    expect((await state(base)).workspace).toBe(opened);
    const r = await cmd(base, { op: "import", name: "dropped.md", text: "# D\n" });
    expect(r.status).toBe(200);
    expect(existsSync(join(opened, "dropped.md"))).toBe(true);
  });
});

describe("no destination by default on any route", () => {
  // The daemon's working directory is the folder `open` ran in, here a set:
  // a `dir` resolved against it would land in a folder nobody named.
  async function inside<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const was = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(was);
    }
  }

  for (const homeWorkspace of [false, undefined] as const) {
    test(`/cmd refuses an empty or relative dir, into or path (${homeWorkspace === false ? "no home" : "home"} app)`, async () => {
      const base = await start(homeWorkspace);
      const set = join(docs, "set");
      const before = readdirSync(set).sort();
      await inside(set, async () => {
        for (const body of [
          { op: "doc.create", dir: "", name: "new.md" },
          { op: "doc.create", dir: "part", name: "new.md" },
          { op: "folder.create", dir: ".", name: "New" },
          { op: "bundle.create", dir: "" },
          { op: "import", name: "dropped.md", text: "# D\n", dir: "" },
          { op: "move", path: join(set, "part", "b.md"), into: "." },
          { op: "folder.add", path: "fresh" },
        ]) {
          const r = await cmd(base, body);
          expect(r.status, JSON.stringify(body)).toBe(400);
          expect(String(r.body.error)).toContain("is not a full path");
        }
      });
      expect(readdirSync(set).sort()).toEqual(before);
      expect(readdirSync(join(set, "part"))).toEqual(["b.md"]);
    });
  }

  test("/cmd: a create with no dir is refused with the app's hint", async () => {
    const base = await start(false);
    for (const op of ["doc.create", "folder.create", "bundle.create"]) {
      const r = await cmd(base, { op, name: "x" });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("no location was named");
      expect(r.body.hint).toBe(HINT);
    }
  });

  test("the socket: a create with no dir is a clean refusal with the app's hint", async () => {
    await start(false);
    const surface = new FakeSurface();
    await surface.connect(daemon?.port as number);
    try {
      for (const [i, op] of (["doc.create", "folder.create"] as const).entries()) {
        surface.send({ op, rid: `r${i}` });
        const f = (await surface.waitFor(
          (m) => m.op === "error" && (m as { requestId?: unknown }).requestId === `r${i}`,
        )) as { message: string; hint?: string };
        expect(f.message).toContain("no location was named");
        expect(f.message).not.toContain("paths[0]");
        expect(f.hint).toBe(HINT);
      }
    } finally {
      surface.close();
    }
    expect(readdirSync(opened)).toEqual([]);
  });
});

describe("a restored session's old workspace, for an app with no home workspace", () => {
  test("a folder that holds files becomes a set, and the chat says so once", async () => {
    // Saved as a home app saves it: `opened` is its workspace.
    writeFileSync(join(opened, "kept.md"), "# Kept\n");
    const old = WorkspaceSession.create(fixtureSessionsRoot(), fixtureApp, undefined, opened);
    old.addContext(join(docs, "set"));
    daemon = fixtureDaemon({
      app: { ...fixtureApp, homeWorkspace: false, locationHint: HINT },
      restore: old.id,
      tmp: join(root, "tmp"),
    });
    await daemon.start();
    const s = await state(daemon.url);
    expect("workspace" in s).toBe(false);
    const sets = s.context.filter((e) => e.membership === "mirrored").map((e) => e.root);
    expect(sets).toContain(opened);
    expect(JSON.stringify(s).split("as its workspace folder").length - 1).toBe(1);
    // A create there now goes where it is pointed.
    expect((await cmd(daemon.url, { op: "doc.create", dir: opened, name: "new.md" })).status).toBe(
      200,
    );
  });
});

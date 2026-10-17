// An app with no home workspace through a real daemon: the snapshot names no
// workspace, the agent's creates that name no place are refused 400 with the
// app's hint (and nothing is written), and those that name one go there.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureApp, fixtureDaemon } from "./fixtures/app";
import { cmd } from "./fixtures/harness";
import type { PublicState } from "./protocol";
import type { WorkspaceDaemon } from "./server";
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

// An app with no home workspace (`AppDeclaration.homeWorkspace: false`): nothing
// writes a new file or folder to a place the caller did not name, a create that
// names none is refused with the way to name one, and the same acts on an app
// with a home workspace (the kit's default) are unchanged.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pngBytes } from "../lib/testImages.ts";
import { DEFAULT_LOCATION_HINT, hasHomeWorkspace } from "./noHome";
import { type AppDeclaration, WorkspaceSession } from "./session";
import { refusal, seedDocs, tempRoot, testApp } from "./testing";
import { createWorkspaceCli, openingFolder } from "./verbs";

const HINT = "name a folder inside a set, or `add-folder <path>`";
const noHomeApp: AppDeclaration = { ...testApp, homeWorkspace: false, locationHint: HINT };

let root: string;
let sessions: string;
let docs: string;
let set: string;
/** The folder `open` ran in: what a home app would write into unasked. */
let opened: string;

beforeEach(() => {
  root = tempRoot("workspace-no-home");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
  set = join(docs, "set");
  opened = join(root, "opened");
  mkdirSync(opened);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A no-home session over the set, created as `open` would with a cwd. */
function noHome(): WorkspaceSession {
  const s = WorkspaceSession.create(sessions, noHomeApp, undefined, opened);
  s.addContext(set);
  return s;
}

const manifest = (s: WorkspaceSession) =>
  JSON.parse(readFileSync(join(s.dir, "manifest.json"), "utf8")) as Record<string, unknown>;

/** Nothing new anywhere a caller did not name: the opening folder and the session's `imported/`. */
function nothingUnasked(s: WorkspaceSession): void {
  expect(readdirSync(opened)).toEqual([]);
  expect(existsSync(join(s.dir, "imported"))).toBe(false);
}

describe("the declaration", () => {
  test("absent or true is a home workspace; only false is none", () => {
    expect(hasHomeWorkspace(testApp)).toBe(true);
    expect(hasHomeWorkspace({ ...testApp, homeWorkspace: true })).toBe(true);
    expect(hasHomeWorkspace(noHomeApp)).toBe(false);
  });

  test("a new session keeps no workspace, even when one is passed", () => {
    const s = noHome();
    expect(s.hasHome).toBe(false);
    expect("workspace" in manifest(s)).toBe(false);
    // The same call on a home app keeps it: unchanged.
    const h = WorkspaceSession.create(sessions, testApp, undefined, opened);
    expect(h.hasHome).toBe(true);
    expect(manifest(h).workspace).toBe(opened);
  });

  test("a restore drops a workspace the manifest still holds, and defaults none", () => {
    const s = noHome();
    const id = s.id;
    const path = join(s.dir, "manifest.json");
    const m = manifest(s);
    writeFileSync(path, JSON.stringify({ ...m, workspace: opened }));
    const back = WorkspaceSession.restore(sessions, noHomeApp, id);
    expect(back.restoreReport.workspaceDefaulted).toBeUndefined();
    expect("workspace" in manifest(back)).toBe(false);
    // A manifest with none at all: still none, and nothing said about it.
    const again = WorkspaceSession.restore(sessions, noHomeApp, id);
    expect(again.restoreReport.workspaceDefaulted).toBeUndefined();
    expect("workspace" in manifest(again)).toBe(false);
  });
});

describe("a create that names no place is refused, with the way to name one", () => {
  test("a dropped document with no folder (`import` with no dir)", () => {
    const s = noHome();
    const e = refusal(() => s.importText("dropped.md", "# Dropped\n"));
    expect(e.status).toBe(400);
    expect(e.message).toContain("no location was named");
    expect(e.hint).toBe(HINT);
    nothingUnasked(s);
  });

  test("a dropped image with no folder", () => {
    const s = noHome();
    const e = refusal(() => s.importImage("pic.png", pngBytes(4, 4), { onTaken: "ask" }));
    expect(e.status).toBe(400);
    expect(e.hint).toBe(HINT);
    nothingUnasked(s);
  });

  test("a document, folder or bundle in a folder that is not the session's (the opening folder too)", () => {
    const s = noHome();
    for (const dir of [opened, join(s.dir, "imported"), root]) {
      for (const act of [
        () => s.createDoc(dir, "new.md"),
        () => s.createFolder(dir, "New"),
        () => s.importText("dropped.md", "x", dir),
      ]) {
        const e = refusal(act);
        expect(e.status).toBe(400);
        expect(e.message).toContain("is not a folder in this session");
        expect(e.hint).toBe(HINT);
      }
    }
    nothingUnasked(s);
    expect(existsSync(join(root, "new.md"))).toBe(false);
  });

  test("a move into a folder that is not the session's", () => {
    const s = noHome();
    const e = refusal(() => s.move(join(set, "a.md"), opened));
    expect(e.status).toBe(400);
    expect(e.hint).toBe(HINT);
    expect(existsSync(join(set, "a.md"))).toBe(true);
    nothingUnasked(s);
  });

  test("setting a workspace is refused: there is none to set", () => {
    const s = noHome();
    const e = refusal(() => s.setWorkspace(opened));
    expect(e.status).toBe(400);
    expect(e.message).toContain("no workspace folder to set");
    expect(e.hint).toBe(HINT);
    expect("workspace" in manifest(s)).toBe(false);
  });

  test("an app that gives no words of its own gets the kit's", () => {
    const s = WorkspaceSession.create(sessions, { ...testApp, homeWorkspace: false });
    expect(refusal(() => s.importText("x.md", "x")).hint).toBe(DEFAULT_LOCATION_HINT);
  });
});

describe("a create that names its place goes there", () => {
  test("a document, a folder and a drop inside a set", () => {
    const s = noHome();
    expect(s.createDoc(join(set, "part"), "new.md").path).toBe(join(set, "part", "new.md"));
    const f = s.createFolder(set, "Drafts");
    expect(f.path).toBe(join(set, "Drafts"));
    // A folder inside the set, not a set of its own.
    expect(s.context.some((e) => e.root === f.path)).toBe(false);
    expect(s.importText("dropped.md", "# D\n", set).path).toBe(join(set, "dropped.md"));
    expect(s.importImage("pic.png", pngBytes(4, 4), { dir: set, onTaken: "ask" }).path).toBe(
      join(set, "pic.png"),
    );
    nothingUnasked(s);
  });

  test("a new folder anywhere whose parent exists, named in full, becomes a set", () => {
    const s = noHome();
    const r = s.addFolder(join(root, "elsewhere"));
    expect(r.set).toBe(true);
    expect(s.createDoc(join(root, "elsewhere"), "first.md").path).toBe(
      join(root, "elsewhere", "first.md"),
    );
    nothingUnasked(s);
  });

  test("a set that holds the folder the session opened in is no overlap: there is no workspace", () => {
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    const s = WorkspaceSession.create(sessions, noHomeApp, undefined, inner);
    expect(s.addContext(outer).added).toBe(true);
    expect(s.workspaceOverlap()).toBeNull();
    // A home app refuses the same: unchanged.
    const h = WorkspaceSession.create(sessions, testApp, undefined, inner);
    expect(refusal(() => h.addContext(outer)).status).toBe(409);
  });
});

describe("a home app is unchanged", () => {
  test("a drop and a create with no folder land in the workspace", () => {
    const h = WorkspaceSession.create(sessions, testApp, undefined, opened);
    expect(h.importText("dropped.md", "x").path).toBe(join(opened, "dropped.md"));
    expect(h.createDoc(opened, "new.md").path).toBe(join(opened, "new.md"));
    const nothing = WorkspaceSession.create(sessions, testApp);
    expect(nothing.importText("dropped.md", "x").path).toBe(
      join(nothing.dir, "imported", "dropped.md"),
    );
  });
});

describe("the CLI of an app with no home workspace", () => {
  const cli = (app: { name: string; homeWorkspace?: boolean }) =>
    createWorkspaceCli({
      app,
      daemon: { command: "bun", args: [] },
      sessionsRoot: () => sessions,
      version: () => ({}),
    });

  test("has no `workspace` verb, and `import` takes --into", () => {
    const home = cli({ name: "kit-test" });
    const none = cli({ name: "kit-test", homeWorkspace: false });
    const names = (c: ReturnType<typeof cli>) => c.rows.map((r) => r.name);
    expect(names(home)).toContain("workspace");
    expect(names(none)).not.toContain("workspace");
    const accepted = (c: ReturnType<typeof cli>, verb: string) => [
      ...(c.rows.find((r) => r.name === verb)?.accepted ?? []),
    ];
    expect(accepted(home, "import")).not.toContain("into");
    expect(accepted(none, "import")).toContain("into");
  });

  test("`import` with no --into is refused before anything is read or sent", async () => {
    const none = cli({ name: "kit-test", homeWorkspace: false });
    const file = join(root, "in.md");
    writeFileSync(file, "# In\n");
    const errs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code: number;
    try {
      code = await none.run(["import", file]);
    } finally {
      process.stderr.write = write;
    }
    expect(code).toBe(2);
    const env = JSON.parse(errs.join("")) as { error: { message: string; hint: string } };
    expect(env.error.message).toContain("--into <folder>");
    expect(env.error.hint).toBe(DEFAULT_LOCATION_HINT);
  });
});

describe("the folder `open` ran in, for an app with no home workspace", () => {
  test("an ordinary folder is added", () => {
    expect(openingFolder(opened, sessions)).toEqual({ path: opened });
  });

  test("not the home folder, one above it, the top of the disk, or the sessions' own", () => {
    const home = process.env.HOME as string;
    expect("skipped" in openingFolder(home, sessions)).toBe(true);
    expect("skipped" in openingFolder(join(home, ".."), sessions)).toBe(true);
    expect("skipped" in openingFolder("/", sessions)).toBe(true);
    mkdirSync(join(sessions, "abc"), { recursive: true });
    expect("skipped" in openingFolder(join(sessions, "abc"), sessions)).toBe(true);
  });

  test("by where it really is: a link to the home folder is the home folder", () => {
    const link = join(root, "home-link");
    symlinkSync(process.env.HOME as string, link);
    expect("skipped" in openingFolder(link, sessions)).toBe(true);
  });
});

// Bundles in the session: a folder of a registered type is one item in the
// tree, opens as its main file, is versioned by its main file only, renames,
// moves and duplicates whole, is searched inside, and reports a change inside
// it as a change to it. The daemon's acts (undo, the Trash, the watcher) are
// in `bundles.server.test.ts`.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import type { ContextNode } from "./protocol";
import { WorkspaceSession } from "./session";
import { refusal, TEST_BUNDLE, tempRoot, testApp, writeBundle } from "./testing";

/**
 * The test type's extension, named on every New: in one test process other
 * files register types of their own (Atlas's canvas), so "the first type" is
 * not this one.
 */
const BOARD = TEST_BUNDLE.extension;

let root: string;
let sessions: string;
let set: string;
let ws: string;

beforeAll(() => registerBundleType(TEST_BUNDLE));
afterAll(() => unregisterBundleType(TEST_BUNDLE.extension));

beforeEach(() => {
  root = tempRoot("workspace-bundles");
  sessions = join(root, "sessions");
  set = join(root, "set");
  ws = join(root, "ws");
  well = join(set, "The well.boardbundle");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n\nSee [the well](./The%20well.boardbundle).\n");
  writeBundle(set, "The well", {
    version: 1,
    type: "board",
    title: "The well at the Glade",
    description: "A well at the Glade's edge",
    colour: "vermilion",
  });
  writeBundle(join(set, "part"), "untitled-board", null);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => {
  const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
  s.addContext(set);
  return s;
};

const nodesOf = (s: WorkspaceSession, at = set): ContextNode[] =>
  s.context.find((e) => e.root === at)?.nodes ?? [];
const flat = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n, ...flat(n.children)] : [n]));
let well: string;
const info = (bundle: string) => JSON.parse(readFileSync(join(bundle, "info.json"), "utf8"));

describe("one item in the tree", () => {
  test("a bundle is one row, named by info.json's title, with its type; its insides do not show", () => {
    const s = session();
    const all = flat(nodesOf(s));
    expect(all.find((n) => n.rel === "The well.boardbundle")).toEqual({
      kind: "bundle",
      rel: "The well.boardbundle",
      type: "board",
      main: "board.board",
      title: "The well at the Glade",
      description: "A well at the Glade's edge",
    });
    // No title: the row is named by its folder (the surface strips the extension).
    expect(all.find((n) => n.rel === "part/untitled-board.boardbundle")).toEqual({
      kind: "bundle",
      rel: "part/untitled-board.boardbundle",
      type: "board",
      main: "board.board",
    });
    expect(all.some((n) => n.rel.includes(".boardbundle/"))).toBe(false);
  });

  test("a folder with an unregistered name is an ordinary folder", () => {
    mkdirSync(join(set, "x.otherbundle"));
    writeFileSync(join(set, "x.otherbundle", "n.md"), "# N\n");
    const s = session();
    expect(flat(nodesOf(s)).find((n) => n.rel === "x.otherbundle")?.kind).toBe("group");
  });

  test("a bundle added by itself is one listed item, never a set of its insides", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    const { entry } = s.addContext(well);
    expect(entry.membership).toBe("listed");
    expect(entry.root).toBe(set);
    expect(entry.nodes).toHaveLength(1);
    expect(entry.nodes[0]?.kind).toBe("bundle");
  });
});

describe("opening and versions", () => {
  test("opening a bundle opens its main file, read as JSON, named for its bundle", () => {
    const s = session();
    const { slug } = s.openPath(well);
    expect(slug).toBe("the-well");
    const d = s.doc(slug);
    expect(d.original).toBe(join(well, "board.board"));
    expect(d.rel).toBe("The well.boardbundle/board.board");
    expect(d.ext).toBe(".board");
    // Shown by its bundle's title, never as the name every main file shares,
    // and the new one after a rename.
    expect(d.name).toBe("The well at the Glade");
    s.rename(well, "Dry");
    expect(s.doc(slug).name).toBe("Dry");
    s.rename(join(set, "Dry.boardbundle"), "The well.boardbundle");
    // Opening the main file by its own path lands on the same document.
    expect(s.openPath(join(well, "board.board")).slug).toBe(slug);
  });

  test("versions are of the main file only: assets are never copied into the session", () => {
    const s = session();
    const { slug } = s.openPath(well);
    s.newVersion({ doc: slug, by: "agent" });
    const dir = join(s.docsDir, slug);
    expect(readdirSync(dir).sort()).toEqual(["v1.board", "v2.board"]);
    expect(readFileSync(join(dir, "v1.board"), "utf8")).toContain("lantern");
    // Nothing of the bundle's other files is anywhere in the session folder.
    const everything = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? everything(join(d, e.name)) : [e.name],
      );
    expect(everything(s.dir).some((n) => n === "fox.png" || n === "info.json")).toBe(false);
  });

  test("the main file is guarded as JSON: Save refuses text that does not parse", () => {
    const s = session();
    const { slug } = s.openPath(well);
    s.edit(slug, 1, '{"nodes": [}');
    expect(refusal(() => s.save(slug)).message).toContain("JSON");
    s.edit(slug, 1, '{"nodes":[],"edges":[]}\n');
    s.save(slug);
    expect(readFileSync(join(well, "board.board"), "utf8")).toBe('{"nodes":[],"edges":[]}\n');
  });
});

describe("rename, move and duplicate act on the whole folder", () => {
  test("a rename names the folder and the title alike, and keeps every other key", () => {
    const s = session();
    const r = s.rename(well, "The dry well");
    const to = join(set, "The dry well.boardbundle");
    expect(r).toMatchObject({
      path: to,
      from: well,
      title: { from: "The well at the Glade", to: "The dry well" },
    });
    expect(existsSync(well)).toBe(false);
    expect(existsSync(join(to, "assets", "fox.png"))).toBe(true);
    expect(info(to)).toEqual({
      version: 1,
      type: "board",
      title: "The dry well",
      description: "A well at the Glade's edge",
      colour: "vermilion",
    });
    const node = flat(nodesOf(s)).find((n) => n.rel === "The dry well.boardbundle");
    expect(node).toMatchObject({ kind: "bundle", title: "The dry well" });
  });

  test("a name given with the extension names the folder exactly; the title is its stem", () => {
    const s = session();
    const r = s.rename(well, "dry.boardbundle");
    expect(r.path).toBe(join(set, "dry.boardbundle"));
    expect(info(r.path).title).toBe("dry");
  });

  test("the open main file follows its bundle, with its versions", () => {
    const s = session();
    const { slug } = s.openPath(well);
    s.rename(well, "Elsewhere");
    expect(s.doc(slug).original).toBe(join(set, "Elsewhere.boardbundle", "board.board"));
    s.move(join(set, "Elsewhere.boardbundle"), join(set, "part"));
    expect(s.doc(slug).original).toBe(join(set, "part", "Elsewhere.boardbundle", "board.board"));
    expect(s.doc(slug).versions).toHaveLength(1);
  });

  test("a folder is never renamed into a bundle, nor made as one", () => {
    const s = session();
    expect(refusal(() => s.rename(join(set, "part"), "part.boardbundle")).message).toContain(
      "make a new board",
    );
    expect(refusal(() => s.createFolder(set, "x.boardbundle")).status).toBe(400);
    expect(existsSync(join(set, "part"))).toBe(true);
  });

  test("nothing is moved or made inside a bundle: it is not a folder to the tree", () => {
    const s = session();
    expect(refusal(() => s.move(join(set, "a.md"), well)).status).toBe(400);
    expect(refusal(() => s.createDoc(well)).status).toBe(400);
    expect(refusal(() => s.createBundle(well, BOARD)).status).toBe(400);
    expect(refusal(() => s.createBundle(join(well, "assets"), BOARD)).status).toBe(400);
    expect(existsSync(join(set, "a.md"))).toBe(true);
  });

  test("a duplicate copies the whole bundle beside it, named as Finder names a copy, its title too", () => {
    const s = session();
    const r = s.duplicate(well);
    const to = join(set, "The well copy.boardbundle");
    expect(r).toMatchObject({ path: to, from: well, dir: true });
    expect(readFileSync(join(to, "assets", "fox.png"), "utf8")).toBe("not really a png");
    expect(readFileSync(join(to, "board.board"), "utf8")).toContain("lantern");
    expect(info(to)).toMatchObject({ title: "The well at the Glade copy", colour: "vermilion" });
    expect(info(well).title).toBe("The well at the Glade");
    expect(flat(nodesOf(s)).some((n) => n.rel === "The well copy.boardbundle")).toBe(true);
  });

  test("a document duplicates too; a folder, an image and a whole set do not", () => {
    const s = session();
    expect(s.duplicate(join(set, "a.md"))).toMatchObject({
      path: join(set, "a copy.md"),
      dir: false,
    });
    expect(readFileSync(join(set, "a copy.md"), "utf8")).toContain("the well");
    expect(refusal(() => s.duplicate(join(set, "part"))).status).toBe(400);
    expect(existsSync(join(set, "part copy"))).toBe(false);
    writeFileSync(join(set, "fox.png"), "png");
    s.rescan(s.context[0]?.id ?? "");
    expect(refusal(() => s.duplicate(join(set, "fox.png"))).status).toBe(400);
    expect(refusal(() => s.duplicate(set)).status).toBe(400);
  });

  test("a relative link inside a duplicated bundle still reads relative, and leads inside the copy", () => {
    writeFileSync(join(well, "notes.md"), "# Notes\n");
    mkdirSync(join(well, "inner"));
    symlinkSync("../notes.md", join(well, "inner", "rel.md"));
    const s = session();
    const copy = s.duplicate(well).path;
    expect(readlinkSync(join(copy, "inner", "rel.md"))).toBe("../notes.md");
    expect(realpathSync(join(copy, "inner", "rel.md"))).toBe(realpathSync(join(copy, "notes.md")));
    writeFileSync(join(copy, "inner", "rel.md"), "# Changed in the copy\n");
    expect(readFileSync(join(well, "notes.md"), "utf8")).toBe("# Notes\n");
  });

  test("a dangling link at a copy's name is kept, and the copy takes the next free name", () => {
    symlinkSync(join(root, "nowhere"), join(set, "The well copy.boardbundle"));
    symlinkSync(join(root, "nowhere.md"), join(set, "a copy.md"));
    const s = session();
    expect(s.duplicate(well).path).toBe(join(set, "The well copy 2.boardbundle"));
    expect(s.duplicate(join(set, "a.md")).path).toBe(join(set, "a copy 2.md"));
    expect(lstatSync(join(set, "The well copy.boardbundle")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(set, "a copy.md")).isSymbolicLink()).toBe(true);
    // And a new item's default name passes one by too.
    symlinkSync(join(root, "nowhere-2.md"), join(set, "Untitled.md"));
    expect(s.createDoc(set).path).toBe(join(set, "Untitled 2.md"));
  });

  test("something that appears at a copy's name before it is made is refused and left there", () => {
    const s = session();
    const to = join(set, "The well copy.boardbundle");
    // Another process makes a folder there between the name check and the copy.
    const real = fs.mkdirSync;
    const spy = spyOn(fs, "mkdirSync").mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p) === to) {
        spy.mockRestore();
        real(to);
        writeFileSync(join(to, "theirs.txt"), "not ours");
      }
      return real(p, o as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync);
    try {
      const e = refusal(() => s.duplicate(well));
      expect(e.status).toBe(409);
      expect(e.message).toContain("EEXIST");
    } finally {
      spy.mockRestore();
    }
    expect(readFileSync(join(to, "theirs.txt"), "utf8")).toBe("not ours");
  });

  test("a copy that fails part way is removed, and the refusal says why", () => {
    const locked = join(well, "assets", "locked.png");
    writeFileSync(locked, "secret");
    chmodSync(locked, 0o000);
    try {
      const s = session();
      const e = refusal(() => s.duplicate(well));
      expect(e.status).toBe(409);
      expect(e.message).toContain("EACCES");
      expect(existsSync(join(set, "The well copy.boardbundle"))).toBe(false);
      expect(flat(nodesOf(s)).some((n) => n.rel === "The well copy.boardbundle")).toBe(false);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("copies of copies: the next free 'copy N', never 'copy copy', titles alike", () => {
    writeFileSync(join(set, "Ch 4.md"), "# Ch 4\n");
    const s = session();
    const ch = join(set, "Ch 4.md");
    expect(s.duplicate(ch).path).toBe(join(set, "Ch 4 copy.md"));
    expect(s.duplicate(ch).path).toBe(join(set, "Ch 4 copy 2.md"));
    expect(s.duplicate(join(set, "Ch 4 copy.md")).path).toBe(join(set, "Ch 4 copy 3.md"));
    expect(s.duplicate(join(set, "Ch 4 copy 2.md")).path).toBe(join(set, "Ch 4 copy 4.md"));
    // The first free number after "copy" from 2: a gap is filled.
    rmSync(join(set, "Ch 4 copy 2.md"));
    s.rescan(s.context[0]?.id ?? "");
    expect(s.duplicate(ch).path).toBe(join(set, "Ch 4 copy 2.md"));
    // A bundle's copy of a copy, and its title.
    const copy = s.duplicate(well).path;
    const again = s.duplicate(copy).path;
    expect(again).toBe(join(set, "The well copy 2.boardbundle"));
    expect(info(again).title).toBe("The well at the Glade copy 2");
  });

  test("a long name is shortened to fit, never its copy suffix", () => {
    const long = `${"a".repeat(247)}.md`;
    expect(long.length).toBe(250);
    writeFileSync(join(set, long), "# Long\n");
    const s = session();
    const one = basename(s.duplicate(join(set, long)).path);
    expect(one.endsWith(" copy.md")).toBe(true);
    expect(Buffer.byteLength(one)).toBeLessThanOrEqual(255);
    const two = basename(s.duplicate(join(set, long)).path);
    expect(two.endsWith(" copy 2.md")).toBe(true);
    expect(Buffer.byteLength(two)).toBeLessThanOrEqual(255);
  });

  test("a bundle that is a link is not duplicated, and its target is left as it was", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const real = writeBundle(elsewhere, "Real", { version: 1, type: "board", title: "Real" });
    const before = readFileSync(join(real, "info.json"), "utf8");
    symlinkSync(real, join(set, "Linked.boardbundle"));
    const s = session();
    const e = refusal(() => s.duplicate(join(set, "Linked.boardbundle")));
    expect(e.status).toBe(409);
    expect(e.message).toContain("is a link");
    expect(readFileSync(join(real, "info.json"), "utf8")).toBe(before);
    expect(existsSync(join(set, "Linked copy.boardbundle"))).toBe(false);
  });

  test("an info.json that is a link is copied as it is and never written through", () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, '{"title":"Outside"}\n');
    const linked = writeBundle(set, "Linky", null);
    symlinkSync(outside, join(linked, "info.json"));
    const s = session();
    const copy = s.duplicate(linked).path;
    expect(readFileSync(outside, "utf8")).toBe('{"title":"Outside"}\n');
    expect(lstatSync(join(copy, "info.json")).isSymbolicLink()).toBe(true);
  });

  test("an info.json that does not parse is left byte for byte by a rename, and the row shows the folder", () => {
    const broken = '{"title": "Half", oops\n';
    writeFileSync(join(well, "info.json"), broken);
    const s = session();
    const r = s.rename(well, "Elsewhere");
    expect(r.title).toBeUndefined();
    const to = join(set, "Elsewhere.boardbundle");
    expect(readFileSync(join(to, "info.json"), "utf8")).toBe(broken);
    expect(flat(nodesOf(s)).find((n) => n.rel === "Elsewhere.boardbundle")).not.toHaveProperty(
      "title",
    );
  });

  test("a bundle with no info.json is not given one by a rename", () => {
    const s = session();
    const plain = join(set, "part", "untitled-board.boardbundle");
    const r = s.rename(plain, "Named");
    expect(existsSync(join(r.path, "info.json"))).toBe(false);
    expect(r.title).toBeUndefined();
  });
});

describe("nothing inside a bundle is an entry of its own", () => {
  test("adding a folder or a file inside a bundle adds the bundle", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    const { entry } = s.addContext(join(well, "assets"));
    expect(entry).toMatchObject({ membership: "listed", root: set });
    expect(entry.nodes[0]).toMatchObject({ kind: "bundle", rel: "The well.boardbundle" });
    expect(s.addContext(join(well, "info.json")).added).toBe(false);
    expect(s.context).toHaveLength(1);
    expect(refusal(() => s.createDoc(join(well, "assets"))).status).toBe(400);
    expect(existsSync(join(well, "assets", "Untitled.md"))).toBe(false);
  });

  test("a workspace inside a bundle writes nothing into it", () => {
    const inside = join(well, "assets");
    // A set elsewhere to move from: one holding the bundle would hold the workspace.
    const notes = join(root, "notes");
    mkdirSync(notes);
    writeFileSync(join(notes, "n.md"), "# N\n");
    const s = WorkspaceSession.create(sessions, testApp, undefined, inside);
    s.addContext(notes);
    const refused = (fn: () => unknown) => {
      const e = refusal(fn);
      expect(e.status).toBe(409);
      expect(e.message).toContain("inside the board The well at the Glade");
    };
    const before = readdirSync(inside).sort();
    refused(() => s.createDoc(inside));
    refused(() => s.createFolder(inside));
    refused(() => s.createBundle(inside, BOARD));
    refused(() => s.importText("dropped.md", "# Dropped\n"));
    refused(() =>
      s.importImage("fox.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        onTaken: "keep-both",
      }),
    );
    refused(() => s.move(join(notes, "n.md"), inside));
    expect(readdirSync(inside).sort()).toEqual(before);
    expect(existsSync(join(notes, "n.md"))).toBe(true);
  });
});

describe("the guard through links", () => {
  test("a linked folder in a set that leads into a bundle takes nothing", () => {
    const other = join(root, "other");
    mkdirSync(other);
    const x = writeBundle(other, "x", { version: 1, type: "board", title: "X" });
    symlinkSync(join(x, "assets"), join(set, "lnk"));
    const before = readdirSync(join(x, "assets")).sort();
    const s = session();
    const refused = (fn: () => unknown) => {
      const e = refusal(fn);
      expect(e.status).toBe(409);
      expect(e.message).toContain("inside the board X");
    };
    refused(() => s.createDoc(join(set, "lnk")));
    refused(() => s.createFolder(join(set, "lnk")));
    refused(() => s.move(join(set, "a.md"), join(set, "lnk")));
    expect(readdirSync(join(x, "assets")).sort()).toEqual(before);
    expect(existsSync(join(set, "a.md"))).toBe(true);
  });

  test("a workspace that is a link into a bundle writes nothing into it, and is refused when set", () => {
    const other = join(root, "other");
    mkdirSync(other);
    const x = writeBundle(other, "x", { version: 1, type: "board", title: "X" });
    const wslink = join(root, "wslink");
    symlinkSync(join(x, "assets"), wslink);
    const before = readdirSync(join(x, "assets")).sort();
    const s = WorkspaceSession.create(sessions, testApp, undefined, wslink);
    const refused = (fn: () => unknown) => {
      const e = refusal(fn);
      expect(e.status).toBe(409);
      expect(e.message).toContain("inside the board X");
    };
    refused(() => s.createDoc(wslink));
    refused(() => s.createBundle(wslink, BOARD));
    refused(() =>
      s.importImage("fox2.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        onTaken: "keep-both",
      }),
    );
    expect(readdirSync(join(x, "assets")).sort()).toEqual(before);
    // Setting it says so at once, by its name and through the link alike.
    const t = WorkspaceSession.create(sessions, testApp, undefined, ws);
    refused(() => t.setWorkspace(wslink));
    refused(() => t.setWorkspace(join(x, "assets")));
    expect(t.workspace).toBe(ws);
  });

  test("a set added through a link into a bundle is the bundle, never its insides", () => {
    const other = join(root, "other");
    mkdirSync(other);
    const x = writeBundle(other, "x", { version: 1, type: "board", title: "X" });
    const link = join(root, "assets-link");
    symlinkSync(join(x, "assets"), link);
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    const { entry } = s.addContext(link);
    expect(entry).toMatchObject({ membership: "listed", root: other });
    expect(entry.nodes[0]).toMatchObject({ kind: "bundle", title: "X" });
    expect(refusal(() => s.createDoc(link)).status).toBe(400);
  });
});

describe("names", () => {
  test("a new item's default name takes the first free number from 2, filling a gap", () => {
    writeFileSync(join(set, "Untitled 3.md"), "");
    const s = session();
    expect(s.createDoc(set).path).toBe(join(set, "Untitled.md"));
    expect(s.createDoc(set).path).toBe(join(set, "Untitled 2.md"));
    expect(s.createDoc(set).path).toBe(join(set, "Untitled 4.md"));
    expect(s.createBundle(set, BOARD).path).toBe(join(set, "Untitled.boardbundle"));
    expect(s.createBundle(set, BOARD).path).toBe(join(set, "Untitled 2.boardbundle"));
  });

  test("a huge number beside a default name never keeps it counting", () => {
    writeFileSync(join(set, "Untitled.md"), "");
    writeFileSync(join(set, "Untitled 9007199254740992.md"), "");
    const s = session();
    expect(s.createDoc(set).path).toBe(join(set, "Untitled 2.md"));
  });

  test("a rename never doubles an extension", () => {
    const s = session();
    writeFileSync(join(set, "notes.md"), "# Notes\n");
    writeFileSync(join(set, "other.md"), "# Other\n");
    s.rescan(s.context[0]?.id ?? "");
    expect(s.rename(join(set, "notes.md"), "notes.md").path).toBe(join(set, "notes.md"));
    expect(s.rename(join(set, "other.md"), "other.MD").path).toBe(join(set, "other.MD"));
    const dry = s.rename(well, "dry.boardbundle");
    expect(dry.path).toBe(join(set, "dry.boardbundle"));
    expect(info(dry.path).title).toBe("dry");
    const cased = s.rename(dry.path, "Dry.BoardBundle");
    expect(cased.path).toBe(join(set, "Dry.BoardBundle"));
    expect(info(cased.path).title).toBe("Dry");
    const plain = s.rename(cased.path, "plain");
    expect(plain.path).toBe(join(set, "plain.boardbundle"));
    expect(info(plain.path).title).toBe("plain");
  });
});

describe("a new bundle", () => {
  test("made in a set: its folder, info.json and an empty main file, and nothing else", () => {
    const s = session();
    const r = s.createBundle(set, BOARD);
    const abs = join(set, "Untitled.boardbundle");
    expect(r.path).toBe(abs);
    expect(readdirSync(abs).sort()).toEqual(["board.board", "info.json"]);
    expect(info(abs)).toEqual({ version: 1, type: "board", title: "Untitled" });
    expect(readFileSync(join(abs, "board.board"), "utf8")).toBe(TEST_BUNDLE.mainTemplate);
    expect(flat(nodesOf(s)).find((n) => n.rel === "Untitled.boardbundle")).toMatchObject({
      kind: "bundle",
      title: "Untitled",
    });
    // A second one takes a free name, and its title says so.
    const two = s.createBundle(set, BOARD);
    expect(two.path).toBe(join(set, "Untitled 2.boardbundle"));
    expect(info(two.path).title).toBe("Untitled 2");
  });

  test("made in the workspace, it is listed there as one item", () => {
    const s = session();
    const r = s.createBundle(ws, BOARD);
    const entry = s.context.find((e) => e.root === ws);
    expect(entry?.membership).toBe("listed");
    expect(entry?.nodes).toEqual([
      {
        kind: "bundle",
        rel: "Untitled.boardbundle",
        type: "board",
        main: "board.board",
        title: "Untitled",
      },
    ]);
    // And it is renamed as the one item it is.
    s.rename(r.path, "Notes for later");
    expect(s.context.find((e) => e.root === ws)?.nodes[0]).toMatchObject({
      rel: "Notes for later.boardbundle",
      title: "Notes for later",
    });
  });

  test("an unknown type, or a folder outside the session, is refused", () => {
    const s = session();
    expect(refusal(() => s.createBundle(set, ".nopebundle")).status).toBe(400);
    expect(refusal(() => s.createBundle(join(root, "elsewhere"), BOARD)).status).toBe(400);
  });
});

describe("the Trash, search and the watcher", () => {
  test("a bundle's Trash preview names it as one item, with the documents held inside it", () => {
    const s = session();
    s.openPath(well);
    expect(s.trashPreview(well)).toMatchObject({
      path: well,
      dir: true,
      files: 3,
      folders: 1,
      bundle: { label: "board", name: "The well at the Glade" },
      docs: [{ slug: "the-well", name: "The well at the Glade" }],
    });
  });

  test("search reads inside a bundle's main file, though the tree hides it, and names the bundle", () => {
    const s = session();
    const text = s.search({ query: "lantern" });
    const hit = text.results.find((r) => r.path === join(well, "board.board"));
    expect(hit).toMatchObject({
      kind: "text",
      bundle: { path: well, name: "The well at the Glade", label: "board" },
    });
    // By name: the bundle's title, not the name every main file shares.
    const named = s.search({ query: "Glade" });
    expect(
      named.results.some((r) => r.kind === "name" && r.path === join(well, "board.board")),
    ).toBe(true);
    // Assets and info.json are not documents.
    expect(s.search({ query: "vermilion" }).results).toEqual([]);
  });

  test("a change to any file inside a bundle is reported as a change to the bundle", () => {
    const s = session();
    writeFileSync(join(well, "assets", "fox.png"), "changed");
    expect(s.onFileEvent(join(well, "assets", "fox.png"))).toEqual({
      kind: "bundle",
      path: well,
      file: join(well, "assets", "fox.png"),
    });
    // A new title is read into the row with it.
    writeFileSync(join(well, "info.json"), '{"version":1,"type":"board","title":"Renamed"}\n');
    expect(s.onFileEvent(join(well, "info.json"))).toMatchObject({ kind: "bundle", path: well });
    expect(flat(nodesOf(s)).find((n) => n.rel === "The well.boardbundle")).toMatchObject({
      title: "Renamed",
    });
    // The watcher's echo of the session's own act is not news: a new bundle's files.
    const made = s.createBundle(set, BOARD).path;
    expect(s.onFileEvent(join(made, "info.json"))).toBeNull();
    // An unopened main file is the bundle's change too; an opened one is a document's.
    expect(s.onFileEvent(join(well, "board.board"))).toMatchObject({ kind: "bundle" });
    s.openPath(well);
    writeFileSync(join(well, "board.board"), '{"nodes":[],"edges":[]}\n');
    expect(s.onFileEvent(join(well, "board.board"))).toMatchObject({ kind: "original.reloaded" });
  });
});

// Structure ops against a temp folder: every op is a real change on disk, the
// model follows it, nothing is deleted, and nothing is overwritten. The daemon
// adds only the announcement, so these tests are the behaviour both parties get.
// Also the workspace (the drop target and a place to create in) and what a reveal may be aimed at.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homeDir } from "../lib/home.ts";
import type { ContextNode } from "./protocol";
import { tilde, WorkspaceSession } from "./session";
import { refusal, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let set: string;
let ws: string;

beforeEach(() => {
  root = tempRoot("workspace-structure");
  sessions = join(root, "sessions");
  set = join(root, "set");
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n");
  writeFileSync(join(set, "part", "b.md"), "# B\n");
  writeFileSync(join(root, "solo.md"), "# Solo\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => {
  const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
  s.addContext(set);
  return s;
};

const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n.rel, ...rels(n.children)] : [n.rel]));

const entryAt = (s: WorkspaceSession, r: string) => s.context.find((e) => e.root === r);

/**
 * A session saved before the overlap block, its workspace `at` (the set's folder
 * or one inside it): written into the manifest, as no act can make it now.
 */
const overlapping = (at: string): WorkspaceSession => {
  const s = session();
  const file = join(sessions, s.id, "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  m.workspace = at;
  writeFileSync(file, JSON.stringify(m));
  return WorkspaceSession.restore(sessions, testApp, s.id);
};

describe("new documents and folders", () => {
  test("a document in a set is a real empty file, shown at once; a default name never collides", () => {
    const s = session();
    const one = s.createDoc(set);
    const two = s.createDoc(join(set, "part"));
    const three = s.createDoc(set);
    expect(one.path).toBe(join(set, "Untitled.md"));
    expect(two.path).toBe(join(set, "part", "Untitled.md"));
    expect(three.path).toBe(join(set, "Untitled 2.md"));
    expect(readFileSync(one.path, "utf8")).toBe("");
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("Untitled 2.md");
  });

  test("an explicit name that exists is refused, and nothing is overwritten", () => {
    const s = session();
    const e = refusal(() => s.createDoc(set, "a.md"));
    expect(e.status).toBe(409);
    expect(readFileSync(join(set, "a.md"), "utf8")).toBe("# A\n");
  });

  test("a name without a document extension gets .md; a path-like name is refused", () => {
    const s = session();
    expect(s.createDoc(set, "notes").path).toBe(join(set, "notes.md"));
    expect(refusal(() => s.createDoc(set, "../escape.md")).status).toBe(400);
    expect(refusal(() => s.createDoc(set, ".secret.md")).status).toBe(400);
  });

  test("a document may start with text, and `free` takes the next free name rather than refusing", () => {
    const s = session();
    const one = s.createDoc(set, "a", { text: "A seed note.\n", free: true });
    expect(one.path).toBe(join(set, "a 2.md"));
    expect(readFileSync(one.path, "utf8")).toBe("A seed note.\n");
    expect(readFileSync(join(set, "a.md"), "utf8")).toBe("# A\n");
    expect(s.createDoc(set, "fresh", { text: "x", free: true }).path).toBe(join(set, "fresh.md"));
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("a 2.md");
    // Without `free`, a taken name is still refused.
    expect(refusal(() => s.createDoc(set, "a", { text: "y" })).status).toBe(409);
  });

  test("a new empty folder is shown: it used to vanish from the mirror", () => {
    const s = session();
    const f = s.createFolder(set);
    expect(f.path).toBe(join(set, "New folder"));
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("New folder");
    expect(s.createDoc(f.path).path).toBe(join(set, "New folder", "Untitled.md"));
  });

  test("a folder outside every mirrored entry is refused: the context stays the way in", () => {
    const s = session();
    expect(refusal(() => s.createDoc(root)).status).toBe(400);
    expect(existsSync(join(root, "Untitled.md"))).toBe(false);
    // A listed entry's folder is not a destination either: it holds one file, not a set.
    s.addContext(join(root, "solo.md"));
    expect(refusal(() => s.createDoc(root)).status).toBe(400);
  });
});

describe("move and rename: real moves, and the model follows", () => {
  test("a document moved into a folder moves on disk and keeps its versions", () => {
    const s = session();
    const { slug } = s.openPath(join(set, "a.md"));
    s.newVersion({ doc: slug, by: "agent" });
    const r = s.move(join(set, "a.md"), join(set, "part"));
    expect(r.path).toBe(join(set, "part", "a.md"));
    expect(existsSync(join(set, "a.md"))).toBe(false);
    expect(readFileSync(r.path, "utf8")).toBe("# A\n");
    const d = s.doc(slug);
    expect(d.original).toBe(r.path);
    expect(d.rel).toBe("part/a.md");
    expect(d.versions.map((v) => v.n)).toEqual([1, 2]);
    // Save still writes, to the new path: admission survives the move.
    s.save(slug);
    expect(existsSync(r.path)).toBe(true);
  });

  test("a single document dragged into a set becomes part of it: its own entry goes", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    expect(s.context).toHaveLength(2);
    s.move(join(root, "solo.md"), set);
    expect(s.context).toHaveLength(1);
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("solo.md");
  });

  test("moving into itself, into where it already is, or onto an existing name is refused", () => {
    const s = session();
    s.createFolder(join(set, "part"), "inner");
    expect(refusal(() => s.move(join(set, "part"), join(set, "part", "inner"))).status).toBe(400);
    expect(refusal(() => s.move(join(set, "a.md"), set)).status).toBe(400);
    writeFileSync(join(set, "part", "a.md"), "other");
    s.rescan(entryAt(s, set)?.id ?? "");
    expect(refusal(() => s.move(join(set, "a.md"), join(set, "part"))).status).toBe(409);
    expect(readFileSync(join(set, "part", "a.md"), "utf8")).toBe("other");
  });

  test("rename keeps a document extension, follows an open doc, and renames a set's folder", () => {
    const s = session();
    const { slug } = s.openPath(join(set, "part", "b.md"));
    expect(s.rename(join(set, "part", "b.md"), "beta").path).toBe(join(set, "part", "beta.md"));
    expect(s.doc(slug).original).toBe(join(set, "part", "beta.md"));
    const r = s.rename(set, "renamed");
    expect(entryAt(s, r.path)?.label).toBe("renamed");
    expect(s.doc(slug).original).toBe(join(root, "renamed", "part", "beta.md"));
  });

  test("a path the context does not show cannot be moved or renamed", () => {
    const s = session();
    expect(refusal(() => s.move(join(root, "solo.md"), set)).status).toBe(404);
    expect(refusal(() => s.rename(join(root, "solo.md"), "x")).status).toBe(404);
  });
});

describe("moving out of a set: into the workspace folder, as its own entry", () => {
  test("a document moved out of a set becomes its own listed entry, and keeps its versions", () => {
    const s = session();
    const { slug } = s.openPath(join(set, "part", "b.md"));
    s.newVersion({ doc: slug, by: "agent" });
    const r = s.move(join(set, "part", "b.md"), ws);
    expect(r).toEqual({ path: join(ws, "b.md"), from: join(set, "part", "b.md") });
    expect(existsSync(join(set, "part", "b.md"))).toBe(false);
    expect(readFileSync(join(ws, "b.md"), "utf8")).toBe("# B\n");
    expect(rels(entryAt(s, set)?.nodes ?? [])).not.toContain("part/b.md");
    const own = s.context.filter((e) => e.membership === "listed");
    expect(own.map((e) => [e.root, e.nodes.map((n) => n.rel)])).toEqual([[ws, ["b.md"]]]);
    const d = s.doc(slug);
    expect(d.original).toBe(join(ws, "b.md"));
    expect(d.entryId).toBe(own[0]?.id ?? "");
    expect(d.versions.map((v) => v.n)).toEqual([1, 2]);
  });

  test("and back again: a move into the set takes the listed entry away", () => {
    const s = session();
    s.move(join(set, "a.md"), ws);
    s.move(join(ws, "a.md"), set);
    expect(existsSync(join(set, "a.md"))).toBe(true);
    expect(s.context).toHaveLength(1);
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("a.md");
  });

  test("an image moved out takes its description, and both are listed, the description beside it", () => {
    const s = session();
    const png = join(set, "fox.png");
    writeFileSync(png, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    writeFileSync(`${png}.md`, "---\ntype: image\n---\n");
    s.rescan(entryAt(s, set)?.id ?? "");
    const r = s.move(png, ws);
    expect(r).toEqual({ path: join(ws, "fox.png"), from: png, sidecar: join(ws, "fox.png.md") });
    const listed = s.context
      .filter((e) => e.membership === "listed")
      .map((e) => e.nodes[0]?.rel)
      .sort();
    expect(listed).toEqual(["fox.png", "fox.png.md"]);
  });

  test("a folder moved out of a set becomes a set of its own", () => {
    const s = session();
    const r = s.move(join(set, "part"), ws);
    expect(r.path).toBe(join(ws, "part"));
    expect(entryAt(s, join(ws, "part"))?.membership).toBe("mirrored");
    expect(rels(entryAt(s, join(ws, "part"))?.nodes ?? [])).toEqual(["b.md"]);
  });

  test("a name already in the workspace is refused, and nothing moves", () => {
    const s = session();
    writeFileSync(join(ws, "a.md"), "theirs");
    expect(refusal(() => s.move(join(set, "a.md"), ws)).status).toBe(409);
    expect(readFileSync(join(ws, "a.md"), "utf8")).toBe("theirs");
    expect(existsSync(join(set, "a.md"))).toBe(true);
  });
});

describe("the workspace and a set may not overlap", () => {
  test("setting the workspace to a set's folder, or a folder inside one, is refused naming the set", () => {
    const s = session();
    for (const at of [set, join(set, "part")]) {
      const e = refusal(() => s.setWorkspace(at));
      expect(e.status).toBe(409);
      expect(e.message).toContain("the set set");
      expect(e.message).toContain(set);
      expect(e.message).toContain(root);
    }
    expect(s.workspace).toBe(ws);
  });

  test("the same through a symlink: compared by where the folder really is", () => {
    const s = session();
    const alias = join(root, "alias");
    symlinkSync(set, alias);
    expect(refusal(() => s.setWorkspace(join(alias, "part"))).message).toContain("the set set");
  });

  test("a set whose folder is the workspace, or holds it, is refused, and nothing is added", () => {
    const inner = join(root, "outer", "inner");
    mkdirSync(inner, { recursive: true });
    const s = WorkspaceSession.create(sessions, testApp, undefined, inner);
    for (const at of [inner, join(root, "outer")]) {
      const e = refusal(() => s.addContext(at));
      expect(e.status).toBe(409);
      expect(e.message).toContain(inner);
    }
    expect(refusal(() => s.addContext(inner)).message).toContain("is the workspace folder");
    expect(refusal(() => s.addContext(join(root, "outer"))).message).toContain(
      "holds the workspace folder",
    );
    expect(s.context).toHaveLength(0);
    // A document in the workspace is no set: it is listed as before.
    writeFileSync(join(inner, "n.md"), "# n\n");
    expect(s.addContext(join(inner, "n.md")).added).toBe(true);
  });

  test("a set inside the workspace is allowed, and its files show once, in the set", () => {
    const s = session();
    s.setWorkspace(root);
    expect(s.workspaceOverlap()).toBeNull();
    // New things at the top of the workspace, and a move out of the set, are
    // listed entries; nothing in the set is listed beside it.
    s.createDoc(root, "top.md");
    s.move(join(set, "a.md"), root);
    s.importText("dropped.md", "x");
    const shown = s.context.flatMap((e) =>
      e.membership === "mirrored"
        ? rels(e.nodes).map((r) => join(e.root, r))
        : e.nodes.map((n) => join(e.root, n.rel)),
    );
    expect(shown.length).toBe(new Set(shown).size);
    expect(shown.sort()).toEqual(
      [
        join(root, "a.md"),
        join(root, "dropped.md"),
        join(root, "top.md"),
        join(set, "part"),
        join(set, "part", "b.md"),
      ].sort(),
    );
  });

  test("a session that already overlaps still opens, and the checkup says what to change", () => {
    const s = overlapping(join(set, "part"));
    expect(s.workspace).toBe(join(set, "part"));
    expect(s.workspaceOverlap()).toEqual({ label: "set", root: set, same: false });
    const f = s.checkup().find((x) => x.kind === "workspace.overlap");
    expect(f?.message).toContain("inside the set set");
    expect(f?.message).toContain(`such as ${root}`);
    expect(f?.fix).toContain("remove set from the context");
    // Changing it is allowed, to a folder outside the set.
    s.setWorkspace(ws);
    expect(s.workspaceOverlap()).toBeNull();
    expect(s.checkup().some((x) => x.kind === "workspace.overlap")).toBe(false);
  });

  test("the overlap is said once per session, not at every restore, and again only when it changes", () => {
    const s = overlapping(join(set, "part"));
    expect(s.overlapToSay()?.label).toBe("set");
    const again = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(again.overlapToSay()).toBeNull();
    // The doctor still lists it every time.
    expect(again.checkup().some((x) => x.kind === "workspace.overlap")).toBe(true);
  });

  test("paths in words show the home folder as ~", () => {
    expect(tilde(join(homeDir(), "worlds", "bible"))).toBe("~/worlds/bible");
    expect(tilde(homeDir())).toBe("~");
    expect(tilde("/elsewhere/x")).toBe("/elsewhere/x");
  });
});

describe("undo of a move goes back, wherever back is", () => {
  test("a set's whole folder moved into the workspace returns to a folder that is no set", () => {
    const s = session();
    const r = s.move(set, ws);
    expect(r.path).toBe(join(ws, "set"));
    // The folder it came from (root) is not a place a party may move to...
    expect(refusal(() => s.move(join(ws, "set"), root)).status).toBe(400);
    // ...but the undo of the move takes it back there.
    const back = s.move(join(ws, "set"), root, { back: true });
    expect(back.path).toBe(set);
    expect(entryAt(s, set)?.membership).toBe("mirrored");
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("a.md");
  });

  test("a folder that has gone is a refusal in words", () => {
    const s = session();
    s.move(join(set, "a.md"), join(set, "part"));
    rmSync(join(root, "nowhere"), { recursive: true, force: true });
    const e = refusal(() =>
      s.move(join(set, "part", "a.md"), join(root, "nowhere"), { back: true }),
    );
    expect(e.status).toBe(409);
    expect(e.message).toContain("no longer a folder");
  });
});

describe("the workspace: where drops and new top-level things land", () => {
  test("a new session's workspace is what it was given; nothing said is its own imported/ folder, never home", () => {
    expect(WorkspaceSession.create(sessions, testApp, undefined, ws).workspace).toBe(ws);
    const bare = WorkspaceSession.create(sessions, testApp);
    expect(bare.workspace).toBe(join(bare.dir, "imported"));
    expect(bare.workspace).not.toBe(homeDir());
    // Made on demand: a drop and a new document both land there.
    expect(existsSync(bare.workspace)).toBe(false);
    expect(bare.importText("note.md", "x").path).toBe(join(bare.dir, "imported", "note.md"));
    const other = WorkspaceSession.create(sessions, testApp);
    expect(other.createDoc(other.workspace).path).toBe(join(other.dir, "imported", "Untitled.md"));
    expect(existsSync(join(other.dir, "imported", "Untitled.md"))).toBe(true);
  });

  test("a workspace that has gone is a clear conflict for a new document or folder, and for a drop", () => {
    const s = session();
    rmSync(ws, { recursive: true });
    for (const act of [
      () => s.createDoc(ws),
      () => s.createFolder(ws),
      () => s.importText("a.md", "x"),
    ]) {
      const e = refusal(act);
      expect(e.status).toBe(409);
      expect(e.message).toContain("workspace folder is gone");
    }
  });

  test("a folder that cannot be written to is not accepted as the workspace", () => {
    const s = session();
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      // Root bypasses the mode bits, so only assert where the folder really is unwritable.
      let writable = true;
      try {
        accessSync(locked, constants.W_OK);
      } catch {
        writable = false;
      }
      if (!writable) {
        expect(refusal(() => s.setWorkspace(locked)).status).toBe(400);
        expect(s.workspace).toBe(ws);
      }
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("setWorkspace takes an existing folder, and refuses a missing path or a file", () => {
    const s = session();
    expect(s.setWorkspace(root)).toEqual({ path: root, from: ws });
    expect(s.workspace).toBe(root);
    expect(refusal(() => s.setWorkspace(join(root, "nope"))).status).toBe(404);
    expect(refusal(() => s.setWorkspace(join(root, "solo.md"))).status).toBe(400);
    expect(s.workspace).toBe(root);
  });

  test("the workspace survives a restore", () => {
    const s = session();
    s.setWorkspace(root);
    expect(WorkspaceSession.restore(sessions, testApp, s.id).workspace).toBe(root);
  });

  test("a manifest without one gets the first context entry's folder, else its own imported/ folder", () => {
    const strip = (id: string) => {
      const file = join(sessions, id, "manifest.json");
      const m = JSON.parse(readFileSync(file, "utf8"));
      m.workspace = undefined;
      writeFileSync(file, JSON.stringify(m));
    };
    const withEntry = WorkspaceSession.create(sessions, testApp, undefined, ws);
    withEntry.addContext(join(root, "solo.md"));
    strip(withEntry.id);
    const r = WorkspaceSession.restore(sessions, testApp, withEntry.id);
    expect(r.workspace).toBe(root);
    expect(r.restoreReport.workspaceDefaulted).toBe(root);
    // It was written back: the next restore reads it as set.
    expect(
      WorkspaceSession.restore(sessions, testApp, withEntry.id).restoreReport.workspaceDefaulted,
    ).toBeUndefined();

    // A first entry that is a set is not the workspace: the two may not overlap.
    const withSet = session();
    strip(withSet.id);
    const fromSet = WorkspaceSession.restore(sessions, testApp, withSet.id);
    expect(fromSet.workspace).toBe(join(withSet.dir, "imported"));
    expect(fromSet.workspaceOverlap()).toBeNull();

    const empty = WorkspaceSession.create(sessions, testApp, undefined, ws);
    strip(empty.id);
    const back = WorkspaceSession.restore(sessions, testApp, empty.id);
    expect(back.workspace).toBe(join(empty.dir, "imported"));
    expect(back.restoreReport.workspaceDefaulted).toBe(join(empty.dir, "imported"));
  });

  test("a new document or folder in the workspace is real, and shown as its own entry", () => {
    const s = session();
    const doc = s.createDoc(ws);
    expect(doc.path).toBe(join(ws, "Untitled.md"));
    expect(readFileSync(doc.path, "utf8")).toBe("");
    expect(s.context.some((e) => e.membership === "listed" && e.root === ws)).toBe(true);
    expect(s.createDoc(ws).path).toBe(join(ws, "Untitled 2.md"));
    const folder = s.createFolder(ws);
    // A folder made in the workspace is a set, and is named as one.
    expect(folder.path).toBe(join(ws, "New set"));
    expect(entryAt(s, folder.path)?.membership).toBe("mirrored");
    expect(s.createFolder(ws).path).toBe(join(ws, "New set 2"));
    // The new folder is a set now, so things can be made in it, and a folder
    // made in it is a folder.
    expect(s.createDoc(folder.path).path).toBe(join(ws, "New set", "Untitled.md"));
    expect(s.createFolder(folder.path).path).toBe(join(ws, "New set", "New folder"));
  });

  test("a folder inside a set is still created there, not in the workspace", () => {
    const s = session();
    expect(s.createDoc(set).path).toBe(join(set, "Untitled.md"));
    expect(existsSync(join(ws, "Untitled.md"))).toBe(false);
  });
});

describe("import: a dropped file is a copy in the workspace folder", () => {
  test("it lands in the workspace, is shown, and opens like any document", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    expect(s.context).toHaveLength(0);
    const r = s.importText("note.md", "# Dropped\n");
    expect(r.path).toBe(join(ws, "note.md"));
    expect(readFileSync(r.path, "utf8")).toBe("# Dropped\n");
    expect(s.context.map((e) => [e.membership, e.nodes.map((n) => n.rel)])).toEqual([
      ["listed", ["note.md"]],
    ]);
    expect(existsSync(join(s.dir, "imported"))).toBe(false);
    expect(s.openPath(r.path).created).toBe(true);
  });

  test("a second drop never overwrites: a name in use gets a free one", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    s.importText("note.md", "first");
    const again = s.importText("note.md", "second");
    expect(again.path).toBe(join(ws, "note 2.md"));
    expect(readFileSync(join(ws, "note.md"), "utf8")).toBe("first");
  });

  test("a drop into a workspace that is a set (a session from before the block) shows in the set", () => {
    const s = overlapping(set);
    const r = s.importText("extra.md", "x");
    expect(r.path).toBe(join(set, "extra.md"));
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("extra.md");
    expect(s.context).toHaveLength(1);
  });

  test("a drop onto a set lands in that set's folder, and onto anything else is refused", () => {
    const s = session();
    const r = s.importText("extra.md", "x", join(set, "part"));
    expect(r.path).toBe(join(set, "part", "extra.md"));
    expect(existsSync(join(ws, "extra.md"))).toBe(false);
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("part/extra.md");
    expect(refusal(() => s.importText("x.md", "x", root)).status).toBe(400);
  });

  test("a non-document is refused with the extensions, and a folder name points at the picker", () => {
    const s = session();
    const e = refusal(() => s.importText("pic.png", "x"));
    expect(e.status).toBe(400);
    expect(e.choices).toContain(".md");
    const folder = refusal(() => s.importText("Some Folder", ""));
    expect(folder.hint).toContain("file picker");
  });

  test("an oversized text is refused", () => {
    const s = session();
    const big = "x".repeat(WorkspaceSession.IMPORT_MAX_BYTES + 1);
    expect(refusal(() => s.importText("big.md", big)).status).toBe(400);
    expect(existsSync(join(ws, "big.md"))).toBe(false);
  });

  test("a workspace that has gone is refused in words", () => {
    const s = session();
    rmSync(ws, { recursive: true });
    expect(refusal(() => s.importText("a.md", "x")).status).toBe(409);
  });

  test("a name with a path in it cannot reach outside the workspace", () => {
    const s = session();
    expect(refusal(() => s.importText("../escape.md", "x")).status).toBe(400);
    expect(refusal(() => s.importText("a/b.md", "x")).status).toBe(400);
  });
});

describe("revealTarget: only paths the session already knows", () => {
  test("a shown document, a set folder, the session folder and its contents pass", () => {
    const s = session();
    const { slug } = s.openPath(join(set, "a.md"));
    expect(s.revealTarget(join(set, "part", "b.md"))).toBe(join(set, "part", "b.md"));
    expect(s.revealTarget(set)).toBe(set);
    expect(s.revealTarget(s.dir)).toBe(s.dir);
    expect(s.revealTarget(s.readVersion(slug, 1).path)).toBe(s.readVersion(slug, 1).path);
    s.importText("note.md", "x");
    expect(s.revealTarget(join(ws, "note.md"))).toBe(join(ws, "note.md"));
  });

  test("anything else is refused as not found, including a path that does not exist", () => {
    const s = session();
    for (const outside of ["/etc/passwd", "/", root, join(root, "solo.md")]) {
      const e = refusal(() => s.revealTarget(outside));
      expect(e.status, outside).toBe(404);
    }
    expect(refusal(() => s.revealTarget(join(set, "nothing-here.md"))).status).toBe(404);
  });

  test("a relative path is a usage refusal, never resolved against the daemon's cwd", () => {
    const s = session();
    expect(refusal(() => s.revealTarget("set/a.md")).status).toBe(400);
  });

  test("a dot-dot cannot carry a request out of the session folder or an entry", () => {
    const s = session();
    expect(refusal(() => s.revealTarget(join(s.dir, "..", "..", "etc"))).status).toBe(404);
    expect(refusal(() => s.revealTarget(join(set, "..", "solo.md"))).status).toBe(404);
  });

  test("a symlink inside an entry that points outside is refused", () => {
    symlinkSync(join(root, "solo.md"), join(set, "escape.md"));
    const s = session();
    expect(refusal(() => s.revealTarget(join(set, "escape.md"))).status).toBe(404);
  });

  test("what is revealed is the realpath, and a link from outside pointing in is refused", () => {
    const s = session();
    const outside = tempRoot("workspace-outside");
    try {
      // A symlink outside every known root whose target is inside one: the path
      // as given is outside, so it is refused even though its realpath is inside.
      symlinkSync(join(set, "a.md"), join(outside, "sneaky.md"));
      symlinkSync(s.dir, join(outside, "session-link"));
      expect(refusal(() => s.revealTarget(join(outside, "sneaky.md"))).status).toBe(404);
      expect(refusal(() => s.revealTarget(join(outside, "session-link"))).status).toBe(404);
      // A link inside a root to somewhere else inside a root: allowed, and the
      // file manager is handed the real path, not the link.
      symlinkSync(join(set, "a.md"), join(set, "alias.md"));
      expect(s.revealTarget(join(set, "alias.md"))).toBe(join(set, "a.md"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a listed entry reveals its own file, not its siblings", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    writeFileSync(join(root, "sibling.md"), "x");
    s.addContext(join(root, "solo.md"));
    expect(s.revealTarget(join(root, "solo.md"))).toBe(join(root, "solo.md"));
    expect(refusal(() => s.revealTarget(join(root, "sibling.md"))).status).toBe(404);
    expect(refusal(() => s.revealTarget(root)).status).toBe(404);
  });
});

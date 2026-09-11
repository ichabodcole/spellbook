// E22–E24's structure ops, against a temp home and temp folders: every op is a
// real change on disk, the model follows it, nothing is deleted, and nothing is
// overwritten. The daemon adds only the announcement, so these cells are the
// behaviour both parties get.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextNode } from "./protocol";
import { Session, SessionError } from "./session";

let root: string;
let home: string;
let set: string;
let ws: string;

beforeEach(() => {
  // realpath: macOS's tmpdir is a symlink, and paths are compared as spelled.
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-structure-")));
  home = join(root, "home");
  set = join(root, "set");
  ws = join(root, "ws");
  mkdirSync(join(set, "part"), { recursive: true });
  mkdirSync(ws);
  writeFileSync(join(set, "a.md"), "# A\n");
  writeFileSync(join(set, "part", "b.md"), "# B\n");
  writeFileSync(join(root, "solo.md"), "# Solo\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => {
  const s = Session.create(home, undefined, ws);
  s.addContext(set);
  return s;
};

const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n.rel, ...rels(n.children)] : [n.rel]));

const entryAt = (s: Session, r: string) => s.context.find((e) => e.root === r);

const refusal = (fn: () => unknown): SessionError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SessionError) return e;
    throw e;
  }
  throw new Error("expected a SessionError");
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

  test("a new EMPTY folder is shown — it used to vanish from the mirror", () => {
    const s = session();
    const f = s.createFolder(set);
    expect(f.path).toBe(join(set, "New folder"));
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("New folder");
    expect(s.createDoc(f.path).path).toBe(join(set, "New folder", "Untitled.md"));
  });

  test("the workspace takes a new top-level document (a listed entry) or folder (a new set)", () => {
    const s = session();
    const d = s.createDoc(ws);
    const f = s.createFolder(ws, "ideas");
    expect(entryAt(s, ws)?.membership).toBe("listed");
    expect(entryAt(s, ws)?.nodes).toEqual([{ kind: "doc", rel: "Untitled.md" }]);
    expect(d.path).toBe(join(ws, "Untitled.md"));
    expect(entryAt(s, f.path)?.membership).toBe("mirrored");
  });

  test("a folder outside the context and the workspace is refused — the context stays the way in", () => {
    const s = session();
    expect(refusal(() => s.createDoc(root)).status).toBe(400);
    expect(existsSync(join(root, "Untitled.md"))).toBe(false);
  });
});

describe("move and rename — real moves, and the model follows", () => {
  test("a document moved into a folder moves on disk and keeps its versions", () => {
    const s = session();
    const { slug } = s.openPath(join(set, "a.md"));
    s.newVersion({ doc: slug, author: "agent" });
    const r = s.move(join(set, "a.md"), join(set, "part"));
    expect(r.path).toBe(join(set, "part", "a.md"));
    expect(existsSync(join(set, "a.md"))).toBe(false);
    expect(readFileSync(r.path, "utf8")).toBe("# A\n");
    const d = s.doc(slug);
    expect(d.original).toBe(r.path);
    expect(d.rel).toBe("part/a.md");
    expect(d.versions.map((v) => v.n)).toEqual([1, 2]);
    // Save still writes — to the NEW path (admission survives the move).
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

  test("a folder moved out of a set into the workspace becomes a set of its own", () => {
    const s = session();
    const r = s.move(join(set, "part"), ws);
    expect(entryAt(s, r.path)?.membership).toBe("mirrored");
    expect(rels(entryAt(s, r.path)?.nodes ?? [])).toEqual(["b.md"]);
    expect(rels(entryAt(s, set)?.nodes ?? [])).not.toContain("part");
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
});

describe("remove from Scriptorium — never from disk (E24)", () => {
  test("hiding a document or folder in a set keeps the files; unhide brings them back", () => {
    const s = session();
    const id = entryAt(s, set)?.id ?? "";
    s.openPath(join(set, "part", "b.md"));
    s.hide(join(set, "part"));
    expect(rels(entryAt(s, set)?.nodes ?? [])).toEqual(["a.md"]);
    expect(existsSync(join(set, "part", "b.md"))).toBe(true);
    // The open document was inside it: closed in the view, not lost.
    expect(s.openDocSlug).toBeNull();
    expect(s.unhide(id).restored).toBe(1);
    expect(rels(entryAt(s, set)?.nodes ?? [])).toContain("part/b.md");
  });

  test("hiding a whole entry removes the entry; the files stay", () => {
    const s = session();
    const r = s.hide(set);
    expect(r.removedEntry).toBe(true);
    expect(s.context).toHaveLength(0);
    expect(existsSync(join(set, "a.md"))).toBe(true);
  });
});

describe("turn a document into a set (E22)", () => {
  test("a folder named for it, the document moved in, the entry now mirrors the folder", () => {
    const s = Session.create(home, undefined, ws);
    const { entry } = s.addContext(join(root, "solo.md"));
    const { slug } = s.openPath(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    expect(r.folder).toBe(join(root, "solo"));
    expect(r.path).toBe(join(root, "solo", "solo.md"));
    const e = s.context.find((x) => x.id === entry.id);
    expect(e?.membership).toBe("mirrored");
    expect(e?.root).toBe(join(root, "solo"));
    expect(s.doc(slug).original).toBe(r.path);
    // It is a set now: a new document can be made in it.
    expect(s.createDoc(r.folder).path).toBe(join(root, "solo", "Untitled.md"));
  });

  test("a document already in a set is refused — make a folder there instead", () => {
    const s = session();
    expect(refusal(() => s.makeSet(join(set, "a.md"))).status).toBe(400);
  });
});

describe("import — E23's drop is a copy", () => {
  test("into the workspace by default, under a free name, shown as a document", () => {
    const s = session();
    writeFileSync(join(ws, "note.md"), "already here");
    const r = s.importText("note.md", "# Dropped\n");
    expect(r.path).toBe(join(ws, "note 2.md"));
    expect(readFileSync(r.path, "utf8")).toBe("# Dropped\n");
    expect(readFileSync(join(ws, "note.md"), "utf8")).toBe("already here");
    expect(entryAt(s, ws)?.nodes).toEqual([{ kind: "doc", rel: "note 2.md" }]);
  });

  test("into a folder of a set; a non-document is refused with the extensions", () => {
    const s = session();
    expect(s.importText("x.md", "x", join(set, "part")).path).toBe(join(set, "part", "x.md"));
    const e = refusal(() => s.importText("pic.png", "x"));
    expect(e.status).toBe(400);
    expect(e.choices).toContain(".md");
  });
});

describe("shownPath — what a reveal may be aimed at", () => {
  test("a shown document, a set folder and the workspace pass; anything else is refused", () => {
    const s = session();
    expect(s.shownPath(join(set, "part", "b.md"))).toBe(join(set, "part", "b.md"));
    expect(s.shownPath(set)).toBe(set);
    expect(s.shownPath(ws)).toBe(ws);
    expect(refusal(() => s.shownPath(join(root, "solo.md"))).status).toBe(400);
    expect(refusal(() => s.shownPath("/etc/passwd")).status).toBe(400);
  });
});

describe("the workspace", () => {
  test("defaults to what the session was created with, persists, and must be a folder", () => {
    const s = session();
    expect(s.workspace).toBe(ws);
    s.setWorkspace(set);
    expect(Session.restore(home, s.id).workspace).toBe(set);
    expect(refusal(() => s.setWorkspace(join(set, "a.md"))).status).toBe(400);
    expect(refusal(() => s.setWorkspace(join(root, "nope"))).status).toBe(404);
  });
});

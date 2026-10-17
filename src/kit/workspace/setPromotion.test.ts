// Set promotion (`makeSet`, and its way back `unmakeSet`) and a folder where
// the caller names it (`addFolder`), against a temp folder: real changes on
// disk, the model following them, the entry's id kept, nothing overwritten.
// Ported from Scriptorium's `structure.test.ts` ("turn a document into a set
// (E22)"), with what the kit adds: what is keyed by the document and the entry
// survives, links, and the way back.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import type { ContextNode } from "./protocol";
import { GoneError, WorkspaceSession } from "./session";
import { refusal, TEST_BUNDLE, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let set: string;
let ws: string;

beforeAll(() => registerBundleType(TEST_BUNDLE));
afterAll(() => unregisterBundleType(TEST_BUNDLE.extension));

beforeEach(() => {
  root = tempRoot("workspace-set-promotion");
  sessions = join(root, "sessions");
  set = join(root, "set");
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n");
  writeFileSync(join(set, "part", "b.md"), "# B\n");
  writeFileSync(join(root, "solo.md"), "# Solo\n\nSee [the sibling](sibling.md).\n");
  writeFileSync(join(root, "sibling.md"), "# Sibling\n\nBack to [solo](solo.md).\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => {
  const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
  s.addContext(set);
  return s;
};

const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n.rel, ...rels(n.children)] : [n.rel]));

const entryById = (s: WorkspaceSession, id: string) => s.context.find((e) => e.id === id);

describe("makeSet: a document listed on its own becomes a set", () => {
  test("a folder named for it, the document moved in, the SAME entry now mirrors the folder", () => {
    const s = session();
    const { entry } = s.addContext(join(root, "solo.md"));
    const { slug } = s.openPath(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    expect(r).toMatchObject({
      folder: join(root, "solo"),
      path: join(root, "solo", "solo.md"),
      from: join(root, "solo.md"),
      entry: entry.id,
    });
    expect(existsSync(join(root, "solo.md"))).toBe(false);
    expect(readFileSync(r.path, "utf8")).toContain("# Solo");
    const e = entryById(s, entry.id);
    expect(e?.membership).toBe("mirrored");
    expect(e?.root).toBe(join(root, "solo"));
    expect(e?.label).toBe("solo");
    expect(rels(e?.nodes ?? [])).toEqual(["solo.md"]);
    expect(s.context).toHaveLength(2);
    expect(s.doc(slug).original).toBe(r.path);
    // It is a set now: a new document can be made in it.
    expect(s.createDoc(r.folder).path).toBe(join(root, "solo", "Untitled.md"));
  });

  test("its versions, notes and chat references by slug survive, and so does the entry id after a restore", () => {
    const s = session();
    const { entry } = s.addContext(join(root, "solo.md"));
    const { slug } = s.openPath(join(root, "solo.md"));
    s.newVersion({ doc: slug, body: "# Solo, again\n", by: "agent" });
    const { note } = s.addNote({ doc: slug, body: "tighten this", by: "human", quote: "Solo" });
    const v1 = s.readVersion(slug, 1).path;
    s.addMessage({
      from: "human",
      text: "what about this one?",
      about: { doc: slug, version: 2, path: s.readVersion(slug, 2).path },
    });
    const r = s.makeSet(join(root, "solo.md"));

    const d = s.doc(slug);
    expect(d.original).toBe(r.path);
    expect(d.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(s.readVersion(slug, 1).path).toBe(v1);
    expect(s.readVersion(slug, 2).text).toBe("# Solo, again\n");
    expect(s.notesOf({ doc: slug }).notes.map((n) => n.id)).toEqual([note.id]);
    // A chat reference names the document by slug: it still leads to it, now
    // at its new path, and the version file it named is still there.
    const about = s.messages().at(-1)?.about;
    expect(about?.doc).toBe(slug);
    expect(s.findDoc(about?.doc ?? "")?.original).toBe(r.path);
    expect(existsSync(about?.path ?? "")).toBe(true);
    // Save writes to the new path.
    s.activate({ doc: slug, version: 2 });
    s.save(slug);
    expect(readFileSync(r.path, "utf8")).toBe("# Solo, again\n");

    const back = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(entryById(back, entry.id)).toMatchObject({
      membership: "mirrored",
      root: join(root, "solo"),
    });
    expect(back.doc(slug).original).toBe(r.path);
  });

  test("the folder takes the next free name; nothing that exists is touched", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    mkdirSync(join(root, "solo"));
    writeFileSync(join(root, "solo", "keep.md"), "keep");
    writeFileSync(join(root, "solo 2"), "a file, not a folder");
    const r = s.makeSet(join(root, "solo.md"));
    expect(r.folder).toBe(join(root, "solo 3"));
    expect(readFileSync(join(root, "solo", "keep.md"), "utf8")).toBe("keep");
    expect(readFileSync(join(root, "solo 2"), "utf8")).toBe("a file, not a folder");
  });

  test("a document already in a set is refused: make a folder there instead", () => {
    const s = session();
    const e = refusal(() => s.makeSet(join(set, "a.md")));
    expect(e.status).toBe(400);
    expect(e.message).toContain("make a folder there instead");
    expect(refusal(() => s.makeSet(set)).status).toBe(400);
    expect(existsSync(join(set, "a"))).toBe(false);
    expect(existsSync(join(set, "a.md"))).toBe(true);
  });

  test("an image or a bundle listed on its own is refused, and nothing is made", () => {
    const s = session();
    writeFileSync(join(root, "pic.png"), "png");
    s.addContext(join(root, "pic.png"));
    expect(refusal(() => s.makeSet(join(root, "pic.png"))).status).toBe(400);
    expect(existsSync(join(root, "pic"))).toBe(false);
    const board = join(root, "b.boardbundle");
    mkdirSync(board);
    writeFileSync(join(board, "board.board"), "{}");
    s.addContext(board);
    expect(refusal(() => s.makeSet(board)).status).toBe(400);
    expect(existsSync(join(root, "b"))).toBe(false);
  });

  test("a path not shown is refused (404)", () => {
    const s = session();
    expect(refusal(() => s.makeSet(join(root, "solo.md"))).status).toBe(404);
    expect(existsSync(join(root, "solo"))).toBe(false);
  });

  test("with `links`: the links the move broke, out of it and into it, each with its new target", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    s.addContext(join(root, "sibling.md"));
    const r = s.makeSet(join(root, "solo.md"), { links: true });
    const byDoc = new Map((r.links ?? []).map((d) => [d.path, d.fixes]));
    expect(byDoc.get(r.path)?.map((f) => [f.from, f.to])).toEqual([
      ["sibling.md", "../sibling.md"],
    ]);
    expect(byDoc.get(join(root, "sibling.md"))?.map((f) => [f.from, f.to])).toEqual([
      ["solo.md", "./solo/solo.md"],
    ]);
    // Nothing was rewritten.
    expect(readFileSync(r.path, "utf8")).toContain("(sibling.md)");
  });
});

describe("unmakeSet: the way back, the same entry listing the document again", () => {
  test("the document goes back beside the folder, the folder goes, the entry is listed again", () => {
    const s = session();
    const { entry } = s.addContext(join(root, "solo.md"));
    const { slug } = s.openPath(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    const u = s.unmakeSet(r.path);
    expect(u).toMatchObject({ path: join(root, "solo.md"), folder: r.folder, entry: entry.id });
    expect(existsSync(r.folder)).toBe(false);
    expect(entryById(s, entry.id)).toMatchObject({
      membership: "listed",
      root,
      label: "solo.md",
      nodes: [{ kind: "doc", rel: "solo.md" }],
    });
    expect(s.doc(slug).original).toBe(join(root, "solo.md"));
    // And forward again, the same entry still.
    expect(s.makeSet(u.path).entry).toBe(entry.id);
  });

  test("a folder that holds anything else now is refused, and nothing moves", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    s.createDoc(r.folder, "more.md");
    expect(refusal(() => s.unmakeSet(r.path)).status).toBe(409);
    expect(existsSync(r.path)).toBe(true);
  });

  test("a document beside the folder under the same name is never overwritten", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    writeFileSync(join(root, "solo.md"), "someone else's");
    expect(refusal(() => s.unmakeSet(r.path)).status).toBe(409);
    expect(readFileSync(join(root, "solo.md"), "utf8")).toBe("someone else's");
    expect(existsSync(r.path)).toBe(true);
  });

  test("once the set is gone it can never apply: a GoneError", () => {
    const s = session();
    s.addContext(join(root, "solo.md"));
    const r = s.makeSet(join(root, "solo.md"));
    s.removeContext(r.entry);
    expect(refusal(() => s.unmakeSet(r.path))).toBeInstanceOf(GoneError);
  });
});

describe("addFolder: a new folder where the caller names it", () => {
  test("anywhere on disk outside every set: a new set in the context, with an entry of its own", () => {
    const s = session();
    const where = join(root, "elsewhere", "ideas");
    mkdirSync(join(root, "elsewhere"));
    const r = s.addFolder(where);
    expect(r.path).toBe(where);
    expect(r.set).toBe(true);
    expect(entryById(s, r.entry)).toMatchObject({ membership: "mirrored", root: where });
    expect(s.createDoc(where).path).toBe(join(where, "Untitled.md"));
  });

  test("inside a set it is a folder of that set, not an entry", () => {
    const s = session();
    const setId = s.context[0]?.id ?? "";
    const r = s.addFolder(join(set, "part", "inner"));
    expect(r).toMatchObject({ entry: setId, set: false });
    expect(s.context).toHaveLength(1);
    expect(rels(s.context[0]?.nodes ?? [])).toContain("part/inner");
  });

  test("refused: a parent that is not there, a name that exists, a dot name, a session's folder, a bundle's insides", () => {
    const s = session();
    expect(refusal(() => s.addFolder(join(root, "nowhere", "x"))).status).toBe(400);
    expect(existsSync(join(root, "nowhere"))).toBe(false);
    expect(refusal(() => s.addFolder(join(root, "solo.md"))).status).toBe(409);
    expect(refusal(() => s.addFolder(join(root, "ws"))).status).toBe(409);
    expect(refusal(() => s.addFolder(join(root, ".hidden"))).status).toBe(400);
    expect(refusal(() => s.addFolder(join(sessions, "mine"))).status).toBe(400);
    expect(refusal(() => s.addFolder(join(root, "x.boardbundle"))).status).toBe(400);
    const board = join(root, "b.boardbundle");
    mkdirSync(board);
    expect(refusal(() => s.addFolder(join(board, "inside"))).status).toBe(409);
    expect(existsSync(join(board, "inside"))).toBe(false);
    expect(s.context).toHaveLength(1);
  });
});

// Expandable bundles in the session: a type that declares `expand` shows its
// real files under its row, its member folders' files are ordinary documents
// (opened, versioned, noted, saved, made, moved and renamed), and everything
// else inside stays closed to writes. Also: `--doc` naming a bundle by its
// folder, and a renamed bundle's main file answering to its new name. The
// daemon's side (the watcher, the wire) is in `bundles.expand.server.test.ts`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundlePlace,
  isBundleMember,
  isMemberDir,
  registerBundleType,
  unregisterBundleType,
} from "../lib/bundles.ts";
import type { ContextNode } from "./protocol";
import { WorkspaceSession } from "./session";
import {
  refusal,
  SHELF_BUNDLE,
  TEST_BUNDLE,
  tempRoot,
  testApp,
  writeBundle,
  writeShelf,
} from "./testing";
import { BUNDLE_OWN_CAP, docPaths, imagePaths, scanTree } from "./tree";

let root: string;
let sessions: string;
let set: string;
let ws: string;
let shelf: string;

beforeAll(() => {
  registerBundleType(TEST_BUNDLE);
  registerBundleType(SHELF_BUNDLE);
});
afterAll(() => {
  unregisterBundleType(TEST_BUNDLE.extension);
  unregisterBundleType(SHELF_BUNDLE.extension);
});

beforeEach(() => {
  root = tempRoot("workspace-bundles-expand");
  sessions = join(root, "sessions");
  set = join(root, "set");
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "loose.md"), "# Loose\n");
  shelf = writeShelf(set, "The lighthouse");
  writeBundle(set, "The well", { version: 1, type: "board", title: "The well" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = () => {
  const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
  s.addContext(set);
  return s;
};

const nodesOf = (s: WorkspaceSession): ContextNode[] =>
  s.context.find((e) => e.root === set)?.nodes ?? [];
const shelfNode = (s: WorkspaceSession) =>
  nodesOf(s).find((n) => n.rel === "The lighthouse.shelfbundle") as Extract<
    ContextNode,
    { kind: "bundle" }
  >;
const flat = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) =>
    n.kind === "group"
      ? [n, ...flat(n.children)]
      : n.kind === "bundle" && n.contents
        ? [n, ...flat(n.contents)]
        : [n],
  );
const R = "The lighthouse.shelfbundle";

describe("the registration", () => {
  test("a member is one plain folder name, never the main file or info.json", () => {
    const base = { ...SHELF_BUNDLE, extension: ".badbundle" };
    for (const m of ["", "a/b", ".hidden", "shelf.json", "info.json"])
      expect(() => registerBundleType({ ...base, expand: { members: [m] } })).toThrow(
        "one plain folder name",
      );
  });

  test("where a path sits in an expandable bundle, by name", () => {
    expect(bundlePlace(join(shelf, "docs", "a.md"))).toBe("member");
    expect(bundlePlace(join(shelf, "docs", "drafts", "a.md"))).toBe("member");
    expect(bundlePlace(join(shelf, "docs"))).toBe("member-folder");
    expect(bundlePlace(`${join(shelf, "docs")}/`)).toBe("member-folder");
    expect(bundlePlace(join(shelf, "audio", "x.mp3"))).toBe("own");
    expect(bundlePlace(join(shelf, "shelf.json"))).toBe("own");
    expect(bundlePlace(join(shelf, "docsy", "a.md"))).toBe("own");
    expect(bundlePlace(shelf)).toBeNull();
    expect(bundlePlace(join(set, "loose.md"))).toBeNull();
    // A type that does not expand has no members and no own files.
    expect(bundlePlace(join(set, "The well.boardbundle", "assets", "fox.png"))).toBeNull();
    expect(isBundleMember(join(shelf, "docs", "a.md"))).toBe(true);
    expect(isBundleMember(join(shelf, "docs"))).toBe(false);
    expect(isMemberDir(join(shelf, "docs"))).toBe(true);
    expect(isMemberDir(join(shelf, "audio"))).toBe(false);
  });
});

describe("the tree", () => {
  test("an expandable bundle's row carries its real files; the convention's files are marked", () => {
    const s = session();
    const node = shelfNode(s);
    expect(node.kind).toBe("bundle");
    expect(node.title).toBe("The lighthouse");
    expect(node.contents).toEqual([
      {
        kind: "group",
        rel: `${R}/audio`,
        children: [
          {
            kind: "group",
            rel: `${R}/audio/01-arrival`,
            children: [
              { kind: "file", rel: `${R}/audio/01-arrival/take.json`, size: 14 },
              { kind: "file", rel: `${R}/audio/01-arrival/take.mp3`, size: 17 },
            ],
          },
        ],
      },
      {
        kind: "group",
        rel: `${R}/docs`,
        children: [
          { kind: "doc", rel: `${R}/docs/01-arrival.md` },
          { kind: "doc", rel: `${R}/docs/02-the-keeper.md` },
        ],
      },
      expect.objectContaining({ kind: "file", rel: `${R}/info.json`, convention: true }),
      expect.objectContaining({ kind: "file", rel: `${R}/shelf.json`, convention: true }),
    ]);
    expect(node.warnings).toBeUndefined();
  });

  test("a type that does not expand is one row with nothing under it, as before", () => {
    const s = session();
    expect(nodesOf(s).find((n) => n.rel === "The well.boardbundle")).toEqual({
      kind: "bundle",
      rel: "The well.boardbundle",
      type: "board",
      main: "board.board",
      title: "The well",
    });
  });

  test("every folder inside shows, even an empty one or one holding only other files", () => {
    mkdirSync(join(shelf, "docs", "empty"));
    mkdirSync(join(shelf, "docs", "art"));
    writeFileSync(join(shelf, "docs", "art", "cover.psd"), "x");
    const s = session();
    const rows = flat(shelfNode(s).contents ?? []);
    expect(rows.find((n) => n.rel === `${R}/docs/empty`)?.kind).toBe("group");
    expect(rows.find((n) => n.rel === `${R}/docs/art/cover.psd`)).toEqual({
      kind: "file",
      rel: `${R}/docs/art/cover.psd`,
      size: 1,
    });
  });

  test("validate's warnings ride on the row", () => {
    writeFileSync(join(shelf, "stray.txt"), "?");
    const s = session();
    expect(shelfNode(s).warnings).toEqual([
      { message: "stray.txt is not where a shelf keeps anything", path: "stray.txt" },
    ]);
  });

  test("a validate that throws is one warning, and the tree still reads", () => {
    registerBundleType({
      ...SHELF_BUNDLE,
      expand: {
        members: ["docs"],
        validate: () => {
          throw new Error("boom");
        },
      },
    });
    try {
      const s = session();
      expect(shelfNode(s).warnings?.[0]?.message).toContain("could not be checked");
    } finally {
      registerBundleType(SHELF_BUNDLE);
    }
  });

  test("the documents in a member folder are documents; nothing else inside is", () => {
    const s = session();
    const entry = s.context[0];
    if (!entry) throw new Error("no entry");
    const docs = docPaths(entry);
    expect(docs).toContain(join(shelf, "shelf.json"));
    expect(docs).toContain(join(shelf, "docs", "01-arrival.md"));
    expect(docs).toContain(join(shelf, "docs", "02-the-keeper.md"));
    // A render's JSON record and info.json are the type's own: no documents.
    expect(docs).not.toContain(join(shelf, "audio", "01-arrival", "take.json"));
    expect(docs).not.toContain(join(shelf, "info.json"));
    // A canvas's insides stay invisible.
    expect(docs.some((p) => p.includes("The well.boardbundle/assets"))).toBe(false);
  });

  test("an image in a member folder is an image; one elsewhere inside is a file", () => {
    writeFileSync(join(shelf, "docs", "map.png"), "not really a png");
    mkdirSync(join(shelf, "art"));
    writeFileSync(join(shelf, "art", "cover.png"), "not really a png");
    const s = session();
    const entry = s.context[0];
    if (!entry) throw new Error("no entry");
    expect(imagePaths(entry)).toEqual([join(shelf, "docs", "map.png")]);
    expect(
      flat(shelfNode(s).contents ?? []).find((n) => n.rel === `${R}/art/cover.png`)?.kind,
    ).toBe("file");
  });

  test("a bundle listed on its own carries its contents too, and its documents open", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    s.addContext(shelf);
    const only = s.context[0]?.nodes[0];
    expect(only?.kind === "bundle" && only.contents?.length).toBe(4);
    const { slug } = s.openPath(join(shelf, "docs", "01-arrival.md"));
    expect(s.doc(slug).rel).toBe(`${R}/docs/01-arrival.md`);
  });
});

describe("a member's file is a document", () => {
  test("it opens, takes a version and a note, and saves to its file", () => {
    const s = session();
    const file = join(shelf, "docs", "01-arrival.md");
    const { slug } = s.openPath(file);
    expect(slug).toBe("01-arrival");
    const d = s.doc(slug);
    expect(d.original).toBe(file);
    expect(d.rel).toBe(`${R}/docs/01-arrival.md`);
    s.edit(slug, 1, "# Arrival\n\nThe boat came in at dawn.\n");
    const { version } = s.newVersion({ doc: slug, by: "agent" });
    expect(version.n).toBe(2);
    s.addNote({ doc: slug, body: "dawn, not dusk", by: "human", quote: "dawn" });
    expect(s.doc(slug).notes).toHaveLength(1);
    s.save(slug);
    expect(readFileSync(file, "utf8")).toBe("# Arrival\n\nThe boat came in at dawn.\n");
  });

  test("the main file still opens as the bundle, by its folder", () => {
    const s = session();
    const { slug } = s.openPath(shelf);
    expect(s.doc(slug).original).toBe(join(shelf, "shelf.json"));
    expect(s.doc(slug).name).toBe("The lighthouse");
  });

  test("a file of the type's own does not open", () => {
    const s = session();
    const e = refusal(() => s.openPath(join(shelf, "audio", "01-arrival", "take.json")));
    expect(e.message).toContain("not in this session's context");
    expect(() => s.openPath(join(shelf, "info.json"))).toThrow();
  });
});

describe("writing inside: members only", () => {
  test("a new document and a new folder are made in a member folder", () => {
    const s = session();
    const { path } = s.createDoc(join(shelf, "docs"), "03-the-light.md");
    expect(path).toBe(join(shelf, "docs", "03-the-light.md"));
    expect(flat(nodesOf(s)).some((n) => n.rel === `${R}/docs/03-the-light.md`)).toBe(true);
    const folder = s.createFolder(join(shelf, "docs"), "drafts");
    s.createDoc(folder.path, "draft.md");
    expect(flat(nodesOf(s)).some((n) => n.rel === `${R}/docs/drafts/draft.md`)).toBe(true);
    // Made where the tree shows it: no second entry for the bundle.
    expect(s.context).toHaveLength(1);
  });

  test("a document dropped in lands in a member folder", () => {
    const s = session();
    const { path } = s.importText("04-coda.md", "# Coda\n", join(shelf, "docs"));
    expect(path).toBe(join(shelf, "docs", "04-coda.md"));
    expect(existsSync(path)).toBe(true);
  });

  // ⛔ THE WRITE GUARD. Each of these must stay refused: lifting the guard for
  // a folder that is not a member makes one of them pass, and fail here.
  test("nothing is made or dropped anywhere else inside", () => {
    const s = session();
    const audio = join(shelf, "audio");
    const take = join(shelf, "audio", "01-arrival");
    for (const dir of [audio, take, shelf]) {
      // Refused as inside the bundle (409), or, for the bundle's own folder,
      // as no folder the tree shows (400).
      expect(refusal(() => s.createDoc(dir, "x.md")).status).toBe(dir === shelf ? 400 : 409);
      expect(refusal(() => s.createFolder(dir, "x")).status).toBeGreaterThanOrEqual(400);
      expect(refusal(() => s.importText("x.md", "# X\n", dir)).status).toBeGreaterThanOrEqual(400);
    }
    expect(refusal(() => s.createDoc(audio, "x.md")).message).toContain(
      "only its docs/ folder can be written into from here",
    );
    expect(existsSync(join(audio, "x.md"))).toBe(false);
    expect(existsSync(join(take, "x.md"))).toBe(false);
    expect(existsSync(join(shelf, "x.md"))).toBe(false);
  });

  test("a bundle is never made inside a member folder", () => {
    const s = session();
    const e = refusal(() => s.createBundle(join(shelf, "docs"), SHELF_BUNDLE.extension));
    expect(e.message).toContain("not made inside");
  });

  test("a document moves into a member folder and out of it", () => {
    const s = session();
    const loose = join(set, "loose.md");
    const { slug } = s.openPath(loose);
    const into = s.move(loose, join(shelf, "docs"));
    expect(into.path).toBe(join(shelf, "docs", "loose.md"));
    // The held document follows it, and is still one of the context's.
    expect(s.doc(slug).original).toBe(into.path);
    expect(s.doc(slug).rel).toBe(`${R}/docs/loose.md`);
    const out = s.move(into.path, join(set, "part"));
    expect(out.path).toBe(join(set, "part", "loose.md"));
    expect(s.doc(slug).rel).toBe("part/loose.md");
  });

  test("a document is renamed in a member folder", () => {
    const s = session();
    const { path } = s.rename(join(shelf, "docs", "02-the-keeper.md"), "02-the-keeper-s-light");
    expect(path).toBe(join(shelf, "docs", "02-the-keeper-s-light.md"));
    expect(flat(nodesOf(s)).some((n) => n.rel === `${R}/docs/02-the-keeper-s-light.md`)).toBe(true);
  });

  test("nothing moves into the type's own folders", () => {
    const s = session();
    const e = refusal(() => s.move(join(set, "loose.md"), join(shelf, "audio")));
    expect(e.status).toBe(409);
    expect(existsSync(join(shelf, "audio", "loose.md"))).toBe(false);
  });

  test("the type's own files and the member folder itself are not renamed, moved or duplicated", () => {
    const s = session();
    for (const p of [
      join(shelf, "shelf.json"),
      join(shelf, "info.json"),
      join(shelf, "audio"),
      join(shelf, "audio", "01-arrival", "take.mp3"),
      join(shelf, "docs"),
    ]) {
      expect(refusal(() => s.rename(p, "renamed")).message).toContain(
        p === join(shelf, "docs") ? "folder for its documents" : "own files",
      );
      expect(refusal(() => s.move(p, join(set, "part"))).status).toBe(409);
      expect(refusal(() => s.duplicate(p)).status).toBe(409);
      expect(existsSync(p)).toBe(true);
    }
  });

  test("the Trash takes a member's document, never the type's own files", () => {
    const s = session();
    expect(s.trashPreview(join(shelf, "docs", "01-arrival.md")).bundle).toBeUndefined();
    expect(
      refusal(() => s.trashPreview(join(shelf, "audio", "01-arrival", "take.mp3"))).status,
    ).toBe(409);
    expect(refusal(() => s.trashPreview(join(shelf, "shelf.json"))).status).toBe(409);
    expect(refusal(() => s.trashPreview(join(shelf, "docs"))).status).toBe(409);
  });

  test("a linked folder in a member folder that leads into the type's own files is refused", () => {
    symlinkSync(join(shelf, "audio"), join(shelf, "docs", "sneaky"));
    const s = session();
    const e = refusal(() => s.createDoc(join(shelf, "docs", "sneaky"), "x.md"));
    expect(e.status).toBe(409);
    expect(existsSync(join(shelf, "audio", "x.md"))).toBe(false);
  });

  test("a member folder that is a link leading out of the bundle is refused", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    rmSync(join(shelf, "docs"), { recursive: true });
    symlinkSync(outside, join(shelf, "docs"));
    const s = session();
    const e = refusal(() => s.createDoc(join(shelf, "docs"), "x.md"));
    expect(e.status).toBe(409);
    expect(existsSync(join(outside, "x.md"))).toBe(false);
  });

  test("in a bundle listed on its own, a member folder takes a new document as its row's", () => {
    const s = WorkspaceSession.create(sessions, testApp, undefined, ws);
    s.addContext(shelf);
    const { path } = s.createDoc(join(shelf, "docs"), "03-the-light.md");
    expect(existsSync(path)).toBe(true);
    expect(s.context).toHaveLength(1);
    const only = s.context[0]?.nodes[0];
    const rels = only?.kind === "bundle" ? flat(only.contents ?? []).map((n) => n.rel) : [];
    expect(rels).toContain(`${R}/docs/03-the-light.md`);
    // And a rename there is read back into the row too.
    s.rename(path, "03-the-lamp");
    const after = s.context[0]?.nodes[0];
    const renamed = after?.kind === "bundle" ? flat(after.contents ?? []).map((n) => n.rel) : [];
    expect(renamed).toContain(`${R}/docs/03-the-lamp.md`);
    expect(refusal(() => s.createDoc(join(shelf, "audio"), "x.md")).status).toBeGreaterThanOrEqual(
      400,
    );
  });
});

describe("--doc names a bundle by its folder", () => {
  test("the folder, with or without a trailing slash, finds the main file's document", () => {
    const s = session();
    const { slug } = s.openPath(shelf);
    expect(s.findDoc(shelf)?.slug).toBe(slug);
    expect(s.findDoc(`${shelf}/`)?.slug).toBe(slug);
    expect(s.findDoc(`${shelf}//`)?.slug).toBe(slug);
    // And so every verb that takes --doc: a version, a note.
    expect(s.newVersion({ doc: `${shelf}/`, by: "agent" }).slug).toBe(slug);
    expect(s.addNote({ doc: shelf, body: "n", by: "agent", quote: "order" }).slug).toBe(slug);
    const well = join(set, "The well.boardbundle");
    const board = s.openPath(well);
    expect(s.findDoc(`${well}/`)?.slug).toBe(board.slug);
  });

  test("a member's document is found by its own path, not taken for the bundle", () => {
    const s = session();
    const file = join(shelf, "docs", "01-arrival.md");
    const { slug } = s.openPath(file);
    expect(s.findDoc(file)?.slug).toBe(slug);
    expect(s.findDoc(shelf)).toBeUndefined();
  });
});

describe("a renamed bundle answers to its new name", () => {
  test("its slug stays, and it answers to the slug of its new title too; state says which", () => {
    const s = session();
    const made = s.createBundle(set, TEST_BUNDLE.extension);
    const { slug } = s.openPath(made.path);
    expect(slug).toBe("untitled");
    expect(s.doc(slug).alias).toBeUndefined();
    const { path } = s.rename(made.path, "touchstones");
    expect(path).toBe(join(set, "touchstones.boardbundle"));
    const d = s.findDoc("touchstones");
    expect(d?.slug).toBe("untitled");
    expect(s.findDoc("untitled")?.slug).toBe("untitled");
    const view = s.view().docs.find((x) => x.slug === "untitled");
    expect(view?.alias).toBe("touchstones");
    expect(view?.name).toBe("touchstones");
    expect(s.newVersion({ doc: "touchstones", by: "agent" }).slug).toBe("untitled");
  });

  test("an alias another document holds as its slug is no alias", () => {
    writeFileSync(join(set, "touchstones.md"), "# T\n");
    const s = session();
    s.openPath(join(set, "touchstones.md"));
    const made = s.createBundle(set, TEST_BUNDLE.extension);
    const { slug } = s.openPath(made.path);
    s.rename(made.path, "touchstones");
    expect(s.doc(slug).alias).toBeUndefined();
    expect(s.findDoc("touchstones")?.slug).toBe("touchstones");
  });
});

describe("a bundle past its caps", () => {
  // ⛔ Read alphabetically under one cap, a full `audio/` (4000 files) pushed
  // `docs/`, `info.json` and the main file out of the tree, and the member
  // documents out of `docPaths`. Members are read first, with a budget of
  // their own, and the convention's files are never cut.
  test("a full audio/ never pushes out the documents or the convention's files", () => {
    rmSync(join(shelf, "audio"), { recursive: true });
    for (let i = 1; i <= 100; i++) {
      const dir = join(shelf, "audio", String(i).padStart(3, "0"));
      mkdirSync(dir, { recursive: true });
      for (let t = 1; t <= 40; t++) writeFileSync(join(dir, `t${t}.json`), "{}");
    }
    let seen: { files: string[]; truncated?: true } | null = null;
    registerBundleType({
      ...SHELF_BUNDLE,
      expand: {
        members: ["docs"],
        validate: (l) => {
          seen = l;
          return [];
        },
      },
    });
    try {
      const s = session();
      const node = shelfNode(s);
      expect(node.truncated).toBe(true);
      const rels = flat(node.contents ?? []).map((n) => n.rel);
      expect(rels).toContain(`${R}/shelf.json`);
      expect(rels).toContain(`${R}/info.json`);
      expect(rels).toContain(`${R}/docs/01-arrival.md`);
      expect(rels).toContain(`${R}/docs/02-the-keeper.md`);
      // The type's own files are read within a budget of their own.
      expect(rels.filter((r) => r.includes("/audio/")).length).toBeLessThanOrEqual(BUNDLE_OWN_CAP);
      const entry = s.context[0];
      if (!entry) throw new Error("no entry");
      expect(docPaths(entry)).toContain(join(shelf, "docs", "01-arrival.md"));
      // The documents still open, and validate is told its listing is partial.
      expect(s.openPath(join(shelf, "docs", "01-arrival.md")).slug).toBe("01-arrival");
      // Assigned inside validate, which TypeScript cannot see run.
      const got = seen as { files: string[]; truncated?: true } | null;
      expect(got?.truncated).toBe(true);
      expect(got?.files).toContain("docs/01-arrival.md");
      expect(got?.files).toContain("shelf.json");
    } finally {
      registerBundleType(SHELF_BUNDLE);
    }
  });

  test("a bundle read whole says nothing of a cap", () => {
    const s = session();
    expect(shelfNode(s).truncated).toBeUndefined();
  });

  test("bundles count toward the scan's overall cap: fifty stages are bounded as a whole", () => {
    rmSync(set, { recursive: true });
    mkdirSync(set, { recursive: true });
    for (let i = 0; i < 50; i++) {
      const b = writeShelf(set, `Stage ${String(i).padStart(2, "0")}`);
      for (let d = 0; d < 30; d++) writeFileSync(join(b, "docs", `x${d}.md`), "# X\n");
    }
    const cap = 300;
    const { nodes, truncated } = scanTree(set, cap);
    expect(truncated).toBe(true);
    // Every node read, at any depth: the cap, plus at most the two convention
    // files of the bundle that met it (never cut, so a row is never nameless).
    expect(flat(nodes).length).toBeLessThanOrEqual(cap + 2);
  });
});

describe("aliases that collide", () => {
  test("two bundles renamed to one name both lose the alias, and --doc by it is not found", () => {
    const s = session();
    const a = s.createBundle(set, TEST_BUNDLE.extension, "First");
    const b = s.createBundle(set, TEST_BUNDLE.extension, "Second");
    const sa = s.openPath(a.path).slug;
    const sb = s.openPath(b.path).slug;
    mkdirSync(join(set, "other"));
    s.rename(a.path, "Twin");
    // The second goes to another folder under the same name: both say "Twin".
    const moved = s.move(b.path, join(set, "other"));
    s.rename(moved.path, "Twin");
    expect(s.doc(sa).alias).toBeUndefined();
    expect(s.doc(sb).alias).toBeUndefined();
    expect(s.findDoc("twin")).toBeUndefined();
    const e = refusal(() => s.newVersion({ doc: "twin", by: "agent" }));
    expect(e.status).toBe(404);
  });

  test("a not-found --doc offers aliases among its choices", () => {
    const s = session();
    const made = s.createBundle(set, TEST_BUNDLE.extension);
    s.openPath(made.path);
    s.rename(made.path, "touchstones");
    const e = refusal(() => s.newVersion({ doc: "nowhere", by: "agent" }));
    expect(e.status).toBe(404);
    expect(e.choices).toContain("untitled");
    expect(e.choices).toContain("touchstones");
  });
});

describe("the member folder's own refusal", () => {
  test("it says the folder takes documents, not that nothing is written there", () => {
    const s = session();
    const e = refusal(() => s.rename(join(shelf, "docs"), "chapters"));
    expect(e.message).toContain("folder for its documents");
    expect(e.message).toContain("documents can be made in it");
    expect(e.message).not.toContain("own files");
  });
});

describe("a bundle's own files come last in a scan", () => {
  // ⛔ Each bundle's own files (`audio/…`) were read as the bundle was met, so
  // thirty render-heavy stages filled the set's cap and the documents that
  // sort after them never showed. They are read in a second pass, from what
  // is left once the set's documents and member folders are read.
  test("thirty render-heavy stages never push the loose documents after them out", () => {
    rmSync(set, { recursive: true });
    mkdirSync(set, { recursive: true });
    for (let i = 0; i < 30; i++) {
      const b = writeShelf(set, `Stage ${String(i).padStart(2, "0")}`);
      for (let k = 0; k < 150; k++) writeFileSync(join(b, "audio", "01-arrival", `r${k}.mp3`), "x");
    }
    for (let d = 0; d < 50; d++) writeFileSync(join(set, `zz-${d}.md`), "# Z\n");
    const { nodes } = scanTree(set);
    const rels = flat(nodes).map((n) => n.rel);
    for (let d = 0; d < 50; d++) expect(rels).toContain(`zz-${d}.md`);
    // Every stage's documents show too; only renders are cut.
    for (let i = 0; i < 30; i++)
      expect(rels).toContain(`Stage ${String(i).padStart(2, "0")}.shelfbundle/docs/01-arrival.md`);
  });
});

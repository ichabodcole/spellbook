// A bundle's references in the link layer (kit-canvas-references), through
// the seam a bundle type fills (`BundleType.references`), driven by the tests'
// own pin board (`PIN_BUNDLE`) so no app is needed: read as links, reported by
// the link check, listed in backlinks, drawn on the graph, and rewritten by a
// rename, its file and its held copy alike. The daemon's half, an open board
// changed through its app, is Atlas's (`apps/atlas/backend/boardReferences.test.ts`).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { SessionError, WorkspaceSession } from "./session";
import { PIN_BUNDLE, pinsText, tempRoot, testApp, writePinBoard } from "./testing";

// Whether this file system treats a name's NFC and NFD forms as one file, as
// macOS does. Linux keeps them apart, so there a card in the other form names
// a file that is not there, and the sift's NFC has nothing to match.
const foldsUnicode = (() => {
  const d = mkdtempSync(join(tmpdir(), "nfc-"));
  try {
    writeFileSync(join(d, "caf\u00e9"), "");
    return existsSync(join(d, "cafe\u0301"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();

let root: string;
let set: string;
let board: string;

beforeAll(() => registerBundleType(PIN_BUNDLE));
afterAll(() => unregisterBundleType(PIN_BUNDLE.extension));

const PINS = [
  { id: "p1", file: "places/glade.md", subpath: "#The Well", note: "The Glade" },
  { id: "p2", file: "places/ruin.md", note: "The Ruin" },
  { id: "p3", file: "./assets/fox.png" },
];

beforeEach(() => {
  root = tempRoot("workspace-references");
  set = join(root, "world");
  mkdirSync(join(set, "places"), { recursive: true });
  mkdirSync(join(set, "boards"), { recursive: true });
  writeFileSync(join(set, "places", "glade.md"), "# The Glade\n\n## The Well\n");
  writeFileSync(join(set, "index.md"), "[Glade](places/glade.md) and [Gone](places/gone.md)\n");
  board = writePinBoard(join(set, "boards"), "The well", PINS);
  mkdirSync(join(board, "assets"));
  writeFileSync(join(board, "assets", "fox.png"), "not really a png");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(set, rel);
const main = () => join(board, PIN_BUNDLE.main);
const session = () => {
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  s.addContext(set);
  return s;
};
/** Every fix a rename found, as swaps per document, as the daemon's accept sends them. */
const edits = (links: { path: string; fixes: { from: string; to: string }[] }[] | undefined) =>
  (links ?? []).map((d) => ({
    path: d.path,
    swaps: d.fixes.map((f): [string, string] => [f.from, f.to]),
  }));

describe("the link check", () => {
  test("reports a board's broken references beside the documents' broken links", () => {
    const check = session().linkCheck();
    expect(check.dangling.links.map((l) => l.raw)).toEqual(["places/gone.md"]);
    expect(check.references.count).toBe(1);
    expect(check.references.links[0]).toMatchObject({
      source: main(),
      bundle: board,
      name: "The well",
      shown: "boards/The well.pinbundle",
      noun: "pin board",
      part: "pin",
      id: "p2",
      line: 3,
      raw: "places/ruin.md",
      label: "The Ruin",
      tried: [at("places/ruin.md"), at("boards/places/ruin.md")],
      text: "pin 'The Ruin' points at `places/ruin.md`, which is missing",
    });
    // Counted with the other problems: one dangling link, one reference.
    expect(check.count).toBe(2);
  });

  test("a reference that lands is not reported, and the bundle's own `./` path lands in it", () => {
    writeFileSync(at("places/ruin.md"), "# The Ruin\n");
    const check = session().linkCheck();
    expect(check.references.count).toBe(0);
  });

  test("a type with no references makes none: the main file is not read as markdown", () => {
    unregisterBundleType(PIN_BUNDLE.extension);
    try {
      registerBundleType({ ...PIN_BUNDLE, references: undefined });
      expect(session().linkCheck().references.count).toBe(0);
    } finally {
      registerBundleType(PIN_BUNDLE);
    }
  });
});

describe("backlinks", () => {
  test("a document lists the boards it is on, apart from the documents linking to it", () => {
    const b = session().backlinks(at("places/glade.md"));
    expect(b.backlinks.map((l) => l.source)).toEqual([at("index.md")]);
    expect(b.count).toBe(1);
    expect(b.bundles).toEqual([
      {
        source: main(),
        bundle: board,
        name: "The well",
        shown: "boards/The well.pinbundle",
        noun: "pin board",
        part: "pin",
        refs: [
          {
            id: "p1",
            line: 2,
            raw: "places/glade.md",
            label: "The Glade",
            subpath: "#The Well",
            from: expect.any(Number),
            to: expect.any(Number),
          },
        ],
      },
    ]);
  });

  test.if(foldsUnicode)(
    "a card naming the file in another Unicode form (NFD against NFC on disk) still lists the board",
    () => {
      const nfc = "café.md";
      const nfd = "café.md";
      writeFileSync(at(`places/${nfc}`), "# Café\n");
      writePinBoard(join(set, "boards"), "Menu", [{ id: "c", file: `places/${nfd}` }]);
      const s = session();
      const target = s.backlinks(at(`places/${nfc}`));
      expect(target.path.normalize("NFC")).toBe(at(`places/${nfc}`));
      expect(target.bundles.map((b) => [b.name, b.refs[0]?.raw])).toEqual([
        ["Menu", `places/${nfd}`],
      ]);
    },
  );

  test("a document no board points at has none", () => {
    expect(session().backlinks(at("index.md")).bundles).toEqual([]);
  });

  test("a board a second board points at lists it, by the folder the card names", () => {
    writePinBoard(join(set, "boards"), "Index", [{ id: "q", file: "boards/The well.pinbundle" }]);
    const b = session().backlinks(main());
    expect(b.bundles.map((x) => x.name)).toEqual(["Index"]);
  });
});

describe("the graph", () => {
  test("boards are nodes of their own kind only when asked, with an edge marked reference", () => {
    const s = session();
    expect(s.linkGraph().nodes.some((n) => n.path === main())).toBe(false);
    const g = s.linkGraph({ bundles: true });
    const node = g.nodes.find((n) => n.path === main());
    expect(node).toMatchObject({
      title: "The well",
      kind: "pins",
      label: "Pin board",
      canon: false,
      bundle: { noun: "pin board" },
      linksOut: 1,
    });
    expect(g.edges.filter((e) => e.from === main())).toEqual([
      { from: main(), to: at("places/glade.md"), rel: [], count: 1, reference: true },
    ]);
    // A reference is no untyped link in the legend.
    expect(g.untyped).toBe(1);
    expect(g.total).toEqual({ nodes: 3, edges: 2, links: 2, bundles: 1, references: 1 });
    expect(s.linkGraph().total.bundles === undefined).toBe(true);
  });
});

describe("a rename updates a board's references", () => {
  test("a closed board: its references are found, written as its type writes them, subpath kept", () => {
    const s = session();
    const r = s.rename(at("places/glade.md"), "the-glade.md", { links: true });
    const fixes = (r.links ?? []).find((d) => d.path === main());
    expect(fixes).toEqual({
      path: main(),
      was: main(),
      noun: "pin board",
      fixes: [
        {
          line: 2,
          label: "The Glade",
          id: "p1",
          from: "places/glade.md",
          to: "places/the-glade.md",
        },
      ],
    });
    const done = s.rewriteLinks(edits(r.links));
    expect(done.docs.find((d) => d.path === main())).toEqual({
      path: main(),
      count: 1,
      noun: "pin board",
    });
    expect(readFileSync(main(), "utf8")).toBe(
      pinsText([
        { id: "p1", file: "places/the-glade.md", subpath: "#The Well", note: "The Glade" },
        PINS[1] as Record<string, unknown>,
        PINS[2] as Record<string, unknown>,
      ]),
    );
    expect(s.backlinks(at("places/the-glade.md")).bundles.map((b) => b.name)).toEqual(["The well"]);
  });

  test("a moved board's own `./` references and its root references still land: nothing is offered", () => {
    mkdirSync(at("archive"));
    const s = session();
    const r = s.move(board, at("archive"), { links: true });
    expect((r.links ?? []).filter((d) => d.noun)).toEqual([]);
  });

  test("a held board: its file and its active version, unsaved edits kept", () => {
    const s = session();
    const { slug: doc } = s.openPath(board);
    const d = s.doc(doc);
    // An unsaved edit: the second pin's note changed in the active version only.
    const edited = pinsText([PINS[0], { ...PINS[1], note: "Ruin, unsaved" }, PINS[2]] as Record<
      string,
      unknown
    >[]);
    s.edit(doc, d.active, edited);
    const r = s.rename(at("places/glade.md"), "the-glade.md", { links: true });
    const done = s.rewriteLinks(edits(r.links));
    expect(done.count).toBe(2);
    expect(readFileSync(main(), "utf8")).toContain('"file":"places/the-glade.md"');
    expect(readFileSync(main(), "utf8")).not.toContain("Ruin, unsaved");
    const active = readFileSync(s.activePath(doc) as string, "utf8");
    expect(active).toContain('"file":"places/the-glade.md"');
    expect(active).toContain("Ruin, unsaved");
    expect(done.texts.map((t) => t.doc)).toEqual([doc]);
  });

  test("a held board an app holds: the app changes the active version, the kit writes the file", () => {
    const s = session();
    const { slug: doc } = s.openPath(board);
    const before = readFileSync(s.activePath(doc) as string, "utf8");
    const r = s.rename(at("places/glade.md"), "the-glade.md", { links: true });
    const asked: unknown[] = [];
    const done = s.rewriteLinks(edits(r.links), {
      held: (slug, swaps) => {
        asked.push({ slug, swaps });
        return slug === doc ? 1 : undefined;
      },
    });
    expect(asked).toContainEqual({
      slug: doc,
      swaps: [["places/glade.md", "places/the-glade.md"]],
    });
    // The kit left the active version to the app, and wrote the file.
    expect(readFileSync(s.activePath(doc) as string, "utf8")).toBe(before);
    expect(done.texts.some((t) => t.doc === doc)).toBe(false);
    expect(readFileSync(main(), "utf8")).toContain('"file":"places/the-glade.md"');
    expect(done.docs.find((x) => x.path === main())?.count).toBe(1);
  });

  test("an app that refuses leaves the board as it was, named as left", () => {
    const s = session();
    const { slug: doc } = s.openPath(board);
    const r = s.rename(at("places/glade.md"), "the-glade.md", { links: true });
    const done = s.rewriteLinks(edits(r.links), {
      held: (slug) => {
        if (slug === doc) throw new SessionError("the user is editing this card", 409);
        return undefined;
      },
    });
    expect(done.skipped).toEqual([{ path: main(), reason: "the user is editing this card" }]);
    expect(readFileSync(main(), "utf8")).toContain('"file":"places/glade.md"');
    // The markdown link was still updated.
    expect(readFileSync(at("index.md"), "utf8")).toContain("./places/the-glade.md");
  });
});

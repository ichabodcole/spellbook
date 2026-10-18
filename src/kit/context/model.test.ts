import { describe, expect, test } from "bun:test";
import type { ContextEntry, ContextNode } from "../workspace/protocol";
import { DOC_EXTENSIONS as DAEMON_DOC_EXTENSIONS } from "../workspace/tree";
import {
  ancestorsOf,
  baseName,
  countsInWords,
  DOC_EXTENSIONS,
  dirOf,
  docAt,
  docsIn,
  entryPath,
  expandTilde,
  filterMoveTargets,
  folderDocs,
  imagesIn,
  indexTree,
  isDocName,
  joinPath,
  moveTargets,
  parentRel,
  ROOT_ID,
  rowRefs,
  rowsShown,
  shortPath,
  singleDoc,
  singleFile,
  sortNodes,
  splitDropped,
  tildify,
} from "./model";

const doc = (rel: string): ContextNode => ({ kind: "doc", rel });
const group = (rel: string, children: ContextNode[]): ContextNode => ({
  kind: "group",
  rel,
  children,
});
const entry = (
  nodes: ContextNode[],
  membership: ContextEntry["membership"] = "listed",
): ContextEntry => ({
  id: "e1",
  label: "notes",
  root: "/r",
  membership,
  nodes,
});

describe("sortNodes", () => {
  test("groups first, then documents, each by natural, case-insensitive name", () => {
    const sorted = sortNodes([
      doc("b.md"),
      group("zeta", []),
      doc("ch10.md"),
      doc("A.md"),
      doc("ch2.md"),
      group("alpha", []),
    ]);
    expect(sorted.map((n) => n.rel)).toEqual([
      "alpha",
      "zeta",
      "A.md",
      "b.md",
      "ch2.md",
      "ch10.md",
    ]);
  });
  test("sorts by the last segment, not the full relative path", () => {
    expect(sortNodes([doc("z/a.md"), doc("a/b.md")]).map((n) => n.rel)).toEqual([
      "z/a.md",
      "a/b.md",
    ]);
  });
  test("does not mutate its input", () => {
    const input = [doc("b.md"), doc("a.md")];
    sortNodes(input);
    expect(input.map((n) => n.rel)).toEqual(["b.md", "a.md"]);
  });
});

describe("singleDoc: one type, rendered two ways", () => {
  test("one document and nothing else renders as that document", () => {
    expect(singleDoc(entry([doc("memo.md")]))?.rel).toBe("memo.md");
  });
  test("a folder with one document inside a group is a tree, not a document", () => {
    expect(singleDoc(entry([group("g", [doc("g/x.md")])]))).toBeNull();
  });
  test("a MIRRORED folder holding one file stays a folder (the human added a folder)", () => {
    expect(singleDoc(entry([doc("only.md")], "mirrored"))).toBeNull();
  });
  test("two documents, or none, is a tree", () => {
    expect(singleDoc(entry([doc("a.md"), doc("b.md")]))).toBeNull();
    expect(singleDoc(entry([]))).toBeNull();
  });
  test("entryPath is the listed file, or the set's own folder", () => {
    expect(entryPath(entry([doc("memo.md")]))).toBe("/r/memo.md");
    expect(entryPath(entry([doc("a.md")], "mirrored"))).toBe("/r");
  });
  test("a loose image is a single file too: singleFile and entryPath, but not singleDoc", () => {
    const loose = entry([{ kind: "image", rel: "map.png" }]);
    expect(singleFile(loose)).toEqual({ kind: "image", rel: "map.png" });
    expect(singleFile(entry([doc("memo.md")]))?.rel).toBe("memo.md");
    expect(singleDoc(loose)).toBeNull();
    expect(entryPath(loose)).toBe("/r/map.png");
    expect(singleFile(entry([{ kind: "image", rel: "map.png" }], "mirrored"))).toBeNull();
  });
});

describe("indexTree", () => {
  test("indexes every node and lists each parent's children in display order", () => {
    const idx = indexTree([doc("b.md"), group("g", [doc("g/z.md"), doc("g/a.md")])]);
    expect(idx.children.get(ROOT_ID)).toEqual(["g", "b.md"]);
    expect(idx.children.get("g")).toEqual(["g/a.md", "g/z.md"]);
    expect(idx.byId.get("g/z.md")?.kind).toBe("doc");
    expect(idx.byId.size).toBe(4);
  });
  test("an empty group has an empty child list, not a missing one", () => {
    expect(indexTree([group("empty", [])]).children.get("empty")).toEqual([]);
  });
  test("ROOT_ID cannot collide with any node id, since rels are relative", () => {
    expect(ROOT_ID).toBe("/");
    const idx = indexTree([group("root", [doc("root/x.md")]), doc("_root.md")]);
    expect(idx.byId.has(ROOT_ID)).toBe(false);
  });
});

describe("paths", () => {
  test("baseName, joinPath, ancestorsOf", () => {
    expect(baseName("a/b/c.md")).toBe("c.md");
    expect(baseName("c.md")).toBe("c.md");
    expect(joinPath("/r", "a/b.md")).toBe("/r/a/b.md");
    expect(joinPath("/", "a.md")).toBe("/a.md");
    expect(ancestorsOf("a/b/c.md")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.md")).toEqual([]);
  });
  test("tildify abbreviates only a real home prefix, and expandTilde undoes it", () => {
    expect(tildify("/Users/x/notes", "/Users/x")).toBe("~/notes");
    expect(tildify("/Users/xy/notes", "/Users/x")).toBe("/Users/xy/notes");
    expect(tildify("/Users/x", "/Users/x")).toBe("~");
    expect(tildify("/tmp/a", null)).toBe("/tmp/a");
    expect(expandTilde("~/notes", "/Users/x")).toBe("/Users/x/notes");
    expect(expandTilde("~", "/Users/x")).toBe("/Users/x");
    expect(expandTilde("~other/a", "/Users/x")).toBe("~other/a");
    expect(expandTilde("/abs", "/Users/x")).toBe("/abs");
  });
  test("shortPath keeps the distinguishing END and the home abbreviation", () => {
    expect(shortPath("/Users/x/notes", "/Users/x")).toBe("~/notes");
    expect(shortPath("/Users/x/a/b", "/Users/x")).toBe("~/a/b");
    expect(shortPath("/Users/x/a/b/c/d", "/Users/x")).toBe("…/c/d");
    expect(shortPath("/tmp/claude/scratch/drive/notes", null)).toBe("…/drive/notes");
    expect(shortPath("/tmp/a", null)).toBe("/tmp/a");
  });
  test("docsIn walks groups", () => {
    expect(
      docsIn([doc("a.md"), group("g", [doc("g/b.md"), group("g/h", [doc("g/h/c.md")])])]).map(
        (n) => n.rel,
      ),
    ).toEqual(["a.md", "g/b.md", "g/h/c.md"]);
  });
});

describe("organizing helpers", () => {
  test("parentRel and dirOf", () => {
    expect(parentRel("a/b/c.md")).toBe("a/b");
    expect(parentRel("c.md")).toBe("");
    expect(dirOf("/x/y/z.md")).toBe("/x/y");
    expect(dirOf("/z.md")).toBe("/");
  });
  test("moveTargets offers each set, never where the item is or inside itself", () => {
    const set = (id: string, root: string): ContextEntry => ({
      id,
      label: root.split("/").pop() as string,
      root,
      membership: "mirrored",
      nodes: [],
    });
    const listed: ContextEntry = { ...set("l", "/l/one.md"), membership: "listed" };
    const entries = [
      set("a", "/w/notes"),
      set("b", "/w/notes/inner"),
      set("c", "/p/other"),
      listed,
    ];
    // A listed entry is a document, not a place to put things.
    expect(moveTargets(entries, "/w/notes/x.md").map((t) => t.path)).toEqual([
      "/w/notes/inner",
      "/p/other",
    ]);
    // A folder cannot go into itself or below itself.
    expect(moveTargets(entries, "/w/notes").map((t) => t.path)).toEqual(["/p/other"]);
  });

  test("moveTargets puts the workspace first, then each set and its folders in tree order", () => {
    const bible: ContextEntry = {
      id: "b",
      label: "bible",
      root: "/w/bible",
      membership: "mirrored",
      nodes: [
        doc("a.md"),
        group("places", [doc("places/x.md"), group("places/towns", [doc("places/towns/t.md")])]),
      ],
    };
    const other: ContextEntry = { ...bible, id: "o", label: "other", root: "/p/other", nodes: [] };
    const from = (item: string) =>
      moveTargets([bible, other], item, "/w").map((t) => `${t.kind}:${t.label}`);
    // Inside a set: the workspace is offered first, then everything but here.
    expect(from("/w/bible/places/x.md")).toEqual([
      "workspace:Workspace",
      "set:bible",
      "folder:bible/places/towns",
      "set:other",
    ]);
    // In the workspace already: it is not offered.
    expect(from("/w/loose.md")[0]).toBe("set:bible");
    // A folder never into itself or anything under it.
    expect(from("/w/bible/places")).toEqual(["workspace:Workspace", "set:other"]);
    // A whole set: never the workspace (its folder would be carried in from
    // wherever it lives), only another set.
    expect(from("/w/bible")).toEqual(["set:other"]);
    // No workspace known: none offered.
    expect(moveTargets([bible], "/w/bible/a.md").map((t) => t.label)).toEqual([
      "bible/places",
      "bible/places/towns",
    ]);
  });

  test("filterMoveTargets keeps the targets with every word in their label, case aside", () => {
    const targets = moveTargets(
      [
        {
          id: "b",
          label: "Bible",
          root: "/w/bible",
          membership: "mirrored",
          nodes: [group("places", []), group("people", [])],
        },
      ],
      "/elsewhere/x.md",
      "/w",
    );
    expect(filterMoveTargets(targets, "").map((t) => t.label)).toEqual([
      "Workspace",
      "Bible",
      "Bible/places",
      "Bible/people",
    ]);
    expect(filterMoveTargets(targets, "bible PEO").map((t) => t.label)).toEqual(["Bible/people"]);
    expect(filterMoveTargets(targets, "work")).toHaveLength(1);
    expect(filterMoveTargets(targets, "nowhere")).toEqual([]);
  });
  test("splitDropped keeps documents, sends images as images, and names the rest", () => {
    expect(
      splitDropped([
        { name: "a.md" },
        { name: "pic.png" },
        { name: "B.TXT" },
        { name: "IMG_1.HEIC" },
        { name: "logo.svg" },
        { name: "a.zip" },
      ]),
    ).toEqual({
      docs: [0, 2],
      images: [1, 3],
      svg: ["logo.svg"],
      skipped: ["a.zip"],
    });
  });
  test("docAt finds the open document by the file it came from", () => {
    const docs = [
      { slug: "a", original: "/r/a.md" },
      { slug: "b", original: "/r/b.md" },
    ];
    expect(docAt(docs, "/r/b.md")?.slug).toBe("b");
    expect(docAt(docs, "/r/c.md")).toBeUndefined();
  });
});

describe("the document extensions", () => {
  test("the surface's list equals the daemon's, which cannot be bundled here", () => {
    expect([...DOC_EXTENSIONS]).toEqual([...DAEMON_DOC_EXTENSIONS]);
  });
  test("isDocName is case-insensitive", () => {
    expect(isDocName("A.MD")).toBe(true);
    expect(isDocName("a.png")).toBe(false);
  });
});

describe("folderDocs", () => {
  const doc = (rel: string): ContextNode => ({ kind: "doc", rel });
  const set: ContextEntry = {
    id: "s",
    label: "set",
    root: "/r/set",
    membership: "mirrored",
    nodes: [
      doc("a.md"),
      { kind: "group", rel: "part", children: [doc("part/b.md")] },
      { kind: "group", rel: "partial", children: [doc("partial/c.md")] },
    ],
  };
  const open = (...paths: string[]) => paths.map((original) => ({ original }));

  test("a folder does not match a sibling that shares its prefix", () => {
    const r = folderDocs([set], open("/r/set/part/b.md", "/r/set/partial/c.md"), "/r/set/part");
    expect(r.total).toBe(1);
    expect(r.docs).toEqual(open("/r/set/part/b.md"));
  });
  test("a document at exactly the folder path is not under it", () => {
    const one: ContextEntry = { ...set, nodes: [doc("a.md")] };
    expect(folderDocs([one], open("/r/set/a.md"), "/r/set/a.md")).toEqual({ docs: [], total: 0 });
  });
  test("a trailing slash on the folder or the root changes nothing", () => {
    const slashed: ContextEntry = { ...set, root: "/r/set/" };
    const want = folderDocs([set], [], "/r/set").total;
    expect(want).toBe(3);
    expect(folderDocs([set], [], "/r/set/").total).toBe(want);
    expect(folderDocs([slashed], [], "/r/set").total).toBe(want);
  });
  test("an entry that overlaps another counts its documents once", () => {
    const listed: ContextEntry = {
      id: "l",
      label: "a",
      root: "/r/set",
      membership: "listed",
      nodes: [doc("a.md")],
    };
    expect(folderDocs([set, listed], open("/r/set/a.md"), "/r/set")).toEqual({
      docs: open("/r/set/a.md"),
      total: 3,
    });
  });
  test("an open document outside the context is not counted", () => {
    const r = folderDocs([set], open("/r/set/a.md", "/r/set/stray.md"), "/r/set");
    expect(r.docs).toEqual(open("/r/set/a.md"));
  });
  test("a nested folder gets only its subtree", () => {
    const r = folderDocs([set], open("/r/set/a.md", "/r/set/part/b.md"), "/r/set/part");
    expect(r).toEqual({ docs: open("/r/set/part/b.md"), total: 1 });
  });
});

describe("a set's counts by kind", () => {
  test("imagesIn finds image nodes at any depth, and docsIn leaves them out", () => {
    const nodes: ContextNode[] = [
      { kind: "doc", rel: "a.md" },
      { kind: "image", rel: "b.png" },
      { kind: "group", rel: "g", children: [{ kind: "image", rel: "g/c.jpg" }] },
    ];
    expect(imagesIn(nodes).map((n) => n.rel)).toEqual(["b.png", "g/c.jpg"]);
    expect(docsIn(nodes).map((n) => n.rel)).toEqual(["a.md"]);
  });

  test("countsInWords names images only when there are any, in the right number", () => {
    expect(countsInWords(2, 0)).toBe("2 documents");
    expect(countsInWords(1, 0)).toBe("1 document");
    expect(countsInWords(0, 1)).toBe("0 documents, 1 image");
    expect(countsInWords(3, 2)).toBe("3 documents, 2 images");
  });
});

describe("rowRefs", () => {
  const set = {
    id: "s",
    label: "set",
    root: "/r/set",
    membership: "mirrored",
    nodes: [
      { kind: "doc", rel: "a.md" },
      { kind: "image", rel: "fox.png" },
      { kind: "bundle", rel: "Well.canvasbundle", main: "board.canvas" },
      { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/b.md" }] },
    ],
  } as ContextEntry;
  test("documents and images are refs, a bundle by its main file; a folder and a row gone are not", () => {
    const rows = [
      "/r/set/fox.png",
      "/r/set/part",
      "/r/set/Well.canvasbundle",
      "/r/set/gone.md",
      "/r/set/part/b.md",
    ];
    expect(rowRefs([set], rows).map((r) => [r.row, r.path])).toEqual([
      ["/r/set/fox.png", "/r/set/fox.png"],
      ["/r/set/Well.canvasbundle", "/r/set/Well.canvasbundle/board.canvas"],
      ["/r/set/part/b.md", "/r/set/part/b.md"],
    ]);
    expect(rowRefs([set], ["/elsewhere/a.md"])).toEqual([]);
  });

  test("a loose file's entry at the workspace's root does not hide a set's rows under it", () => {
    const loose = {
      id: "l",
      label: "loose.md",
      root: "/r",
      membership: "listed",
      nodes: [{ kind: "doc", rel: "loose.md" }],
    } as ContextEntry;
    expect(rowRefs([loose, set], ["/r/set/a.md", "/r/loose.md"]).map((r) => r.path)).toEqual([
      "/r/set/a.md",
      "/r/loose.md",
    ]);
    expect(rowsShown([loose, set], ["/r/set/a.md", "/r/set/gone.md", "/r/set/part"])).toEqual([
      "/r/set/a.md",
      "/r/set/part",
    ]);
  });
});

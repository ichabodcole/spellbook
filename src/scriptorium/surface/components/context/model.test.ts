import { describe, expect, test } from "bun:test";
import type { ContextEntry, ContextNode } from "../../../backend/protocol";
import {
  ancestorsOf,
  baseName,
  docsIn,
  indexTree,
  joinPath,
  ROOT_ID,
  shortPath,
  singleDoc,
  sortNodes,
  tildify,
} from "./model";

const doc = (rel: string): ContextNode => ({ kind: "doc", rel });
const group = (rel: string, children: ContextNode[]): ContextNode => ({
  kind: "group",
  rel,
  children,
});
const entry = (nodes: ContextNode[]): ContextEntry => ({
  id: "e1",
  label: "notes",
  root: "/r",
  membership: "mirrored",
  nodes,
});

describe("sortNodes (E17)", () => {
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

describe("singleDoc (E15 — one type, rendered two ways)", () => {
  test("one document and nothing else renders as that document", () => {
    expect(singleDoc(entry([doc("memo.md")]))?.rel).toBe("memo.md");
  });
  test("a folder with one document inside a group is a tree, not a document", () => {
    expect(singleDoc(entry([group("g", [doc("g/x.md")])]))).toBeNull();
  });
  test("two documents, or none, is a tree", () => {
    expect(singleDoc(entry([doc("a.md"), doc("b.md")]))).toBeNull();
    expect(singleDoc(entry([]))).toBeNull();
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
  test("tildify abbreviates only a real home prefix", () => {
    expect(tildify("/Users/x/notes", "/Users/x")).toBe("~/notes");
    expect(tildify("/Users/xy/notes", "/Users/x")).toBe("/Users/xy/notes");
    expect(tildify("/Users/x", "/Users/x")).toBe("~");
    expect(tildify("/tmp/a", null)).toBe("/tmp/a");
  });
  test("shortPath keeps the distinguishing END and the home abbreviation", () => {
    expect(shortPath("/Users/x/notes", "/Users/x")).toBe("~/notes");
    expect(shortPath("/Users/x/a/b", "/Users/x")).toBe("~/a/b");
    expect(shortPath("/Users/x/a/b/c/d", "/Users/x")).toBe("…/c/d");
    expect(shortPath("/tmp/claude/scratch/sb-drive/notes", null)).toBe("…/sb-drive/notes");
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

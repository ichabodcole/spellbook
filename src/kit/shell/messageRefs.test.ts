// What the next message is about and draws on, as cells: one subject, and the
// refs from the tree, from a view's other documents, and added by hand.
import { describe, expect, test } from "bun:test";
import { MAX_REFS } from "../workspace/messageParts.ts";
import { messageParts, REFS_SENT } from "./messageRefs.ts";

const nameOf = (p: string) => p.split("/").pop() ?? p;
const row = (name: string) => ({ row: `/w/${name}`, path: `/w/${name}`, name });
const base = {
  selection: false,
  pointed: [],
  openDoc: { original: "/w/a.md", path: "/s/a/v2.md" },
  openImage: null,
  tree: [],
  added: [],
  nameOf,
};

describe("the subject", () => {
  test("the open document is left to the daemon; the tree's rows besides it are refs", () => {
    const p = messageParts({ ...base, tree: [row("a.md"), row("b.md"), row("fox.png")] });
    expect(p.subject).toBeNull();
    expect(p.refs.map((r) => [r.from, r.path])).toEqual([
      ["tree", "/w/b.md"],
      ["tree", "/w/fox.png"],
    ]);
    expect(p.refs[0]?.ref).toEqual({ path: "/w/b.md", label: "b.md" });
  });

  test("an open image is the subject, named by its path", () => {
    const p = messageParts({
      ...base,
      openImage: "/w/fox.png",
      tree: [row("fox.png"), row("a.md")],
    });
    expect(p.subject).toBe("/w/fox.png");
    // The document behind the image is no subject now: it may be a ref.
    expect(p.refs.map((r) => r.path)).toEqual(["/w/a.md"]);
  });

  test("a text selection is the subject: the daemon attaches it, and the document's paths are not refs", () => {
    const p = messageParts({
      ...base,
      selection: true,
      openImage: null,
      added: [{ path: "/s/a/v2.md" }],
    });
    expect(p.subject).toBeNull();
    expect(p.refs).toEqual([]);
  });

  test("documents a view points at: the open one is the subject, else the first, and the rest are refs", () => {
    const pointed = [
      { path: "/w/b.md", name: "B" },
      { path: "/w/a.md", name: "A" },
      { path: "/w/c.md", name: "C" },
    ];
    const open = messageParts({ ...base, pointed });
    expect(open.subject).toBe("/w/a.md");
    expect(open.refs.map((r) => [r.from, r.name])).toEqual([
      ["pointed", "B"],
      ["pointed", "C"],
    ]);
    const none = messageParts({ ...base, openDoc: null, pointed });
    expect(none.subject).toBe("/w/b.md");
    expect(none.refs.map((r) => r.name)).toEqual(["A", "C"]);
  });
});

describe("refs", () => {
  test("a path held twice shows once, the first source winning; one added by hand keeps its role", () => {
    const p = messageParts({
      ...base,
      tree: [row("b.md")],
      added: [
        { path: "/w/b.md", label: "Bee" },
        { path: "/w/g.md", role: "guidance" },
      ],
    });
    expect(p.refs.map((r) => [r.from, r.name, r.role])).toEqual([
      ["tree", "b.md", undefined],
      ["added", "g.md", "guidance"],
    ]);
    expect(p.refs[1]?.ref).toEqual({ path: "/w/g.md", role: "guidance" });
  });

  test("no refs at all is an empty list", () => {
    expect(messageParts(base).refs).toEqual([]);
  });
});

describe("the cap", () => {
  test("the chip holds no more refs than are sent, and counts the rest", () => {
    const tree = Array.from({ length: REFS_SENT + 7 }, (_, i) => row(`d${i}.md`));
    const p = messageParts({ ...base, tree });
    expect(p.refs).toHaveLength(REFS_SENT);
    expect(p.unsent).toBe(7);
    expect(messageParts(base).unsent).toBe(0);
  });

  test("the surface's cap is the daemon's", () => {
    expect(REFS_SENT).toBe(MAX_REFS);
  });
});

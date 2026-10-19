// Frontmatter references by their shape, on the kit path. The cases are the
// shipped `links.test.ts`'s pure ones for `looksLikeRef` and `fieldRefs`,
// copied here when the helper moved (scriptorium-kit-keepers) so they outlive
// the shipped tests at the cutover; the graph cases there stay with the
// shipped resolver.
import { describe, expect, test } from "bun:test";
import { fieldRefs, looksLikeRef } from "./fieldRefs";

describe("frontmatter references: the SHAPE decides, not the key", () => {
  test("a slash or a .md makes a reference; bare tags do not", () => {
    expect(looksLikeRef("concept/exit-codes")).toBe(true);
    expect(looksLikeRef("./other.md")).toBe(true);
    expect(looksLikeRef("exit-codes")).toBe(false); // a tag
    expect(looksLikeRef("https://x.dev/a")).toBe(false); // external
    expect(looksLikeRef("//cdn.example.com/x")).toBe(false); // protocol-relative
    expect(looksLikeRef(42)).toBe(false);
  });
  test("any key carries them: related, supersedes, a nested sources[].resource", () => {
    const refs = fieldRefs({
      related: ["concept/exit-codes", "rule/help-exits-zero"],
      supersedes: "decision/older",
      tags: ["exit-codes", "errors"],
      sources: [{ resource: "./research/a.md", title: "A" }],
      applied_to: ["project/x"],
      count: 3,
    });
    expect(refs.map((r) => `${r.key}=${r.value}`).sort()).toEqual(
      [
        "applied_to=project/x",
        "related=concept/exit-codes",
        "related=rule/help-exits-zero",
        "sources.resource=./research/a.md",
        "supersedes=decision/older",
      ].sort(),
    );
  });
  test("deeper than maxDepth is not walked", () => {
    expect(fieldRefs({ a: { b: { c: "x/y.md" } } }, 1)).toEqual([]);
    expect(fieldRefs({ a: { b: { c: "x/y.md" } } }, 2)).toEqual([
      { key: "a.b.c", value: "x/y.md" },
    ]);
  });
});

describe("a frontmatter value that cannot be a path is not a reference", () => {
  test("prose with a slash in it, as titles and descriptions have, is not one", () => {
    expect(
      looksLikeRef(
        "The build-out of imago — an end-to-end v1 build: the CLI/server pair, hardening and finalize.",
      ),
    ).toBe(false);
    expect(looksLikeRef("MOVED — the conformance register now lives in docs/architecture/")).toBe(
      false,
    );
    expect(looksLikeRef("mind-mapper acc L0 — and the census that went 0/48 → 49/49")).toBe(false);
    expect(looksLikeRef("see notes/a.md, then b/c.md")).toBe(false);
    expect(looksLikeRef("one/two\nthree")).toBe(false);
  });
  test("a value no filesystem could name is not one", () => {
    expect(looksLikeRef(`notes/${"x".repeat(256)}.md`)).toBe(false);
    expect(looksLikeRef(`notes/${"x".repeat(250)}.md`)).toBe(true);
  });
  test("a path with spaces in it still is", () => {
    expect(looksLikeRef("./My Notes.md")).toBe(true);
    expect(looksLikeRef("places/Maren's Bakery.md")).toBe(true);
    expect(looksLikeRef("assets/a map.png")).toBe(true);
  });
  test("a value anchored at ./, ../ or / is a path whatever its punctuation", () => {
    expect(looksLikeRef("./notes/Chapter 1, Part 2.md")).toBe(true);
    expect(looksLikeRef("./notes/Dawn — Dusk.md")).toBe(true);
    expect(looksLikeRef("./notes/my chapter.md#scene")).toBe(true);
    expect(looksLikeRef("./notes/my chapter")).toBe(true);
    expect(looksLikeRef("../research/field notes")).toBe(true);
    expect(looksLikeRef("/notes/a b, c.md")).toBe(true);
    expect(
      fieldRefs({
        related: ["../research/field notes", "./notes/Chapter 1, Part 2.md"],
        source: "../research/field notes",
      }).map((r) => `${r.key}=${r.value}`),
    ).toEqual([
      "related=../research/field notes",
      "related=./notes/Chapter 1, Part 2.md",
      "source=../research/field notes",
    ]);
    expect(looksLikeRef("./notes/one\ntwo.md")).toBe(false);
    expect(looksLikeRef(`./notes/${"x".repeat(256)}.md`)).toBe(false);
    expect(looksLikeRef("Chapter 1, Part 2/notes.md")).toBe(false);
    expect(looksLikeRef("//cdn.example.com/a b.md")).toBe(false);
  });
});

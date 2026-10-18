// What the link picker ranks and writes, pure.
import { describe, expect, test } from "bun:test";
import type { KindRelationUse, LinkTarget, RelationOffer } from "../workspace/protocol";
import {
  escapeLinkText,
  escapeUnbalanced,
  hrefWithRelations,
  insertionGuard,
  linkInsertion,
  linkTextProblem,
  linkTrigger,
  normaliseRelation,
  rankHeadings,
  rankRelations,
  rankTargets,
  stem,
  suggestRelations,
  typedFrom,
} from "./linkInsert.ts";

const t = (shown: string): LinkTarget => {
  const name = shown.split("/").pop() as string;
  return { path: `/w/${shown}`, name, href: `./${shown}`, shown };
};

const TARGETS = [
  t("locations/the-old-mill.md"),
  t("locations/the-glade.md"),
  t("00-overview.md"),
  t("touchstones/00-touchstones.md"),
  t("Maren's Bakery.md"),
];

describe("ranking the targets", () => {
  test("an empty query lists them all, by path", () => {
    expect(rankTargets(TARGETS, "").map((x) => x.shown)).toEqual([
      "00-overview.md",
      "locations/the-glade.md",
      "locations/the-old-mill.md",
      "Maren's Bakery.md",
      "touchstones/00-touchstones.md",
    ]);
  });

  test("a space matches a word boundary, as in the header search", () => {
    expect(rankTargets(TARGETS, "old mill")[0]?.shown).toBe("locations/the-old-mill.md");
    expect(rankTargets(TARGETS, "mbak")[0]?.shown).toBe("Maren's Bakery.md");
  });

  test("a name match ranks above a match on the folder alone", () => {
    const r = rankTargets(TARGETS, "touch").map((x) => x.shown);
    expect(r[0]).toBe("touchstones/00-touchstones.md");
    expect(rankTargets(TARGETS, "locations").map((x) => x.shown)).toEqual([
      "locations/the-glade.md",
      "locations/the-old-mill.md",
    ]);
  });

  test("nothing matching is nothing", () => {
    expect(rankTargets(TARGETS, "zzz")).toEqual([]);
  });
});

describe("what a choice writes", () => {
  const mill = t("locations/the-old-mill.md");

  test("a selection becomes the link's text, as written", () => {
    expect(linkInsertion("wrap", "the mill", mill, [])).toBe(
      "[the mill](./locations/the-old-mill.md)",
    );
  });

  test("with no selection, the target's name is the text, escaped", () => {
    expect(linkInsertion("wrap", "", mill, [])).toBe("[the-old-mill](./locations/the-old-mill.md)");
    expect(linkInsertion("wiki", "", { name: "[draft].md", href: "./%5Bdraft%5D.md" }, [])).toBe(
      "[\\[draft\\]](./%5Bdraft%5D.md)",
    );
  });

  test("`](` is completed with the path and the closing paren", () => {
    expect(linkInsertion("complete", "", mill, [])).toBe("./locations/the-old-mill.md)");
  });

  test("`[[` becomes a whole standard link", () => {
    expect(linkInsertion("wiki", "", mill, ["applies"])).toBe(
      "[the-old-mill](./locations/the-old-mill.md?rel=applies)",
    );
  });

  test("an image is embedded, unless words are being linked to it", () => {
    const fox = { name: "fox.png", href: "./images/fox.png", image: true as const };
    expect(linkInsertion("wrap", "", fox, [])).toBe("![fox](./images/fox.png)");
    expect(linkInsertion("wiki", "", fox, ["sourced-from"])).toBe(
      "![fox](./images/fox.png?rel=sourced-from)",
    );
    expect(linkInsertion("wrap", "the fox", fox, [])).toBe("[the fox](./images/fox.png)");
    expect(linkInsertion("complete", "", fox, [])).toBe("./images/fox.png)");
  });

  test("relations: none is bare, several are joined by commas, never defaulted", () => {
    expect(hrefWithRelations("./a.md", [])).toBe("./a.md");
    expect(hrefWithRelations("./a.md", ["sister-of", "extends"])).toBe(
      "./a.md?rel=sister-of,extends",
    );
    expect(hrefWithRelations("./a.md", ["applies", "applies", " "])).toBe("./a.md?rel=applies");
    expect(hrefWithRelations("./a.md", ["located in"])).toBe("./a.md?rel=located-in");
    expect(hrefWithRelations("./a.md", ["it's (sort of)"])).toBe("./a.md?rel=its-sort-of");
    // Written as typed, case kept; a repeat in another case is one relation to the reader.
    expect(hrefWithRelations("./a.md", ["Extends", "extends", "applies"])).toBe(
      "./a.md?rel=Extends,applies",
    );
  });

  test("a typed relation is trimmed, its spaces hyphenated, its commas dropped", () => {
    expect(normaliseRelation("  located   in ")).toBe("located-in");
    expect(normaliseRelation("a,b")).toBe("a-b");
    expect(normaliseRelation(" , ")).toBe("");
  });

  test("a relation keeps only what a relation is read with: `(`, `)` and `'` would break the link", () => {
    expect(normaliseRelation("maren's")).toBe("marens");
    expect(normaliseRelation("(echoes)")).toBe("echoes");
    expect(normaliseRelation("a)b")).toBe("ab");
    expect(normaliseRelation("-lead_and.trail-")).toBe("lead_and.trail");
    expect(normaliseRelation("über-ort")).toBe("über-ort");
    expect(normaliseRelation("?#&=")).toBe("");
  });

  test("escapes brackets and backslashes in a supplied name", () => {
    expect(escapeLinkText("a [b] \\c")).toBe("a \\[b\\] \\\\c");
    expect(stem("Maren's Bakery.md")).toBe("Maren's Bakery");
    expect(stem(".hidden")).toBe(".hidden");
  });

  test("the guard is what must still stand at the tracked range", () => {
    expect(insertionGuard("wrap", { from: 4, to: 8 }, "mill")).toEqual({ at: 4, text: "mill" });
    expect(insertionGuard("complete", { from: 10, to: 13 }, "")).toEqual({ at: 8, text: "](" });
    expect(insertionGuard("wiki", { from: 3, to: 5 }, "")).toEqual({ at: 3, text: "[[" });
  });

  test("what was typed after the trigger starts after `](`, or after the two brackets", () => {
    expect(typedFrom("complete", { from: 10, to: 14 })).toBe(10);
    expect(typedFrom("wiki", { from: 3, to: 9 })).toBe(5);
  });

  test("a selection's unbalanced brackets are escaped; balanced ones and escapes are kept", () => {
    const b = { name: "b.md", href: "./b.md" };
    expect(linkInsertion("wrap", "odd ] bracket", b, [])).toBe("[odd \\] bracket](./b.md)");
    expect(linkInsertion("wrap", "an [open one", b, [])).toBe("[an \\[open one](./b.md)");
    expect(linkInsertion("wrap", "a [pair] here", b, [])).toBe("[a [pair] here](./b.md)");
    expect(escapeUnbalanced("x \\] y")).toBe("x \\] y");
    expect(escapeUnbalanced("] [ ]")).toBe("\\] [ ]");
  });

  test("a selection with a blank line, or with a link in it, cannot become one link", () => {
    expect(linkTextProblem("one\n\ntwo")).toMatch(/blank line/);
    expect(linkTextProblem("one\n  \ntwo")).toMatch(/blank line/);
    expect(linkTextProblem("Prefix [old](../CHANGELOG.md) suffix")).toMatch(/already holds a link/);
    expect(linkTextProblem("see ![alt](./i.png)")).toMatch(/already holds a link/);
    expect(linkTextProblem("one\ntwo")).toBeNull();
  });

  test("a selection running into another block is refused; a soft break inside a paragraph is not", () => {
    expect(linkTextProblem("circulation hub.\n- **The Glade")).toMatch(/another block/);
    expect(linkTextProblem("end of it\n2. next")).toMatch(/another block/);
    expect(linkTextProblem("end of it\n## A heading")).toMatch(/another block/);
    expect(linkTextProblem("end of it\n> quoted")).toMatch(/another block/);
    expect(linkTextProblem("end of it\n```")).toMatch(/another block/);
    expect(linkTextProblem("end of it\n| a | b |")).toMatch(/another block/);
    expect(linkTextProblem("a soft\nline break")).toBeNull();
    // The first line may itself be a list item's text.
    expect(linkTextProblem("- an item's words")).toBeNull();
  });

  test("emphasis or code cut by the selection's edge is refused; whole spans are fine", () => {
    expect(linkTextProblem("bold** and after")).toMatch(/emphasis or code/);
    expect(linkTextProblem("before **bold")).toMatch(/emphasis or code/);
    expect(linkTextProblem("half *em")).toMatch(/emphasis or code/);
    expect(linkTextProblem("code` after")).toMatch(/emphasis or code/);
    expect(linkTextProblem("~~struck")).toMatch(/emphasis or code/);
    expect(linkTextProblem("a **whole** span and *em*")).toBeNull();
    expect(linkTextProblem("`a ** b` in code")).toBeNull();
    expect(linkTextProblem("* a list marker")).toBeNull();
    expect(linkTextProblem("2 * 3 and snake_case")).toBeNull();
    expect(linkTextProblem("an escaped \\* star")).toBeNull();
    expect(linkTextProblem("odd ] bracket")).toBeNull();
  });
});

describe("what typing starts a link", () => {
  test("`](` after a `[` on the line", () => {
    expect(linkTrigger("see [the mill](")).toBe("complete");
    expect(linkTrigger("a stray ](")).toBeNull();
  });

  test("an embed's `](` too, but not `![[`", () => {
    expect(linkTrigger("see ![alt](")).toBe("complete");
    expect(linkTrigger("see ![[")).toBeNull();
  });

  test("`[[`, but not a third bracket", () => {
    expect(linkTrigger("see [[")).toBe("wiki");
    expect(linkTrigger("see [[[")).toBeNull();
    expect(linkTrigger("see [")).toBeNull();
  });
});

describe("rankRelations", () => {
  const offers: RelationOffer[] = [
    { rel: "applies", count: 11, declared: true },
    { rel: "sister-of", count: 10, declared: true },
    { rel: "sourced-from", count: 8, declared: true },
    { rel: "contrasts-with", count: 6, declared: true },
    { rel: "sourced_from", count: 1, declared: false },
    { rel: "extends", count: 0, declared: true },
  ];
  const byKind: KindRelationUse[] = [
    { kind: "location", rel: "contrasts-with", links: 6, fromKind: 6 },
    { kind: "location", rel: "applies", links: 1, fromKind: 0 },
    { kind: "reference", rel: "sourced-from", links: 4, fromKind: 0 },
    { kind: "reference", rel: "sister-of", links: 1, fromKind: 1 },
  ];
  const order = (kind: string | undefined) => rankRelations(offers, byKind, kind).map((r) => r.rel);

  test("between the two kinds first: Ruin to Cave puts contrasts-with first", () => {
    expect(order("location")).toEqual([
      "contrasts-with",
      "applies",
      "sister-of",
      "sourced-from",
      "sourced_from",
      "extends",
    ]);
  });

  test("then into the target's kind from any kind, then overall use", () => {
    // sister-of has the pair (one link from this kind); sourced-from leads the
    // rest on its four links into references.
    expect(order("reference").slice(0, 3)).toEqual(["sister-of", "sourced-from", "applies"]);
    expect(rankRelations(offers, byKind, "reference")[1]).toMatchObject({ here: 0, into: 4 });
  });

  test("an unknown kind and no target fall back to overall use, a declared one first at equal use", () => {
    expect(order("ritual")).toEqual(order(undefined));
    expect(order(undefined)).toEqual(offers.map((o) => o.rel));
    expect(
      rankRelations(
        [
          { rel: "b", count: 2, declared: false },
          { rel: "a", count: 2, declared: true },
        ],
        [],
        undefined,
      ).map((r) => r.rel),
    ).toEqual(["a", "b"]);
  });
});

describe("relations in any case", () => {
  const offers: RelationOffer[] = [
    { rel: "extends", count: 3, declared: true, label: "extends" },
    { rel: "Extends", count: 2, declared: false },
    { rel: "applies", count: 1, declared: true },
  ];

  test("two offers that differ only in case are offered once, the first standing with both counts", () => {
    const ranked = rankRelations(offers, [], undefined);
    expect(ranked.map((r) => [r.rel, r.count, r.declared])).toEqual([
      ["extends", 5, true],
      ["applies", 1, true],
    ]);
  });

  test("the declared offer's words stand even when an undeclared one in another case came first", () => {
    const [only, ...rest] = rankRelations(
      [
        { rel: "Extends", count: 2, declared: false },
        {
          rel: "extends",
          count: 3,
          declared: true,
          label: "builds on",
          means: "Takes the target further.",
        },
      ],
      [],
      undefined,
    );
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      rel: "extends",
      count: 5,
      declared: true,
      label: "builds on",
      means: "Takes the target further.",
    });
  });

  test("the use between kinds is matched in any case", () => {
    const ranked = rankRelations(
      offers,
      [{ kind: "location", rel: "Applies", links: 4, fromKind: 4 }],
      "location",
    );
    expect(ranked[0]).toMatchObject({ rel: "applies", here: 4, into: 4 });
  });

  test("typing Ext, ext or EXT offers extends, and a chosen relation is not offered again in another case", () => {
    const ranked = rankRelations(offers, [], undefined);
    for (const typed of ["Ext", "ext", "EXT", " eXt "])
      expect(suggestRelations(ranked, [], typed, 12).map((r) => r.rel)).toEqual(["extends"]);
    expect(suggestRelations(ranked, ["Extends"], "", 12).map((r) => r.rel)).toEqual(["applies"]);
    expect(suggestRelations(ranked, [], "", 1).map((r) => r.rel)).toEqual(["extends"]);
  });
});

describe("a link to a heading", () => {
  const touchstones = { name: "00-touchstones.md", href: "./touchstones/00-touchstones.md" };
  const arcturus = {
    text: "A Voyage to Arcturus — David Lindsay",
    anchor: "A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay",
  };
  test("the anchor follows the path and the relations; the heading is the label the picker supplies", () => {
    expect(linkInsertion("wrap", "", touchstones, ["grounded-in"], arcturus)).toBe(
      "[A Voyage to Arcturus — David Lindsay](./touchstones/00-touchstones.md?rel=grounded-in#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay)",
    );
    expect(linkInsertion("wrap", "form as instrument", touchstones, [], arcturus)).toBe(
      "[form as instrument](./touchstones/00-touchstones.md#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay)",
    );
    expect(linkInsertion("complete", "", touchstones, [], arcturus)).toBe(
      "./touchstones/00-touchstones.md#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay)",
    );
  });
  test("headings rank by what is typed, and keep the document's order with nothing typed", () => {
    const hs = [
      { level: 2, text: "How lenses work", line: 48, anchor: "How%20lenses%20work" },
      { level: 3, text: "Stacking lenses", line: 70, anchor: "x" },
      { level: 2, text: "The lenses", line: 87, anchor: "The%20lenses" },
    ];
    expect(rankHeadings(hs, "").map((h) => h.line)).toEqual([48, 70, 87]);
    expect(rankHeadings(hs, "stack").map((h) => h.line)).toEqual([70]);
    expect(rankHeadings(hs, "zzz")).toEqual([]);
  });
});

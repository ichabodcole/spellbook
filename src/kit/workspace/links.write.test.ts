// Writing a link, pure: the relative target the picker writes, and the relation
// vocabulary gathered from what the documents already write. Every target is
// checked against the resolver, so a link written here is one that follows.
import { describe, expect, test } from "bun:test";
import {
  collectRelations,
  type LinkIndex,
  parseRel,
  rebaseCopy,
  relativeHref,
  resolveTarget,
} from "./links";

/** An index whose context is exactly `paths`. */
function index(paths: string[], root = "/w/wiki"): LinkIndex {
  return {
    root,
    inContext: (p) => (paths.includes(p) ? p : null),
    exists: (p) => paths.includes(p),
    isDir: () => false,
  };
}

describe("the target a new link is written with", () => {
  test("the same folder starts `./`, as the Dreamwood export writes it", () => {
    expect(relativeHref("/w/wiki/index.md", "/w/wiki/glossary.md")).toBe("./glossary.md");
  });

  test("a child folder", () => {
    expect(relativeHref("/w/wiki/index.md", "/w/wiki/concepts/exit-codes.md")).toBe(
      "./concepts/exit-codes.md",
    );
  });

  test("a parent folder, one level and two", () => {
    expect(relativeHref("/w/wiki/concepts/exit-codes.md", "/w/wiki/index.md")).toBe("../index.md");
    expect(relativeHref("/w/wiki/rules/exit-codes/help-exits-zero.md", "/w/wiki/index.md")).toBe(
      "../../index.md",
    );
  });

  test("a sibling folder", () => {
    expect(
      relativeHref("/w/wiki/decisions/stay-pre-1-0.md", "/w/wiki/concepts/exit-codes.md"),
    ).toBe("../concepts/exit-codes.md");
  });

  test("a space is percent-encoded, in the file and in a folder; an apostrophe is not", () => {
    expect(relativeHref("/w/wiki/index.md", "/w/wiki/Maren's Bakery.md")).toBe(
      "./Maren's%20Bakery.md",
    );
    expect(relativeHref("/w/wiki/Old Town/a.md", "/w/wiki/New Town/the mill.md")).toBe(
      "../New%20Town/the%20mill.md",
    );
  });

  test("what would break the link is encoded; an accent stays readable", () => {
    expect(relativeHref("/w/a.md", "/w/notes (draft).md")).toBe("./notes%20%28draft%29.md");
    expect(relativeHref("/w/a.md", "/w/100% done?#1.md")).toBe("./100%25%20done%3F%231.md");
    expect(relativeHref("/w/a.md", "/w/[x].md")).toBe("./%5Bx%5D.md");
    expect(relativeHref("/w/a.md", "/w/café.md")).toBe("./café.md");
  });

  test("every target written resolves back to the document it names, with or without a relation", () => {
    const names = [
      "/w/wiki/index.md",
      "/w/wiki/Maren's Bakery.md",
      "/w/wiki/notes (draft).md",
      "/w/wiki/100% done?#1.md",
      "/w/wiki/Old Town/the mill.md",
      "/w/wiki/concepts/exit-codes.md",
    ];
    for (const from of names)
      for (const to of names) {
        if (from === to) continue;
        const href = relativeHref(from, to);
        expect(resolveTarget(href, from, index(names))).toEqual({ state: "in-context", path: to });
        expect(resolveTarget(`${href}?rel=sister-of,extends`, from, index(names))).toEqual({
          state: "in-context",
          path: to,
        });
      }
  });
});

describe("relations", () => {
  test("parseRel reads `rel=a,b`, decoded, in order, once each, and nothing else", () => {
    expect(parseRel("rel=sister-of,extends")).toEqual(["sister-of", "extends"]);
    expect(parseRel("x=1&rel=applies&y=2")).toEqual(["applies"]);
    expect(parseRel("rel=a,a,b")).toEqual(["a", "b"]);
    expect(parseRel("rel=located%2Din")).toEqual(["located-in"]);
    expect(parseRel("rel=")).toEqual([]);
    expect(parseRel("rel=<relationship>")).toEqual([]);
    expect(parseRel(undefined)).toEqual([]);
    expect(parseRel("relation=applies")).toEqual([]);
  });

  test("parseRel folds case and drops what repeats after folding, first seen first (relCase, as Scriptorium)", () => {
    expect(parseRel("rel=Extends,%20governs,extends")).toEqual(["extends", "governs"]);
    expect(parseRel("rel=Sister-Of&rel=sister-of,EXTENDS")).toEqual(["sister-of", "extends"]);
    expect(parseRel("rel=Located%2DIn")).toEqual(["located-in"]);
    // The kit's own reading stays: every `rel=` pair, and the placeholder filter.
    expect(parseRel("rel=A&rel=b")).toEqual(["a", "b"]);
    expect(parseRel("rel=<Relationship>")).toEqual([]);
  });

  test("non-ASCII case folds too, and a folded word stays a relation (İ folds to i + a combining dot)", () => {
    const dotted = "i\u0307lgili";
    expect("İlgili".toLowerCase()).toBe(dotted);
    expect(parseRel("rel=İlgili")).toEqual([dotted]);
    expect(parseRel(`rel=İlgili,${dotted}`)).toEqual([dotted]);
    expect(parseRel("rel=Über,über,ÜBER")).toEqual(["über"]);
    expect(parseRel("rel=Αναφέρεται,ΑΝΑΦΈΡΕΤΑΙ,αναφέρεται")).toEqual(["αναφέρεται"]);
    // What the reader emits reads back as itself: a folded word written into a link.
    for (const q of ["rel=İlgili", "rel=Über", "rel=Αναφέρεται"]) {
      const [folded] = parseRel(q);
      expect(parseRel(`rel=${folded}`)).toEqual([folded as string]);
    }
  });

  test("one relation written in two cases is one entry in the vocabulary, counted once per use", () => {
    const texts = [
      "[a](./a.md?rel=Extends) [b](./b.md?rel=extends)",
      "[c](./c.md?rel=EXTENDS,extends)",
    ];
    expect(collectRelations(texts)).toEqual([{ rel: "extends", count: 3 }]);
  });

  test("the vocabulary is every `?rel=` on a link across the documents, most used first", () => {
    const texts = [
      "[a](./a.md?rel=applies) and [b](../b.md?rel=sister-of,extends#top)",
      "[c](./c.md?rel=applies) [d](d.md) [e](<./e f.md?rel=grounded-in>)",
      '[f](./f.md?rel=contrasts-with "a title")',
    ];
    expect(collectRelations(texts)).toEqual([
      { rel: "applies", count: 2 },
      { rel: "contrasts-with", count: 1 },
      { rel: "extends", count: 1 },
      { rel: "grounded-in", count: 1 },
      { rel: "sister-of", count: 1 },
    ]);
  });

  test("a relation mentioned in prose or in code is not a use", () => {
    const text = [
      "Write `?rel=<relationship>` only when it carries meaning (`grounded-in`, `applies`).",
      "Like `[x](./x.md?rel=inline-example)`.",
      "```",
      "[y](./y.md?rel=fenced-example)",
      "```",
      "?rel=bare-prose",
      "",
      "    [w](./w.md?rel=indented-example)",
      "",
      "[z](./z.md?rel=real)",
      "",
      "- a list item",
      "",
      "    [v](./v.md?rel=in-a-list)",
    ].join("\n");
    // Indented under a list item is the item's text, not code, so it counts.
    expect(collectRelations([text])).toEqual([
      { rel: "in-a-list", count: 1 },
      { rel: "real", count: 1 },
    ]);
  });

  test("no typed links, no vocabulary: nothing is made up", () => {
    expect(collectRelations(["# Nothing here\n\n[plain](./plain.md)\n"])).toEqual([]);
    expect(collectRelations([])).toEqual([]);
  });
});

describe("a copy's links (rebaseCopy)", () => {
  /** A disk of exactly these files and folders. */
  const disk = (files: string[], dirs: string[] = []) => ({
    exists: (p: string) => files.includes(p),
    isDir: (p: string) => dirs.includes(p),
  });

  test("rewrites relative links to keep resolving, points a self-link at the copy, leaves the rest", () => {
    const src = "/w/stories/a.md";
    const dest = "/w/prod/S.stagebundle/docs/a.md";
    const files = ["/w/stories/b.md", "/w/stories/a.md", "/w/stories/img/x.png"];
    const text = [
      "[B](./b.md?rel=next#top) and [B again](b) and [self](./a.md#scene)",
      "![x](img/x.png) [gone](./nope.md) [web](https://example.com) [[b]]",
      "`[code](./b.md)`",
    ].join("\n");
    const out = rebaseCopy(text, src, dest, { root: "/w", ...disk(files) });
    expect(out.text).toBe(
      [
        "[B](../../../stories/b.md?rel=next#top) and [B again](../../../stories/b.md) and [self](./a.md#scene)",
        "![x](../../../stories/img/x.png) [gone](./nope.md) [web](https://example.com) [[b]]",
        "`[code](./b.md)`",
      ].join("\n"),
    );
    // The self-link is written the same from the copy, so it is no change.
    expect(out.count).toBe(3);
    // A rewritten target lands, from the copy, on what it found from the original.
    expect(resolveTarget("../../../stories/b.md", dest, index(files, "/w"))).toEqual({
      state: "in-context",
      path: "/w/stories/b.md",
    });
  });

  test("resolves as a link does: from the entry's root, by the root fallback, to a folder, in a reference definition", () => {
    // A document two folders into the set `tale`, copied onto a stage in another set.
    const src = "/w/tale/sub/04-deep.md";
    const dest = "/p/prod/S.stagebundle/docs/04-deep.md";
    const files = [
      "/w/tale/02-departure.md",
      "/w/tale/03-return.md",
      "/w/tale/images/fox.png",
      src,
    ];
    const dirs = ["/w/tale/images"];
    const text = [
      "[root](/02-departure.md) ![img](/images/fox.png) [bare-root](03-return.md)",
      "[folder](../images) [no-ext](/02-departure)",
      "",
      "[ref]: ../02-departure.md",
      "  [ref2]: <../03-return.md>",
    ].join("\n");
    const out = rebaseCopy(text, src, dest, { root: "/w/tale", ...disk(files, dirs) });
    expect(out.text).toBe(
      [
        "[root](../../../../w/tale/02-departure.md) ![img](../../../../w/tale/images/fox.png) [bare-root](../../../../w/tale/03-return.md)",
        "[folder](../../../../w/tale/images) [no-ext](../../../../w/tale/02-departure.md)",
        "",
        "[ref]: ../../../../w/tale/02-departure.md",
        "  [ref2]: <../../../../w/tale/03-return.md>",
      ].join("\n"),
    );
    expect(out.count).toBe(7);
    // Each lands, from the copy, where it landed from the original.
    for (const [from, to] of [
      ["../../../../w/tale/02-departure.md", "/w/tale/02-departure.md"],
      ["../../../../w/tale/images/fox.png", "/w/tale/images/fox.png"],
      ["../../../../w/tale/03-return.md", "/w/tale/03-return.md"],
    ])
      expect(resolveTarget(from as string, dest, index(files, "/p"))).toMatchObject({ path: to });
    // Without the root, a link written from it finds nothing and is left alone.
    expect(
      rebaseCopy("[root](/02-departure.md)", src, dest, { root: null, ...disk(files) }).count,
    ).toBe(0);
  });

  test("a link to another document copied in the same act points at its copy", () => {
    const src = "/w/tale/01-arrival.md";
    const dest = "/p/S.stagebundle/docs/01-arrival.md";
    const files = ["/w/tale/02-departure.md", "/w/tale/03-return.md", src];
    const copies = new Map([["/w/tale/02-departure.md", "/p/S.stagebundle/docs/02-departure.md"]]);
    const out = rebaseCopy("[next](./02-departure.md) [later](./03-return.md)", src, dest, {
      root: "/w/tale",
      ...disk(files),
      copies,
    });
    expect(out.text).toBe("[next](./02-departure.md) [later](../../../w/tale/03-return.md)");
  });
});

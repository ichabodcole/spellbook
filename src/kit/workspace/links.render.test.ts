// Links count only where the rendered view shows a link: extraction asks the
// renderer's own parser (micromark + GFM) where code and comments are. Ported
// from the verifier repros of the source editor's links cycle, which found
// the line scanner this kit had wrong in each shape below, plus the SPEC.md line atlas-wiki-links-in-code was
// filed on.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../lib/markdown.ts";
import { caretInCode, maskCode } from "../lib/markdownCode.ts";
import { collectRelations, extractLinks, swapLinkTargets } from "./links";

const targets = (body: string) => extractLinks(body).map((l) => l.target);

describe("code is what the rendered view calls code", () => {
  test("indented code inside a LIST ITEM is code", () => {
    expect(targets("- item\n\n      [x](./nope4.md)")).toEqual([]);
    // An ordered item's content starts three characters in, so code is seven.
    expect(targets("1. item\n\n       [x](./nope.md)\n\n[b](./b.md)")).toEqual(["./b.md"]);
  });

  test("indented code inside a BLOCKQUOTE is code too", () => {
    expect(targets("> q\n>\n>     [x](./nope5.md)")).toEqual([]);
    expect(targets("> - item\n>\n>       [x](./nope6.md)")).toEqual([]);
  });

  test("⚠ a list item's continuation PARAGRAPH is prose, and its links count", () => {
    expect(targets("- a\n\n  more [x](./ok.md)")).toEqual(["./ok.md"]);
    expect(targets("1. a\n\n   more [y](./ok2.md)")).toEqual(["./ok2.md"]);
    expect(targets(["- item", "    [x](./a.md)"].join("\n"))).toEqual(["./a.md"]);
  });

  test("a code span that runs onto the next line is still code", () => {
    expect(targets("`a\n[x](./c3.md)`")).toEqual([]);
    expect(targets("``a ` b\n[x](./c4.md) ``")).toEqual([]);
    // A blank line ends the paragraph, so the ticks close nothing.
    expect(targets("`a\n\n[x](./c5.md)`")).toEqual(["./c5.md"]);
  });

  test("masking keeps every offset: the text is as long, line breaks stay", () => {
    const body = "a `b` c\r\n\r\n    code\r\n\t[x](./y.md)\r\n<!-- z -->\r\nend";
    for (const masked of [maskCode(body), maskCode(body, { html: true })]) {
      expect(masked).toHaveLength(body.length);
      expect(masked.replace(/[^\r\n]/g, "")).toBe(body.replace(/[^\r\n]/g, ""));
    }
    expect(maskCode(body, { html: true })).not.toContain("z");
    expect(maskCode(body)).toContain("<!-- z -->");
  });

  test("a link after code on a CRLF document keeps its place", () => {
    const [l] = extractLinks("a `b` c\r\n```\r\n[n](./n.md)\r\n```\r\nsee [y](./y.md)\r\n");
    expect(l?.target).toBe("./y.md");
    expect(l?.line).toBe(5);
  });
});

describe("a comment is what the renderer calls one", () => {
  test("a link inside an HTML comment is an aside, not a link", () => {
    expect(targets("p <!-- [x](./a.md) --> [b](./b.md)")).toEqual(["./b.md"]);
    expect(targets(["<!--", "[x](./a.md)", "-->", "[b](./b.md)"].join("\n"))).toEqual(["./b.md"]);
    // ⚠ A comment that OPENS a line is an HTML block, and the block runs to
    // the end of the line holding `-->`: the renderer shows that line as text.
    expect(targets("<!-- [x](./a.md) --> [b](./b.md)")).toEqual([]);
  });

  test("an unclosed INLINE `<!--` is text, and the links after it count", () => {
    expect(targets("Use <!-- to open a comment.\n\n[later](./later.md)")).toEqual(["./later.md"]);
    // On the same line, too: the renderer shows `<!--` as text and links the rest.
    expect(targets("[b](./b.md) <!-- [x](./a.md)")).toEqual(["./b.md", "./a.md"]);
  });

  test("a comment BLOCK ends with its container, not at the end of the document", () => {
    expect(targets("> <!-- q\n\n[z](./z.md)")).toEqual(["./z.md"]);
    expect(targets("- a\n  <!-- c\n\n[z](./z.md)")).toEqual(["./z.md"]);
    // …and one that never closes at the top level runs to the end, as rendered.
    expect(targets("a\n<!-- x\n[y](./y.md)")).toEqual([]);
  });

  test("a link inside an HTML block is text, as the view shows it", () => {
    // `<div>` opens a block that runs to the blank line; the view encodes it.
    const div = "<div>\n[x](./in-div.md)\n</div>\n\n[after](./after.md)";
    expect(targets(div)).toEqual(["./after.md"]);
    expect(renderMarkdown(div)).not.toContain('href="./in-div.md"');
    // A line opening with a complete `<b>` tag alone opens one too.
    const b = "<b>\n[x](./in-b.md)\n</b>\n\n[after](./after.md)";
    expect(targets(b)).toEqual(["./after.md"]);
    expect(renderMarkdown(b)).not.toContain('href="./in-b.md"');
  });

  test("⚠ an inline tag hides only itself: the links beside it count", () => {
    const text = 'Some <b>bold [x](./x.md)</b> and <span title="[t](./t.md)">s</span>.';
    expect(targets(text)).toEqual(["./x.md"]);
    expect(renderMarkdown(text)).toContain('href="./x.md"');
    expect(renderMarkdown(text)).not.toContain('href="./t.md"');
  });

  test("`<!--` inside code opens nothing", () => {
    expect(targets("`<!--` then [a](./a.md)")).toEqual(["./a.md"]);
  });

  test("a comment in the frontmatter's place is the frontmatter's, not the body's", () => {
    expect(targets("---\nnote: <!--\n---\n[a](./a.md)")).toEqual(["./a.md"]);
  });
});

describe("a link wrapped around an image", () => {
  test("is a link to the OUTER target, and the image inside an embed", () => {
    const links = extractLinks("[![badge](./b.png)](./real.md)");
    expect(links.map((l) => [l.raw, l.embed])).toEqual([
      ["./real.md", undefined],
      ["./b.png", true],
    ]);
    expect(targets("[t ![a](i.png)](./r.md)")).toEqual(["./r.md", "i.png"]);
    const [l] = extractLinks("[![a](i.png) and text](./r2.md?rel=see-also)");
    expect([l?.target, l?.rel]).toEqual(["./r2.md", ["see-also"]]);
  });

  test("…and a LINK inside a label still means the inner one is what renders", () => {
    expect(targets("[![b](i.png) [x](./y.md)](./z.md)")).toEqual(["i.png", "./y.md"]);
  });

  test("a rename rewrites the outer target, not the image's", () => {
    const swapped = swapLinkTargets("[![b](./real.md)](./real.md) [c](./real.md)", (raw) =>
      raw === "./real.md" ? "./moved.md" : undefined,
    );
    expect(swapped).toEqual({
      text: "[![b](./moved.md)](./moved.md) [c](./moved.md)",
      count: 3,
    });
    const outerOnly = swapLinkTargets("[![b](./b.png)](./real.md)", (raw) =>
      raw === "./real.md" ? "./moved.md" : undefined,
    );
    expect(outerOnly.text).toBe("[![b](./b.png)](./moved.md)");
  });

  test("⛔ a title holding `](target` is left alone: only the target's own span changes", () => {
    const swap = (raw: string) => (raw === "./x.md" ? "./NEW.md" : undefined);
    expect(swapLinkTargets('[a](./x.md "see ](./x.md")', swap)).toEqual({
      text: '[a](./NEW.md "see ](./x.md")',
      count: 1,
    });
    expect(swapLinkTargets("[a](./x.md 'x](./x.md')", swap)).toEqual({
      text: "[a](./NEW.md 'x](./x.md')",
      count: 1,
    });
    expect(swapLinkTargets("[a]( <./x.md> )", swap).text).toBe("[a]( <./NEW.md> )");
  });
});

describe("a protocol-relative URL names a host", () => {
  test("it is no document link and no scheme to report", () => {
    expect(targets("[cdn](//cdn.example.com/x) [d](./d.md)")).toEqual(["./d.md"]);
    expect(
      extractLinks("[cdn](//cdn.example.com/x.js)", { schemes: true }).map((l) => l.raw),
    ).toEqual([]);
  });
});

describe("relations in use are read where links are", () => {
  test("a ?rel= in code, a comment or the frontmatter is no use", () => {
    const text = [
      "---",
      "example: '[x](./a.md?rel=front)'",
      "---",
      "- item",
      "",
      "      [x](./b.md?rel=coded)",
      "",
      "<!-- [y](./c.md?rel=hidden) -->",
      "",
      "[z](./d.md?rel=real)",
    ].join("\n");
    expect(collectRelations([text])).toEqual([{ rel: "real", count: 1 }]);
  });
});

describe("a wiki link in code is no link (atlas-wiki-links-in-code)", () => {
  // A table row from the design spec this case was filed from, kept verbatim:
  // `[[wiki]]` once in inline code (an example), once in prose (the chip's
  // name, which reads as a link). The spec lives in the kit's source repo, not
  // here, so the row is the fixture on its own.
  const row =
    "| Wiki link         | Faint dashed 1.5px grey, no arrow                                                                      | Derived from `[[wiki]]` links between documents on the canvas. Read-only. Toggle with the [[wiki]] chip. |";

  test("only the one in prose is read, in the row and in a fence", () => {
    const text = `| a | b | c |\n| - | - | - |\n${row}\n`;
    const wiki = extractLinks(text).filter((l) => l.kind === "wiki");
    expect(wiki).toHaveLength(1);
    expect(text.slice(wiki[0]?.from, wiki[0]?.to)).toBe("[[wiki]]");
    expect(text.slice((wiki[0]?.from ?? 0) - 9, wiki[0]?.from)).toBe("with the ");
    expect(extractLinks(["```", "[[wiki]] [x](./x.md)", "```"].join("\n"))).toEqual([]);
    expect(extractLinks("    [[wiki]]")).toEqual([]);
  });

  test("the same for markdown links in code", () => {
    expect(targets("Derived from `[x](./x.md)` links. See [y](./y.md).")).toEqual(["./y.md"]);
  });

  test("link autocomplete does not open in code", () => {
    expect(caretInCode("Derived from `[[")).toBe(true);
    expect(caretInCode("```\n[[")).toBe(true);
    expect(caretInCode("Toggle with the [[")).toBe(false);
  });
});

describe("random documents of code, comment and link pieces", () => {
  test("link what the renderer links", () => {
    // A fixed seed (mulberry32), so a failure reproduces. As in the source
    // editor's run, a lone `[` and table pipes are left out: a label crossing
    // into a list line and a table row's extra cells are disagreements of
    // their own, older than comments.
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // biome-ignore format: one row of pieces reads better than thirty lines
    const pieces = ["LINK", "LINK", "`", "``", "```", "~~~", "<!--", "-->", "<div>", "<b>", "</b>", "\n", "\n\n", "    ", "\t", "- ", "> ", "1. ", " ", "word", "\\", "]", "(", ")", "# ", "!"];
    const ours = /^\.\/t\d+\.md$/;
    const disagree: string[] = [];
    let k = 0;
    for (let i = 0; i < 1500; i++) {
      let s = "";
      const len = 3 + Math.floor(rand() * 20);
      for (let j = 0; j < len; j++) {
        const p = pieces[Math.floor(rand() * pieces.length)] as string;
        s += p === "LINK" ? `[l${k}](./t${k++}.md)` : p;
      }
      const shown = [...renderMarkdown(s).matchAll(/<a href="([^"]*)"/g)]
        .map((m) => m[1] as string)
        .filter((h) => ours.test(h));
      // An embed is a link here but an image there: only links are compared.
      const read = extractLinks(s)
        .filter((l) => !l.embed)
        .map((l) => l.raw)
        .filter((r) => ours.test(r));
      if (shown.join(" ") !== read.join(" ")) disagree.push(s);
    }
    expect(disagree).toEqual([]);
  });

  test("adversarial runs finish quickly", () => {
    // Images inside link labels, run together, are still quadratic: about
    // 0.5 s at 50 000 characters here and over 2 s on a CI runner. They were
    // before the port too (`kit-links-image-label-quadratic`), so they are
    // held to a shorter run until that is fixed, and the rest to the full one.
    const runs: [string, number][] = [
      ...["[", "(", "](", "`", "<!--", "[a](", "[[", "\\["].map((u): [string, number] => [
        u,
        50_000,
      ]),
      ["[![a](b)", 10_000],
    ];
    for (const [unit, n] of runs) {
      const started = performance.now();
      extractLinks(unit.repeat(Math.ceil(n / unit.length)));
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

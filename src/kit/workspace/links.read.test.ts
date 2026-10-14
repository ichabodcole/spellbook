// The reading half of links, pure: what a document's links are (ported from the
// source editor's extraction tests: fences, images, wiki links, the target as
// written and its line) and which of a set of documents' links land on one
// document. Resolution is injected, so nothing here touches disk.
import { describe, expect, test } from "bun:test";
import { backlinksTo, extractLinks, type LinkIndex, type LinkSource, resolveTarget } from "./links";

describe("what counts as a link", () => {
  test("markdown links and embeds, minus external targets and in-page anchors", () => {
    const links = extractLinks(
      [
        "[a](./other.md)",
        "[b](../concepts/exit-codes.md)",
        "![pic](./diagram.png)",
        "[c](https://x.dev)",
        "[d](mailto:a@b.c)",
        "[e](#anchor-only)",
        "![remote](https://x.dev/a.png)",
      ].join("\n\n"),
    );
    expect(links.map((l) => l.target)).toEqual([
      "./other.md",
      "../concepts/exit-codes.md",
      "./diagram.png",
    ]);
  });

  test("an embed is a link marked embed, its alt text the label, its relation kept", () => {
    const links = extractLinks(
      "A [link](./fox.png) and ![The fox](images/fox.png?rel=sourced-from) here.",
    );
    expect(links.map((l) => [l.target, l.label, l.embed, l.rel])).toEqual([
      ["./fox.png", "link", undefined, []],
      ["images/fox.png", "The fox", true, ["sourced-from"]],
    ]);
    // A linked image (`[![alt](a.png)](b.md)`) keeps the embed, and the link
    // around it is a link too, by its outer target.
    const linked = extractLinks("[![The fox](./fox.png)](./fox.md)");
    expect(linked.map((l) => [l.target, l.embed])).toEqual([
      ["./fox.md", undefined],
      ["./fox.png", true],
    ]);
  });

  test("wiki links, with and without a label", () => {
    const links = extractLinks("See [[exit-codes]] and [[stay-pre-1-0|that decision]].");
    expect(links.map((l) => [l.kind, l.target, l.label])).toEqual([
      ["wiki", "exit-codes", undefined],
      ["wiki", "stay-pre-1-0", "that decision"],
    ]);
  });

  test("⛔ a link inside a FENCE is an example, not a link", () => {
    const body = ["Real: [a](./real.md)", "", "```md", "[fake](./fake.md)", "```", ""].join("\n");
    expect(extractLinks(body).map((l) => l.target)).toEqual(["./real.md"]);
  });

  test("nor is one in inline code or an indented block", () => {
    const body = ["Write `[x](./inline.md)` like so.", "", "    [y](./indented.md)", ""].join("\n");
    expect(extractLinks(body)).toEqual([]);
  });

  test("an anchor is not part of the target, a title is not a target, and <…> is unwrapped", () => {
    expect(extractLinks("[a](./other.md#part)")[0]?.target).toBe("./other.md");
    expect(extractLinks('[a](./other.md "A title")')[0]?.target).toBe("./other.md");
    expect(extractLinks("[a](<./two words.md>)")[0]?.target).toBe("./two words.md");
  });

  test("a percent-encoded name is decoded in the target and kept in the raw", () => {
    const [link] = extractLinks("[M](./Maren's%20Bakery.md?rel=located-in)");
    expect(link?.target).toBe("./Maren's Bakery.md");
    expect(link?.raw).toBe("./Maren's%20Bakery.md?rel=located-in");
  });
});

describe("what markdown says is not a link, and what still is", () => {
  test("a backslash-escaped bracket is text, and an escaped `]` stays inside its label", () => {
    expect(extractLinks("\\[not](./x.md) and [not\\](./y.md)")).toEqual([]);
    const [link] = extractLinks("[a \\] b](./z.md)");
    expect([link?.target, link?.label]).toEqual(["./z.md", "a ] b"]);
  });

  test("nothing inside an HTML comment, on one line or several", () => {
    const text = [
      "<!-- [one](./one.md) -->",
      "<!--",
      "[two](./two.md)",
      "-->",
      "[three](./three.md)",
    ].join("\n");
    expect(extractLinks(text).map((l) => [l.target, l.line])).toEqual([["./three.md", 5]]);
  });

  test("a label that runs onto the next line is one link, on the line it starts", () => {
    const text = "# T\n\nSee [the old\nmill](./mill.md?rel=sister-of) here.";
    const [link] = extractLinks(text);
    expect([link?.target, link?.label, link?.line, link?.rel]).toEqual([
      "./mill.md",
      "the old mill",
      3,
      ["sister-of"],
    ]);
    expect(text.slice(link?.from, link?.to)).toBe("[the old\nmill](./mill.md?rel=sister-of)");
    // A blank line ends a paragraph, and with it any label.
    expect(extractLinks("[a\n\nb](./x.md)")).toEqual([]);
  });

  test("a blank line ends a label in a CRLF file too", () => {
    expect(extractLinks("[a\r\n\r\nb](./x.md)")).toEqual([]);
    expect(extractLinks("[a\r\nb](./x.md)")[0]?.label).toBe("a b");
  });

  test("a link inside another link's label is the link, as markdown reads it", () => {
    expect(extractLinks("[see [x](./y.md)](./z.md)").map((l) => [l.target, l.label])).toEqual([
      ["./y.md", "x"],
    ]);
  });

  test("a heading ends at its line break, and a label in it ends there too", () => {
    expect(extractLinks("# [a\nb](./x.md)")).toEqual([]);
    // In a paragraph the same label may run on.
    expect(extractLinks("[a\nb](./x.md)")[0]?.target).toBe("./x.md");
  });

  test("nested brackets in a label, and parentheses in a target, written or encoded", () => {
    expect(extractLinks("[a [b] c](./x.md)")[0]?.label).toBe("a [b] c");
    expect(extractLinks("[p](./notes%20%281%29.md)")[0]?.target).toBe("./notes (1).md");
    expect(extractLinks("[p](./notes(1).md)")[0]?.target).toBe("./notes(1).md");
    expect(extractLinks("[p](<./two words (1).md>)")[0]?.target).toBe("./two words (1).md");
  });
});

describe("typed links", () => {
  test("relations ride the link, several at once, order kept, repeats dropped", () => {
    expect(extractLinks("[a](./x.md?rel=sister-of,extends,sister-of)")[0]?.rel).toEqual([
      "sister-of",
      "extends",
    ]);
    expect(extractLinks("[[x?rel=see-also|label]]")[0]?.rel).toEqual(["see-also"]);
  });

  test("⛔ a BARE link asserts nothing: it is not an implicit `references`", () => {
    expect(extractLinks("[a](./x.md)")[0]?.rel).toEqual([]);
    expect(extractLinks("[[x]]")[0]?.rel).toEqual([]);
  });

  test("the query is stripped from the path it rides on", () => {
    expect(extractLinks("[a](./x.md?rel=extends)")[0]?.target).toBe("./x.md");
  });
});

describe("what a report needs: the link as written, and where", () => {
  test("a link carries the target AS WRITTEN, not only the resolved shape", () => {
    const [link] = extractLinks("See [it](./missing/deep.md?rel=x#top).\n");
    expect(link?.target).toBe("./missing/deep.md");
    expect(link?.raw).toBe("./missing/deep.md?rel=x#top");
  });

  test("and the line it is on, counted from 1", () => {
    const body = ["# Title", "", "prose", "", "- [a](x.md)", "- [b](y.md)"].join("\n");
    expect(extractLinks(body).map((l) => `${l.target}:${l.line}`)).toEqual(["x.md:5", "y.md:6"]);
  });

  test("⚠ A FENCED BLOCK SHIFTS NOTHING: line numbers survive the stripping", () => {
    const body = [
      "# Title",
      "",
      "```ts",
      "const a = [1](not-a-link.md);",
      "```",
      "",
      "real [link](x.md)",
    ].join("\n");
    const links = extractLinks(body);
    expect(links).toHaveLength(1);
    expect(links[0]?.line).toBe(7);
  });

  test("lines are the FILE's: a frontmatter block is counted, and holds no links", () => {
    const text = [
      "---",
      "title: Glade",
      "related: [./not-a-body-link.md]",
      "---",
      "",
      "The [Glade](./the-glade.md) is here.",
    ].join("\n");
    const links = extractLinks(text);
    expect(links.map((l) => [l.target, l.line])).toEqual([["./the-glade.md", 6]]);
  });

  test("offsets are the original text's, even after inline code is cut out of the line", () => {
    const text = "# T\n\nUse `code` then [the glade](./the-glade.md) and [again](./b.md).";
    const [a, b] = extractLinks(text);
    expect(text.slice(a?.from, a?.to)).toBe("[the glade](./the-glade.md)");
    expect(text.slice(b?.from, b?.to)).toBe("[again](./b.md)");
  });

  test("a label written in inline code keeps its place and its words", () => {
    // The Dreamwood bible's CONTRIBUTING.md writes `[`bible/x.md`](../x.md)`: the
    // stripped line has lost the label, so the link is found by its target half.
    const text = "# T\n\nCite by id: [`bible/the-glade.md`](../locations/the-glade.md). Done.";
    const [link] = extractLinks(text);
    expect(link?.target).toBe("../locations/the-glade.md");
    expect(text.slice(link?.from, link?.to)).toBe(
      "[`bible/the-glade.md`](../locations/the-glade.md)",
    );
    expect(link?.label).toBe("`bible/the-glade.md`");
  });

  test("two identical links on one line are two places", () => {
    const text = "[x](./a.md) and [x](./a.md)";
    const [a, b] = extractLinks(text);
    expect([a?.from, b?.from]).toEqual([0, 16]);
  });

  test("the context is the line, trimmed, and windowed around the link when long", () => {
    expect(extractLinks("   - See [a](./a.md) here.  ")[0]?.context).toBe(
      "- See [a](./a.md) here.",
    );
    const long = `${"word ".repeat(60)}[far](./far.md)${" tail".repeat(60)}`;
    const ctx = extractLinks(long)[0]?.context ?? "";
    expect(ctx).toContain("[far](./far.md)");
    expect(ctx.startsWith("…")).toBe(true);
    expect(ctx.endsWith("…")).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(162);
  });

  test("⛔ the window never ends inside another link", () => {
    // The bible's 06-design-lenses has a long line with links on both sides of
    // the one quoted; the first cut showed `[the Cave](./locat…`.
    const text = `${"word ".repeat(30)}[the Glade](./the-glade.md) ${"word ".repeat(16)}[the Cave](./locations/the-cave.md) ${"tail ".repeat(40)}`;
    const glade = extractLinks(text)[0];
    const ctx = glade?.context ?? "";
    expect(ctx).toContain("[the Glade](./the-glade.md)");
    // Either the whole of the next link, or none of it.
    expect(ctx.includes("[the Cave") === ctx.includes("the-cave.md)")).toBe(true);
    // And a window starting inside a link before it moves off it too.
    const before = `${"x ".repeat(60)}[a long label here](./somewhere/far.md) [g](./g.md) ${"y ".repeat(80)}`;
    const ctx2 = extractLinks(before)[1]?.context ?? "";
    expect(ctx2.includes("[a long") === ctx2.includes("far.md)")).toBe(true);
  });

  test("a wiki link reports what was written inside the brackets", () => {
    const [link] = extractLinks("A [[Ghost Page|the ghost]] here.\n");
    expect(link?.target).toBe("Ghost Page");
    expect(link?.raw).toBe("Ghost Page");
    expect(link?.line).toBe(1);
  });
});

// ── backlinks ─────────────────────────────────────────────────────────────

const ROOT = "/w/world";
const GLADE = "/w/world/locations/the-glade.md";
const PATHS = [
  GLADE,
  "/w/world/locations/the-river.md",
  "/w/world/characters/maren.md",
  "/w/world/02-voice.md",
];

const index: LinkIndex = {
  root: ROOT,
  inContext: (p) => (PATHS.includes(p) ? p : null),
  exists: (p) => PATHS.includes(p),
  isDir: () => false,
};
/** Resolve as a document does: no chat fallback. */
const asDocument = (raw: string, from: string) => resolveTarget(raw, from, index, "document");
const source = (path: string, text: string): LinkSource => ({ path, links: extractLinks(text) });

describe("backlinksTo", () => {
  test("every link that lands, with its source, line, raw and relations", () => {
    const found = backlinksTo(
      GLADE,
      [
        source(
          "/w/world/locations/the-river.md",
          "Flows past [the glade](./the-glade.md?rel=sister-of).",
        ),
        source(
          "/w/world/characters/maren.md",
          ["# Maren", "", "Lives by [it](../locations/the-glade.md?rel=sister-of,extends)."].join(
            "\n",
          ),
        ),
        source("/w/world/02-voice.md", "See [[locations/the-glade]] and [elsewhere](./x.md)."),
      ],
      asDocument,
    );
    expect(found.map((b) => [b.source, b.line, b.raw, b.rel])).toEqual([
      ["/w/world/locations/the-river.md", 1, "./the-glade.md?rel=sister-of", ["sister-of"]],
      [
        "/w/world/characters/maren.md",
        3,
        "../locations/the-glade.md?rel=sister-of,extends",
        ["sister-of", "extends"],
      ],
      ["/w/world/02-voice.md", 1, "locations/the-glade", []],
    ]);
    expect(found[1]?.context).toBe(
      "Lives by [it](../locations/the-glade.md?rel=sister-of,extends).",
    );
  });

  test("a document's links to itself are not backlinks", () => {
    const found = backlinksTo(
      GLADE,
      [
        source(GLADE, "Back to [the top](./the-glade.md#top)."),
        source("/w/world/locations/the-river.md", "[g](./the-glade.md)"),
      ],
      asDocument,
    );
    expect(found.map((b) => b.source)).toEqual(["/w/world/locations/the-river.md"]);
  });

  test("⛔ a link that only resolves through the CHAT's fallback does not count", () => {
    // `./locations/the-glade.md` from `characters/` names `characters/locations/…`,
    // which is not there. In the chat it would fall back to the root and land;
    // written in a document it is broken where it stands.
    const text = "[g](./locations/the-glade.md)";
    expect(resolveTarget(text.slice(4, -1), "/w/world/characters/maren.md", index, "chat")).toEqual(
      { state: "in-context", path: GLADE },
    );
    expect(backlinksTo(GLADE, [source("/w/world/characters/maren.md", text)], asDocument)).toEqual(
      [],
    );
  });

  test("an unanchored path still finds the root, as a document reads it", () => {
    const found = backlinksTo(
      GLADE,
      [source("/w/world/characters/maren.md", "[g](locations/the-glade.md)")],
      asDocument,
    );
    expect(found).toHaveLength(1);
  });

  test("links to other documents are sifted out without resolving them", () => {
    const asked: string[] = [];
    backlinksTo(
      GLADE,
      [
        source(
          "/w/world/02-voice.md",
          "[r](./locations/the-river.md) [g](./locations/the-glade.md)",
        ),
      ],
      (raw, from) => {
        asked.push(raw);
        return asDocument(raw, from);
      },
    );
    expect(asked).toEqual(["./locations/the-glade.md"]);
  });

  test("a name composed one way and written the other still passes the sift (NFC)", () => {
    const cafe = "/w/world/café.md"; // composed, as an editor writes it
    const asked: string[] = [];
    const found = backlinksTo(
      cafe,
      [source("/w/world/02-voice.md", "[c](./café.md)")], // decomposed, as macOS lists it
      (raw) => {
        asked.push(raw);
        return { state: "in-context", path: cafe };
      },
    );
    expect(asked).toEqual(["./café.md"]);
    expect(found).toHaveLength(1);
  });

  test("a link whose name matches but which lands elsewhere is not a backlink", () => {
    const found = backlinksTo(
      GLADE,
      [source("/w/world/02-voice.md", "[g](./elsewhere/the-glade.md)")],
      asDocument,
    );
    expect(found).toEqual([]);
  });
});

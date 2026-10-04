// The resolver, over real shapes: the wiki's `type/slug` keys, Operator's typed
// links, wiki links, and the frontmatter references that are NOT links.
import { describe, expect, test } from "bun:test";
import type { Edge, GraphNode, UnsupportedLink } from "./links";
import {
  type BundleIndex,
  buildGraph,
  extractLinks,
  fieldRefs,
  looksLikeRef,
  maskCode,
  parseRel,
  resolveTarget,
  splitTarget,
} from "./links";
import type { DocMeta, GraphPayload } from "./protocol";

const meta = (fields: Record<string, unknown>): DocMeta => ({
  raw: "",
  fields,
  ...(typeof fields.type === "string" ? { type: fields.type } : {}),
  status: "stable",
  tags: [],
  trust: "unverified",
  stale: false,
  date: null,
});

const ROOT = "/w/wiki";
const PATHS = [
  "/w/wiki/index.md",
  "/w/wiki/concepts/exit-codes.md",
  "/w/wiki/decisions/stay-pre-1-0.md",
  "/w/wiki/rules/exit-codes/help-exits-zero.md",
];
const METAS: Record<string, DocMeta> = {
  "/w/wiki/concepts/exit-codes.md": meta({ type: "concept" }),
  "/w/wiki/decisions/stay-pre-1-0.md": meta({
    type: "decision",
    related: ["concept/exit-codes"],
    tags: ["exit-codes"],
  }),
  "/w/wiki/rules/exit-codes/help-exits-zero.md": meta({ type: "rule" }),
};
const index = (extra: string[] = []): BundleIndex => ({
  root: ROOT,
  paths: PATHS,
  metaOf: (p) => METAS[p] ?? null,
  exists: (p) => PATHS.includes(p) || extra.includes(p),
});

describe("what counts as a link", () => {
  test("markdown links, minus images and external targets", () => {
    const links = extractLinks(
      [
        "[a](./other.md)",
        "[b](../concepts/exit-codes.md)",
        "![pic](./diagram.png)",
        "[c](https://x.dev)",
        "[d](mailto:a@b.c)",
        "[e](#anchor-only)",
      ].join("\n\n"),
    );
    expect(links.map((l) => l.target)).toEqual(["./other.md", "../concepts/exit-codes.md"]);
  });
  test("wiki links, with and without a label", () => {
    const links = extractLinks("See [[exit-codes]] and [[stay-pre-1-0|that decision]].");
    expect(links.map((l) => [l.kind, l.target, l.label])).toEqual([
      ["wiki", "exit-codes", undefined],
      ["wiki", "stay-pre-1-0", "that decision"],
    ]);
  });
  test("⛔ a link inside a FENCE is an example, not an edge", () => {
    const body = ["Real: [a](./real.md)", "", "```md", "[fake](./fake.md)", "```", ""].join("\n");
    expect(extractLinks(body).map((l) => l.target)).toEqual(["./real.md"]);
    expect(maskCode(body)).not.toContain("fake");
    expect(maskCode(body)).toHaveLength(body.length);
  });
  test("an anchor is not part of the target, and a title is not a target", () => {
    expect(splitTarget("../concepts/exit-codes.md#the-taxonomy").path).toBe(
      "../concepts/exit-codes.md",
    );
    expect(extractLinks('[a](./other.md "A title")')[0]?.target).toBe("./other.md");
  });
});

describe("what markdown renders as a link, and what it does not (#126)", () => {
  const targets = (body: string) => extractLinks(body).map((l) => l.target);

  test("a link in INLINE code is an example, not an edge", () => {
    expect(targets("see `[x](./a.md)` and [real](./b.md)")).toEqual(["./b.md"]);
    // A double-tick span holding a single tick, as CONTRIBUTING-style prose does.
    expect(targets("``[x](./a.md) ` ``")).toEqual([]);
    // An unclosed tick is not a span, so the link after it counts.
    expect(targets("a stray ` then [y](./y.md)")).toEqual(["./y.md"]);
  });
  test("a link in an INDENTED code block is an example too", () => {
    expect(targets(["prose", "", "    [x](./a.md)", "", "[b](./b.md)"].join("\n"))).toEqual([
      "./b.md",
    ]);
  });
  test("⚠ but an indented line continuing a LIST ITEM is prose, not code", () => {
    expect(targets(["- item", "    [x](./a.md)"].join("\n"))).toEqual(["./a.md"]);
  });
  test("a fence inside a blockquote masks its contents", () => {
    expect(targets(["> ```", "> [x](./a.md)", "> ```"].join("\n"))).toEqual([]);
  });
  test("an escaped bracket is text", () => {
    expect(targets("\\[not](./x.md)")).toEqual([]);
    expect(targets("[not\\](./x.md)")).toEqual([]);
  });
  test("a link inside an HTML comment is an aside, not an edge", () => {
    expect(targets("<!-- [x](./a.md) --> [b](./b.md)")).toEqual(["./b.md"]);
    expect(targets(["<!--", "[x](./a.md)", "-->", "[b](./b.md)"].join("\n"))).toEqual(["./b.md"]);
    // An unclosed comment runs to the end, as an HTML parser reads it.
    expect(targets("[b](./b.md) <!-- [x](./a.md)")).toEqual(["./b.md"]);
  });
  test("an <…> target, which may hold spaces", () => {
    const [l] = extractLinks("[a](<./My Notes.md>)");
    expect(l?.target).toBe("./My Notes.md");
    expect(l?.raw).toBe("./My Notes.md");
  });
  test("a single-quoted title is not part of the target", () => {
    expect(targets("[a](./x.md 'A title')")).toEqual(["./x.md"]);
  });
  test("nested brackets in a label", () => {
    const [l] = extractLinks("[a [b] c](./x.md)");
    expect(l?.target).toBe("./x.md");
    expect(l?.label).toBe("a [b] c");
  });
  test("an escaped ] in a label", () => {
    const [l] = extractLinks("[a \\] b](./x.md)");
    expect(l?.target).toBe("./x.md");
    expect(l?.label).toBe("a ] b");
  });
  test("a label that wraps onto the next line (a Prettier reflow) is one link, on its first line", () => {
    const [l] = extractLinks(["intro", "see [the long", "label](./x.md) here"].join("\n"));
    expect(l?.target).toBe("./x.md");
    expect(l?.label).toBe("the long label");
    expect(l?.line).toBe(2);
  });
  test("⚠ a BLANK line ends a label, and so does the end of a heading", () => {
    expect(targets(["[a", "", "b](./x.md)"].join("\n"))).toEqual([]);
    expect(targets(["# [a", "b](./x.md)"].join("\n"))).toEqual([]);
  });
  test("parentheses in a target", () => {
    expect(targets("[a](./notes(1).md)")).toEqual(["./notes(1).md"]);
    expect(targets("[a](./notes\\(2\\).md)")).toEqual(["./notes(2).md"]);
  });
  test("a link inside another link's label: the INNER one is what renders", () => {
    expect(targets("[see [x](./y.md)](./z.md)")).toEqual(["./y.md"]);
  });
  test("an escaped image marker leaves a plain link", () => {
    expect(targets("\\![pic](./pic.md)")).toEqual(["./pic.md"]);
  });
  test("a wiki link in code is masked too, and links come back in document order", () => {
    const links = extractLinks("`[[skip]]` [[b]] then [a](./a.md)");
    expect(links.map((l) => l.target)).toEqual(["b", "./a.md"]);
  });
  test("line numbers are right on every line of a long document", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} [l${i}](./d${i}.md)`);
    const links = extractLinks(lines.join("\n"));
    expect(links).toHaveLength(2000);
    expect(links.every((l, i) => l.line === i + 1 && l.target === `./d${i}.md`)).toBe(true);
  });
  test("the map (and so backlinks and dangling) reads links the same way", () => {
    const g = buildGraph(index(), (p) =>
      p === "/w/wiki/index.md"
        ? "`[x](./gone.md)` <!-- [y](./gone2.md) --> \\[z](./gone3.md) [ok](./concepts/exit-codes.md)"
        : "",
    );
    const fromIndex = g.edges.filter((e) => e.from === "/w/wiki/index.md" && e.source === "link");
    expect(fromIndex.map((e) => e.raw)).toEqual(["./concepts/exit-codes.md"]);
    expect(g.dangling).toBe(0);
  });
  test("adversarial runs finish quickly (the cost was quadratic)", () => {
    const n = 50_000;
    for (const unit of ["[", "(", "](", "`", "<!--", "[a](", "[[", "\\["]) {
      const started = performance.now();
      extractLinks(unit.repeat(Math.ceil(n / unit.length)));
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe("typed links — Operator's shape", () => {
  test("rels are parsed, lowercased, trimmed and deduped, order kept", () => {
    expect(parseRel("rel=Extends,%20governs,extends")).toEqual(["extends", "governs"]);
    expect(extractLinks("[a](./x.md?rel=supersedes)")[0]?.rel).toEqual(["supersedes"]);
    expect(extractLinks("[[x?rel=see-also|label]]")[0]?.rel).toEqual(["see-also"]);
  });
  test("⛔ a BARE link asserts nothing — it is not an implicit `references`", () => {
    expect(extractLinks("[a](./x.md)")[0]?.rel).toEqual([]);
    expect(extractLinks("[[x]]")[0]?.rel).toEqual([]);
  });
  test("the query is stripped from the path it rides on", () => {
    expect(extractLinks("[a](./x.md?rel=extends)")[0]?.target).toBe("./x.md");
  });
});

describe("frontmatter references — the SHAPE decides, not the key", () => {
  test("a slash or a .md makes a reference; bare tags do not", () => {
    expect(looksLikeRef("concept/exit-codes")).toBe(true);
    expect(looksLikeRef("./other.md")).toBe(true);
    expect(looksLikeRef("exit-codes")).toBe(false); // a tag
    expect(looksLikeRef("https://x.dev/a")).toBe(false); // external
    expect(looksLikeRef(42)).toBe(false);
  });
  test("any key carries them — related, supersedes, a nested sources[].resource", () => {
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
});

describe("what a dangling link report needs (E54)", () => {
  test("a link carries the target AS WRITTEN, not only the resolved shape", () => {
    const [link] = extractLinks("See [it](./missing/deep.md?rel=x#top).\n");
    expect(link?.target).toBe("./missing/deep.md");
    // ⛔ The written string is the one that is IN the file, so it is the one a
    // repair can search for. `target` alone sends you looking for `deep.md`.
    expect(link?.raw).toBe("./missing/deep.md?rel=x#top");
  });

  test("and the line it is on, counted from 1", () => {
    const body = ["# Title", "", "prose", "", "- [a](x.md)", "- [b](y.md)"].join("\n");
    const links = extractLinks(body);
    expect(links.map((l) => `${l.target}:${l.line}`)).toEqual(["x.md:5", "y.md:6"]);
  });

  test("⚠ A FENCED BLOCK SHIFTS NOTHING — line numbers survive code masking", () => {
    // `maskCode` BLANKS fenced lines rather than removing them, so the
    // count is preserved. A link after a code block must still report its real
    // line, or every report in a document with code is off by the block.
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

  test("a wiki link reports what was written inside the brackets", () => {
    const [link] = extractLinks("A [[Ghost Page|the ghost]] here.\n");
    expect(link?.target).toBe("Ghost Page");
    expect(link?.raw).toBe("Ghost Page");
    expect(link?.line).toBe(1);
  });
});

describe("resolving against the bundle", () => {
  const from = "/w/wiki/decisions/stay-pre-1-0.md";
  // ⛔ THE CLICK PATH GETS THE TARGET AS WRITTEN — query, anchor, encoding and
  // all. `extractLinks` splits it before building the graph (E49), so the graph
  // was right while FOLLOWING the same link reported it missing; Cole found it
  // by clicking an Operator typed link in Hollowbrook. These four are that bug.
  test("an Operator typed link (`?rel=`) resolves — the query is not part of the name", () => {
    const i = index();
    expect(resolveTarget("../concepts/exit-codes.md?rel=located-in", from, i)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("a percent-encoded space resolves", () => {
    const i = index(["/w/wiki/concepts/two words.md"]);
    const withFile: BundleIndex = { ...i, paths: [...i.paths, "/w/wiki/concepts/two words.md"] };
    expect(resolveTarget("../concepts/two%20words.md", from, withFile)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/two words.md",
    });
  });
  test("an anchor is not part of the name either", () => {
    expect(resolveTarget("../concepts/exit-codes.md#the-rule", from, index())).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("all three at once — the Hollowbrook shape", () => {
    const i = index();
    const withFile: BundleIndex = { ...i, paths: [...i.paths, "/w/wiki/concepts/two words.md"] };
    expect(resolveTarget("../concepts/two%20words.md?rel=located-in#top", from, withFile)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/two words.md",
    });
  });

  test("a relative path resolves against the document", () => {
    expect(resolveTarget("../concepts/exit-codes.md", from, index())).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("⛔ a leading slash is the BUNDLE root, not the filesystem root", () => {
    expect(resolveTarget("/concepts/exit-codes.md", from, index())).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("`type/slug` resolves by TYPE and BASENAME, so a page can move folders", () => {
    expect(resolveTarget("concept/exit-codes", from, index())).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
    // The type must match the target's own claim.
    expect(resolveTarget("guide/exit-codes", from, index()).state).toBe("in-bundle"); // falls back to basename
    expect(resolveTarget("concept/nothing-here", from, index()).state).toBe("missing");
  });
  test("a target with ANY extension is a path, even without a ./ — the lint.ts case", () => {
    const i = index(["/w/wiki/lint.ts"]);
    expect(resolveTarget("lint.ts", "/w/wiki/index.md", i)).toEqual({
      state: "outside",
      path: "/w/wiki/lint.ts",
    });
    // And a `type/slug` key, which has a slash but no extension, is still a key.
    expect(resolveTarget("concept/exit-codes", "/w/wiki/index.md", i).state).toBe("in-bundle");
  });

  test("an UNANCHORED path is tried against the document AND the bundle root", () => {
    // The real wiki's rule pages carry `checker: src/acc/kit/checkers/…`, which
    // is repo-relative, not document-relative: resolving only from the document
    // reported 22 of them missing while the files sat under the bundle.
    const i = index(["/w/wiki/src/acc/kit/checkers/a.ts"]);
    expect(resolveTarget("src/acc/kit/checkers/a.ts", "/w/wiki/rules/x.md", i)).toEqual({
      state: "outside",
      path: "/w/wiki/src/acc/kit/checkers/a.ts",
    });
    // A repo-relative path — pdocs' own form — is the third place tried.
    const repo: BundleIndex = {
      ...index(["/w/src/acc/kit/checkers/a.ts"]),
      repoRoot: "/w",
    };
    expect(resolveTarget("src/acc/kit/checkers/a.ts", "/w/wiki/rules/x.md", repo)).toEqual({
      state: "outside",
      path: "/w/src/acc/kit/checkers/a.ts",
    });
    // Document-relative still WINS when both would resolve.
    const j: BundleIndex = {
      ...index(),
      paths: [...PATHS, "/w/wiki/decisions/notes.md", "/w/wiki/notes.md"],
    };
    expect(resolveTarget("notes.md", "/w/wiki/decisions/x.md", j)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/decisions/notes.md",
    });
  });

  test("a bare name (a wiki link) resolves by basename", () => {
    expect(resolveTarget("exit-codes", from, index())).toEqual({
      state: "in-bundle",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("a target OUTSIDE the bundle that exists is `outside`, not missing", () => {
    const i = index(["/w/other/notes.md"]);
    expect(resolveTarget("../../other/notes.md", from, i)).toEqual({
      state: "outside",
      path: "/w/other/notes.md",
    });
  });
  test("a target nothing answers is `missing` — tolerated, never an error", () => {
    expect(resolveTarget("./gone.md", from, index()).state).toBe("missing");
  });
});

describe("a link to a folder (#123)", () => {
  const from = "/w/wiki/index.md";
  const DIRS = ["/w/wiki", "/w/wiki/concepts", "/w/wiki/rules", "/w/wiki/rules/exit-codes"];
  const withDirs = (extra: Partial<BundleIndex> = {}): BundleIndex => ({
    ...index(),
    isDir: (p) => DIRS.includes(p),
    ...extra,
  });

  test("`./concepts/` and `./concepts` are the folder, not a missing concepts.md", () => {
    for (const t of ["./concepts/", "./concepts", "concepts/", "/concepts/", "./concepts/?rel=x"])
      expect(resolveTarget(t, from, withDirs())).toEqual({
        state: "folder",
        path: "/w/wiki/concepts",
      });
  });
  test("a bare name no document answers resolves as a folder too", () => {
    expect(resolveTarget("rules", from, withDirs())).toEqual({
      state: "folder",
      path: "/w/wiki/rules",
    });
  });
  test("a nested folder, from a document inside another one", () => {
    expect(
      resolveTarget("../rules/exit-codes/", "/w/wiki/concepts/exit-codes.md", withDirs()),
    ).toEqual({ state: "folder", path: "/w/wiki/rules/exit-codes" });
  });
  test("a link to the bundle root itself is the root folder", () => {
    expect(resolveTarget("/", from, withDirs())).toEqual({ state: "folder", path: "/w/wiki" });
  });
  test("⚠ a document beats a folder of the same name, without the slash", () => {
    const both = withDirs({
      paths: [...PATHS, "/w/wiki/rules.md"],
      exists: (p) => PATHS.includes(p) || p === "/w/wiki/rules.md",
    });
    expect(resolveTarget("./rules", from, both)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/rules.md",
    });
    // …and a trailing slash says FOLDER, whatever document shares the name.
    expect(resolveTarget("./rules/", from, both)).toEqual({
      state: "folder",
      path: "/w/wiki/rules",
    });
  });
  test("a trailing-slash target that is no folder is missing, and says the folder it tried", () => {
    expect(resolveTarget("./places/", from, withDirs())).toEqual({
      state: "missing",
      tried: "/w/wiki/places",
    });
    // Read as a key it matched any `places.md` by basename; it no longer does.
    expect(resolveTarget("index/", from, withDirs()).state).toBe("missing");
  });
  test("without a disk to ask (no `isDir`), nothing is a folder", () => {
    expect(resolveTarget("./concepts/", from, index()).state).toBe("missing");
  });
  test("a folder edge is in the map, and is not dangling", () => {
    const g = buildGraph(withDirs(), (p) => (p === from ? "[c](./concepts/) [r](rules)" : ""));
    const folderEdges = g.edges.filter((e) => e.state === "folder");
    expect(folderEdges.map((e) => e.to)).toEqual(["/w/wiki/concepts", "/w/wiki/rules"]);
    expect(g.dangling).toBe(0);
  });
});

describe("links with a scheme nothing here opens (#128)", () => {
  test("extraction keeps scheme targets only when asked, each with its scheme", () => {
    const body = "[src](op:doc/1d63ec43-65cd) [web](https://x.dev) [doc](./a.md)";
    expect(extractLinks(body).map((l) => l.raw)).toEqual(["./a.md"]);
    expect(extractLinks(body, { schemes: true }).map((l) => [l.raw, l.scheme])).toEqual([
      ["op:doc/1d63ec43-65cd", "op"],
      ["https://x.dev", "https"],
      ["./a.md", undefined],
    ]);
  });
  test("the map keeps an `op:` link apart, with its line and the link as written", () => {
    const g = buildGraph(index(), (p) =>
      p === "/w/wiki/index.md"
        ? ["intro", "[the source](op:doc/1d63?rel=derived-from)", "[w](https://x.dev)"].join("\n")
        : "",
    );
    expect(g.unsupported).toEqual([
      {
        from: "/w/wiki/index.md",
        raw: "op:doc/1d63?rel=derived-from",
        line: 2,
        scheme: "op",
        rel: ["derived-from"],
      },
    ]);
    // Not an edge, and not counted as a missing file.
    expect(g.edges.some((e) => e.raw?.startsWith("op:"))).toBe(false);
    expect(g.dangling).toBe(0);
  });
  test("http, https and mailto open outward, so they are never reported", () => {
    const g = buildGraph(index(), (p) =>
      p === "/w/wiki/index.md" ? "[a](http://x) [b](HTTPS://x) [c](mailto:a@b.c)" : "",
    );
    expect(g.unsupported).toEqual([]);
  });
  test("⚠ any other scheme is reported, as the surface strikes it through: tel:, ftp:, javascript:", () => {
    const g = buildGraph(index(), (p) =>
      p === "/w/wiki/index.md" ? "[a](tel:123) [b](FTP://x) [c](javascript:void(0))" : "",
    );
    expect(g.unsupported.map((u) => u.scheme)).toEqual(["tel", "ftp", "javascript"]);
  });
  test("an `op:` link written in code is still an example, not a report", () => {
    const g = buildGraph(index(), (p) => (p === "/w/wiki/index.md" ? "`[x](op:doc/1)`" : ""));
    expect(g.unsupported).toEqual([]);
  });
});

describe("the map", () => {
  const bodies: Record<string, string> = {
    "/w/wiki/index.md": "[exit codes](./concepts/exit-codes.md) and [[stay-pre-1-0]]",
    "/w/wiki/concepts/exit-codes.md":
      "See [the rule](/rules/exit-codes/help-exits-zero.md?rel=governs)",
    "/w/wiki/decisions/stay-pre-1-0.md": "Nothing in the body. [gone](./nowhere.md)",
    "/w/wiki/rules/exit-codes/help-exits-zero.md": "",
  };
  const graph = buildGraph(index(), (p) => bodies[p] ?? "");

  test("every document is a node, with its own title and counts", () => {
    expect(graph.nodes.map((n) => n.rel).sort()).toEqual(
      [
        "index.md",
        "concepts/exit-codes.md",
        "decisions/stay-pre-1-0.md",
        "rules/exit-codes/help-exits-zero.md",
      ].sort(),
    );
    expect(graph.nodes.find((n) => n.rel === "concepts/exit-codes.md")?.linksIn).toBe(2); // body + related
  });
  test("body links and frontmatter references are KEPT APART", () => {
    const toExitCodes = graph.edges.filter((e) => e.to === "/w/wiki/concepts/exit-codes.md");
    expect(toExitCodes.map((e) => e.source).sort()).toEqual(["frontmatter", "link"]);
    expect(toExitCodes.find((e) => e.source === "frontmatter")?.key).toBe("related");
  });
  test("a typed link keeps its relation", () => {
    const typed = graph.edges.find((e) => e.rel.includes("governs"));
    expect(typed?.to).toBe("/w/wiki/rules/exit-codes/help-exits-zero.md");
  });
  test("a dangling target is counted and kept, not dropped", () => {
    expect(graph.dangling).toBe(1);
    expect(graph.edges.some((e) => e.state === "missing")).toBe(true);
  });
});

describe("percent-encoded targets (E49)", () => {
  test("a space encoded as %20 resolves to the file it names", () => {
    // ⛔ FOUND IN USE, not in a fixture: a real corpus whose filenames have
    // spaces linked itself correctly and the graph drew NO edges into those
    // documents, because the target was looked up literally.
    expect(splitTarget("Maren's%20Bakery.md").path).toBe("Maren's Bakery.md");
  });

  test("decoding happens before the query is read, not after", () => {
    const t = splitTarget("Visual%20Style.md?rel=renders-per");
    expect(t.path).toBe("Visual Style.md");
    expect(parseRel(t.query)).toEqual(["renders-per"]);
  });

  test("an em dash survives encoding", () => {
    expect(splitTarget("Hollowbrook%20%E2%80%94%20Overview.md").path).toBe(
      "Hollowbrook — Overview.md",
    );
  });

  test("an UNDECODABLE target is left alone rather than throwing", () => {
    // `100% done.md` is an ordinary filename and a lone % is not valid encoding.
    expect(() => splitTarget("100% done.md")).not.toThrow();
    expect(splitTarget("100% done.md").path).toBe("100% done.md");
  });

  test("a target with no encoding is untouched", () => {
    expect(splitTarget("Maren.md").path).toBe("Maren.md");
  });

  test("an anchor is still split off, and decoded", () => {
    const t = splitTarget("Hollowbrook%20Overview.md#the-rules");
    expect(t.path).toBe("Hollowbrook Overview.md");
    expect(t.anchor).toBe("the-rules");
  });
});

// ── the mirror guard ────────────────────────────────────────────────────────
//
// ⛔ `protocol.ts` DUPLICATES these shapes BY NECESSITY — it is import-free so
// that the surface and `dist/cli.js` never drag the daemon's graph — which
// makes it the lockstep mirror this repo has paid for before. This is the check
// that the copy stays a copy. Nothing runs; the type checker is the assertion.
//
// ⚠ IT COMPARES KEY SETS, NOT ASSIGNABILITY, AND THE DIFFERENCE IS THE WHOLE
// POINT. Two-way assignability was the first attempt and it was measured to be
// USELESS for this: an OPTIONAL field added to one side alone keeps both
// directions assignable, so planting exactly the drift E54 introduced
// (`raw?`/`line?` on the computing side only) produced zero errors. Key
// equality catches it, because the key is there whether or not it is optional.
type ExactKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
type ProtoEdge = GraphPayload["edges"][number];
type ProtoNode = GraphPayload["nodes"][number];
const _edgeKeysMatch: ExactKeys<Edge, ProtoEdge> = true;
const _nodeKeysMatch: ExactKeys<GraphNode, ProtoNode> = true;
// And assignability on top, which catches a field whose TYPE drifted while its
// name stayed — the case key equality cannot see.
const _edgeToProto: ProtoEdge = {} as Edge;
const _protoToEdge: Edge = {} as ProtoEdge;
const _nodeToProto: ProtoNode = {} as GraphNode;
const _protoToNode: GraphNode = {} as ProtoNode;
// #128's `unsupported` is mirrored the same way.
type ProtoUnsupported = GraphPayload["unsupported"][number];
const _unsupportedKeysMatch: ExactKeys<UnsupportedLink, ProtoUnsupported> = true;
const _unsupportedToProto: ProtoUnsupported = {} as UnsupportedLink;
const _protoToUnsupported: UnsupportedLink = {} as ProtoUnsupported;
void _unsupportedKeysMatch;
void _unsupportedToProto;
void _protoToUnsupported;
void _edgeKeysMatch;
void _nodeKeysMatch;
void _edgeToProto;
void _protoToEdge;
void _nodeToProto;
void _protoToNode;

describe("round two: extraction agrees with the rendered view", () => {
  const targets = (body: string) => extractLinks(body).map((l) => l.target);

  test("indented code inside a LIST ITEM is code, as the surface renders it", () => {
    expect(targets("- item\n\n      [x](./nope4.md)")).toEqual([]);
    // An ordered item's content starts three columns in, so code is seven.
    expect(targets("1. item\n\n       [x](./nope.md)\n\n[b](./b.md)")).toEqual(["./b.md"]);
  });
  test("indented code inside a BLOCKQUOTE is code too", () => {
    expect(targets("> q\n>\n>     [x](./nope5.md)")).toEqual([]);
    expect(targets("> - item\n>\n>       [x](./nope6.md)")).toEqual([]);
  });
  test("⚠ a list item's continuation PARAGRAPH is prose, and its links count", () => {
    expect(targets("- a\n\n  more [x](./ok.md)")).toEqual(["./ok.md"]);
    expect(targets("1. a\n\n   more [y](./ok2.md)")).toEqual(["./ok2.md"]);
  });
  test("a code span that runs onto the next line is still code", () => {
    expect(targets("`a\n[x](./c3.md)`")).toEqual([]);
    expect(targets("``a ` b\n[x](./c4.md) ``")).toEqual([]);
    // A blank line ends the paragraph, so the ticks close nothing.
    expect(targets("`a\n\n[x](./c5.md)`")).toEqual(["./c5.md"]);
  });
  test("a link wrapped around an image is an edge to the OUTER target", () => {
    expect(targets("[![badge](./b.png)](./real.md)")).toEqual(["./real.md"]);
    expect(targets("[t ![a](i.png)](./r.md)")).toEqual(["./r.md"]);
    const [l] = extractLinks("[![a](i.png) and text](./r2.md?rel=see-also)");
    expect([l?.target, l?.rel]).toEqual(["./r2.md", ["see-also"]]);
    // The image inside is still an image, never a document link.
    expect(extractLinks("[![b](./b.md)](./real.md)", { schemes: true }).map((x) => x.raw)).toEqual([
      "./real.md",
    ]);
    // …and a LINK inside a label still means the inner one is what renders.
    expect(targets("[![b](i.png) [x](./y.md)](./z.md)")).toEqual(["./y.md"]);
  });
  test("a protocol-relative URL is external, not a dangling path", () => {
    expect(targets("[cdn](//cdn.example.com/x) [d](./d.md)")).toEqual(["./d.md"]);
    expect(looksLikeRef("//cdn.example.com/x")).toBe(false);
    const g = buildGraph(index(), (p) =>
      p === "/w/wiki/index.md" ? "[cdn](//cdn.example.com/x.js)" : "",
    );
    expect(g.edges.filter((e) => e.from === "/w/wiki/index.md")).toEqual([]);
    expect(g.unsupported).toEqual([]);
    expect(g.dangling).toBe(0);
  });
});

describe("round two: a document beats a same-named folder, dots and all", () => {
  const from = "/w/wiki/index.md";
  const disk = (docs: string[], dirs: string[], files: string[] = []): BundleIndex => ({
    root: ROOT,
    paths: [...PATHS, ...docs],
    metaOf: () => null,
    exists: (p) => PATHS.includes(p) || docs.includes(p) || files.includes(p),
    isDir: (p) => p === ROOT || dirs.includes(p),
  });

  test("`./v1.2` is v1.2.md when both it and a v1.2/ folder exist", () => {
    const both = disk(["/w/wiki/v1.2.md"], ["/w/wiki/v1.2"]);
    expect(resolveTarget("./v1.2", from, both)).toEqual({
      state: "in-bundle",
      path: "/w/wiki/v1.2.md",
    });
    expect(resolveTarget("./v1.2/", from, both)).toEqual({
      state: "folder",
      path: "/w/wiki/v1.2",
    });
    // With no document, the folder answers.
    expect(resolveTarget("./v1.2", from, disk([], ["/w/wiki/v1.2"]))).toEqual({
      state: "folder",
      path: "/w/wiki/v1.2",
    });
  });
  test("`./notes.v2` finds notes.v2.md", () => {
    expect(resolveTarget("./notes.v2", from, disk(["/w/wiki/notes.v2.md"], []))).toEqual({
      state: "in-bundle",
      path: "/w/wiki/notes.v2.md",
    });
  });
  test("⚠ a name with a real extension is still that file, and a miss says what was written", () => {
    expect(resolveTarget("./lint.ts", from, disk([], [], ["/w/wiki/lint.ts"]))).toEqual({
      state: "outside",
      path: "/w/wiki/lint.ts",
    });
    expect(resolveTarget("./v9.9", from, disk([], []))).toEqual({
      state: "missing",
      tried: "/w/wiki/v9.9",
    });
    // A document name is not given a second `.md`.
    expect(resolveTarget("./gone.md", from, disk([], []))).toEqual({
      state: "missing",
      tried: "/w/wiki/gone.md",
    });
  });
});

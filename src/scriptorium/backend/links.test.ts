// The resolver, over real shapes: the wiki's `type/slug` keys, Operator's typed
// links, wiki links, and the frontmatter references that are NOT links.
import { describe, expect, test } from "bun:test";
import {
  type BundleIndex,
  buildGraph,
  extractLinks,
  fieldRefs,
  looksLikeRef,
  parseRel,
  resolveTarget,
  splitTarget,
  withoutFences,
} from "./links";
import type { DocMeta } from "./protocol";

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
    expect(withoutFences(body)).not.toContain("fake");
  });
  test("an anchor is not part of the target, and a title is not a target", () => {
    expect(splitTarget("../concepts/exit-codes.md#the-taxonomy").path).toBe(
      "../concepts/exit-codes.md",
    );
    expect(extractLinks('[a](./other.md "A title")')[0]?.target).toBe("./other.md");
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

describe("resolving against the bundle", () => {
  const from = "/w/wiki/decisions/stay-pre-1-0.md";
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

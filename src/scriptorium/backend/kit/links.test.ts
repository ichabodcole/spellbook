// Scriptorium's part of the kit's link slot (kit-link-edges-slot), on a real
// kit session: frontmatter references as `frontmatter` edges, kept apart from
// body links as the shipped `graph` and `backlinks` keep `related` from `links`,
// and its wiki forms landing through the kit's resolver.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSession } from "../../../kit/workspace/session";
import { inContext, tempRoot } from "../../../kit/workspace/testing";
import {
  FRONTMATTER_EDGE,
  frontmatterEdges,
  scriptoriumLinkSlot,
  wikiFormsResolver,
} from "./links";

describe("wikiFormsResolver", () => {
  const docs = [
    { path: "/w/wiki/concepts/exit-codes.md", type: "concept", frontmatter: null },
    { path: "/w/wiki/rules/exit-codes.md", type: "rule", frontmatter: null },
    { path: "/w/other/exit-codes.md", type: "rule", frontmatter: null },
  ];
  const ask = (target: string, root = "/w/wiki") =>
    wikiFormsResolver(() => "/w")({
      target,
      from: null,
      root,
      kind: "wiki",
      documents: () => docs,
    });

  test("a `type/slug` key is the document of that type first, then the name", () => {
    expect(ask("rule/exit-codes")).toEqual([
      "/w/wiki/rules/exit-codes.md",
      "/w/wiki/concepts/exit-codes.md",
    ]);
    expect(ask("guide/exit-codes")).toEqual(["/w/wiki/concepts/exit-codes.md"]);
  });

  test("names are looked for in the set the link is written in", () => {
    expect(ask("exit-codes", "/w/other")).toEqual(["/w/other/exit-codes.md"]);
    expect(ask("nothing")).toEqual([]);
  });

  test("an unanchored path is also tried from the repo root; an anchored one is not", () => {
    expect(ask("src/lint.ts")).toEqual(["/w/src/lint.ts"]);
    expect(ask("./src/lint.ts")).toBeUndefined();
    expect(ask("concepts/")).toBeUndefined();
  });
});

describe("frontmatterEdges", () => {
  test("every key that holds a reference, by its shape, as the shipped graph reads them", () => {
    expect(
      frontmatterEdges({
        title: "the CLI/server pair, finalize.",
        tags: ["a", "b"],
        related: ["../concepts/exit-codes.md", "concept/exit-codes"],
        sources: [{ resource: "./notes/field notes.md" }],
      }),
    ).toEqual([
      { kind: FRONTMATTER_EDGE, target: "../concepts/exit-codes.md", key: "related" },
      { kind: FRONTMATTER_EDGE, target: "concept/exit-codes", key: "related" },
      { kind: FRONTMATTER_EDGE, target: "./notes/field notes.md", key: "sources.resource" },
    ]);
    expect(frontmatterEdges(null)).toEqual([]);
  });
});

describe("on a kit session", () => {
  let root: string;
  let set: string;
  let s: WorkspaceSession;
  beforeEach(() => {
    root = tempRoot("scr-kit-links");
    set = join(root, "repo", "wiki");
    mkdirSync(join(set, "concepts"), { recursive: true });
    mkdirSync(join(set, "decisions"), { recursive: true });
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    // The set sits in a git working tree: the repo root is a third place to look.
    mkdirSync(join(root, "repo", ".git"));
    writeFileSync(join(root, "repo", "src", "lint.md"), "# The linter\n");
    writeFileSync(
      join(set, "concepts", "exit-codes.md"),
      "---\ntype: concept\n---\n# Exit codes\n",
    );
    writeFileSync(
      join(set, "decisions", "stay.md"),
      [
        "---",
        "type: decision",
        "related: [concept/exit-codes, ../concepts/missing.md]",
        "supersedes: src/lint.md",
        "---",
        "# Stay",
        "",
        "See [[exit-codes]] and [the codes](../concepts/exit-codes.md).",
      ].join("\n"),
    );
    s = inContext(join(root, "sessions"), set);
    s.setLinkSlot(scriptoriumLinkSlot());
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("backlinks keep the frontmatter references apart from the body links", () => {
    const b = s.backlinks(join(set, "concepts", "exit-codes.md"));
    // The wiki link lands by bare name; the markdown link by path.
    expect(b.backlinks.map((l) => l.raw).sort()).toEqual([
      "../concepts/exit-codes.md",
      "exit-codes",
    ]);
    expect(b.edges).toEqual([
      {
        source: join(set, "decisions", "stay.md"),
        name: "stay.md",
        shown: "decisions/stay.md",
        edge: FRONTMATTER_EDGE,
        raw: "concept/exit-codes",
        key: "related",
        rel: [],
      },
    ]);
  });

  test("the graph draws them, marked as frontmatter, and a key resolves by type and name", () => {
    const g = s.linkGraph({ edge: [FRONTMATTER_EDGE] });
    expect(g.edges).toEqual([
      {
        from: join(set, "decisions", "stay.md"),
        to: join(set, "concepts", "exit-codes.md"),
        rel: [],
        count: 1,
        edge: FRONTMATTER_EDGE,
      },
    ]);
    expect(s.linkGraph().edgeKinds).toEqual([
      { kind: "link", count: 2 },
      { kind: FRONTMATTER_EDGE, count: 1 },
    ]);
  });

  test("the link check reports a reference nothing answers, and finds one from the repo root", () => {
    const c = s.linkCheck();
    expect(c.edges?.links.map((e) => [e.raw, e.key])).toEqual([
      ["../concepts/missing.md", "related"],
    ]);
    expect(c.dangling.count).toBe(0);
    // `supersedes: src/lint.md` is outside the set, under the repo root: found, not dangling.
    const stay = s.openPath(join(set, "decisions", "stay.md")).slug;
    expect(s.resolveLink("src/lint.md", stay)).toEqual({
      state: "outside",
      path: join(root, "repo", "src", "lint.md"),
    });
  });
});

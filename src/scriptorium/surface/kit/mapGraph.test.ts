// The map's feed on the kit path: the kit's `LinkGraph` joined with docMeta
// (`mapGraph`), pinned field by field.

import { describe, expect, test } from "bun:test";
import type { GraphEdgeView, GraphNodeView, LinkGraph } from "../../../kit/workspace/protocol";
import type { DocSummary } from "../../backend/protocol";
import { mapGraph } from "./mapGraph";

const node = (path: string, extra: Partial<GraphNodeView> = {}): GraphNodeView => ({
  path,
  name: path.split("/").pop() as string,
  shown: path.replace("/set/", ""),
  title: path,
  kind: null,
  label: null,
  canon: true,
  linksIn: 0,
  linksOut: 0,
  ...extra,
});

const graphOf = (
  nodes: GraphNodeView[],
  edges: GraphEdgeView[] = [],
  total?: number,
): LinkGraph => ({
  focus: null,
  nodes,
  edges,
  relations: [],
  untyped: 0,
  kinds: [],
  total: { nodes: total ?? nodes.length, edges: edges.length, links: 0 },
});

const meta = (extra: Partial<DocSummary> = {}): DocSummary => ({
  status: "stable",
  tags: [],
  trust: "unverified",
  stale: false,
  ...extra,
});

describe("mapGraph", () => {
  test("a node carries its path from the set's root, title, kind and label, and its links", () => {
    const g = mapGraph(
      graphOf([
        node("/set/a.md", {
          title: "Alpha",
          kind: "rule",
          label: "Rule",
          status: "draft",
          linksIn: 3,
          linksOut: 1,
        }),
      ]),
      {},
    );
    expect(g.nodes).toEqual([
      {
        path: "/set/a.md",
        rel: "a.md",
        title: "Alpha",
        type: "rule",
        typeLabel: "Rule",
        status: "draft",
        stale: false,
        tags: [],
        linksIn: 3,
        linksOut: 1,
      },
    ]);
  });

  test("a kind with no label is its own heading; a kindless node has no column of its own", () => {
    const g = mapGraph(graphOf([node("/set/a.md", { kind: "note" }), node("/set/b.md")]), {});
    expect(g.nodes[0]?.type).toBe("note");
    expect(g.nodes[0]?.typeLabel).toBe("note");
    expect("type" in (g.nodes[1] ?? {})).toBe(false);
    expect("typeLabel" in (g.nodes[1] ?? {})).toBe(false);
  });

  test("stale and tags are joined from docMeta, by path", () => {
    const g = mapGraph(graphOf([node("/set/a.md"), node("/set/b.md")]), {
      "/set/a.md": meta({ stale: true, tags: ["x", "y"] }),
    });
    expect(g.nodes[0]?.stale).toBe(true);
    expect(g.nodes[0]?.tags).toEqual(["x", "y"]);
    // Not in docMeta (no frontmatter, or past its cap): nothing is claimed.
    expect(g.nodes[1]?.stale).toBe(false);
    expect(g.nodes[1]?.tags).toEqual([]);
  });

  test("a missing status stays missing: not docMeta's default, not `stable`", () => {
    const g = mapGraph(graphOf([node("/set/a.md")]), {
      "/set/a.md": meta({ status: "stable" }),
    });
    expect("status" in (g.nodes[0] ?? {})).toBe(false);
  });

  test("E69: trust is not on the map, so nothing reads `unverified` for a missing field", () => {
    const g = mapGraph(graphOf([node("/set/a.md"), node("/set/b.md", { status: "stable" })]), {
      "/set/a.md": meta({ trust: "unverified" }),
      "/set/b.md": meta({ trust: "unverified" }),
    });
    expect(JSON.stringify(g)).not.toContain("unverified");
    expect(JSON.stringify(g)).not.toContain("trust");
  });

  test("body links and frontmatter references keep their kind; folded counts add up to the links", () => {
    const g = mapGraph(
      graphOf(
        [node("/set/a.md"), node("/set/b.md"), node("/set/c.md")],
        [
          { from: "/set/a.md", to: "/set/b.md", rel: [], count: 2 },
          { from: "/set/a.md", to: "/set/c.md", rel: ["extends"], count: 1, edge: "frontmatter" },
        ],
      ),
      {},
    );
    expect(g.edges).toEqual([
      { from: "/set/a.md", to: "/set/b.md", source: "link", rel: [], count: 2 },
      { from: "/set/a.md", to: "/set/c.md", source: "frontmatter", rel: ["extends"], count: 1 },
    ]);
    expect(g.links).toBe(3);
  });

  test("a board's references, another app's edge kind and an edge to no node are not drawn", () => {
    const g = mapGraph(
      graphOf(
        [
          node("/set/a.md"),
          node("/set/b.md"),
          node("/set/board/board.json", { bundle: { noun: "board" } }),
        ],
        [
          { from: "/set/board/board.json", to: "/set/a.md", rel: [], count: 1, reference: true },
          { from: "/set/a.md", to: "/set/b.md", rel: [], count: 1, edge: "voice" },
          { from: "/set/a.md", to: "/elsewhere.md", rel: [], count: 1 },
        ],
      ),
      {},
    );
    expect(g.nodes.map((n) => n.path)).toEqual(["/set/a.md", "/set/b.md"]);
    expect(g.edges).toEqual([]);
    expect(g.links).toBe(0);
  });

  test("the kit's cut is counted: documents in the set the graph did not answer with", () => {
    expect(mapGraph(graphOf([node("/set/a.md")], [], 7), {}).cut).toBe(6);
    expect(mapGraph(graphOf([node("/set/a.md")]), {}).cut).toBe(0);
  });
});

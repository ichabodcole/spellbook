// The link graph as a pure function: folding, the filters in their order, the
// focus's rings, and the cut by degree. Resolution is injected, so these name
// paths as written and land them by a lookup.
import { describe, expect, test } from "bun:test";
import { extractLinks, type GraphDoc, type LinkSource, linkGraph, type Resolution } from "./links";

const doc = (path: string, kind: string | null = null): GraphDoc => ({ path, kind });

/** `/w/<name>` for every `./<name>` target, missing otherwise. */
function resolver(known: readonly string[]) {
  const set = new Set(known);
  return (raw: string): Resolution => {
    const name = raw.replace(/[?#].*$/, "").replace(/^\.\//, "");
    const path = `/w/${name}`;
    return set.has(path) ? { state: "in-context", path } : { state: "missing", tried: [path] };
  };
}

function world(texts: Record<string, string>, kinds: Record<string, string | null> = {}) {
  const paths = Object.keys(texts).map((n) => `/w/${n}`);
  const docs = paths.map((p) => doc(p, kinds[p.slice(3)] ?? null));
  const sources: LinkSource[] = paths.map((p) => ({
    path: p,
    links: extractLinks(texts[p.slice(3)] as string, { schemes: true }),
  }));
  return { docs, sources, resolve: resolver(paths) };
}

describe("linkGraph", () => {
  test("folds links with the same ends and relations, and leaves out self, scheme and dangling links", () => {
    const w = world({
      "a.md":
        "[b](./b.md?rel=sister-of,extends) [b again](./b.md?rel=extends,sister-of) [b bare](./b.md) [me](./a.md) [op](op:doc/1) [gone](./gone.md)",
      "b.md": "[a](./a.md)",
    });
    const g = linkGraph(w.docs, w.sources, w.resolve);
    expect(g.edges).toEqual([
      { from: "/w/a.md", to: "/w/b.md", rel: ["extends", "sister-of"], count: 2 },
      { from: "/w/a.md", to: "/w/b.md", rel: [], count: 1 },
      { from: "/w/b.md", to: "/w/a.md", rel: [], count: 1 },
    ]);
    expect(g.relations).toEqual([
      { rel: "extends", count: 2 },
      { rel: "sister-of", count: 2 },
    ]);
    expect(g.untyped).toBe(2);
    expect(g.nodes.find((n) => n.path === "/w/b.md")).toMatchObject({ linksIn: 3, linksOut: 1 });
    expect(g.total).toEqual({ nodes: 2, edges: 3, links: 4 });
  });

  test("a relation filter drops untyped links unless asked, and keeps an edge with any of its relations", () => {
    const w = world({
      "a.md": "[b](./b.md?rel=applies) [c](./c.md?rel=contrasts-with,mirrors) [d](./d.md)",
      "b.md": "",
      "c.md": "",
      "d.md": "",
    });
    const only = linkGraph(w.docs, w.sources, w.resolve, { rel: ["mirrors"] });
    expect(only.edges.map((e) => e.to)).toEqual(["/w/c.md"]);
    // The legend's list is what the filter chose from, not what it kept.
    expect(only.relations.map((r) => r.rel).sort()).toEqual([
      "applies",
      "contrasts-with",
      "mirrors",
    ]);
    const withBare = linkGraph(w.docs, w.sources, w.resolve, { rel: ["mirrors"], untyped: true });
    expect(withBare.edges.map((e) => e.to).sort()).toEqual(["/w/c.md", "/w/d.md"]);
    const typedOnly = linkGraph(w.docs, w.sources, w.resolve, { untyped: false });
    expect(typedOnly.edges.map((e) => e.to).sort()).toEqual(["/w/b.md", "/w/c.md"]);
    // Every document stays without a focus: a filter thins links, not the set.
    expect(typedOnly.nodes).toHaveLength(4);
  });

  test("a relation in two cases is one relation in the legend and one edge, and the filter matches either case", () => {
    const w = world({
      "a.md": "[b](./b.md?rel=Mirrors) [b again](./b.md?rel=mirrors) [c](./c.md?rel=applies)",
      "b.md": "",
      "c.md": "",
    });
    const g = linkGraph(w.docs, w.sources, w.resolve);
    expect(g.edges).toContainEqual({ from: "/w/a.md", to: "/w/b.md", rel: ["mirrors"], count: 2 });
    expect(g.relations).toEqual([
      { rel: "mirrors", count: 2 },
      { rel: "applies", count: 1 },
    ]);
    const only = linkGraph(w.docs, w.sources, w.resolve, { rel: ["MIRRORS"] });
    expect(only.edges.map((e) => e.to)).toEqual(["/w/b.md"]);
  });

  test("a kind filter drops other kinds and their links, keeps the focus, and lists every kind", () => {
    const w = world(
      { "a.md": "[b](./b.md) [c](./c.md)", "b.md": "[c](./c.md)", "c.md": "" },
      { "a.md": "location", "b.md": "location", "c.md": "rule" },
    );
    const g = linkGraph(w.docs, w.sources, w.resolve, { kind: ["location"] });
    expect(g.nodes.map((n) => n.path).sort()).toEqual(["/w/a.md", "/w/b.md"]);
    expect(g.edges).toEqual([{ from: "/w/a.md", to: "/w/b.md", rel: [], count: 1 }]);
    expect(g.kinds).toEqual([
      { kind: "location", label: "location", canon: true, count: 2 },
      { kind: "rule", label: "rule", canon: true, count: 1 },
    ]);
    const focused = linkGraph(w.docs, w.sources, w.resolve, {
      kind: ["location"],
      focus: "/w/c.md",
    });
    expect(focused.nodes.map((n) => [n.path, n.hop])).toEqual([
      ["/w/c.md", 0],
      ["/w/a.md", 1],
      ["/w/b.md", 1],
    ]);
  });

  test("documents with no kind stay without a kind filter, go with one, and kindless keeps or drops them", () => {
    const w = world(
      { "a.md": "[b](./b.md) [n](./n.md)", "b.md": "", "n.md": "" },
      { "a.md": "location", "b.md": "rule" },
    );
    const paths = (f: Parameters<typeof linkGraph>[3]) =>
      linkGraph(w.docs, w.sources, w.resolve, f)
        .nodes.map((n) => n.path)
        .sort();
    expect(paths({})).toEqual(["/w/a.md", "/w/b.md", "/w/n.md"]);
    expect(paths({ kind: ["location"] })).toEqual(["/w/a.md"]);
    expect(paths({ kind: ["location"], kindless: true })).toEqual(["/w/a.md", "/w/n.md"]);
    expect(paths({ kindless: false })).toEqual(["/w/a.md", "/w/b.md"]);
    // Every kind is still listed, the hidden ones and no kind among them.
    expect(linkGraph(w.docs, w.sources, w.resolve, { kind: [] }).kinds.map((k) => k.kind)).toEqual([
      "location",
      null,
      "rule",
    ]);
  });

  test("a kind filter runs before the cut: a hidden kind takes no place in it", () => {
    // Three well-linked rules and two leaf locations; a cut of 2 with rules hidden
    // must still give both locations.
    const w = world(
      {
        "r1.md": "[r2](./r2.md) [r3](./r3.md) [l1](./l1.md)",
        "r2.md": "[r3](./r3.md) [r1](./r1.md)",
        "r3.md": "[r1](./r1.md)",
        "l1.md": "",
        "l2.md": "",
      },
      {
        "r1.md": "rule",
        "r2.md": "rule",
        "r3.md": "rule",
        "l1.md": "location",
        "l2.md": "location",
      },
    );
    const all = linkGraph(w.docs, w.sources, w.resolve, { limit: 2 });
    expect(all.nodes.every((n) => n.kind === "rule")).toBe(true);
    const g = linkGraph(w.docs, w.sources, w.resolve, { kind: ["location"], limit: 2 });
    expect(g.nodes.map((n) => n.path).sort()).toEqual(["/w/l1.md", "/w/l2.md"]);
    expect(g.total.nodes).toBe(2);
  });

  test("a kind carries its documents' label, and is not canon only when none of them is", () => {
    const w = world({ "a.md": "", "b.md": "", "c.md": "" });
    const docs = [
      { path: "/w/a.md", kind: "guide", label: "Guide", canon: false },
      { path: "/w/b.md", kind: "guide", label: "Guide", canon: false },
      { path: "/w/c.md", kind: "location", label: "Location", canon: true },
    ];
    const g = linkGraph(docs, w.sources, w.resolve);
    expect(g.kinds).toEqual([
      { kind: "guide", label: "Guide", canon: false, count: 2 },
      { kind: "location", label: "Location", canon: true, count: 1 },
    ]);
    // The shallowest profile's label wins, whatever order the documents come in.
    const nested = linkGraph(
      [
        { path: "/w/a.md", kind: "location", label: "Wild place", labelDepth: 5 },
        { path: "/w/b.md", kind: "location", label: "Location", labelDepth: 3 },
        { path: "/w/c.md", kind: "location" },
      ],
      w.sources,
      w.resolve,
    );
    expect(nested.kinds[0]?.label).toBe("Location");
    expect(g.nodes.find((n) => n.path === "/w/a.md")).toMatchObject({
      label: "Guide",
      canon: false,
    });
  });

  test("a focus keeps what is within its hops, either way, nearest first", () => {
    const w = world({
      "a.md": "[b](./b.md)",
      "b.md": "[c](./c.md)",
      "c.md": "[d](./d.md)",
      "d.md": "",
      "lone.md": "",
    });
    const one = linkGraph(w.docs, w.sources, w.resolve, { focus: "/w/b.md" });
    expect(one.nodes.map((n) => [n.path, n.hop])).toEqual([
      ["/w/b.md", 0],
      ["/w/a.md", 1],
      ["/w/c.md", 1],
    ]);
    expect(one.edges).toHaveLength(2);
    const two = linkGraph(w.docs, w.sources, w.resolve, { focus: "/w/b.md", hops: 2 });
    expect(two.nodes.map((n) => n.path)).toContain("/w/d.md");
    expect(two.nodes.map((n) => n.path)).not.toContain("/w/lone.md");
    const none = linkGraph(w.docs, w.sources, w.resolve, { focus: "/w/b.md", hops: 0 });
    expect(none.nodes.map((n) => n.path)).toEqual(["/w/b.md"]);
    expect(none.edges).toEqual([]);
  });

  test("with a focus, the legend counts the neighbourhood's links, hidden relations included", () => {
    const w = world({
      "a.md": "[b](./b.md?rel=applies) [c](./c.md?rel=mirrors) [c](./c.md)",
      "b.md": "",
      "c.md": "",
      "far.md": "[d](./d.md?rel=contrasts-with)",
      "d.md": "",
    });
    const g = linkGraph(w.docs, w.sources, w.resolve, { focus: "/w/a.md", rel: ["applies"] });
    // The world's contrasts-with is not in the neighbourhood; mirrors is, though hidden.
    expect(g.relations).toEqual([
      { rel: "applies", count: 1 },
      { rel: "mirrors", count: 1 },
    ]);
    expect(g.untyped).toBe(1);
    expect(g.nodes.map((n) => n.path)).toEqual(["/w/a.md", "/w/b.md"]);
    expect(g.total).toEqual({ nodes: 2, edges: 1, links: 1 });
  });

  test("the cut keeps the best connected, not the first in path order, and says what passed", () => {
    // The leaf document sorts first and links nowhere; the hub sorts last and is linked from everything.
    const texts: Record<string, string> = { "a-leaf.md": "", "z-hub.md": "" };
    for (let i = 0; i < 5; i++) texts[`m${i}.md`] = "[hub](./z-hub.md)";
    const w = world(texts);
    const g = linkGraph(w.docs, w.sources, w.resolve, { limit: 3 });
    expect(g.nodes[0]?.path).toBe("/w/z-hub.md");
    expect(g.nodes.map((n) => n.path)).not.toContain("/w/a-leaf.md");
    expect(g.total).toEqual({ nodes: 7, edges: 5, links: 5 });
    // Edges only between the kept documents.
    expect(g.edges).toHaveLength(2);
    for (const e of g.edges) expect(g.nodes.map((n) => n.path)).toContain(e.from);
  });

  test("a link whose name matches no document is passed over without resolving", () => {
    const w = world({ "a.md": "[x](./nowhere.md) [b](./b.md)", "b.md": "" });
    const asked: string[] = [];
    linkGraph(w.docs, w.sources, (raw) => {
      asked.push(raw);
      return w.resolve(raw);
    });
    expect(asked).toEqual(["./b.md"]);
  });
});

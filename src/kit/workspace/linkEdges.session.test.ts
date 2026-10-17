// The app's link slot (kit-link-edges-slot) over a real session and disk:
// app edges with a kind in the graph, backlinks and the link check, each
// filterable by kind; an app resolver tried after the kit's; edges that follow
// the frontmatter through an edit, a new version and a change on disk; and
// body links exactly as they were without the slot.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AppEdge, BODY_LINKS, type LinkSlot, readEdges } from "./linkEdges";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

/** A concept graph's edges: each name under `concepts:` is an edge of kind `concept`. */
const conceptEdges: NonNullable<LinkSlot["edges"]> = ({ frontmatter }) => {
  const list = frontmatter?.concepts;
  return Array.isArray(list)
    ? list.map((t, i): AppEdge => ({ kind: "concept", target: String(t), key: `concepts[${i}]` }))
    : [];
};

/** An alias form: `@name` names `<root>/aliases/<name>.md`. */
const aliasResolver: NonNullable<LinkSlot["resolve"]> = ({ target, root: r }) =>
  target.startsWith("@") ? [join(r, "aliases", target)] : undefined;

beforeEach(() => {
  root = tempRoot("link-edges");
  world = join(root, "world");
  mkdirSync(join(world, "aliases"), { recursive: true });
  writeFileSync(
    join(world, "glade.md"),
    "---\ntitle: The Glade\nconcepts: [./ruin.md, ./gone.md]\n---\n# The Glade\n\nSee [the ruin](./ruin.md?rel=near).\n",
  );
  writeFileSync(join(world, "ruin.md"), "---\ntitle: The Ruin\n---\n# The Ruin\n");
  writeFileSync(join(world, "notes.md"), "# Notes\n\n[[@well]] and [glade](./glade.md).\n");
  writeFileSync(join(world, "aliases", "@well.md"), "# The Well\n");
  s = inContext(join(root, "sessions"), world);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(world, rel);

describe("without the slot, nothing changes", () => {
  test("the answers carry no edge fields at all", () => {
    const g = s.linkGraph();
    expect("edgeKinds" in g).toBe(false);
    expect(g.edges.every((e) => !("edge" in e))).toBe(true);
    const b = s.backlinks(at("ruin.md"));
    expect("edges" in b).toBe(false);
    expect("edgeCount" in b).toBe(false);
    expect("edges" in s.linkCheck()).toBe(false);
  });

  test("setting the slot to nothing answers byte for byte as before", () => {
    const before = JSON.stringify([s.linkGraph(), s.backlinks(at("ruin.md")), s.linkCheck()]);
    s.setLinkSlot({});
    expect(JSON.stringify([s.linkGraph(), s.backlinks(at("ruin.md")), s.linkCheck()])).toBe(before);
  });
});

describe("app edges with a kind", () => {
  beforeEach(() => s.setLinkSlot({ edges: conceptEdges }));

  test("the graph carries them apart from body links, with the kinds counted", () => {
    const g = s.linkGraph();
    expect(g.edges).toContainEqual({
      from: at("glade.md"),
      to: at("ruin.md"),
      rel: ["near"],
      count: 1,
    });
    expect(g.edges).toContainEqual({
      from: at("glade.md"),
      to: at("ruin.md"),
      rel: [],
      count: 1,
      edge: "concept",
    });
    expect(g.edgeKinds).toEqual([
      { kind: BODY_LINKS, count: 2 },
      { kind: "concept", count: 1 },
    ]);
    expect(g.total.links).toBe(3);
  });

  test("graph --edge keeps the kinds named, `link` naming the body links", () => {
    const only = s.linkGraph({ edge: ["concept"] });
    expect(only.edges).toEqual([
      { from: at("glade.md"), to: at("ruin.md"), rel: [], count: 1, edge: "concept" },
    ]);
    // The legend still names what the filter hides.
    expect(only.edgeKinds?.map((k) => k.kind)).toEqual([BODY_LINKS, "concept"]);
    const body = s.linkGraph({ edge: [BODY_LINKS] });
    expect(body.edges.some((e) => e.edge !== undefined)).toBe(false);
    expect(body.edges).toHaveLength(2);
    expect(s.linkGraph({ edge: ["nope"] }).warnings).toContain(
      "edge: no link is of kind nope; the edge kinds are link, concept",
    );
  });

  test("backlinks lists them apart, with the key that carries them, and filters by kind", () => {
    const b = s.backlinks(at("ruin.md"));
    expect(b.count).toBe(1);
    expect(b.backlinks.map((l) => l.raw)).toEqual(["./ruin.md?rel=near"]);
    expect(b.edges).toEqual([
      {
        source: at("glade.md"),
        name: "glade.md",
        shown: "glade.md",
        edge: "concept",
        raw: "./ruin.md",
        key: "concepts[0]",
        rel: [],
      },
    ]);
    expect(b.edgeCount).toBe(1);
    const edgesOnly = s.backlinks(at("ruin.md"), { edge: ["concept"] });
    expect(edgesOnly.backlinks).toEqual([]);
    expect(edgesOnly.edges).toHaveLength(1);
    const linksOnly = s.backlinks(at("ruin.md"), { edge: [BODY_LINKS] });
    expect(linksOnly.backlinks).toHaveLength(1);
    expect(linksOnly.edges).toEqual([]);
  });

  test("the link check reports an edge nothing answers, counted, and filters by kind", () => {
    const c = s.linkCheck();
    expect(c.edges).toEqual({
      count: 1,
      kinds: ["concept"],
      links: [
        {
          source: at("glade.md"),
          name: "glade.md",
          shown: "glade.md",
          edge: "concept",
          raw: "./gone.md",
          key: "concepts[1]",
          tried: [at("gone.md")],
        },
      ],
    });
    // `[[@well]]` names nothing the kit can find: one dangling body link.
    expect(c.dangling.count).toBe(1);
    expect(c.count).toBe(2);
    const edgesOnly = s.linkCheck({ edge: ["concept"] });
    expect(edgesOnly.dangling.count).toBe(0);
    expect(edgesOnly.count).toBe(1);
    const linksOnly = s.linkCheck({ edge: [BODY_LINKS] });
    expect(linksOnly.edges?.count).toBe(0);
    expect(linksOnly.dangling.count).toBe(1);
    expect(linksOnly.count).toBe(1);
  });

  test("an edge to itself is no edge, as a link to itself is none", () => {
    writeFileSync(at("ruin.md"), "---\nconcepts: [./ruin.md]\n---\n# The Ruin\n");
    expect(s.linkGraph().edges.some((e) => e.from === e.to)).toBe(false);
    expect(s.backlinks(at("ruin.md")).edges?.map((e) => e.source)).toEqual([at("glade.md")]);
  });
});

describe("edges stay current with the frontmatter", () => {
  beforeEach(() => s.setLinkSlot({ edges: conceptEdges }));
  const conceptTargets = () =>
    s
      .linkGraph({ edge: ["concept"] })
      .edges.map((e) => basename(e.to))
      .sort();

  test("the human's edit to a held document's active version", () => {
    expect(conceptTargets()).toEqual(["ruin.md"]);
    const { slug } = s.openPath(at("glade.md"));
    const d = s.findDoc(slug);
    if (!d) throw new Error("not held");
    s.edit(slug, d.active, "---\nconcepts: [./notes.md]\n---\n# The Glade\n");
    expect(conceptTargets()).toEqual(["notes.md"]);
    // And through Save to the file, which is what an unheld reader sees.
    s.save(slug);
    expect(conceptTargets()).toEqual(["notes.md"]);
  });

  test("an agent's new version, once active", () => {
    const { slug } = s.openPath(at("glade.md"));
    const v = s.newVersion({
      doc: slug,
      body: "---\nconcepts: [./notes.md, ./ruin.md]\n---\n# The Glade\n",
      by: "agent",
    });
    // Not active yet: the graph reads the active version.
    expect(conceptTargets()).toEqual(["ruin.md"]);
    s.activate({ doc: slug, version: v.version.n });
    expect(conceptTargets()).toEqual(["notes.md", "ruin.md"]);
  });

  test("a change on disk, even one that keeps the size and puts the mtime back", () => {
    expect(conceptTargets()).toEqual(["ruin.md"]);
    const file = at("glade.md");
    const st = statSync(file);
    // Same length: `./ruin.md, ./gone.md` becomes `./notes.md, ./gon.md`.
    writeFileSync(
      file,
      "---\ntitle: The Glade\nconcepts: [./notes.md, ./gon.md]\n---\n# The Glade\n\nSee [the ruin](./ruin.md?rel=near).\n",
    );
    utimesSync(file, st.atime, st.mtime);
    expect(statSync(file).size).toBe(st.size);
    expect(conceptTargets()).toEqual(["notes.md"]);
    expect(s.backlinks(at("ruin.md")).edges).toEqual([]);
    expect(s.backlinks(at("notes.md")).edges?.map((e) => e.key)).toEqual(["concepts[0]"]);
  });
});

describe("the app's resolver", () => {
  test("is tried after the kit's, and only when the kit finds no file", () => {
    const asked: string[] = [];
    s.setLinkSlot({
      resolve: (input) => {
        asked.push(input.target);
        return aliasResolver(input);
      },
    });
    expect(s.backlinks(at("aliases/@well.md")).backlinks.map((l) => l.raw)).toEqual(["@well"]);
    expect(s.linkCheck().dangling.count).toBe(0);
    expect(s.resolveLink("@well", s.openPath(at("notes.md")).slug)).toEqual({
      state: "in-context",
      path: at("aliases/@well.md"),
    });
    // Every link the kit answers on its own never reached the app.
    expect(asked.every((t) => t === "@well")).toBe(true);
  });

  test("a miss it cannot answer either says where both looked", () => {
    s.setLinkSlot({ resolve: aliasResolver });
    const r = s.resolveLink("@nobody", s.openPath(at("notes.md")).slug);
    expect(r).toEqual({
      state: "missing",
      tried: [at("@nobody.md"), at("aliases/@nobody.md")],
    });
  });

  test("one that throws answers nothing, and nothing else breaks", () => {
    s.setLinkSlot({
      resolve: () => {
        throw new Error("boom");
      },
    });
    expect(s.resolveLink("@well", s.openPath(at("notes.md")).slug).state).toBe("missing");
    expect(s.linkCheck().dangling.count).toBe(1);
  });

  test("hands every target in one answer the same documents, with their frontmatter", () => {
    const seen = new Set<unknown>();
    s.setLinkSlot({
      resolve: ({ documents }) => {
        const docs = documents();
        seen.add(docs);
        expect(docs.find((d) => d.path === at("glade.md"))?.frontmatter?.title).toBe("The Glade");
        return undefined;
      },
    });
    writeFileSync(at("more.md"), "[[@a]] [[@b]] [[@c]]\n");
    s.linkCheck();
    expect(seen.size).toBe(1);
  });
});

describe("what an app hands over is checked, not trusted", () => {
  const doc = { path: "/w/x.md", text: "", frontmatter: null };
  test("an edge with a bad kind, `link`, or no target is left out", () => {
    const got = readEdges(
      {
        edges: () => [
          { kind: "Bad Kind", target: "./a.md" },
          { kind: BODY_LINKS, target: "./a.md" },
          { kind: "ok", target: "  " },
          { kind: "ok", target: " ./a.md ", rel: ["Near", "near"], line: 0 },
        ],
      },
      doc,
    );
    expect(got).toEqual([{ kind: "ok", target: "./a.md", rel: ["near"] }]);
  });

  test("an edges function that throws gives that document none, and the graph still answers", () => {
    expect(
      readEdges(
        {
          edges: () => {
            throw new Error("boom");
          },
        },
        doc,
      ),
    ).toEqual([]);
    s.setLinkSlot({
      edges: () => {
        throw new Error("boom");
      },
    });
    expect(s.linkGraph().total.links).toBe(2);
  });
});

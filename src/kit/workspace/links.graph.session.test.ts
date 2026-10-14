// The link graph over a real session and disk: titles and kinds from the
// frontmatter, the active version read rather than the saved file, a folder's
// graph, the refusals, and the daemon's `link.graph` frame.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { FakeSurface, waitUntil } from "./fixtures/harness";
import type { ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import type { WorkspaceSession } from "./session";
import { inContext, refusal, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

beforeEach(() => {
  root = tempRoot("link-graph");
  world = join(root, "bible");
  mkdirSync(join(world, "locations"), { recursive: true });
  writeFileSync(
    join(world, "03-cosmology.md"),
    "---\ntitle: Cosmology\ntype: foundation\nstatus: stable\n---\n# The shape of things\n",
  );
  writeFileSync(
    join(world, "locations", "the-cave.md"),
    [
      "---",
      "type: location",
      "---",
      "# The Cave",
      "",
      "Applies [cosmology](../03-cosmology.md?rel=applies); mirrors [the Stair](./the-stair.md?rel=mirrors).",
    ].join("\n"),
  );
  writeFileSync(
    join(world, "locations", "the-stair.md"),
    "---\ntype: location\n---\n# The Stair\n\nBack to [the Cave](./the-cave.md?rel=mirrors).\n",
  );
  writeFileSync(
    join(world, "notes.md"),
    "No frontmatter, no heading, [cave](./locations/the-cave.md).\n",
  );
  s = inContext(join(root, "sessions"), world);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(world, rel);

describe("linkGraph on a session", () => {
  test("nodes carry title, kind (the frontmatter type) and status; edges carry relations", () => {
    const g = s.linkGraph();
    const byPath = new Map(g.nodes.map((n) => [n.path, n]));
    expect(byPath.get(at("03-cosmology.md"))).toMatchObject({
      name: "03-cosmology.md",
      shown: "03-cosmology.md",
      title: "Cosmology",
      kind: "foundation",
      status: "stable",
      linksIn: 1,
      linksOut: 0,
    });
    expect(byPath.get(at("locations/the-cave.md"))).toMatchObject({
      shown: "locations/the-cave.md",
      title: "The Cave",
      kind: "location",
    });
    expect(byPath.get(at("notes.md"))).toMatchObject({ title: "notes", kind: null });
    expect(byPath.get(at("notes.md"))?.status).toBeUndefined();
    expect(g.edges).toContainEqual({
      from: at("locations/the-cave.md"),
      to: at("03-cosmology.md"),
      rel: ["applies"],
      count: 1,
    });
    expect(g.relations).toEqual([
      { rel: "mirrors", count: 2 },
      { rel: "applies", count: 1 },
    ]);
    expect(g.untyped).toBe(1);
    expect(g.kinds).toEqual([
      { kind: "location", label: "location", canon: true, count: 2 },
      { kind: "foundation", label: "foundation", canon: true, count: 1 },
      { kind: null, label: null, canon: true, count: 1 },
    ]);
    // No profiles: every node is canon, labelled by its raw type.
    expect(g.nodes.every((n) => n.canon && n.label === n.kind)).toBe(true);
    expect(g.focus).toBeNull();
    expect(g.truncated).toBeUndefined();
  });

  test("a focus by path or held name, a kind filter, a folder, and the cut", () => {
    const f = s.linkGraph({ focus: at("03-cosmology.md") });
    expect(f.focus).toBe(at("03-cosmology.md"));
    expect(f.nodes.map((n) => [n.name, n.hop])).toEqual([
      ["03-cosmology.md", 0],
      ["the-cave.md", 1],
    ]);
    const k = s.linkGraph({ kind: ["location"] });
    expect(k.nodes.map((n) => n.name).sort()).toEqual(["the-cave.md", "the-stair.md"]);
    const w = s.linkGraph({ within: at("locations") });
    expect(w.nodes.map((n) => n.name).sort()).toEqual(["the-cave.md", "the-stair.md"]);
    expect(w.edges.every((e) => e.rel.includes("mirrors"))).toBe(true);
    const cut = s.linkGraph({ limit: 1 });
    expect(cut.nodes.map((n) => n.name)).toEqual(["the-cave.md"]);
    expect(cut).toMatchObject({ truncated: true, total: { nodes: 4 } });
  });

  test("reads a held document's ACTIVE version, and re-reads it after an edit", () => {
    const { slug } = s.openPath(at("notes.md"));
    expect(s.linkGraph({ focus: slug }).nodes.map((n) => n.name)).toEqual([
      "notes.md",
      "the-cave.md",
    ]);
    const v = s.doc(slug).versions[0]?.path as string;
    writeFileSync(
      v,
      "---\ntitle: Field notes\ntype: note\n---\nNow [the Stair](./locations/the-stair.md?rel=visits).\n",
    );
    const g = s.linkGraph({ focus: slug });
    expect(g.nodes[0]).toMatchObject({ title: "Field notes", kind: "note" });
    expect(g.nodes.map((n) => n.name)).toEqual(["notes.md", "the-stair.md"]);
    expect(g.edges).toEqual([
      { from: at("notes.md"), to: at("locations/the-stair.md"), rel: ["visits"], count: 1 },
    ]);
  });

  test("a filter that matches nothing says so in warnings, and a clean one has none", () => {
    expect(s.linkGraph().warnings).toBeUndefined();
    expect(s.linkGraph({ kind: ["location"], rel: ["mirrors"] }).warnings).toBeUndefined();
    const kind = s.linkGraph({ kind: ["nosuch"] });
    expect(kind.total.nodes).toBe(0);
    expect(kind.warnings).toEqual([
      "kind: no document is of kind nosuch; the kinds are location, foundation",
      "the filter left no document",
    ]);
    expect(s.linkGraph({ rel: ["nosuch"] }).warnings).toEqual([
      "rel: no link in view carries nosuch; the relations in view are mirrors, applies",
    ]);
    expect(s.linkGraph({ within: join(root, "elsewhere") }).warnings).toEqual([
      `within: no document in the session is under ${join(root, "elsewhere")}`,
      "the filter left no document",
    ]);
  });

  test("refuses a focus outside the session, hops past three, a zero limit and a relative folder", () => {
    expect(refusal(() => s.linkGraph({ focus: "nope.md" })).status).toBe(404);
    expect(refusal(() => s.linkGraph({ hops: 4 })).status).toBe(400);
    expect(refusal(() => s.linkGraph({ limit: 0 })).status).toBe(400);
    expect(refusal(() => s.linkGraph({ within: "locations" })).status).toBe(400);
  });
});

describe("link.graph over the daemon", () => {
  let daemon: WorkspaceDaemon;
  let surface: FakeSurface;

  beforeEach(async () => {
    const tmp = join(root, "tmp");
    mkdirSync(tmp, { recursive: true });
    process.env.KIT_FIXTURE_HOME = join(root, "home");
    daemon = fixtureDaemon({ tmp, platform: "darwin", reveal: () => {} });
    await daemon.start();
    surface = new FakeSurface();
    await surface.connect(daemon.port);
    surface.send({ op: "context.add", path: world });
    await waitUntil("context", () => surface.state.context.length === 1);
  });
  afterEach(async () => {
    surface.close();
    await daemon.stop();
  });

  const ask = async (frame: Record<string, unknown>, id: string) => {
    surface.send({ op: "link.graph", ...frame, rid: id } as never);
    return (await surface.waitFor(
      (m) =>
        (m.op === "link.graph" || m.op === "error") &&
        (m as { requestId?: unknown }).requestId === id,
    )) as ServerOp;
  };

  test("answers the filtered graph to the asking surface, and refuses a malformed filter", async () => {
    const r = await ask({ rel: ["mirrors"] }, "g1");
    expect(r.op).toBe("link.graph");
    const g = r as Extract<ServerOp, { op: "link.graph" }>;
    expect(g.edges.map((e) => e.rel)).toEqual([["mirrors"], ["mirrors"]]);
    expect(g.nodes).toHaveLength(4);
    const bad = await ask({ rel: "mirrors" }, "g2");
    expect(bad).toMatchObject({ op: "error" });
    expect((bad as { message: string }).message).toContain("rel must be a list");
  });
});

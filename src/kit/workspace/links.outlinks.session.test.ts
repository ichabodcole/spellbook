// What a report about one document reads from the session (atlas-impact-check
// added them as kit primitives): the links it writes and where each lands, its
// text as the session holds it, and any documents' kinds as the profiles say.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSession } from "./session";
import { inContext, refusal, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;
const at = (rel: string) => join(world, rel);

beforeEach(() => {
  root = tempRoot("outlinks");
  world = join(root, "bible");
  mkdirSync(join(world, "_meta", "profiles"), { recursive: true });
  mkdirSync(join(world, "locations"), { recursive: true });
  writeFileSync(
    join(world, "_meta", "profiles", "guide.json"),
    JSON.stringify({ kind: "guide", label: "Guide", canon: false }),
  );
  writeFileSync(
    join(world, "_meta", "profiles", "location.json"),
    JSON.stringify({ kind: "location", label: "Location" }),
  );
  writeFileSync(
    at("00-orientation.md"),
    "---\ntype: guide\ntitle: Orientation\nstatus: stable\n---\n# Start here\n",
  );
  writeFileSync(at("locations/the-cave.md"), "---\ntype: location\n---\n# The Cave\n");
  writeFileSync(join(root, "outside.md"), "# Outside\n");
  writeFileSync(
    at("index.md"),
    [
      "# Index",
      "",
      "[the Cave](./locations/the-cave.md?rel=contrasts-with) and [gone](./gone.md)",
      "[a note](op:doc/abc) and [the web](https://example.com)",
      "[out](../outside.md) and [folder](./locations)",
      "```",
      "[in code](./nowhere.md)",
      "```",
    ].join("\n"),
  );
  s = inContext(join(root, "sessions"), world);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("outlinks", () => {
  test("each link the document writes, in order, with where it landed", () => {
    const o = s.outlinks(at("index.md"));
    expect(o).toMatchObject({ path: at("index.md"), shown: "index.md", version: null, count: 6 });
    expect(o.links.map((l) => [l.line, l.raw, l.state, l.path ?? l.scheme ?? null])).toEqual([
      [3, "./locations/the-cave.md?rel=contrasts-with", "in-context", at("locations/the-cave.md")],
      [3, "./gone.md", "missing", null],
      [4, "op:doc/abc", "scheme", "op"],
      [4, "https://example.com", "scheme", "https"],
      [5, "../outside.md", "outside", join(root, "outside.md")],
      [5, "./locations", "folder", at("locations")],
    ]);
    expect(o.links[0]?.rel).toEqual(["contrasts-with"]);
    expect(o.links[2]?.outward).toBe(false);
    expect(o.links[3]?.outward).toBe(true);
  });

  test("reads the active version, or a held version asked for; a version of a document not held is refused", () => {
    expect(refusal(() => s.outlinks(at("index.md"), 1)).status).toBe(404);
    const { slug } = s.openPath(at("index.md"));
    const v2 = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(v2.version.path, "# Index\n\n[orientation](./00-orientation.md)\n");
    expect(s.outlinks(slug).links).toHaveLength(6);
    const two = s.outlinks(slug, v2.version.n);
    expect(two.version).toBe(v2.version.n);
    expect(two.links.map((l) => l.path)).toEqual([at("00-orientation.md")]);
    expect(refusal(() => s.outlinks(slug, 99)).status).toBe(404);
  });
});

describe("documentText", () => {
  test("the file for a document not held, the active version for one held, a held version when asked", () => {
    expect(s.documentText(at("locations/the-cave.md"))).toEqual({
      path: at("locations/the-cave.md"),
      shown: "locations/the-cave.md",
      version: null,
      text: "---\ntype: location\n---\n# The Cave\n",
    });
    const { slug } = s.openPath(at("locations/the-cave.md"));
    s.edit(slug, 1, "# The Cave, edited\n");
    expect(s.documentText(slug).text).toBe("# The Cave, edited\n");
    const v2 = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(v2.version.path, "# The Cave, proposed\n");
    expect(s.documentText(slug).text).toBe("# The Cave, edited\n");
    expect(s.documentText(slug, v2.version.n)).toMatchObject({
      version: 2,
      text: "# The Cave, proposed\n",
    });
    expect(refusal(() => s.documentText(at("nope.md"))).status).toBe(404);
  });
});

describe("summaries", () => {
  test("each document's title and kind as the profiles say, a non-canon kind marked; other paths dropped", () => {
    const got = s.summaries([
      at("00-orientation.md"),
      at("locations/the-cave.md"),
      at("index.md"),
      join(root, "outside.md"),
      at("locations/the-cave.md"),
      "relative.md",
    ]);
    expect(got).toEqual([
      {
        path: at("00-orientation.md"),
        name: "00-orientation.md",
        shown: "00-orientation.md",
        title: "Orientation",
        kind: "guide",
        label: "Guide",
        canon: false,
        status: "stable",
      },
      {
        path: at("locations/the-cave.md"),
        name: "the-cave.md",
        shown: "locations/the-cave.md",
        title: "The Cave",
        kind: "location",
        label: "Location",
        canon: true,
      },
      {
        path: at("index.md"),
        name: "index.md",
        shown: "index.md",
        title: "Index",
        kind: null,
        label: null,
        canon: true,
      },
    ]);
  });
});

describe("searchEach", () => {
  test("one report per query, as search gives it, reading each document once for all of them", () => {
    const { slug } = s.openPath(at("locations/the-cave.md"));
    s.edit(slug, 1, "# The Cave\n\nA lantern, unsaved.\n");
    const reads = spyOn(fs, "readFileSync");
    try {
      const [cave, start] = s.searchEach({ queries: ["lantern", "start here"], limit: 50 });
      const files = reads.mock.calls.filter(([p]) => typeof p === "string" && p.endsWith(".md"));
      // The three markdown documents (the Cave from its held version), each read
      // once for both queries.
      expect(files).toHaveLength(3);
      expect(new Set(files.map(([p]) => p)).size).toBe(3);
      expect(cave?.results.map((r) => [r.kind, r.path, r.line])).toEqual([
        ["text", at("locations/the-cave.md"), 3],
      ]);
      expect(start).toEqual(s.search({ query: "start here", limit: 50 }));
    } finally {
      reads.mockRestore();
    }
    expect(refusal(() => s.searchEach({ queries: ["ok", " "] })).status).toBe(400);
  });
});

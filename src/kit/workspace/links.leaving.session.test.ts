// The link check's "leaving the set" (kit-broken-links-visible): links and app
// edges that land outside the set they are written in, apart from the broken
// ones and out of `count`; and every entry naming its set, so the human's list
// can group by set.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEdge, LinkSlot } from "./linkEdges";
import { locateEdges } from "./linkEdges";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let lore: string;
let s: WorkspaceSession;

/** `related:` names are edges of kind `frontmatter`, as Scriptorium reads them. */
const related: NonNullable<LinkSlot["edges"]> = ({ frontmatter }) => {
  const list = frontmatter?.related;
  return Array.isArray(list)
    ? list.map((t): AppEdge => ({ kind: "frontmatter", target: String(t), key: "related" }))
    : [];
};

const GLADE = [
  "---",
  "title: The Glade",
  "related: [./ruin.md, ./ghost.md, ../lore/myth.md]",
  "---",
  "# The Glade",
  "",
  "See [the ruin](./ruin.md), [the myth](../lore/myth.md), [the code](../src/tool.ts),",
  "[a ghost](./gone.md), [the map](./images/map.png), [the data](./data.csv) and [the folder](./places/).",
  "",
].join("\n");

beforeEach(() => {
  root = tempRoot("link-leaving");
  world = join(root, "world");
  lore = join(root, "lore");
  mkdirSync(join(world, "images"), { recursive: true });
  mkdirSync(join(world, "places"), { recursive: true });
  mkdirSync(lore, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(world, "glade.md"), GLADE);
  writeFileSync(join(world, "ruin.md"), "# The Ruin\n");
  writeFileSync(join(world, "images", "map.png"), "png");
  // A file no document view opens, in the set's own folder: it does not leave.
  writeFileSync(join(world, "data.csv"), "a,b\n");
  writeFileSync(join(lore, "myth.md"), "# The Myth\n\nBack to [the glade](../world/glade.md).\n");
  writeFileSync(join(root, "src", "tool.ts"), "export {};\n");
  s = inContext(join(root, "sessions"), world);
  s.addContext(lore);
  s.setLinkSlot({ edges: related });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ids = () => ({ world: s.context[0]?.id, lore: s.context[1]?.id });

describe("leaving the set", () => {
  test("lists links and edges that land in another set or in none, each opening at its place", () => {
    const c = s.linkCheck();
    const { world: w, lore: l } = ids();
    expect(c.leaving?.count).toBe(4);
    expect(
      c.leaving?.links.map((x) => [x.shown, x.raw, x.edge ?? "link", x.targetShown, x.targetSet]),
    ).toEqual([
      ["glade.md", "../lore/myth.md", "frontmatter", "myth.md", "lore"],
      ["glade.md", "../lore/myth.md", "link", "myth.md", "lore"],
      ["glade.md", "../src/tool.ts", "link", "../src/tool.ts", undefined],
      ["myth.md", "../world/glade.md", "link", "glade.md", "world"],
    ]);
    // Each names the set it is written in, and where it is written.
    expect(c.leaving?.links.map((x) => x.set)).toEqual([w, w, w, l]);
    const edge = c.leaving?.links[0];
    expect(edge?.line).toBe(3);
    expect(edge && GLADE.slice(edge.from ?? 0, edge.to ?? 0)).toBe("../lore/myth.md");
    const body = c.leaving?.links[1];
    expect(body?.line).toBe(7);
    expect(body && GLADE.slice(body.from ?? 0, body.to ?? 0)).toBe("[the myth](../lore/myth.md)");
  });

  test("not counted as a problem, and an image, a folder or a link inside the set never leaves", () => {
    const c = s.linkCheck();
    // The broken body link and the broken frontmatter reference; leaving adds nothing.
    expect(c.dangling.links.map((x) => x.raw)).toEqual(["./gone.md"]);
    expect(c.edges?.links.map((x) => x.raw)).toEqual(["./ghost.md"]);
    expect(c.count).toBe(2);
    const raws = c.leaving?.links.map((x) => x.raw) ?? [];
    for (const inside of ["./ruin.md", "./images/map.png", "./data.csv", "./places/"])
      expect(raws).not.toContain(inside);
  });

  test("the edge filter keeps leaving links of the kinds it names", () => {
    expect(s.linkCheck({ edge: ["frontmatter"] }).leaving?.links.map((x) => x.edge)).toEqual([
      "frontmatter",
    ]);
    expect(s.linkCheck({ edge: ["link"] }).leaving?.links.every((x) => x.edge === undefined)).toBe(
      true,
    );
  });

  test("a broken frontmatter reference opens at its line", () => {
    const e = s.linkCheck().edges?.links[0];
    expect(e?.line).toBe(3);
    expect(e && GLADE.slice(e.from ?? 0, e.to ?? 0)).toBe("./ghost.md");
  });
});

describe("grouped by set", () => {
  test("each entry names its set, and `sets` lists those named, in the context's order", () => {
    const c = s.linkCheck();
    const { world: w, lore: l } = ids();
    expect(c.sets).toEqual([
      { id: w as string, label: "world" },
      { id: l as string, label: "lore" },
    ]);
    expect(c.dangling.links[0]?.set).toBe(w);
    expect(c.edges?.links[0]?.set).toBe(w);
  });

  test("a set with nothing to report is not listed", () => {
    writeFileSync(join(lore, "myth.md"), "# The Myth\n");
    expect(s.linkCheck().sets?.map((x) => x.label)).toEqual(["world"]);
  });
});

describe("locateEdges", () => {
  test("finds a target whole, in the frontmatter, each repeat taking the next place", () => {
    const text = "---\nrelated: [ruin-two, ruin, ruin]\n---\nruin in the body\n";
    const spots = locateEdges(text, [
      { kind: "f", target: "ruin" },
      { kind: "f", target: "ruin" },
      { kind: "f", target: "ruin-two" },
    ]);
    expect(spots.map((x) => x && text.slice(x.from, x.to))).toEqual(["ruin", "ruin", "ruin-two"]);
    expect(spots[0]?.from).toBe(text.indexOf("ruin,"));
    expect(spots[1]?.from).toBe(text.indexOf("ruin]"));
    expect(spots.map((x) => x?.line)).toEqual([2, 2, 2]);
  });

  test("searches from the line of the edge's own key, past the same name in an earlier field", () => {
    const text =
      "---\ntitle: Sentence\nsummary: Moved from notes/ghost.md, see there.\nrelated: [notes/ghost.md]\nsources:\n  resource: notes/ghost.md\n---\n";
    const spots = locateEdges(text, [
      { kind: "f", target: "notes/ghost.md", key: "related" },
      { kind: "f", target: "notes/ghost.md", key: "sources.resource" },
      { kind: "f", target: "notes/ghost.md", key: "nowhere" },
    ]);
    expect(spots.map((x) => x?.line)).toEqual([4, 6, 3]);
    expect(spots[0]?.from).toBe(text.indexOf("[notes/ghost.md]") + 1);
  });

  test("a target not in the frontmatter is not found in the body; the app's line wins", () => {
    const text = "---\ntitle: x\n---\nghost\n";
    expect(locateEdges(text, [{ kind: "f", target: "ghost" }])).toEqual([undefined]);
    expect(locateEdges(text, [{ kind: "f", target: "ghost", line: 4 }])).toEqual([
      { line: 4, from: text.indexOf("ghost"), to: text.indexOf("ghost") + 5 },
    ]);
  });
});

// The link check's "leaving the set" (kit-broken-links-visible): links and app
// edges that land on a file the session does not hold, apart from the broken
// ones and out of `count`; a link between two of the session's documents never
// leaves, whichever sets they are in (scriptorium-broken-links-sign-noise); and
// every entry naming its set, so the human's list can group by set.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppEdge, LinkSlot } from "./linkEdges";
import { locateEdges } from "./linkEdges";
import { LINK_CHECK_CAP, type WorkspaceSession } from "./session";
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
  "related: [./ruin.md, ./ghost.md, ../lore/myth.md, ../loose.md]",
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
  writeFileSync(
    join(lore, "myth.md"),
    "# The Myth\n\nBack to [the glade](../world/glade.md), and [the code](../src/tool.ts).\n",
  );
  writeFileSync(join(root, "src", "tool.ts"), "export {};\n");
  // A document on disk that no set holds.
  writeFileSync(join(root, "loose.md"), "# Loose\n");
  s = inContext(join(root, "sessions"), world);
  s.addContext(lore);
  s.setLinkSlot({ edges: related });
  // As Scriptorium declares it: the kit reports leaving links only when asked.
  s.setLinkCheck({ leaving: true, noun: "set" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ids = () => ({ world: s.context[0]?.id, lore: s.context[1]?.id });

describe("leaving the set", () => {
  test("lists links and edges that land on a file the session does not hold, each opening at its place", () => {
    const c = s.linkCheck();
    const { world: w, lore: l } = ids();
    expect(c.leaving?.count).toBe(3);
    expect(
      c.leaving?.links.map((x) => [x.shown, x.raw, x.edge ?? "link", x.targetShown, x.targetSet]),
    ).toEqual([
      ["glade.md", "../loose.md", "frontmatter", "../loose.md", undefined],
      ["glade.md", "../src/tool.ts", "link", "../src/tool.ts", undefined],
      ["myth.md", "../src/tool.ts", "link", "../src/tool.ts", undefined],
    ]);
    // Each names the set it is written in, and where it is written.
    expect(c.leaving?.links.map((x) => x.set)).toEqual([w, w, l]);
    const edge = c.leaving?.links[0];
    expect(edge?.line).toBe(3);
    expect(edge && GLADE.slice(edge.from ?? 0, edge.to ?? 0)).toBe("../loose.md");
    const body = c.leaving?.links[1];
    expect(body?.line).toBe(7);
    expect(body && GLADE.slice(body.from ?? 0, body.to ?? 0)).toBe("[the code](../src/tool.ts)");
  });

  test("a link or an edge to another set's document stays inside the session", () => {
    const raws = s.linkCheck().leaving?.links.map((x) => x.raw) ?? [];
    expect(raws).not.toContain("../lore/myth.md");
    expect(raws).not.toContain("../world/glade.md");
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
    // Each with its whole: world's broken link, broken reference and two leaving.
    expect(c.sets).toEqual([
      { id: w as string, label: "world", total: 4 },
      { id: l as string, label: "lore", total: 1 },
    ]);
    expect(c.noun).toBe("set");
    expect(c.dangling.links[0]?.set).toBe(w);
    expect(c.edges?.links[0]?.set).toBe(w);
  });

  test("a set with nothing to report is not listed", () => {
    writeFileSync(join(lore, "myth.md"), "# The Myth\n");
    expect(s.linkCheck().sets?.map((x) => x.label)).toEqual(["world"]);
  });
});

describe("leaving is the app's to ask for", () => {
  test("without the option there is no leaving section and no noun; count is the same", () => {
    const asked = s.linkCheck();
    s.setLinkCheck(undefined);
    const c = s.linkCheck();
    expect("leaving" in c).toBe(false);
    expect("noun" in c).toBe(false);
    expect(c.count).toBe(asked.count);
    expect(c.sets?.map((x) => [x.label, x.total])).toEqual([["world", 2]]);
  });
});

describe("the edges of a set", () => {
  test("a sibling folder whose name starts with the set's is outside it", () => {
    mkdirSync(join(root, "world-old"), { recursive: true });
    writeFileSync(join(root, "world-old", "data.csv"), "a\n");
    writeFileSync(join(world, "old.md"), "# Old\n\n[the old data](../world-old/data.csv)\n");
    s.rescan(ids().world ?? "");
    const raws = s.linkCheck().leaving?.links.map((x) => x.raw) ?? [];
    expect(raws).toContain("../world-old/data.csv");
  });

  test("the innermost set wins for grouping; a file that is not a document leaves by the source set's folder", () => {
    const inner = join(world, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      join(inner, "deep.md"),
      "# Deep\n\n[the ruin](../ruin.md), [the data](../data.csv) and [the gap](./gap.md)\n",
    );
    writeFileSync(join(inner, "notes.csv"), "a\n");
    // The other way: from `world` into the set nested in it, which is under its folder.
    writeFileSync(
      join(world, "ruin.md"),
      "# The Ruin\n\n[deep](./inner/deep.md) and [the notes](./inner/notes.csv)\n",
    );
    s.addContext(inner);
    // `world` lists `inner/deep.md` too (it was added first): the first entry to
    // list a file is the one a click resolves from, and the innermost set still wins.
    s.rescan(ids().world ?? "");
    const innerId = s.context[2]?.id;
    const c = s.linkCheck();
    const deep = c.leaving?.links.filter((x) => x.source === join(inner, "deep.md"));
    // `../ruin.md` is a session document: it stays. `../data.csv` is not, and
    // it is outside `inner`'s folder: it leaves, into `world`'s folder.
    expect(deep?.map((x) => [x.shown, x.raw, x.targetSet, x.set])).toEqual([
      ["deep.md", "../data.csv", "world", innerId],
    ]);
    expect(c.dangling.links.find((x) => x.raw === "./gap.md")?.set).toBe(innerId);
    // As the shipped map counted it: what is under `world`'s folder never leaves `world`,
    // a document of the nested set and a file no set holds alike.
    const fromRuin = c.leaving?.links.filter((x) => x.source === join(world, "ruin.md"));
    expect(fromRuin).toEqual([]);
  });

  test("documents added on their own: the session's documents stay, a sibling it does not hold leaves", () => {
    const loose = join(root, "loose");
    mkdirSync(join(loose, "world2"), { recursive: true });
    writeFileSync(
      join(loose, "solo.md"),
      "# Solo\n\n[sib](./sib.md) and [w](./world2/w.md); [me](./solo.md); [stray](./stray.md)\n",
    );
    writeFileSync(join(loose, "sib.md"), "# Sib\n");
    writeFileSync(join(loose, "stray.md"), "# Stray\n");
    writeFileSync(join(loose, "world2", "w.md"), "# W\n");
    s.addContext(join(loose, "solo.md"));
    s.addContext(join(loose, "sib.md"));
    s.addContext(join(loose, "world2"));
    const solo = s.context.find(
      (e) => e.membership === "listed" && e.nodes.some((n) => "rel" in n && n.rel === "solo.md"),
    );
    expect(solo).toBeDefined();
    const fromSolo = s
      .linkCheck()
      .leaving?.links.filter((x) => x.source === join(loose, "solo.md"));
    // Each added on its own is a set of its own, and still a link to another
    // of them, or to a set below, stays: only the sibling no set holds leaves.
    expect(fromSolo?.map((x) => [x.raw, x.targetSet])).toEqual([["./stray.md", undefined]]);
  });

  test("an unused image keeps its set", () => {
    writeFileSync(join(world, "images", "unused.png"), "png");
    s.rescan(ids().world ?? "");
    const c = s.linkCheck();
    expect(c.unusedImages.images.map((x) => [x.shown, x.set])).toEqual([
      ["images/unused.png", ids().world],
    ]);
  });

  test("a leaving list past the cap marks the check truncated, its count whole", () => {
    const many = Array.from({ length: LINK_CHECK_CAP + 1 }, (_, i) => `[m${i}](../src/tool.ts)`);
    writeFileSync(join(world, "many.md"), `# Many\n\n${many.join("\n")}\n`);
    // The rest of the world cut down, so leaving alone passes the cap.
    writeFileSync(join(world, "glade.md"), "# The Glade\n");
    writeFileSync(join(lore, "myth.md"), "# The Myth\n");
    s.rescan(ids().world ?? "");
    const c = s.linkCheck();
    expect(c.leaving?.count).toBe(LINK_CHECK_CAP + 1);
    expect(c.leaving?.links).toHaveLength(LINK_CHECK_CAP);
    expect(c.truncated).toBe(true);
    // The set says its whole, so a list can say how much of it shows.
    // (and the map, which the cut-down glade no longer embeds: an unused image).
    expect(c.sets?.[0]?.total).toBe(LINK_CHECK_CAP + 2);
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

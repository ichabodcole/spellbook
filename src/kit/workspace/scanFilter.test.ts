// The app's filter on the tree scan (`AppDeclaration.scan`): a path it skips
// is out of the tree, search, the link graph and backlinks, stays on disk, and
// stays skipped across a rescan and a restore, because what the filter reads
// lives in the app slot.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextNode } from "./protocol";
import { type AppDeclaration, GoneError, WorkspaceSession } from "./session";
import { tempRoot } from "./testing";
import { scanTree } from "./tree";

/** An app that keeps a skip list per entry in its slot, as Scriptorium's `hide` does. */
const filterApp: AppDeclaration = {
  name: "kit-filter",
  slot: { version: 1, migrate: (prev) => ({ skipped: {}, ...prev }) },
  scan: ({ entryId, slot }) => {
    const rels = (slot.skipped as Record<string, string[]> | undefined)?.[entryId];
    return rels?.length ? { skip: (rel) => rels.includes(rel) } : undefined;
  },
};

let root: string;
let world: string;
let sessions: string;

beforeEach(() => {
  root = tempRoot("scan-filter");
  world = join(root, "world");
  sessions = join(root, "sessions");
  mkdirSync(join(world, "drafts", "old"), { recursive: true });
  writeFileSync(join(world, "canon.md"), "# Canon\n\nThe lighthouse keeper.\n");
  writeFileSync(
    join(world, "drafts", "rough.md"),
    "# Rough\n\nlighthouse, see [canon](../canon.md).\n",
  );
  writeFileSync(join(world, "drafts", "old", "older.md"), "# Older\n\nlighthouse again.\n");
  writeFileSync(join(world, "aside.md"), "# Aside\n\nlighthouse [canon](./canon.md).\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(world, rel);

/** Every rel a tree shows. */
const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => [n.rel, ...(n.kind === "group" ? rels(n.children) : [])]);

const skip = (s: WorkspaceSession, entryId: string, list: string[]) => {
  s.updateApp((slot) => {
    slot.skipped = { ...(slot.skipped as Record<string, string[]>), [entryId]: list };
  });
  return s.refilter(entryId);
};

function open(): { s: WorkspaceSession; entry: string } {
  const s = WorkspaceSession.create(sessions, filterApp);
  const { entry } = s.addContext(world);
  return { s, entry: entry.id };
}

const treeOf = (s: WorkspaceSession, id: string) =>
  rels(s.context.find((e) => e.id === id)?.nodes ?? []);
const searched = (s: WorkspaceSession) =>
  s.search({ query: "lighthouse" }).results.map((r) => r.path);
const graphed = (s: WorkspaceSession) => s.linkGraph().nodes.map((n) => n.path);
const linkingIn = (s: WorkspaceSession) =>
  s.backlinks(at("canon.md")).backlinks.map((b) => b.source);

describe("a scan filter (AppDeclaration.scan)", () => {
  test("a skipped folder takes everything under it out of the tree, search, the graph and backlinks; the files stay", () => {
    const { s, entry } = open();
    expect(treeOf(s, entry)).toContain("drafts/old/older.md");
    expect(searched(s)).toContain(at("drafts/rough.md"));
    expect(linkingIn(s)).toContain(at("drafts/rough.md"));

    expect(skip(s, entry, ["drafts"])).toBe(true);
    expect(treeOf(s, entry)).toEqual(["aside.md", "canon.md"]);
    expect(searched(s)).not.toContain(at("drafts/rough.md"));
    expect(searched(s)).not.toContain(at("drafts/old/older.md"));
    expect(graphed(s)).not.toContain(at("drafts/rough.md"));
    expect(linkingIn(s)).toEqual([at("aside.md")]);
    expect(existsSync(at("drafts/rough.md"))).toBe(true);
    expect(existsSync(at("drafts/old/older.md"))).toBe(true);
  });

  test("a skipped file goes alone; its folder stays", () => {
    const { s, entry } = open();
    skip(s, entry, ["drafts/rough.md"]);
    expect(treeOf(s, entry)).toContain("drafts/old/older.md");
    expect(treeOf(s, entry)).not.toContain("drafts/rough.md");
    expect(searched(s)).toContain(at("drafts/old/older.md"));
  });

  test("it holds through a rescan: a file added beside it shows, the skipped one does not", () => {
    const { s, entry } = open();
    skip(s, entry, ["drafts"]);
    writeFileSync(at("drafts/new.md"), "# New\n");
    writeFileSync(at("fresh.md"), "# Fresh\n");
    s.rescan(entry);
    expect(treeOf(s, entry)).toEqual(["aside.md", "canon.md", "fresh.md"]);
  });

  test("it holds through a restore: the list is in the app slot, and the restore scans through it", () => {
    const { s, entry } = open();
    skip(s, entry, ["drafts"]);
    const back = WorkspaceSession.restore(sessions, filterApp, s.id);
    expect(back.appSlot.skipped).toEqual({ [entry]: ["drafts"] });
    expect(treeOf(back, entry)).toEqual(["aside.md", "canon.md"]);
    expect(searched(back)).not.toContain(at("drafts/rough.md"));
  });

  test("clearing the list and refiltering brings everything back", () => {
    const { s, entry } = open();
    skip(s, entry, ["drafts"]);
    expect(skip(s, entry, [])).toBe(true);
    expect(treeOf(s, entry)).toContain("drafts/old/older.md");
    expect(searched(s)).toContain(at("drafts/rough.md"));
  });

  test("an open document the filter takes away is closed in the view; its versions stay", () => {
    const { s, entry } = open();
    const { slug } = s.openPath(at("drafts/rough.md"));
    expect(s.openDocSlug).toBe(slug);
    skip(s, entry, ["drafts"]);
    expect(s.openDocSlug).toBeNull();
    expect(s.findDoc(slug)).toBeDefined();
  });

  test("a set added after the rule exists is scanned through it", () => {
    const pre: AppDeclaration = {
      ...filterApp,
      scan: () => ({ skip: (rel) => rel === "drafts" }),
    };
    const s = WorkspaceSession.create(sessions, pre);
    const { entry } = s.addContext(world);
    expect(rels(entry.nodes)).toEqual(["aside.md", "canon.md"]);
  });

  test("a set the session makes (a folder moved into the workspace) is scanned through it from the first scan", () => {
    const pre: AppDeclaration = {
      ...filterApp,
      scan: () => ({ skip: (rel) => rel === "secret" }),
    };
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    mkdirSync(join(world, "box", "secret"), { recursive: true });
    writeFileSync(join(world, "box", "keep.md"), "# Keep\n");
    writeFileSync(join(world, "box", "secret", "x.md"), "# X\n");
    const s = WorkspaceSession.create(sessions, pre);
    s.setWorkspace(ws);
    s.addContext(world);
    const moved = s.move(join(world, "box"), ws);
    const made = s.context.find((e) => e.root === moved.path);
    expect(made?.membership).toBe("mirrored");
    expect(rels(made?.nodes ?? [])).toEqual(["keep.md"]);
  });

  test("refilter names an entry that is not there with the ones that are", () => {
    const { s, entry } = open();
    expect(() => s.refilter("c-nope")).toThrow("no context entry c-nope");
    expect(s.refilter()).toBe(false);
    expect(treeOf(s, entry)).toContain("drafts/rough.md");
  });

  test("shownAt says where a path is shown, and whether it is the whole entry", () => {
    const { s, entry } = open();
    expect(s.shownAt(world)).toMatchObject({ entryId: entry, rel: "", whole: true });
    expect(s.shownAt(at("drafts/old"))).toMatchObject({
      entryId: entry,
      rel: "drafts/old",
      whole: false,
    });
    skip(s, entry, ["drafts"]);
    expect(() => s.shownAt(at("drafts/old"))).toThrow("not shown");
  });
});

describe("an opened document the filter then skips", () => {
  // The session keeps an opened document's record (its versions, its unsaved
  // text) after the filter takes it away, for when it comes back. The record
  // is not the context: search and links read the context.
  const leaks = (s: WorkspaceSession, canonSlug: string) => {
    const rough = at("drafts/rough.md");
    const broken = at("drafts/broken.md");
    expect(searched(s)).not.toContain(rough);
    expect(searched(s)).not.toContain(broken);
    // Its unsaved text is not searched either.
    expect(s.search({ query: "zephyr" }).results).toEqual([]);
    expect(graphed(s)).not.toContain(rough);
    expect(linkingIn(s)).not.toContain(rough);
    expect(s.linkTargets(canonSlug).targets.map((t) => t.path)).not.toContain(rough);
    expect(s.linkCheck().dangling.links.map((l) => l.source)).not.toContain(broken);
  };

  test("is out of search, the graph, backlinks, link targets and the link check, and stays out across a restore; its record comes back with it", () => {
    writeFileSync(at("drafts/broken.md"), "# Broken\n\nlighthouse [gone](./nowhere.md)\n");
    const { s, entry } = open();
    const rough = at("drafts/rough.md");
    const { slug } = s.openPath(rough);
    const active = s.findDoc(slug)?.active ?? 0;
    s.edit(slug, active, "# Rough\n\nzephyr, see [canon](../canon.md).\n");
    s.openPath(at("drafts/broken.md"));
    const canonSlug = s.openPath(at("canon.md")).slug;
    // Before: all of it is in.
    expect(s.search({ query: "zephyr" }).results.map((r) => r.path)).toEqual([rough]);
    expect(s.linkCheck().dangling.links.map((l) => l.source)).toContain(at("drafts/broken.md"));

    skip(s, entry, ["drafts"]);
    leaks(s, canonSlug);

    const back = WorkspaceSession.restore(sessions, filterApp, s.id);
    leaks(back, canonSlug);

    // The filter lets it back: the same record, unsaved text and all.
    skip(back, entry, []);
    expect(back.findDoc(slug)).toBeDefined();
    expect(back.search({ query: "zephyr" }).results.map((r) => r.path)).toEqual([rough]);
    expect(linkingIn(back)).toContain(rough);
  });

  test("a skipped file alone (not its folder) is out too", () => {
    const { s, entry } = open();
    s.openPath(at("drafts/rough.md"));
    skip(s, entry, ["drafts/rough.md"]);
    expect(searched(s)).not.toContain(at("drafts/rough.md"));
    expect(searched(s)).toContain(at("drafts/old/older.md"));
  });

  test("an opened document whose whole set left the context is still one the human has", () => {
    // Not the filter's: nothing skips it, so it stays found, as before.
    const { s, entry } = open();
    s.openPath(at("drafts/rough.md"));
    s.removeContext(entry);
    expect(searched(s)).toEqual([at("drafts/rough.md")]);
  });
});

describe("restoreContext", () => {
  test("puts a removed entry back with the same id and membership, where it stood, through the filter", () => {
    const { s, entry } = open();
    const solo = join(root, "solo.md");
    writeFileSync(solo, "# Solo\n\nlighthouse\n");
    s.addContext(solo);
    skip(s, entry, ["drafts"]);
    const removed = s.removeContext(entry);
    expect(removed.index).toBe(0);
    expect(s.context.map((e) => e.label)).toEqual(["solo.md"]);
    const back = s.restoreContext(removed.entry, removed.index);
    expect(back.id).toBe(entry);
    expect(back.membership).toBe("mirrored");
    expect(s.context.map((e) => e.id)[0]).toBe(entry);
    // The slot still names it by id: still filtered.
    expect(treeOf(s, entry)).toEqual(["aside.md", "canon.md"]);
    expect(searched(s)).toContain(at("canon.md"));
    // A listed one too.
    const soloEntry = s.context[1];
    if (!soloEntry) throw new Error("no solo entry");
    const r2 = s.removeContext(soloEntry.id);
    expect(s.restoreContext(r2.entry, r2.index)).toMatchObject({
      id: soloEntry.id,
      membership: "listed",
    });
    expect(searched(s)).toContain(solo);
  });

  test("one that can never come back is a GoneError: in the context already, or gone from disk", () => {
    const { s, entry } = open();
    const removed = s.removeContext(entry);
    s.restoreContext(removed.entry, removed.index);
    expect(() => s.restoreContext(removed.entry, 0)).toThrow(GoneError);
    s.removeContext(entry);
    // Added back by hand (a new id): this one cannot come back as well.
    s.addContext(world);
    expect(() => s.restoreContext(removed.entry, 0)).toThrow(GoneError);
    s.removeContext(s.context[0]?.id ?? "");
    rmSync(world, { recursive: true, force: true });
    expect(() => s.restoreContext(removed.entry, 0)).toThrow(GoneError);
    expect(s.context).toEqual([]);
  });
});

describe("scanTree with a skip", () => {
  test("nothing skipped counts toward the cap", () => {
    const many = join(root, "many");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(many, `noise-${i}.md`), "x");
    writeFileSync(join(many, "z.md"), "# Z\n");
    const capped = scanTree(many, 5);
    expect(capped.truncated).toBe(true);
    const skipped = scanTree(many, 5, (rel) => rel.startsWith("noise-"));
    expect(skipped).toEqual({ nodes: [{ kind: "doc", rel: "z.md" }], truncated: false });
  });

  test("no skip scans everything, as before", () => {
    expect(rels(scanTree(world).nodes)).toContain("drafts/old/older.md");
  });
});

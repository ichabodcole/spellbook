// Which versions the link check's `proposed` reads (kit-relink-misses-proposed-
// versions): the agent's, never active. A version the human made is theirs,
// not a proposal; `Version.activated` marks every version that has been active.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;
let slug: string;

const TEXT = "# Keeper\n\nLives by [the Glade](./places/glade.md).\n";

beforeEach(() => {
  root = tempRoot("link-proposed");
  world = join(root, "world");
  mkdirSync(join(world, "places"), { recursive: true });
  mkdirSync(join(world, "wilds"), { recursive: true });
  writeFileSync(join(world, "places", "glade.md"), "# The Glade\n");
  writeFileSync(join(world, "keeper.md"), TEXT);
  s = inContext(join(root, "sessions"), world);
  slug = s.openPath(join(world, "keeper.md"), { focus: false }).slug;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a version the human made is not read; the agent's is", () => {
  s.newVersion({ doc: slug, body: "# K\n\n[g](places/glade.md)\n", by: "human" });
  const v3 = s.newVersion({ doc: slug, body: "# K\n\n[g](places/./glade.md)\n", by: "agent" })
    .version.n;
  s.move(join(world, "places", "glade.md"), join(world, "wilds"));
  const c = s.linkCheck();
  // v1 is active and broken (no relink here): reported in `dangling`.
  expect(c.dangling.links.map((l) => l.raw)).toEqual(["./places/glade.md"]);
  // The human's v2 is broken the same way, and not read; the agent's v3 is.
  expect(c.proposed?.links.map((l) => [l.version, l.raw])).toEqual([[v3, "places/./glade.md"]]);
});

test("activating marks both versions; neither is read again", () => {
  const body = "# Keeper\n\nBy [the Glade](places/glade.md).\n";
  const v2 = s.newVersion({ doc: slug, body, by: "agent" }).version.n;
  s.move(join(world, "places", "glade.md"), join(world, "wilds"));
  expect(s.linkCheck().proposed?.links.map((l) => [l.version, l.suggest])).toEqual([
    [v2, "./wilds/glade.md"],
  ]);
  s.activate({ doc: slug, version: v2 });
  s.activate({ doc: slug, version: 1 });
  const versions = s.view().docs.find((d) => d.slug === slug)?.versions ?? [];
  expect(versions.map((v) => [v.n, v.activated ?? false])).toEqual([
    [1, true],
    [v2, true],
  ]);
  expect(s.linkCheck().proposed?.count).toBe(0);
});

test("a version kept from an outside write to the active one is no proposal", () => {
  s.edit(slug, 1, TEXT);
  const path = s.readVersion(slug, 1).path;
  // Written beside the kit, with a link that will break: kept as an agent version.
  writeFileSync(path, "# K\n\n[g](places/./glade.md)\n");
  expect(s.onFileEvent(path)).toMatchObject({ kind: "active.outside", preservedAs: 2 });
  expect(s.doc(slug).versions[1]).toMatchObject({ by: "agent", outside: true });
  s.move(join(world, "places", "glade.md"), join(world, "wilds"));
  expect(s.linkCheck().proposed?.count).toBe(0);
});

test("one kept before the mark, known by its label, is no proposal either", () => {
  const body = "# K\n\n[g](places/./glade.md)\n";
  s.newVersion({ doc: slug, body, by: "agent", label: "outside write to v1" });
  s.move(join(world, "places", "glade.md"), join(world, "wilds"));
  expect(s.linkCheck().proposed?.count).toBe(0);
});

// An app edge nothing answers is broken only when it is written as a path
// (scriptorium-broken-links-sign-noise, Cole's ruling 2026-10-22): one with an
// extension or a leading `/`, `./` or `../`. Anything else is a reference in a
// convention the kit does not know (`feature/some-slug`): listed as
// `unresolved`, kept out of `count`, and never guessed at.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppEdge, type LinkSlot, pathShaped } from "./linkEdges";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

const related: NonNullable<LinkSlot["edges"]> = ({ frontmatter }) => {
  const list = frontmatter?.related;
  return Array.isArray(list)
    ? list.map((t): AppEdge => ({ kind: "frontmatter", target: String(t), key: "related" }))
    : [];
};

const PAGE = [
  "---",
  "title: Page",
  "related:",
  "  - feature/workspace-kit-follow-ups",
  "  - cycle/2026-10-polish",
  "  - a-bare-name",
  "  - ./ghost.md",
  "  - notes/thing.md",
  "  - ../up.md",
  "  - /rooted/gone.md",
  "  - known-name",
  "---",
  "# Page",
  "",
].join("\n");

beforeEach(() => {
  root = tempRoot("link-unresolved");
  world = join(root, "world");
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "page.md"), PAGE);
  writeFileSync(join(world, "known.md"), "# Known\n");
  s = inContext(join(root, "sessions"), world);
  // The app answers one name of its own; the kit knows none.
  s.setLinkSlot({
    edges: related,
    resolve: ({ target }) => (target === "known-name" ? [join(world, "known.md")] : undefined),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("pathShaped", () => {
  test("a path: anchored, or with an extension", () => {
    for (const t of [
      "./a",
      "../a",
      "/a",
      "a.md",
      "notes/thing.md",
      "a.md#Heading",
      "x/y.png?rel=z",
      "notes.markdown",
      "clip.mp4",
    ])
      expect([t, pathShaped(t)]).toEqual([t, true]);
  });
  test("not a path: a slug, a typed key, a bare name, a dotfile", () => {
    for (const t of [
      "feature/workspace-kit-follow-ups",
      "cycle/2026-10-polish",
      "name",
      ".hidden",
      "a.",
      // A version number is no extension.
      "feature/kit-v1.2",
      // What follows a `#` or a `?` is no part of the name.
      "notes/page#sec.tion",
      "page?at=a.b",
    ])
      expect([t, pathShaped(t)]).toEqual([t, false]);
  });
});

describe("the link check", () => {
  test("broken edges are the path-shaped ones; the rest are unresolved, listed, not counted", () => {
    const c = s.linkCheck();
    expect(c.edges?.links.map((e) => e.raw)).toEqual([
      "./ghost.md",
      "notes/thing.md",
      "../up.md",
      "/rooted/gone.md",
    ]);
    expect(c.unresolved?.links.map((e) => e.raw)).toEqual([
      "feature/workspace-kit-follow-ups",
      "cycle/2026-10-polish",
      "a-bare-name",
    ]);
    expect(c.unresolved?.kinds).toEqual(["frontmatter"]);
    // An unresolved one carries what a broken one does: its key, line and place.
    const first = c.unresolved?.links[0];
    expect(first?.key).toBe("related");
    expect(first?.line).toBe(4);
    expect(first && PAGE.slice(first.from ?? 0, first.to ?? 0)).toBe(
      "feature/workspace-kit-follow-ups",
    );
    // Only the broken ones count; a name the app answers is neither.
    expect(c.count).toBe(4);
    expect(JSON.stringify(c)).not.toContain('"known-name"');
    // The set's whole is what the sign counts of it: the unresolved ones apart.
    expect(c.sets?.[0]?.total).toBe(4);
  });

  test("an app that adds no edges has no unresolved section", () => {
    s.setLinkSlot({});
    const c = s.linkCheck();
    expect("edges" in c).toBe(false);
    expect("unresolved" in c).toBe(false);
  });

  test("the edge filter applies to it as to the broken edges", () => {
    expect(s.linkCheck({ edge: ["link"] }).unresolved?.count).toBe(0);
    expect(s.linkCheck({ edge: ["frontmatter"] }).unresolved?.count).toBe(3);
  });
});

// A link's row in a set's tree (a folder link the scan shows and never
// enters, `kit-workspace-symlinked-sets`) takes nothing: a document, a folder,
// a bundle, an import, a move or a drop there would land where the link
// leads, outside the set, and vanish from it. Each refusal names the act that
// answers it: adding the linked folder as a set of its own.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { pngBytes } from "../lib/testImages.ts";
import { WorkspaceSession } from "./session";
import { refusal, TEST_BUNDLE, tempRoot, testApp } from "./testing";

let root: string;
let set: string;
let outside: string;
let ws: string;
let linkdir: string;

beforeEach(() => {
  registerBundleType(TEST_BUNDLE);
  root = tempRoot("workspace-link-rows");
  set = join(root, "world");
  outside = join(root, "outside");
  ws = join(root, "ws");
  linkdir = join(set, "linkdir");
  mkdirSync(join(set, "real"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(set, "real", "inner.md"), "# Inner\n");
  writeFileSync(join(outside, "theirs.md"), "# Theirs\n");
  symlinkSync(outside, linkdir);
});
afterEach(() => {
  unregisterBundleType(TEST_BUNDLE.extension);
  rmSync(root, { recursive: true, force: true });
});

const session = () => {
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, ws);
  s.addContext(set);
  return s;
};

/** Refused as a link's row, with the act that answers it, and nothing written outside. */
const refusedAsLink = (fn: () => unknown, at = linkdir) => {
  const before = readdirSync(outside).sort();
  const e = refusal(fn);
  expect(e.status).toBe(400);
  expect(e.message).toContain("is a link that leads outside world");
  expect(e.hint).toBe(`to work in that folder, add it as a set of its own: add ${at}`);
  expect(readdirSync(outside).sort()).toEqual(before);
};

test("the link's row is shown, and is no place to make a document, a folder or a bundle", () => {
  const s = session();
  expect(s.context[0]?.nodes).toContainEqual({ kind: "group", rel: "linkdir", children: [] });
  refusedAsLink(() => s.createDoc(linkdir, "created.md"));
  refusedAsLink(() => s.createDoc(linkdir));
  refusedAsLink(() => s.createFolder(linkdir, "newfold"));
  refusedAsLink(() => s.createBundle(linkdir, TEST_BUNDLE.extension, "Board"));
  refusedAsLink(() => s.addFolder(join(linkdir, "newfold")));
});

test("nothing is imported, dropped or pasted into it", () => {
  const s = session();
  refusedAsLink(() => s.importText("imp.md", "# Imported\n", linkdir));
  refusedAsLink(() => s.importImage("pic.png", pngBytes(2, 2), { dir: linkdir, onTaken: "ask" }));
  refusedAsLink(() => s.shownFolderOrDie(linkdir));
});

test("nothing is moved into it, and its target's files cannot be moved out through it", () => {
  const s = session();
  refusedAsLink(() => s.move(join(set, "real", "inner.md"), linkdir));
  refusedAsLink(() => s.movePlan(join(set, "real", "inner.md"), linkdir));
  expect(existsSync(join(set, "real", "inner.md"))).toBe(true);
  // Out of it: its files are not shown, so they are not the set's to move.
  const out = refusal(() => s.move(join(linkdir, "theirs.md"), join(set, "real")));
  expect(out.message).toContain("is not shown");
  expect(existsSync(join(outside, "theirs.md"))).toBe(true);
  expect(existsSync(join(set, "real", "theirs.md"))).toBe(false);
});

test("a link that stays inside the set is refused too: it is still a link, not a folder of the set", () => {
  symlinkSync(join(set, "real"), join(set, "alias"));
  const s = session();
  const e = refusal(() => s.createDoc(join(set, "alias"), "x.md"));
  expect(e.status).toBe(400);
  expect(e.message).toContain("is a link (to");
  expect(e.message).not.toContain("leads outside");
  expect(existsSync(join(set, "real", "x.md"))).toBe(false);
});

test("a shown folder swapped for a link, or one under it, before a rescan takes nothing", () => {
  rmSync(linkdir);
  mkdirSync(join(linkdir, "sub"), { recursive: true });
  writeFileSync(join(linkdir, "sub", "s.md"), "# S\n");
  const s = session();
  rmSync(linkdir, { recursive: true });
  symlinkSync(outside, linkdir);
  mkdirSync(join(outside, "sub"));
  refusedAsLink(() => s.createDoc(linkdir, "x.md"));
  const e = refusal(() => s.createDoc(join(linkdir, "sub"), "x.md"));
  expect(e.message).toContain("is reached through a link that leads outside world");
  expect(existsSync(join(outside, "sub", "x.md"))).toBe(false);
});

test("the link itself still moves, like any item", () => {
  const s = session();
  s.move(linkdir, join(set, "real"));
  expect(existsSync(join(set, "real", "linkdir", "theirs.md"))).toBe(true);
  expect(existsSync(join(outside, "theirs.md"))).toBe(true);
});

test("a set rooted at a link is still a place to make things", () => {
  const via = join(root, "via");
  symlinkSync(join(set, "real"), via);
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, ws);
  s.addContext(via);
  expect(existsSync(s.createDoc(via, "made.md").path)).toBe(true);
  expect(existsSync(join(set, "real", "made.md"))).toBe(true);
});

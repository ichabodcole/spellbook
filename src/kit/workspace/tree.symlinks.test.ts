// A mirrored set never enters a link to a folder: one leading out of the set
// would show files that are not the set's, one leading in shows them twice,
// and `self -> .` or `up -> ..` is a loop that was walked until the node cap.
// The link keeps its row, as a folder with nothing read under it, so the link
// itself can still be renamed, moved or put in the Trash. A link to a file
// still shows. The way to a linked folder's files is to add it as a set.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import type { ContextNode } from "./protocol";
import { SHELF_BUNDLE, TEST_BUNDLE, tempRoot, writeBundle, writeShelf } from "./testing";
import { bundleContents, docPaths, entryForPath, scanTree } from "./tree";

let root: string;
let set: string;
let outside: string;

beforeAll(() => {
  registerBundleType(TEST_BUNDLE);
  registerBundleType(SHELF_BUNDLE);
});
afterAll(() => {
  unregisterBundleType(TEST_BUNDLE.extension);
  unregisterBundleType(SHELF_BUNDLE.extension);
});

beforeEach(() => {
  root = tempRoot("workspace-tree-links");
  set = join(root, "set");
  outside = join(root, "outside");
  mkdirSync(join(set, "real"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(set, "top.md"), "top");
  writeFileSync(join(set, "real", "inner.md"), "inner");
  writeFileSync(join(outside, "secret.md"), "not the set's");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A link's row: a folder, with nothing read under it. */
const linkRow = (rel: string): ContextNode => ({ kind: "group", rel, children: [] });

/** The set's real folder, as every case below must still read it. */
const REAL: ContextNode = {
  kind: "group",
  rel: "real",
  children: [{ kind: "doc", rel: "real/inner.md" }],
};
const TOP: ContextNode = { kind: "doc", rel: "top.md" };

// Each scan is asked twice: with no guard, and with one (which reads a folder's
// entries another way, to know which are links).
const scans = [
  ["no guard", (at: string) => scanTree(at)],
  ["a guard", (at: string) => scanTree(at, undefined, undefined, () => false)],
] as const;

describe.each(scans)("a set's scan with %s", (_, scan) => {
  // Not `out`: that is a noise folder a scan skips by name, link or not.
  test("a link to a folder outside the set is not entered: its files are not the set's", () => {
    symlinkSync(outside, join(set, "away"));
    expect(scan(set)).toEqual({ nodes: [linkRow("away"), REAL, TOP], truncated: false });
  });

  test("a link to a folder inside the set is not entered: its files show once, where they are", () => {
    symlinkSync(join(set, "real"), join(set, "alias"));
    expect(scan(set)).toEqual({ nodes: [linkRow("alias"), REAL, TOP], truncated: false });
  });

  test("a loop to itself (`self -> .`) is read once, not walked to the cap", () => {
    symlinkSync(".", join(set, "self"));
    expect(scan(set)).toEqual({ nodes: [REAL, linkRow("self"), TOP], truncated: false });
  });

  test("a loop up (`up -> ..`) deeper in is read once, and the parent is not entered", () => {
    symlinkSync("..", join(set, "real", "up"));
    expect(scan(set)).toEqual({
      nodes: [
        { ...REAL, children: [linkRow("real/up"), { kind: "doc", rel: "real/inner.md" }] },
        TOP,
      ],
      truncated: false,
    });
  });

  test("a link named like a bundle is a link's row, not a bundle read through it", () => {
    const real = writeBundle(outside, "Real", { version: 1, type: "board", title: "Real" });
    symlinkSync(real, join(set, "Linked.boardbundle"));
    const { nodes } = scan(set);
    expect(nodes).toEqual([linkRow("Linked.boardbundle"), REAL, TOP]);
    expect(docPaths({ id: "c1", label: "set", root: set, membership: "mirrored", nodes })).toEqual([
      join(set, "real", "inner.md"),
      join(set, "top.md"),
    ]);
  });

  test("a link to a file still shows as the document it is", () => {
    symlinkSync(join(set, "top.md"), join(set, "also.md"));
    expect(scan(set).nodes).toEqual([REAL, { kind: "doc", rel: "also.md" }, TOP]);
  });
});

test("a link's row counts toward the cap, as any folder does", () => {
  for (const name of ["a1", "a2", "a3"]) symlinkSync(outside, join(set, name));
  expect(scanTree(set, 2)).toEqual({ nodes: [linkRow("a1"), linkRow("a2")], truncated: true });
  expect(scanTree(set, 6)).toEqual({
    nodes: [linkRow("a1"), linkRow("a2"), linkRow("a3"), REAL, TOP],
    truncated: false,
  });
});

test("a set rooted at a link is read through it: the link is the set, not inside it", () => {
  const via = join(root, "via");
  symlinkSync(set, via);
  const e = entryForPath(via, "c1");
  expect(e.nodes).toEqual([REAL, TOP]);
  expect(docPaths(e)).toEqual([join(via, "real", "inner.md"), join(via, "top.md")]);
});

test("inside an expandable bundle, neither its member folders nor its own files enter a link", () => {
  const shelf = writeShelf(set, "The lighthouse");
  symlinkSync(outside, join(shelf, "docs", "away"));
  symlinkSync("..", join(shelf, "docs", "up"));
  symlinkSync(outside, join(shelf, "audio", "away"));
  symlinkSync(".", join(shelf, "audio", "self"));
  const at = "The lighthouse.shelfbundle";
  const { contents, truncated } = bundleContents(at, shelf, SHELF_BUNDLE);
  expect(truncated).toBe(false);
  expect(contents).toEqual([
    {
      kind: "group",
      rel: `${at}/audio`,
      children: [
        {
          kind: "group",
          rel: `${at}/audio/01-arrival`,
          children: [
            { kind: "file", rel: `${at}/audio/01-arrival/take.json`, size: 14 },
            { kind: "file", rel: `${at}/audio/01-arrival/take.mp3`, size: 17 },
          ],
        },
        linkRow(`${at}/audio/away`),
        linkRow(`${at}/audio/self`),
      ],
    },
    {
      kind: "group",
      rel: `${at}/docs`,
      children: [
        linkRow(`${at}/docs/away`),
        linkRow(`${at}/docs/up`),
        { kind: "doc", rel: `${at}/docs/01-arrival.md` },
        { kind: "doc", rel: `${at}/docs/02-the-keeper.md` },
      ],
    },
    expect.objectContaining({ kind: "file", rel: `${at}/info.json`, convention: true }),
    expect.objectContaining({ kind: "file", rel: `${at}/shelf.json`, convention: true }),
  ]);
});

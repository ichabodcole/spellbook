// The sidebar's pure rules for a bundle row: its name, its place in the sort,
// the open main file marking its row, and what a drag of it says it is.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import type { ContextEntry, ContextNode } from "../workspace/protocol";
import { TEST_BUNDLE } from "../workspace/testing";
import { docPathOf, folderDocs, indexTree, nodeLabel, rowHolds, sortNodes } from "./model.ts";
import { rowKindOf } from "./rowDrag.ts";

beforeAll(() => registerBundleType(TEST_BUNDLE));
afterAll(() => unregisterBundleType(TEST_BUNDLE.extension));

const well: ContextNode = {
  kind: "bundle",
  rel: "places/zz-well.boardbundle",
  type: "board",
  main: "board.board",
  title: "A well",
};
const plain: ContextNode = {
  kind: "bundle",
  rel: "places/plain.boardbundle",
  type: "board",
  main: "board.board",
};

describe("a bundle row", () => {
  test("is named by its title, else its folder without the extension, and sorted by that name", () => {
    expect(nodeLabel(well)).toBe("A well");
    expect(nodeLabel(plain)).toBe("plain");
    const sorted = sortNodes([{ kind: "doc", rel: "places/b.md" }, well, plain]);
    expect(sorted.map(nodeLabel)).toEqual(["A well", "b.md", "plain"]);
  });

  test("stands for its main file: opened, marked, and counted as one document", () => {
    expect(docPathOf("/w", well)).toBe("/w/places/zz-well.boardbundle/board.board");
    expect(rowHolds(well, "places/zz-well.boardbundle/board.board")).toBe(true);
    expect(rowHolds(well, "places/zz-well.boardbundle/assets/fox.png")).toBe(false);
    const index = indexTree([{ kind: "group", rel: "places", children: [well] }]);
    expect(index.bundleOf.get("places/zz-well.boardbundle/board.board")).toBe(
      "places/zz-well.boardbundle",
    );
    const entry: ContextEntry = {
      id: "c",
      label: "w",
      root: "/w",
      membership: "mirrored",
      nodes: [{ kind: "group", rel: "places", children: [well] }],
    };
    const open = { original: "/w/places/zz-well.boardbundle/board.board" };
    expect(folderDocs([entry], [open], "/w/places")).toEqual({ docs: [open], total: 1 });
  });

  test("is dragged as a bundle", () => {
    expect(rowKindOf(well)).toBe("bundle");
  });
});

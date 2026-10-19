// A message's chip names a path at or inside a bundle by the bundle, never by
// its main file or its folder: by its title when the surface knows it (the
// shell's `pathName`, read from the context's tree), else by its folder's
// name without the extension.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aboutLabel, pathLabel } from "../chat/ChatMessageView.tsx";
import { bundleLabelAt } from "../context/model.ts";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import type { ContextEntry } from "../workspace/protocol";
import { TEST_BUNDLE } from "../workspace/testing";

beforeAll(() => registerBundleType(TEST_BUNDLE));
afterAll(() => unregisterBundleType(TEST_BUNDLE.extension));

const entries: ContextEntry[] = [
  {
    id: "c",
    label: "world",
    root: "/w/world",
    membership: "mirrored",
    nodes: [
      {
        kind: "group",
        rel: "places",
        children: [
          {
            kind: "bundle",
            rel: "places/the-well.boardbundle",
            type: "board",
            main: "board.board",
            title: "The well",
          },
        ],
      },
    ],
  },
];

describe("a chip's path in a bundle", () => {
  test("by default: the bundle's folder name, without its extension", () => {
    expect(pathLabel("/w/world/places/the-well.boardbundle/board.board")).toBe("the-well");
    expect(pathLabel("/w/world/places/the-well.boardbundle")).toBe("the-well");
    expect(pathLabel("/w/world/harbour.md")).toBe("harbour");
  });

  test("from the context's tree: the bundle's title, for the bundle and anything inside it", () => {
    const name = (p: string) => bundleLabelAt(entries, p) ?? pathLabel(p);
    const label = aboutLabel(
      {
        docs: [
          "/w/world/places/the-well.boardbundle/board.board",
          "/w/world/places/the-well.boardbundle/assets/fox.png",
          "/w/world/harbour.md",
        ],
      },
      (s) => s,
      name,
    );
    expect(label).toBe("The well, The well, harbour");
    expect(bundleLabelAt(entries, "/w/world/elsewhere.boardbundle")).toBeNull();
  });
});

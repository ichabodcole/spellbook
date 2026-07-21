// Pure-logic test for the ground-ref prefix grammar (Claim G).

import { expect, test } from "bun:test";
import type { DocMeta, MapNode } from "../types";
import { resolveGroundRef } from "./groundRefs";

const nodes: MapNode[] = [
  { id: "maren", title: "Maren", kind: "cast", tier: "canon", synopsis: "" },
];
const docs: DocMeta[] = [
  { id: "toll-ramble", title: "The Toll Ramble", kind: "ramble", kindAuthor: null },
];

test("a bare id resolves as a node ref", () => {
  expect(resolveGroundRef("maren", nodes, docs)).toEqual({
    type: "node",
    node: nodes[0] as MapNode,
  });
});

test("a doc:-prefixed id resolves as a doc ref", () => {
  expect(resolveGroundRef("doc:toll-ramble", nodes, docs)).toEqual({
    type: "doc",
    doc: docs[0] as DocMeta,
  });
});

test("a bare id never resolves against docs (the prefix is load-bearing)", () => {
  expect(resolveGroundRef("toll-ramble", nodes, docs)).toBeNull();
});

test("a doc:-prefixed id never resolves against nodes", () => {
  expect(resolveGroundRef("doc:maren", nodes, docs)).toBeNull();
});

test("unresolvable refs drop silently (null), including unknown prefixes", () => {
  expect(resolveGroundRef("no-such-node", nodes, docs)).toBeNull();
  expect(resolveGroundRef("doc:no-such-doc", nodes, docs)).toBeNull();
  expect(resolveGroundRef("msg:whatever", nodes, docs)).toBeNull();
});

// Pure-logic tests for the V2 doc lens — source-membership rule, the
// message-grounded exclusion, and the honest empty.

import { expect, test } from "bun:test";
import type { MapNode } from "../types";
import { docLensNodeIds } from "./docLens";

function node(id: string, sources?: MapNode["sources"]): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "", sources };
}

test("nodes with a source in the doc are admitted; others are not", () => {
  const keep = docLensNodeIds(
    [
      node("a", [{ docId: "ramble-01", span: "x" }]),
      node("b", [{ docId: "other-doc", span: null }]),
      node("c"),
    ],
    "ramble-01",
  );
  expect([...keep]).toEqual(["a"]);
});

test("a message-grounded source never matches a doc lens", () => {
  const keep = docLensNodeIds([node("a", [{ messageId: "m-1", span: "said" }])], "m-1");
  expect(keep.size).toBe(0);
});

test("a node with mixed sources is admitted when ANY source grounds in the doc", () => {
  const keep = docLensNodeIds(
    [
      node("a", [
        { messageId: "m-1", span: null },
        { docId: "ramble-01", span: null },
      ]),
    ],
    "ramble-01",
  );
  expect(keep.has("a")).toBe(true);
});

test("marks-but-no-nodes is honestly empty (no sources anywhere → empty set, not everything)", () => {
  expect(docLensNodeIds([node("a"), node("b")], "marked-doc").size).toBe(0);
});

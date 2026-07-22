// Pure-logic tests for the shared neighborhood BFS. Depth-1 is the
// select-connected (SC) derive: the node ∪ its immediate neighbors.

import { expect, test } from "bun:test";
import type { MapEdge } from "../types";
import { lensSet } from "./neighborhood";

function edge(source: string, target: string): MapEdge {
  return { id: `${source}-${target}`, source, target, label: "", provenance: "asserted" };
}

// a—b—c, plus a—d
const map = { edges: [edge("a", "b"), edge("b", "c"), edge("a", "d")] };

test("depth-1 admits the node and its immediate neighbors (the SC selection)", () => {
  expect([...lensSet(map, "a", 1)].sort()).toEqual(["a", "b", "d"]);
});

test("depth-1 is undirected — a target reaches its source", () => {
  expect([...lensSet(map, "c", 1)].sort()).toEqual(["b", "c"]);
});

test("depth-0 is the node alone", () => {
  expect([...lensSet(map, "a", 0)]).toEqual(["a"]);
});

test("a disconnected node selects only itself", () => {
  expect([...lensSet(map, "lonely", 1)]).toEqual(["lonely"]);
});

test("depth-2 reaches two hops out", () => {
  expect([...lensSet(map, "c", 2)].sort()).toEqual(["a", "b", "c"]);
});

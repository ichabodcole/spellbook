// Pure-logic tests for the shared neighborhood BFS. Depth-1 is the
// select-connected (SC) derive: the node ∪ its immediate neighbors.

import { expect, test } from "bun:test";
import type { MapEdge } from "../types";
import { directedSet, lensSet } from "./neighborhood";

function edge(source: string, target: string, direction?: "both"): MapEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    label: "",
    provenance: "asserted",
    direction,
  };
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

// DIRSELECT (finding #2) — directed depth-1 siblings. children = OUTGOING
// (edge.source === id → target); parents = INCOMING (edge.target === id →
// source). Both always include the node itself.
// a→b→c, plus a→d (all directed).
const directed = { edges: [edge("a", "b"), edge("b", "c"), edge("a", "d")] };

test("children are the OUTGOING targets (plus the node)", () => {
  expect([...directedSet(directed, "a", "children")].sort()).toEqual(["a", "b", "d"]);
});

test("parents are the INCOMING sources (plus the node)", () => {
  expect([...directedSet(directed, "c", "parents")].sort()).toEqual(["b", "c"]);
});

test("children excludes incoming — b's child is c only, not a", () => {
  expect([...directedSet(directed, "b", "children")].sort()).toEqual(["b", "c"]);
});

test("parents excludes outgoing — b's parent is a only, not c", () => {
  expect([...directedSet(directed, "b", "parents")].sort()).toEqual(["a", "b"]);
});

test("a source-less node has only itself as parents", () => {
  expect([...directedSet(directed, "a", "parents")]).toEqual(["a"]);
});

// A direction:"both" edge makes the neighbor BOTH a child and a parent
// (ruling). x—y is mutual; x has y as a child AND as a parent.
const mutual = { edges: [edge("x", "y", "both")] };

test("a both-direction edge counts the neighbor as a child", () => {
  expect([...directedSet(mutual, "x", "children")].sort()).toEqual(["x", "y"]);
  expect([...directedSet(mutual, "y", "children")].sort()).toEqual(["x", "y"]);
});

test("a both-direction edge counts the neighbor as a parent", () => {
  expect([...directedSet(mutual, "x", "parents")].sort()).toEqual(["x", "y"]);
  expect([...directedSet(mutual, "y", "parents")].sort()).toEqual(["x", "y"]);
});

// Pure-logic tests for the SL spotlight intersection + induced-edge lighting.

import { expect, test } from "bun:test";
import type { MapEdge } from "../types";
import { computeSpotlight } from "./spotlight";

function edge(source: string, target: string): MapEdge {
  return { id: `${source}-${target}`, source, target, label: "", provenance: "asserted" };
}

// a and b both connect to shared s; a also connects to lone x, b to lone y.
const map = {
  edges: [edge("a", "s"), edge("b", "s"), edge("a", "x"), edge("b", "y")],
};

test("<2 selected returns null (nothing to intersect)", () => {
  expect(computeSpotlight(map, [])).toBeNull();
  expect(computeSpotlight(map, ["a"])).toBeNull();
});

test("the shared neighbor is lit; the non-shared neighbors are not", () => {
  const spot = computeSpotlight(map, ["a", "b"]);
  expect(spot).not.toBeNull();
  expect([...(spot?.nodes ?? [])].sort()).toEqual(["a", "b", "s"]);
  // x and y are each a neighbor of only ONE selected node → dimmed.
  expect(spot?.nodes.has("x")).toBe(false);
  expect(spot?.nodes.has("y")).toBe(false);
});

test("only the joining edges (both endpoints lit) light up", () => {
  const spot = computeSpotlight(map, ["a", "b"]);
  expect([...(spot?.edges ?? [])].sort()).toEqual(["a-s", "b-s"]);
  // the edges out to the non-shared neighbors stay dim.
  expect(spot?.edges.has("a-x")).toBe(false);
  expect(spot?.edges.has("b-y")).toBe(false);
});

test("a direct edge between two selected nodes lights (induced subgraph)", () => {
  const withDirect = { edges: [...map.edges, edge("a", "b")] };
  const spot = computeSpotlight(withDirect, ["a", "b"]);
  expect(spot?.edges.has("a-b")).toBe(true);
});

test("no shared neighbors → only the selected nodes are lit, no edges", () => {
  const disjoint = { edges: [edge("a", "x"), edge("b", "y")] };
  const spot = computeSpotlight(disjoint, ["a", "b"]);
  expect([...(spot?.nodes ?? [])].sort()).toEqual(["a", "b"]);
  expect(spot?.edges.size).toBe(0);
});

test("a shared neighbor common to THREE selected nodes is lit", () => {
  const threeWay = {
    edges: [edge("a", "s"), edge("b", "s"), edge("c", "s"), edge("c", "z")],
  };
  const spot = computeSpotlight(threeWay, ["a", "b", "c"]);
  expect(spot?.nodes.has("s")).toBe(true);
  expect(spot?.nodes.has("z")).toBe(false);
});

// Round 7 (FILTER) — the pure faceted-filter derive: AND across facets, OR
// within, empty = everything, edges pruned to surviving endpoints, facet
// options present-only.

import { expect, test } from "bun:test";
import type { MapEdge, MapNode, StubMap } from "../types";
import {
  activeFilterCount,
  EMPTY_FILTER,
  filterFacets,
  filterMap,
  isEmptyFilter,
  statusOf,
  toggleFacet,
} from "./filter";

function node(id: string, over: Partial<MapNode> = {}): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "", ...over };
}

function edge(id: string, source: string, target: string): MapEdge {
  return { id, source, target, label: "", provenance: "asserted" };
}

function map(nodes: MapNode[], edges: MapEdge[] = []): StubMap {
  return { docs: [], nodes, edges };
}

test("an empty filter returns the map untouched (everything)", () => {
  const m = map([node("a"), node("b", { pending: true })]);
  expect(filterMap(m, EMPTY_FILTER)).toBe(m);
  expect(isEmptyFilter(EMPTY_FILTER)).toBe(true);
});

test("statusOf derives from the pending flag (no literal wire field)", () => {
  expect(statusOf(node("a"))).toBe("ratified");
  expect(statusOf(node("b", { pending: true }))).toBe("pending");
});

test("a single status facet keeps only matching nodes", () => {
  const m = map([node("real"), node("prop", { pending: true })]);
  expect(filterMap(m, { ...EMPTY_FILTER, status: ["ratified"] }).nodes.map((n) => n.id)).toEqual([
    "real",
  ]);
});

test("AND across facets — status AND tier must both hold", () => {
  const m = map([
    node("a", { tier: "canon" }),
    node("b", { tier: "thread" }),
    node("c", { tier: "canon", pending: true }),
  ]);
  const out = filterMap(m, { status: ["ratified"], tier: ["canon"], tags: [] });
  expect(out.nodes.map((n) => n.id)).toEqual(["a"]);
});

test("OR within a facet — any of several tiers passes", () => {
  const m = map([
    node("a", { tier: "canon" }),
    node("b", { tier: "thread" }),
    node("c", { tier: "background" }),
  ]);
  const out = filterMap(m, { ...EMPTY_FILTER, tier: ["canon", "thread"] });
  expect(out.nodes.map((n) => n.id)).toEqual(["a", "b"]);
});

test("tags facet is OR-within: a node matches if it holds ANY selected tag", () => {
  const m = map([node("a", { tags: ["x", "y"] }), node("b", { tags: ["z"] }), node("c")]);
  const out = filterMap(m, { ...EMPTY_FILTER, tags: ["y", "z"] });
  expect(out.nodes.map((n) => n.id)).toEqual(["a", "b"]);
});

test("edges are pruned to surviving endpoints", () => {
  const m = map(
    [node("a", { tier: "canon" }), node("b", { tier: "thread" })],
    [edge("e1", "a", "b")],
  );
  const out = filterMap(m, { ...EMPTY_FILTER, tier: ["canon"] });
  expect(out.nodes.map((n) => n.id)).toEqual(["a"]);
  expect(out.edges).toEqual([]);
});

test("filterFacets offers only present values (no empty bucket)", () => {
  const m = map([
    node("a", { tier: "canon", tags: ["zeta", "alpha"] }),
    node("b", { tier: "thread", pending: true }),
  ]);
  expect(filterFacets(m)).toEqual({
    statuses: ["ratified", "pending"],
    tiers: ["canon", "thread"],
    tags: ["alpha", "zeta"],
  });
});

test("toggleFacet adds an absent value and removes a present one", () => {
  expect(toggleFacet(["a"], "b")).toEqual(["a", "b"]);
  expect(toggleFacet(["a", "b"], "a")).toEqual(["b"]);
});

test("activeFilterCount sums the facet selections", () => {
  expect(activeFilterCount({ status: ["ratified"], tier: ["canon", "thread"], tags: ["x"] })).toBe(
    4,
  );
});

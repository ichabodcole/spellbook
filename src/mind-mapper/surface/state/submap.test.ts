// Pure-logic tests for the SG2 submap view filter + breadcrumb parent-walk.

import { expect, test } from "bun:test";
import type { MapEdge, MapNode } from "../types";
import { breadcrumbTrail, submapView } from "./submap";

function node(id: string, anchorNodeId: string | null = null): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "", anchorNodeId };
}
function edge(source: string, target: string): MapEdge {
  return { id: `${source}-${target}`, source, target, label: "", provenance: "asserted" };
}

// root -> a (child), a -> a1 (grandchild); b is a separate top-level node.
const nodes = [node("root"), node("a", "root"), node("a1", "a"), node("b")];
const edges = [edge("root", "a"), edge("a", "a1"), edge("root", "b")];
const map = { nodes, edges };

test("top-level view (null anchor) keeps only un-anchored nodes", () => {
  const view = submapView(map, null);
  expect(view.nodes.map((n) => n.id).sort()).toEqual(["b", "root"]);
  // Only the edge whose endpoints are both top-level survives.
  expect(view.edges.map((e) => e.id)).toEqual(["root-b"]);
});

test("a submap view keeps the anchor (as root/context) plus its direct children", () => {
  const view = submapView(map, "root");
  expect(view.nodes.map((n) => n.id).sort()).toEqual(["a", "root"]);
  // Grandchild a1 (anchored to a, not root) is NOT in root's submap.
  expect(view.nodes.some((n) => n.id === "a1")).toBe(false);
  expect(view.edges.map((e) => e.id)).toEqual(["root-a"]);
});

test("nesting: a deeper submap shows the next level only", () => {
  const view = submapView(map, "a");
  expect(view.nodes.map((n) => n.id).sort()).toEqual(["a", "a1"]);
  expect(view.edges.map((e) => e.id)).toEqual(["a-a1"]);
});

test("synthetic nodes with no anchorNodeId read as top-level", () => {
  const pending: MapNode = { id: "p", title: "p", kind: "concept", tier: "thread", synopsis: "" };
  const view = submapView({ nodes: [node("root"), pending], edges: [] }, null);
  expect(view.nodes.map((n) => n.id).sort()).toEqual(["p", "root"]);
});

test("breadcrumb walks anchorNodeId up to the root, root-first", () => {
  expect(breadcrumbTrail(nodes, "a1").map((n) => n.id)).toEqual(["root", "a", "a1"]);
  expect(breadcrumbTrail(nodes, "a").map((n) => n.id)).toEqual(["root", "a"]);
  expect(breadcrumbTrail(nodes, "root").map((n) => n.id)).toEqual(["root"]);
});

test("breadcrumb is empty at top level (null anchor)", () => {
  expect(breadcrumbTrail(nodes, null)).toEqual([]);
});

test("breadcrumb tolerates a missing ancestor (ends the walk)", () => {
  const orphan = [node("x", "gone")];
  expect(breadcrumbTrail(orphan, "x").map((n) => n.id)).toEqual(["x"]);
});

test("breadcrumb's defensive seen-guard survives a malformed cycle", () => {
  // The engine forbids this, but the walk must not loop if the wire lies.
  const cyclic = [node("p", "q"), node("q", "p")];
  const trail = breadcrumbTrail(cyclic, "p");
  expect(trail.length).toBeLessThanOrEqual(2);
});

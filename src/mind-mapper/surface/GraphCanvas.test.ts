// Pure-logic test for the P4 force-layout toggle's position solver
// (computeForcePositions) — settle-then-snapshot, no React/DOM involved.
// GraphCanvas.tsx itself (React Flow, context menus) is exercised live per
// the seat-doc reflex (pixels + a11y tree), not unit-tested here.

import { expect, test } from "bun:test";
import { computeForcePositions } from "./GraphCanvas";
import type { StubMap } from "./types";

function node(id: string): StubMap["nodes"][number] {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "" };
}

test("every node gets a finite, defined position", () => {
  const map: StubMap = {
    docs: [],
    nodes: [node("a"), node("b"), node("c")],
    edges: [{ id: "e1", source: "a", target: "b", label: "", provenance: "asserted" }],
  };
  const positions = computeForcePositions(map);
  expect(positions.size).toBe(3);
  for (const id of ["a", "b", "c"]) {
    const p = positions.get(id);
    expect(p).toBeDefined();
    expect(Number.isFinite(p?.x)).toBe(true);
    expect(Number.isFinite(p?.y)).toBe(true);
  }
});

test("the same map settles to the same positions (deterministic seeding, not Math.random)", () => {
  const map: StubMap = {
    docs: [],
    nodes: [node("a"), node("b"), node("c"), node("d")],
    edges: [
      { id: "e1", source: "a", target: "b", label: "", provenance: "asserted" },
      { id: "e2", source: "b", target: "c", label: "", provenance: "asserted" },
    ],
  };
  const first = computeForcePositions(map);
  const second = computeForcePositions(map);
  for (const id of ["a", "b", "c", "d"]) {
    expect(first.get(id)).toEqual(second.get(id));
  }
});

test("a connected pair settles closer together than a disconnected node", () => {
  const map: StubMap = {
    docs: [],
    nodes: [node("hub"), node("linked"), node("isolated")],
    edges: [{ id: "e1", source: "hub", target: "linked", label: "", provenance: "asserted" }],
  };
  const positions = computeForcePositions(map);
  const dist = (a: string, b: string) => {
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) throw new Error("missing position");
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  };
  expect(dist("hub", "linked")).toBeLessThan(dist("hub", "isolated"));
});

test("an edge referencing a node not in the map is dropped, not thrown", () => {
  const map: StubMap = {
    docs: [],
    nodes: [node("a")],
    edges: [{ id: "e1", source: "a", target: "ghost", label: "", provenance: "asserted" }],
  };
  const positions = computeForcePositions(map);
  expect(positions.size).toBe(1);
});

test("an empty map settles to an empty position map", () => {
  expect(computeForcePositions({ docs: [], nodes: [], edges: [] }).size).toBe(0);
});

// Pure-logic test for the P4 force-layout toggle's position solver
// (computeForcePositions) — settle-then-snapshot, no React/DOM involved.
// GraphCanvas.tsx itself (React Flow, context menus) is exercised live per
// the seat-doc reflex (pixels + a11y tree), not unit-tested here.

import { expect, test } from "bun:test";
import type { Node } from "@xyflow/react";
import {
  carryMeasured,
  computeForcePositions,
  type IdeaNodeData,
  mergeLayout,
} from "./GraphCanvas";
import type { MapNode, StubMap } from "./types";

function node(id: string): StubMap["nodes"][number] {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "" };
}

// A minimal flow node for mergeLayout (RENDER, finding #5) — only the fields
// the merge touches (id, position, selected, data) matter.
function flowNode(
  id: string,
  x: number,
  y: number,
  extra: Partial<Node<IdeaNodeData>> = {},
): Node<IdeaNodeData> {
  return {
    id,
    type: "idea",
    position: { x, y },
    data: { node: node(id) as MapNode, onCommand: () => {} },
    ...extra,
  };
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

// RENDER (finding #5) — mergeLayout: merge fresh layout onto prior on-screen
// nodes so a rapid proposal.added burst can't drop settled nodes.

test("a known id keeps its on-screen position and selection, takes the fresh data", () => {
  const prev = [flowNode("a", 100, 200, { selected: true })];
  // Fresh layout re-computed the position AND carries new node data.
  const freshData = { node: { ...node("a"), title: "A renamed" } as MapNode, onCommand: () => {} };
  const fresh = [{ ...flowNode("a", 999, 999), data: freshData }];
  const [merged] = mergeLayout(prev, fresh);
  expect(merged?.position).toEqual({ x: 100, y: 200 }); // preserved
  expect(merged?.selected).toBe(true); // preserved
  expect(merged?.data.node.title).toBe("A renamed"); // fresh data flows through
});

test("a new id takes the freshly-computed layout position", () => {
  const prev = [flowNode("a", 100, 200)];
  const fresh = [flowNode("a", 10, 10), flowNode("b", 50, 60)];
  const merged = mergeLayout(prev, fresh);
  const b = merged.find((n) => n.id === "b");
  expect(b?.position).toEqual({ x: 50, y: 60 });
});

test("a departed id is dropped (absent from fresh)", () => {
  const prev = [flowNode("a", 100, 200), flowNode("gone", 5, 5)];
  const fresh = [flowNode("a", 10, 10)];
  const merged = mergeLayout(prev, fresh);
  expect(merged.map((n) => n.id)).toEqual(["a"]);
});

test("a burst (fresh superset) preserves every earlier node's position — the drop bug", () => {
  // The bug: each proposal.added tick blindly replaced nodes; an async
  // onNodesChange race dropped earlier ones. mergeLayout, fed the full fresh
  // set each tick, keeps every settled node.
  const prev = [flowNode("n1", 1, 1), flowNode("n2", 2, 2), flowNode("n3", 3, 3)];
  const fresh = [
    flowNode("n1", 900, 900),
    flowNode("n2", 900, 900),
    flowNode("n3", 900, 900),
    flowNode("n4", 40, 40),
  ];
  const merged = mergeLayout(prev, fresh);
  expect(merged.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4"]);
  expect(merged.find((n) => n.id === "n1")?.position).toEqual({ x: 1, y: 1 });
  expect(merged.find((n) => n.id === "n4")?.position).toEqual({ x: 40, y: 40 });
});

// position-carry-across-ratify (drive7 #5A) — a ratified node mints a NEW id;
// without carry it takes a fresh dagre slot ("lands under another node"). The
// alias (mintedId → proposalId) + posMemory (last-known position, retained
// across the transient disappearance) carry the proposal's spot onto the node.

test("#5A: a minted node inherits its proposal's remembered position via the alias", () => {
  const posMemory = new Map([["prop-1", { x: 100, y: 200 }]]);
  const alias = new Map([["node-9", "prop-1"]]); // node-9 was ratified from prop-1
  // The synthetic proposal node is already gone from prev (dropped a render
  // earlier when its status flipped to ratified).
  const fresh = [flowNode("node-9", 777, 777)];
  const [merged] = mergeLayout([], fresh, { alias, posMemory });
  expect(merged?.position).toEqual({ x: 100, y: 200 }); // carried, not the dagre slot
});

test("#5A: without an alias entry a minted node still takes the fresh slot (no false carry)", () => {
  const posMemory = new Map([["prop-1", { x: 100, y: 200 }]]);
  const fresh = [flowNode("node-9", 777, 777)];
  const [merged] = mergeLayout([], fresh, { alias: new Map(), posMemory });
  expect(merged?.position).toEqual({ x: 777, y: 777 });
});

// SEAM 3 REPRO — the authoritative proof (the live timing race isn't reliably
// reproducible headless; this pure sequence models the two GraphCanvas renders
// the ratify actually produces: (1) node.ratified flips the proposal → its
// synthetic drops before (2) the async snapshot refetch backfills the minted
// node + sets resultNodeId). The lead's "alias-on-the-event" alone can't see
// the position by render 2 — posMemory is what bridges the gap.
test("#5A: position-carry survives the two-render ratify gap (flip, then backfill)", () => {
  const posMemory = new Map<string, { x: number; y: number }>();
  const record = (nodes: ReturnType<typeof flowNode>[]) => {
    for (const n of nodes) posMemory.set(n.id, n.position);
  };

  // Render 1: the pending synthetic (id === proposal id) is on-screen at (100,200).
  let cur = [flowNode("prop-1", 100, 200)];

  // Render 2: node.ratified flipped prop-1 out of "pending" → the synthetic is
  // gone, the minted node isn't in the snapshot yet, resultNodeId not set.
  record(cur); // GraphCanvas records prev positions before every merge
  cur = mergeLayout(cur, [], { alias: new Map(), posMemory });
  expect(cur).toEqual([]); // the node is momentarily absent — the two-render gap

  // Render 3: the snapshot refetch lands → minted node-9 appears with a fresh
  // dagre slot, and resultNodeId now yields the alias. posMemory still holds
  // prop-1's spot from render 1, so the node lands there — no jump.
  record(cur);
  cur = mergeLayout(cur, [flowNode("node-9", 777, 777)], {
    alias: new Map([["node-9", "prop-1"]]),
    posMemory,
  });
  expect(cur[0]?.position).toEqual({ x: 100, y: 200 });
});

// R12 EDGEPAINT — the vanishing edge (and the node it hangs off).
//
// React Flow writes its ResizeObserver measurement back into OUR node objects
// (`measured`, via onNodesChange → applyNodeChanges). Every rebuild here starts
// from a freshly-derived node that has no such field, so a rebuild that doesn't
// carry it WIPES the measurement. An unmeasured node is rendered
// visibility:hidden and getEdgePosition returns null for every edge touching
// it — the edge is absent from the DOM while present and correct in the `edges`
// prop, and it does NOT self-heal (the re-measure waits on a box change that
// never comes). Measured live at 8/24 trials before this carry, 0/24 after.
//
// These are the authoritative proof: the live symptom is a third-party render
// consequence, but the CAUSE is exactly the dropped field asserted below.

const MEASURED = { width: 190, height: 76 };

test("EDGEPAINT: a known id keeps the measurement React Flow gave it", () => {
  const prev = [flowNode("a", 100, 200, { measured: MEASURED })];
  const fresh = [flowNode("a", 999, 999)]; // a fresh derive never carries `measured`
  const [merged] = mergeLayout(prev, fresh);
  expect(merged?.measured).toEqual(MEASURED);
});

test("EDGEPAINT: a burst preserves every earlier node's measurement, not just its position", () => {
  const prev = [
    flowNode("n1", 1, 1, { measured: MEASURED }),
    flowNode("n2", 2, 2, { measured: MEASURED }),
  ];
  const fresh = [flowNode("n1", 9, 9), flowNode("n2", 9, 9), flowNode("n3", 40, 40)];
  const merged = mergeLayout(prev, fresh);
  expect(merged.find((n) => n.id === "n1")?.measured).toEqual(MEASURED);
  expect(merged.find((n) => n.id === "n2")?.measured).toEqual(MEASURED);
  // A genuinely new node has never been on screen — no false measurement.
  expect(merged.find((n) => n.id === "n3")?.measured).toBeUndefined();
});

test("EDGEPAINT: the position-RESETTING paths (mode flip, Tidy) carry measurement too", () => {
  // These were full replaces — the strongest way to break the whole board at
  // once, which is exactly why toggling the layout or hitting Tidy never
  // repaired a missing edge.
  const prev = [
    flowNode("a", 100, 200, { measured: MEASURED, selected: true }),
    flowNode("b", 300, 400, { measured: MEASURED }),
  ];
  const fresh = [flowNode("a", 1, 1), flowNode("b", 2, 2)];
  const replaced = carryMeasured(prev, fresh);
  expect(replaced.map((n) => n.position)).toEqual([
    { x: 1, y: 1 },
    { x: 2, y: 2 },
  ]); // positions genuinely reset
  expect(replaced.every((n) => n.measured === MEASURED)).toBe(true); // measurement kept
});

test("EDGEPAINT: width/height ride along when React Flow set them, and stay absent when it didn't", () => {
  const withAttrs = [flowNode("a", 0, 0, { measured: MEASURED, width: 190, height: 76 })];
  const [a] = mergeLayout(withAttrs, [flowNode("a", 9, 9)]);
  expect([a?.width, a?.height]).toEqual([190, 76]);

  const withoutAttrs = [flowNode("b", 0, 0, { measured: MEASURED })];
  const [b] = mergeLayout(withoutAttrs, [flowNode("b", 9, 9)]);
  expect("width" in (b ?? {})).toBe(false);
});

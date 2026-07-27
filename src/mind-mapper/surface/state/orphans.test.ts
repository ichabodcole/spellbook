// R12 SEAM 6 — the orphan (unconnected ratified node) derive.
//
// The cry-wolf tests are the point of this file: the NORMAL ratification flow
// (ratify the nodes, then their edges a moment later) must NOT flag anything,
// because the pending edge proposals are still on the wire and still name the
// node. Only when that intent is GONE (drive #10: the agent deleted its own
// pending edges) does the marker appear.

import { expect, test } from "bun:test";
import type { MapEdge, MapNode, Proposal } from "../types";
import { orphanNodeIds } from "./orphans";

function node(id: string, over: Partial<MapNode> = {}): MapNode {
  return { id, title: id, kind: "concept", tier: "canon", synopsis: "", ...over };
}

function edge(id: string, source: string, target: string): MapEdge {
  return { id, source, target, label: "", provenance: "asserted" };
}

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "node",
    draft: {},
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...over,
  };
}

function edgeProposal(id: string, source: string, target: string, over: Partial<Proposal> = {}) {
  return proposal(id, { kind: "edge", draft: { source, target, label: "" }, ...over });
}

test("a ratified node with no edges and no pending edge intent is an orphan", () => {
  const orphans = orphanNodeIds([node("a"), node("b")], [edge("e1", "b", "b")], []);
  expect(orphans.has("a")).toBe(true);
});

test("a node with any real edge (either direction) is not an orphan", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const orphans = orphanNodeIds(nodes, [edge("e1", "a", "b")], []);
  expect(orphans.has("a")).toBe(false);
  expect(orphans.has("b")).toBe(false);
  expect(orphans.has("c")).toBe(true);
});

// The falsification the seam asked for, stated as a test: the ordinary
// ratify-node-then-ratify-its-edge flow must be SILENT.
test("CRY-WOLF: a just-ratified node whose edge is still a pending proposal is NOT flagged", () => {
  const nodes = [node("real-a"), node("real-b")];
  const proposals = [
    // both node proposals ratified — each carries its minted node id
    proposal("p-a", { status: "ratified", resultNodeId: "real-a" }),
    proposal("p-b", { status: "ratified", resultNodeId: "real-b" }),
    // the edge is still pending and still names the OLD proposal ids
    edgeProposal("p-e", "p-a", "p-b"),
  ];
  expect([...orphanNodeIds(nodes, [], proposals)]).toEqual([]);
});

test("DRIVE-10: deleting the pending edges is what makes the nodes read as orphans", () => {
  const nodes = [node("real-a"), node("real-b")];
  const proposals = [
    proposal("p-a", { status: "ratified", resultNodeId: "real-a" }),
    proposal("p-b", { status: "ratified", resultNodeId: "real-b" }),
  ];
  const orphans = orphanNodeIds(nodes, [], proposals);
  expect(orphans.has("real-a")).toBe(true);
  expect(orphans.has("real-b")).toBe(true);
});

test("a pending edge naming the REAL node id also suppresses the marker", () => {
  const nodes = [node("a"), node("b")];
  const orphans = orphanNodeIds(nodes, [], [edgeProposal("p-e", "a", "b")]);
  expect([...orphans]).toEqual([]);
});

test("a REJECTED or already-ratified edge proposal carries no intent", () => {
  const nodes = [node("a"), node("b")];
  const proposals = [
    edgeProposal("p-r", "a", "b", { status: "rejected" }),
    edgeProposal("p-d", "a", "b", { status: "ratified" }),
  ];
  // (a ratified edge proposal's edge lives in `edges` — counting the proposal
  // too would double-count, and a rejected one is a decision AGAINST the edge)
  expect(orphanNodeIds(nodes, [], proposals).size).toBe(2);
});

test("a ZONED pending edge proposal still counts as intent (zone-blind by ruling)", () => {
  const nodes = [node("a"), node("b")];
  const orphans = orphanNodeIds(nodes, [], [edgeProposal("p-e", "a", "b", { zoneId: "sandbox" })]);
  expect([...orphans]).toEqual([]);
});

test("submap containment counts as connection (both ends of the anchor)", () => {
  const nodes = [
    node("parent", { submapChildCount: 1 }),
    node("child", { anchorNodeId: "parent" }),
    node("loner"),
  ];
  const orphans = orphanNodeIds(nodes, [], []);
  expect([...orphans]).toEqual(["loner"]);
});

test("a lone node on a fresh map is NOT an orphan (nothing to connect to)", () => {
  expect(orphanNodeIds([node("only")], [], []).size).toBe(0);
  expect(orphanNodeIds([], [], []).size).toBe(0);
});

test("pending synthetic nodes are never flagged (staging is unconnected by nature)", () => {
  const nodes = [node("a"), node("b"), node("p-x", { pending: true })];
  const orphans = orphanNodeIds(nodes, [edge("e1", "a", "b")], []);
  expect(orphans.has("p-x")).toBe(false);
});

test("an edge to a node that isn't on the board doesn't rescue the other end", () => {
  // (defensive: a half-resolved edge still names this node, so it counts —
  // the derive reports what the wire says, it never second-guesses it)
  const orphans = orphanNodeIds([node("a"), node("b")], [edge("e1", "a", "ghost")], []);
  expect(orphans.has("a")).toBe(false);
  expect(orphans.has("b")).toBe(true);
});

test("a malformed edge proposal draft is ignored, not treated as intent", () => {
  const nodes = [node("a"), node("b")];
  const proposals = [proposal("p-e", { kind: "edge", draft: { source: "a" } })];
  expect(orphanNodeIds(nodes, [], proposals).size).toBe(2);
});

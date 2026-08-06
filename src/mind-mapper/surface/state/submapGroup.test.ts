// Pure-logic tests for the R6 group-under-a-node-as-a-submap gesture.

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import { ratifiedSelection, submapChildTargets } from "./submapGroup";

function node(id: string, over: Partial<MapNode> = {}): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "", ...over };
}

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "node",
    draft: { title: id },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...over,
  };
}

const nodes = [node("a"), node("b"), node("c")];

test("keeps only real ratified nodes in the selection, preserving selection order", () => {
  const sel = ratifiedSelection(nodes, [], ["b", "a"]);
  expect(sel.map((n) => n.id)).toEqual(["b", "a"]);
});

test("excludes a pending synthetic (its id names a pending proposal — anchor is real-nodes-only)", () => {
  // "p" is a pending synthetic on the board (id === proposal id).
  const board = [...nodes, node("p", { pending: true })];
  const proposals = [proposal("p")];
  expect(ratifiedSelection(board, proposals, ["a", "p"]).map((n) => n.id)).toEqual(["a"]);
});

test("drops ids that name no node at all", () => {
  expect(ratifiedSelection(nodes, [], ["a", "ghost"]).map((n) => n.id)).toEqual(["a"]);
});

test("submapChildTargets is every selected node except the chosen parent", () => {
  expect(submapChildTargets(["a", "b", "c"], "a")).toEqual(["b", "c"]);
});

test("submapChildTargets never returns the parent (no self-anchor the daemon would refuse)", () => {
  expect(submapChildTargets(["a", "b"], "b")).toEqual(["a"]);
});

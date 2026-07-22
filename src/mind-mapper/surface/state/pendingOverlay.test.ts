// Pure-logic tests for the P2.4 pending overlay — proposal-to-synthetic-
// node/edge derivation never touches React or the network.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { pendingEdgesFrom, pendingNodesFrom, resultNodeIdMap } from "./pendingOverlay";

function nodeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    kind: "node",
    draft: { title: "The story-toll", synopsis: "Paid in untold stories.", kind: "concept" },
    evidence: { docId: "toll-ramble", messageId: null, span: "a story you have never told" },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...overrides,
  };
}

test("a pending node proposal becomes a synthetic MapNode with pending:true and its evidence as sources", () => {
  const [node] = pendingNodesFrom([nodeProposal()]);
  expect(node).toMatchObject({
    id: "prop-1",
    title: "The story-toll",
    kind: "concept",
    tier: "thread",
    pending: true,
    sources: [{ docId: "toll-ramble", span: "a story you have never told" }],
  });
});

test("a non-pending (already-ruled) proposal is excluded", () => {
  expect(pendingNodesFrom([nodeProposal({ status: "ratified" })])).toEqual([]);
});

// PROC (R6) — the client-only `processing` overlay, off the wire's `author`.

test("a pending author:user proposal's synthetic node carries processing:true", () => {
  const [node] = pendingNodesFrom([nodeProposal({ author: "user" })]);
  expect(node?.processing).toBe(true);
});

test("a pending agent proposal's synthetic node is not processing (a normal sketch)", () => {
  const [node] = pendingNodesFrom([nodeProposal({ author: "agent" })]);
  expect(node?.processing).toBe(false);
});

test("an edge-kind proposal is excluded from node derivation", () => {
  expect(
    pendingNodesFrom([nodeProposal({ kind: "edge", draft: { source: "a", target: "b" } })]),
  ).toEqual([]);
});

test("an untrusted draft.kind falls back to 'concept', an untrusted suggestedTier falls back to 'thread'", () => {
  const [node] = pendingNodesFrom([
    nodeProposal({
      draft: { title: "x", kind: "not-a-real-kind" },
      suggestedTier: "not-a-tier" as unknown as Proposal["suggestedTier"],
    }),
  ]);
  expect(node?.kind).toBe("concept");
  expect(node?.tier).toBe("thread");
});

test("message-grounded evidence becomes a message source on the synthetic node (Claim E)", () => {
  const [node] = pendingNodesFrom([
    nodeProposal({ evidence: { docId: null, messageId: "m-1", span: "said in passing" } }),
  ]);
  expect(node?.sources).toEqual([{ messageId: "m-1", span: "said in passing" }]);
});

test("a missing evidence.docId means no sources array, not an empty one", () => {
  const [node] = pendingNodesFrom([
    nodeProposal({ evidence: { docId: null, messageId: null, span: null } }),
  ]);
  expect(node?.sources).toBeUndefined();
});

test("a pending edge proposal becomes a synthetic MapEdge with pending:true", () => {
  const [edge] = pendingEdgesFrom([
    nodeProposal({
      id: "prop-2",
      kind: "edge",
      draft: { source: "maren", target: "the-hollow", label: "returns to" },
    }),
  ]);
  expect(edge).toMatchObject({
    id: "prop-2",
    source: "maren",
    target: "the-hollow",
    label: "returns to",
    pending: true,
    provenance: "asserted",
  });
});

test("an edge proposal missing source or target is dropped, not rendered as a dangling half-edge", () => {
  expect(
    pendingEdgesFrom([
      nodeProposal({ id: "prop-3", kind: "edge", draft: { target: "the-hollow" } }),
    ]),
  ).toEqual([]);
});

// EF (finding #8) — the re-point that keeps a pending edge attached when its
// endpoint node proposal ratifies (and gets a fresh minted node id).

test("resultNodeIdMap maps a ratified proposal's id to its minted node id, skips proposals with none", () => {
  const map = resultNodeIdMap([
    nodeProposal({ id: "p-ratified", status: "ratified", resultNodeId: "node-77" }),
    nodeProposal({ id: "p-pending" }),
  ]);
  expect(map.get("p-ratified")).toBe("node-77");
  expect(map.has("p-pending")).toBe(false);
});

test("a pending edge whose endpoint proposal ratified re-points to the minted node id (does not dangle)", () => {
  const resolve = new Map([["p-src", "node-77"]]);
  const [edge] = pendingEdgesFrom(
    [nodeProposal({ id: "e-1", kind: "edge", draft: { source: "p-src", target: "the-hollow" } })],
    resolve,
  );
  // The endpoint was the OLD proposal id p-src; now it points at the real node.
  expect(edge?.source).toBe("node-77");
  expect(edge?.target).toBe("the-hollow");
});

test("an endpoint with no mapping passes through unchanged", () => {
  const [edge] = pendingEdgesFrom(
    [nodeProposal({ id: "e-2", kind: "edge", draft: { source: "still-pending", target: "b" } })],
    new Map([["someone-else", "node-9"]]),
  );
  expect(edge?.source).toBe("still-pending");
  expect(edge?.target).toBe("b");
});

test("a re-pointed edge is NOT dropped by the emptiness filter (the vanishing-edge bug)", () => {
  const resolve = new Map([
    ["p-a", "node-a"],
    ["p-b", "node-b"],
  ]);
  const edges = pendingEdgesFrom(
    [nodeProposal({ id: "e-3", kind: "edge", draft: { source: "p-a", target: "p-b" } })],
    resolve,
  );
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ source: "node-a", target: "node-b", pending: true });
});

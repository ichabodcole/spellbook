// Pure-logic tests for the P2.4 pending overlay — proposal-to-synthetic-
// node/edge derivation never touches React or the network.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { pendingEdgesFrom, pendingNodesFrom } from "./pendingOverlay";

function nodeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop-1",
    kind: "node",
    draft: { title: "The story-toll", synopsis: "Paid in untold stories.", kind: "concept" },
    evidence: { docId: "toll-ramble", span: "a story you have never told" },
    suggestedTier: "thread",
    status: "pending",
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

test("a missing evidence.docId means no sources array, not an empty one", () => {
  const [node] = pendingNodesFrom([nodeProposal({ evidence: { docId: null, span: null } })]);
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

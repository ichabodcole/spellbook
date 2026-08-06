// Pure-logic test for the delete flow's 409-body parse (Claim A) — the
// fetch glue is live-verified; the untrusted-body discrimination is not.

import { expect, test } from "bun:test";
import { parseCitedBody, parseNodeCitedBody } from "./deleteFlow";

test("a well-formed cited 409 body parses to its counts", () => {
  expect(parseCitedBody({ error: "cited", citedBy: { nodes: 3, proposals: 1 } })).toEqual({
    nodes: 3,
    proposals: 1,
  });
});

test("zero counts are still a valid cited body (0 nodes, 2 pending proposals)", () => {
  expect(parseCitedBody({ error: "cited", citedBy: { nodes: 0, proposals: 2 } })).toEqual({
    nodes: 0,
    proposals: 2,
  });
});

test("a different error shape returns null (caller degrades to the generic notice)", () => {
  expect(parseCitedBody({ error: "unknown doc" })).toBeNull();
});

test("a cited error with malformed counts returns null, never fabricated numbers", () => {
  expect(parseCitedBody({ error: "cited", citedBy: { nodes: "3", proposals: 1 } })).toBeNull();
  expect(parseCitedBody({ error: "cited", citedBy: null })).toBeNull();
  expect(parseCitedBody({ error: "cited" })).toBeNull();
});

test("non-object bodies return null", () => {
  expect(parseCitedBody(null)).toBeNull();
  expect(parseCitedBody("cited")).toBeNull();
  expect(parseCitedBody(undefined)).toBeNull();
});

// Round 6 (DEL) — the NODE delete cited-guard (edges + children, not
// nodes + proposals).

test("a well-formed node-cited 409 body parses to its edge + child counts", () => {
  expect(parseNodeCitedBody({ error: "cited", citedBy: { edges: 2, children: 3 } })).toEqual({
    edges: 2,
    children: 3,
  });
});

test("zero counts are a valid node-cited body (0 edges, 0 children — still forced)", () => {
  expect(parseNodeCitedBody({ error: "cited", citedBy: { edges: 0, children: 0 } })).toEqual({
    edges: 0,
    children: 0,
  });
});

test("the DOC cited shape (nodes/proposals) is NOT a node-cited body", () => {
  // The two 409s share error:"cited" but carry disjoint fields — a node
  // delete must never render the doc shape's counts, and vice-versa.
  expect(parseNodeCitedBody({ error: "cited", citedBy: { nodes: 3, proposals: 1 } })).toBeNull();
  expect(parseCitedBody({ error: "cited", citedBy: { edges: 2, children: 3 } })).toBeNull();
});

test("a node-cited error with malformed counts returns null, never fabricated numbers", () => {
  expect(parseNodeCitedBody({ error: "cited", citedBy: { edges: "2", children: 3 } })).toBeNull();
  expect(parseNodeCitedBody({ error: "cited", citedBy: null })).toBeNull();
  expect(parseNodeCitedBody({ error: "cited" })).toBeNull();
});

test("non-object / non-cited bodies return null for the node parser too", () => {
  expect(parseNodeCitedBody(null)).toBeNull();
  expect(parseNodeCitedBody("cited")).toBeNull();
  expect(parseNodeCitedBody({ error: "unknown node" })).toBeNull();
});

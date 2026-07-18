// Pure-logic test for the delete flow's 409-body parse (Claim A) — the
// fetch glue is live-verified; the untrusted-body discrimination is not.

import { expect, test } from "bun:test";
import { parseCitedBody } from "./deleteFlow";

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

// Round 7 (TAGS) — the client-side tag curation rules (finding #4: reuse-suggest
// has zero engine support by design; the existing-tag set is a pure derive over
// the wire we already hold).

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import { addTag, existingTags, removeTag, tagSuggestions } from "./tags";

function node(id: string, tags?: string[]): MapNode {
  return {
    id,
    title: id,
    kind: "concept",
    tier: "thread",
    synopsis: "",
    ...(tags ? { tags } : {}),
  };
}

function proposal(id: string, tags?: string[]): Proposal {
  return {
    id,
    kind: "node",
    draft: {},
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...(tags ? { tags } : {}),
  };
}

test("existingTags unions nodes + proposals, dedupes and sorts", () => {
  const nodes = [node("a", ["zeta", "alpha"]), node("b", ["alpha"])];
  const proposals = [proposal("p1", ["mid", "zeta"])];
  expect(existingTags(nodes, proposals)).toEqual(["alpha", "mid", "zeta"]);
});

test("existingTags treats an absent tags key as none (no empty bucket)", () => {
  expect(existingTags([node("a"), node("b", [])], [proposal("p1")])).toEqual([]);
});

test("tagSuggestions excludes tags already on the target", () => {
  expect(tagSuggestions(["alpha", "beta", "gamma"], ["beta"], "")).toEqual(["alpha", "gamma"]);
});

test("tagSuggestions filters by a case-insensitive substring of the query", () => {
  expect(tagSuggestions(["Alpha", "beta", "Alabama"], [], "al")).toEqual(["Alpha", "Alabama"]);
});

test("addTag trims, dedupes, and is a no-op (same identity) on empty/duplicate", () => {
  const current = ["alpha"];
  expect(addTag(current, "  beta ")).toEqual(["alpha", "beta"]);
  expect(addTag(current, "alpha")).toBe(current);
  expect(addTag(current, "   ")).toBe(current);
});

test("removeTag drops the named tag", () => {
  expect(removeTag(["alpha", "beta"], "alpha")).toEqual(["beta"]);
});

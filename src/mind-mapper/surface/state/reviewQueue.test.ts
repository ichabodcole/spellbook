// Pure-logic test for the review-queue grouping — no React, no network.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { draftSummary, groupProposalsByDoc, UNGROUNDED } from "./reviewQueue";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "node",
    draft: { title: "x" },
    evidence: { docId: "doc-a", span: null },
    suggestedTier: "thread",
    status: "pending",
    ...overrides,
  };
}

test("groups pending proposals by their evidence docId", () => {
  const groups = groupProposalsByDoc([
    proposal({ id: "p1", evidence: { docId: "doc-a", span: null } }),
    proposal({ id: "p2", evidence: { docId: "doc-a", span: null } }),
    proposal({ id: "p3", evidence: { docId: "doc-b", span: null } }),
  ]);
  expect(groups.get("doc-a")?.map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(groups.get("doc-b")?.map((p) => p.id)).toEqual(["p3"]);
});

test("a proposal with no evidence docId (an orphan) lands in the UNGROUNDED bucket", () => {
  const groups = groupProposalsByDoc([
    proposal({ id: "orphan", evidence: { docId: null, span: null } }),
  ]);
  expect(groups.get(UNGROUNDED)?.map((p) => p.id)).toEqual(["orphan"]);
});

test("non-pending proposals (already ruled) are excluded entirely", () => {
  const groups = groupProposalsByDoc([
    proposal({ status: "ratified" }),
    proposal({ status: "rejected" }),
  ]);
  expect(groups.size).toBe(0);
});

test("an empty proposal list produces an empty map", () => {
  expect(groupProposalsByDoc([]).size).toBe(0);
});

test("draftSummary for a node proposal: title + synopsis, verbatim", () => {
  expect(
    draftSummary(
      proposal({ kind: "node", draft: { title: "The story-toll", synopsis: "Paid in stories." } }),
    ),
  ).toEqual({ title: "The story-toll", detail: "Paid in stories." });
});

test("draftSummary for a node proposal missing a title falls back to 'untitled'", () => {
  expect(draftSummary(proposal({ kind: "node", draft: {} })).title).toBe("untitled");
});

test("draftSummary for an edge proposal: source — label — target, no detail line", () => {
  expect(
    draftSummary(
      proposal({
        kind: "edge",
        draft: { source: "maren", target: "the-hollow", label: "returns to" },
      }),
    ),
  ).toEqual({ title: "maren — returns to — the-hollow", detail: "" });
});

test("draftSummary for an edge proposal missing a label falls back to 'relates to'", () => {
  expect(draftSummary(proposal({ kind: "edge", draft: { source: "a", target: "b" } })).title).toBe(
    "a — relates to — b",
  );
});

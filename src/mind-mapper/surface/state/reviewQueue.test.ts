// Pure-logic test for the review-queue grouping — no React, no network.

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import {
  draftSummary,
  FROM_CONVERSATION,
  groupProposalsByDoc,
  partitionByAuthor,
  UNGROUNDED,
} from "./reviewQueue";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "node",
    draft: { title: "x" },
    evidence: { docId: "doc-a", messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    ...overrides,
  };
}

test("groups pending proposals by their evidence docId", () => {
  const groups = groupProposalsByDoc([
    proposal({ id: "p1", evidence: { docId: "doc-a", messageId: null, span: null } }),
    proposal({ id: "p2", evidence: { docId: "doc-a", messageId: null, span: null } }),
    proposal({ id: "p3", evidence: { docId: "doc-b", messageId: null, span: null } }),
  ]);
  expect(groups.get("doc-a")?.map((p) => p.id)).toEqual(["p1", "p2"]);
  expect(groups.get("doc-b")?.map((p) => p.id)).toEqual(["p3"]);
});

test("a proposal with no evidence at all (an orphan) lands in the UNGROUNDED bucket", () => {
  const groups = groupProposalsByDoc([
    proposal({ id: "orphan", evidence: { docId: null, messageId: null, span: null } }),
  ]);
  expect(groups.get(UNGROUNDED)?.map((p) => p.id)).toEqual(["orphan"]);
});

// Claim E: message-grounded proposals are NOT "ungrounded" — a conversation
// message is real evidence, so they get their own bucket.
test("a message-grounded proposal lands in the FROM_CONVERSATION bucket, not UNGROUNDED", () => {
  const groups = groupProposalsByDoc([
    proposal({ id: "conv", evidence: { docId: null, messageId: "m-1", span: "said so" } }),
    proposal({ id: "orphan", evidence: { docId: null, messageId: null, span: null } }),
  ]);
  expect(groups.get(FROM_CONVERSATION)?.map((p) => p.id)).toEqual(["conv"]);
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

// Claim D: the author partition upstream of the by-doc grouping — the
// queue's asymmetry (waiting state vs one-keystroke ruling) starts here.
test("partitionByAuthor splits pending proposals into user and agent lanes", () => {
  const { user, agent } = partitionByAuthor([
    proposal({ id: "u1", author: "user" }),
    proposal({ id: "a1", author: "agent" }),
    proposal({ id: "u2", author: "user" }),
  ]);
  expect(user.map((p) => p.id)).toEqual(["u1", "u2"]);
  expect(agent.map((p) => p.id)).toEqual(["a1"]);
});

test("partitionByAuthor excludes non-pending proposals from both lanes", () => {
  const { user, agent } = partitionByAuthor([
    proposal({ id: "u1", author: "user", status: "ratified" }),
    proposal({ id: "a1", author: "agent", status: "rejected" }),
  ]);
  expect(user).toEqual([]);
  expect(agent).toEqual([]);
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

// T10 fold-in: edge rows resolve endpoint titles when nodes are supplied —
// display resolution only, an unknown id renders as-is.
test("draftSummary resolves edge endpoint ids to node titles when nodes are passed", () => {
  const nodes: MapNode[] = [
    { id: "maren", title: "Maren", kind: "cast", tier: "canon", synopsis: "" },
    { id: "the-hollow", title: "The Hollow", kind: "place", tier: "thread", synopsis: "" },
  ];
  expect(
    draftSummary(
      proposal({ kind: "edge", draft: { source: "maren", target: "the-hollow", label: "haunts" } }),
      nodes,
    ).title,
  ).toBe("Maren — haunts — The Hollow");
});

test("draftSummary leaves an unresolvable edge endpoint id as-is", () => {
  expect(
    draftSummary(proposal({ kind: "edge", draft: { source: "ghost-id", target: "b" } }), []).title,
  ).toBe("ghost-id — relates to — b");
});

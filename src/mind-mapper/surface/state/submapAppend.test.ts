// Round 7 (SUBMAPPEND) — the pending-group ratify-batch payload rules.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { buildSubmapAppend, pendingNodeProposalIds } from "./submapAppend";

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

test("pendingNodeProposalIds keeps only pending main-queue NODE proposals in selection", () => {
  const proposals = [
    proposal("n1"),
    proposal("n2"),
    proposal("edge1", { kind: "edge" }),
    proposal("zoned", { zoneId: "z" }),
    proposal("done", { status: "ratified" }),
  ];
  const out = pendingNodeProposalIds(proposals, ["n1", "edge1", "zoned", "done", "n2", "unknown"]);
  expect(out).toEqual(["n1", "n2"]);
});

test("buildSubmapAppend — a pending parent is excluded from its own children", () => {
  const { ids, anchors } = buildSubmapAppend(["p1", "p2", "p3"], "p1");
  expect(ids).toEqual(["p1", "p2", "p3"]);
  expect(anchors).toEqual([
    { node: "p2", parent: "p1" },
    { node: "p3", parent: "p1" },
  ]);
});

test("buildSubmapAppend — an EXTERNAL real-node parent nests every pending child under it", () => {
  const { ids, anchors } = buildSubmapAppend(["p1", "p2"], "real-node");
  expect(ids).toEqual(["p1", "p2"]);
  expect(anchors).toEqual([
    { node: "p1", parent: "real-node" },
    { node: "p2", parent: "real-node" },
  ]);
});

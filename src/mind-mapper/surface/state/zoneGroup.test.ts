// Pure-logic tests for the IC-c group-into-zone selection scope.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { selectedPendingProposalIds } from "./zoneGroup";

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "node",
    draft: { title: id },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "user",
    zoneId: null,
    ...over,
  };
}

const proposals = [
  proposal("p-pending"),
  proposal("p-zoned", { zoneId: "z1" }),
  proposal("p-ratified", { status: "ratified" }),
];

test("keeps only pending main-queue proposals in the selection", () => {
  const ids = selectedPendingProposalIds(proposals, ["p-pending", "node-real", "p-ratified"]);
  expect(ids).toEqual(["p-pending"]);
});

test("excludes already-zoned proposals (not on the main board)", () => {
  expect(selectedPendingProposalIds(proposals, ["p-zoned"])).toEqual([]);
});

test("preserves selection order and drops unknown ids", () => {
  const two = [...proposals, proposal("p2")];
  expect(selectedPendingProposalIds(two, ["p2", "unknown", "p-pending"])).toEqual([
    "p2",
    "p-pending",
  ]);
});

test("empty selection → empty", () => {
  expect(selectedPendingProposalIds(proposals, [])).toEqual([]);
});

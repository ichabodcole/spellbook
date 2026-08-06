// drive7 #6A — pure tests for the selection-aware context menu's eligibility
// logic (the clicked node designates the submap parent/anchor). The rendering
// is exercised live; here we pin which multi-actions each clicked node offers
// over a given selection.

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import { multiSelectActions } from "./multiSelect";

function node(id: string): MapNode {
  return { id, title: id, kind: "concept", tier: "thread", synopsis: "" };
}

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "node",
    draft: { title: id },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...overrides,
  };
}

test("under two selected ratified nodes, the clicked one is a valid submap anchor", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const got = multiSelectActions("a", ["a", "b"], nodes, [], null);
  expect(got?.groupSubmap).toBe(true);
  expect(got?.nestSubmap).toBe(false);
});

test("right-clicking a node OUTSIDE the selection keeps its single menu (no multi-section)", () => {
  const nodes = [node("a"), node("b"), node("c")];
  // c isn't selected — its menu stays single-node even though a & b are.
  expect(multiSelectActions("c", ["a", "b"], nodes, [], null)).toBeNull();
});

test("a selected ratified node clicked alongside pendings offers zone-grouping but not anchor", () => {
  const nodes = [node("x")];
  const proposals = [proposal("p1"), proposal("p2")];
  // x is a selected ratified node; p1/p2 are selected pendings. x can't anchor
  // pendings (nest is for pending-parents), but zone-grouping still applies.
  const got = multiSelectActions("x", ["x", "p1", "p2"], nodes, proposals, null);
  expect(got?.groupSubmap).toBe(false); // only one ratified node selected
  expect(got?.nestSubmap).toBe(false); // x isn't a pending proposal
  expect(got?.groupZone).toBe(true);
});

test("under two selected pending node proposals, the clicked one can nest the group", () => {
  const proposals = [proposal("p1"), proposal("p2")];
  const got = multiSelectActions("p1", ["p1", "p2"], [], proposals, null);
  expect(got?.nestSubmap).toBe(true);
  expect(got?.groupZone).toBe(true); // pending proposals can also group into a zone
});

test("a single selection surfaces no multi-actions (single-select keeps today's menu)", () => {
  expect(multiSelectActions("a", ["a"], [node("a")], [], null)).toBeNull();
});

test("inside a zone, the submap gestures are off (a zone holds proposals, not ratified nodes)", () => {
  const nodes = [node("a"), node("b")];
  expect(multiSelectActions("a", ["a", "b"], nodes, [], "sandbox")).toBeNull();
});

test("group-into-zone needs at least one pending main-queue proposal in the selection", () => {
  // Two ratified nodes only — no pending proposal, so no zone grouping.
  const got = multiSelectActions("a", ["a", "b"], [node("a"), node("b")], [], null);
  expect(got?.groupZone).toBe(false);
});

// #6B snapshot invariant — the modals/gestures capture their eligible ids at
// open, independent of a later selection change (an errant canvas click that
// deselects can't yank the group out from under them). ratifiedSelection
// returns a FRESH array, so a captured snapshot is decoupled from selectedIds.
test("#6B: an eligibility snapshot is independent of a later selection change", () => {
  const nodes = [node("a"), node("b"), node("c")];
  const proposals: Proposal[] = [];
  const first = multiSelectActions("a", ["a", "b"], nodes, proposals, null);
  // Selection collapses to nothing afterwards — the earlier result is unchanged.
  const cleared = multiSelectActions("a", [], nodes, proposals, null);
  expect(first?.groupSubmap).toBe(true);
  expect(cleared).toBeNull();
});

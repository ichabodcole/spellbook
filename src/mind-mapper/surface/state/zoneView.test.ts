// Pure-logic tests for the Z3 zone-view derivation and the Z1 segregation
// rule. The ratified clause under test: with the INCLUSIVE store, snapshot
// merge and event upsert feed the same proposals[] — so the ONE mainProposals
// filter IS the main view's segregation at both ingestion points, and the
// test proves it by driving both paths into the same derivation.

import { expect, test } from "bun:test";
import type { ProjectState, Proposal } from "../types";
import { pendingNodesFrom } from "./pendingOverlay";
import { applyEvent } from "./reducer";
import { mainProposals, zoneMapFrom, zoneOf } from "./zoneView";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "node",
    draft: { title: "The story-toll", synopsis: "Paid in untold stories.", kind: "concept" },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...overrides,
  };
}

test("mainProposals keeps only zoneId == null rows (zoned rows stay in the store, off the main board)", () => {
  const all = [
    proposal({ id: "main-1" }),
    proposal({ id: "z-1", zoneId: "wild" }),
    proposal({ id: "main-2" }),
  ];
  expect(mainProposals(all).map((p) => p.id)).toEqual(["main-1", "main-2"]);
});

// The both-ingestion-points clause, exercised end to end: a zoned proposal
// arriving via the SNAPSHOT (already in proposals[]) and one arriving via a
// proposal.added EVENT land in the same inclusive store, and the single
// mainProposals filter excludes both from the main overlay derivation.
test("a zoned row is segregated from the main view whether it arrived by snapshot or by event", () => {
  const snapshotState: ProjectState = {
    project: { id: "p", title: "P" },
    docs: [],
    nodes: [],
    edges: [],
    zones: [{ id: "wild", name: "Wild" }],
    proposals: [proposal({ id: "via-snapshot", zoneId: "wild" }), proposal({ id: "main-1" })],
    conversation: [],
    lens: null,
    cursor: 1,
    presence: { agents: 0 },
  };
  const afterEvent = applyEvent(snapshotState, {
    seq: 2,
    kind: "proposal.added",
    payload: proposal({ id: "via-event", zoneId: "wild" }),
  });
  // Both zoned rows are IN the store (inclusive)…
  expect(afterEvent.proposals.map((p) => p.id).sort()).toEqual([
    "main-1",
    "via-event",
    "via-snapshot",
  ]);
  // …and the one main-view rule excludes both from the pending overlay.
  const mainNodes = pendingNodesFrom(mainProposals(afterEvent.proposals));
  expect(mainNodes.map((n) => n.id)).toEqual(["main-1"]);
});

test("zoneMapFrom renders the zone's proposals UN-DASHED (pending suppressed at derivation)", () => {
  const { nodes } = zoneMapFrom([proposal({ id: "z-1", zoneId: "wild" })], "wild", []);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.id).toBe("z-1");
  expect(nodes[0]?.pending).toBe(false);
});

test("zoneMapFrom excludes other zones' and main-queue proposals", () => {
  const { nodes } = zoneMapFrom(
    [
      proposal({ id: "z-1", zoneId: "wild" }),
      proposal({ id: "other", zoneId: "tame" }),
      proposal({ id: "main-1" }),
    ],
    "wild",
    [],
  );
  expect(nodes.map((n) => n.id)).toEqual(["z-1"]);
});

test("a zoned edge pulls its REAL endpoint nodes in as context, full-strength", () => {
  const real = [
    { id: "maren", title: "Maren", kind: "cast" as const, tier: "canon" as const, synopsis: "" },
  ];
  const { nodes, edges } = zoneMapFrom(
    [
      proposal({ id: "z-n", zoneId: "wild" }),
      proposal({
        id: "z-e",
        zoneId: "wild",
        kind: "edge",
        draft: { source: "z-n", target: "maren", label: "haunts" },
      }),
    ],
    "wild",
    real,
  );
  expect(nodes.map((n) => n.id).sort()).toEqual(["maren", "z-n"]);
  expect(nodes.find((n) => n.id === "maren")?.pending).toBeUndefined();
  expect(edges).toHaveLength(1);
  expect(edges[0]?.pending).toBe(false);
});

test("a context endpoint that is a MAIN-pending synthetic keeps its dashed pending styling (honest 'this one left')", () => {
  // App passes the pending-merged main board as realNodes, so a zoned edge
  // whose endpoint was just promoted still renders — the endpoint wearing
  // its main-queue staging marks inside the zone.
  const promotedSynthetic = {
    id: "just-promoted",
    title: "Just promoted",
    kind: "concept" as const,
    tier: "thread" as const,
    synopsis: "",
    pending: true,
  };
  const { nodes, edges } = zoneMapFrom(
    [
      proposal({ id: "z-n", zoneId: "wild" }),
      proposal({
        id: "z-e",
        zoneId: "wild",
        kind: "edge",
        draft: { source: "z-n", target: "just-promoted", label: "binds" },
      }),
    ],
    "wild",
    [promotedSynthetic],
  );
  expect(edges).toHaveLength(1);
  expect(nodes.find((n) => n.id === "just-promoted")?.pending).toBe(true);
});

test("a zoned edge whose endpoint resolves to nothing in the view is dropped, not dangled", () => {
  const { edges } = zoneMapFrom(
    [
      proposal({
        id: "z-e",
        zoneId: "wild",
        kind: "edge",
        draft: { source: "ghost", target: "also-ghost", label: "?" },
      }),
    ],
    "wild",
    [],
  );
  expect(edges).toEqual([]);
});

test("zoneOf: zoned pending proposal → its zone; main pending → null; real node / ratified → undefined", () => {
  const proposals = [
    proposal({ id: "z-1", zoneId: "wild" }),
    proposal({ id: "main-1" }),
    proposal({ id: "done", zoneId: "wild", status: "ratified" }),
  ];
  expect(zoneOf(proposals, "z-1")).toBe("wild");
  expect(zoneOf(proposals, "main-1")).toBeNull();
  expect(zoneOf(proposals, "done")).toBeUndefined();
  expect(zoneOf(proposals, "maren")).toBeUndefined();
});

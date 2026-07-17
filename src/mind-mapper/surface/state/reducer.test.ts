// Pure-logic tests for the P1 wire reducer (plan/circe.md P1.2) — event
// application and gap detection never touch React or the network, so they're
// exercised directly. The socket lifecycle that feeds this is DOM/network and
// gets a live verify pass instead (matches the imago fileIntake precedent).

import { expect, test } from "bun:test";
import type { ProjectState, ServerEvent } from "../types";
import { applyEvent, isGap } from "./reducer";

function baseState(): ProjectState {
  return {
    project: { id: "p1", title: "Hollowbrook" },
    docs: [],
    nodes: [{ id: "maren", title: "Maren", kind: "cast", tier: "canon", synopsis: "..." }],
    edges: [],
    proposals: [
      {
        id: "prop-1",
        kind: "node",
        draft: { title: "The Hollow" },
        evidence: { docId: "ramble-01", span: null },
        suggestedTier: "thread",
        status: "pending",
      },
    ],
    conversation: [],
    lens: { owner: null, nodeId: null, depth: 1 },
    cursor: 5,
  };
}

test("doc.added appends a new doc and advances cursor", () => {
  const event: ServerEvent = {
    seq: 6,
    kind: "doc.added",
    payload: { id: "ramble-02", title: "Ramble 2", kind: "ramble" },
  };
  const next = applyEvent(baseState(), event);
  expect(next.docs).toEqual([{ id: "ramble-02", title: "Ramble 2", kind: "ramble" }]);
  expect(next.cursor).toBe(6);
});

// node.ratified/edge.ratified carry ONLY {id, proposalId} (ratify.ts) —
// never the full ratified entity (cassandra's P3 gate finding, t-bdd3136e:
// the reducer previously tried to upsert this partial payload AS a MapNode,
// and never touched proposals at all, so the review badge/queue never
// cleared without a full reload). The reducer's real job here is just
// flipping the matching proposal out of "pending"; useProjectState is
// responsible for the follow-up snapshot refetch that backfills the real
// node/edge this payload doesn't carry.
test("node.ratified flips the matching proposal to ratified and does NOT fabricate a node", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "node.ratified",
    payload: { id: "the-hollow", proposalId: "prop-1" },
  });
  expect(next.proposals[0]?.status).toBe("ratified");
  expect(next.nodes).toEqual(baseState().nodes);
});

test("edge.ratified flips the matching proposal to ratified and does NOT fabricate an edge", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "edge.ratified",
    payload: { id: "e1", proposalId: "prop-1" },
  });
  expect(next.proposals[0]?.status).toBe("ratified");
  expect(next.edges).toEqual([]);
});

test("a ratified event whose proposalId matches nothing is a harmless no-op on proposals", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "node.ratified",
    payload: { id: "x", proposalId: "no-such-proposal" },
  });
  expect(next.proposals).toEqual(baseState().proposals);
});

test("proposal.added upserts by id into proposals", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "proposal.added",
    payload: {
      id: "prop-1",
      kind: "node",
      draft: { title: "New idea" },
      evidence: { docId: "ramble-01" },
      suggestedTier: "thread",
      status: "pending",
    },
  });
  expect(next.proposals).toHaveLength(1);
  expect(next.proposals[0]?.id).toBe("prop-1");
});

test("message.posted appends the wire message to conversation", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "message.posted",
    payload: {
      id: "m1",
      seq: 1,
      role: "agent",
      kind: "info",
      text: "hi",
      ground: null,
      ts: 1700000000,
    },
  });
  expect(next.conversation).toHaveLength(1);
  expect(next.conversation[0]?.role).toBe("agent");
});

test("lens.set replaces the lens wholesale", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "lens.set",
    payload: { owner: "agent", nodeId: "maren", depth: 2 },
  });
  expect(next.lens).toEqual({ owner: "agent", nodeId: "maren", depth: 2 });
});

test("an event at or before the current cursor is a no-op (dedupe on resume)", () => {
  const state = baseState();
  const next = applyEvent(state, {
    seq: 5,
    kind: "doc.added",
    payload: { id: "x", title: "x", kind: "ramble" },
  });
  expect(next).toBe(state);
});

test("an unknown event kind is ignored, not thrown, but still advances the cursor", () => {
  const next = applyEvent(baseState(), {
    // biome-ignore lint/suspicious/noExplicitAny: exercising an unrecognized wire kind on purpose
    kind: "something.new" as any,
    seq: 6,
    payload: { anything: true },
  });
  expect(next.cursor).toBe(6);
  expect(next.nodes).toEqual(baseState().nodes);
});

test("isGap: seq immediately after cursor is not a gap", () => {
  expect(isGap(5, 6)).toBe(false);
});

test("isGap: a skipped seq is a gap", () => {
  expect(isGap(5, 8)).toBe(true);
});

test("isGap: a stale/duplicate seq is not treated as a gap (it's a no-op, handled separately)", () => {
  expect(isGap(5, 5)).toBe(false);
  expect(isGap(5, 3)).toBe(false);
});

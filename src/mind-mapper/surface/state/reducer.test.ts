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
    zones: [],
    proposals: [
      {
        id: "prop-1",
        kind: "node",
        draft: { title: "The Hollow" },
        evidence: { docId: "ramble-01", messageId: null, span: null },
        suggestedTier: "thread",
        status: "pending",
        author: "agent",
        zoneId: null,
      },
    ],
    conversation: [],
    lens: { owner: null, nodeId: null, depth: 1, docId: null },
    cursor: 5,
    presence: { agents: 0 },
  };
}

test("doc.added appends a new doc and advances cursor", () => {
  const event: ServerEvent = {
    seq: 6,
    kind: "doc.added",
    payload: { id: "ramble-02", title: "Ramble 2", kind: "ramble", kindAuthor: null },
  };
  const next = applyEvent(baseState(), event);
  expect(next.docs).toEqual([
    { id: "ramble-02", title: "Ramble 2", kind: "ramble", kindAuthor: null },
  ]);
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

test("node.anchored flips the node's anchorNodeId locally (thin event)", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "node.anchored",
    payload: { nodeId: "maren", anchorNodeId: "the-hollow" },
  });
  expect(next.nodes[0]?.anchorNodeId).toBe("the-hollow");
  expect(next.cursor).toBe(6);
});

test("node.anchored with null anchorNodeId clears to top-level", () => {
  const anchored: ProjectState = {
    ...baseState(),
    nodes: [
      { ...baseState().nodes[0], anchorNodeId: "the-hollow" } as ProjectState["nodes"][number],
    ],
  };
  const next = applyEvent(anchored, {
    seq: 6,
    kind: "node.anchored",
    payload: { nodeId: "maren", anchorNodeId: null },
  });
  expect(next.nodes[0]?.anchorNodeId).toBeNull();
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

test("doc.deleted filters the doc out and advances cursor", () => {
  const state = {
    ...baseState(),
    docs: [{ id: "ramble-01", title: "R1", kind: "ramble", kindAuthor: null }],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "doc.deleted",
    payload: { id: "ramble-01" },
  });
  expect(next.docs).toEqual([]);
  expect(next.cursor).toBe(6);
  // Nodes SURVIVE a doc delete (map-as-view, Claim A).
  expect(next.nodes).toEqual(state.nodes);
});

test("doc.marked upserts the full inline mark onto the doc, stale=false by construction", () => {
  const state = {
    ...baseState(),
    docs: [{ id: "ramble-01", title: "R1", kind: "ramble", kindAuthor: null }],
  };
  const mark = { author: "agent", note: "nothing worth extracting", status: "analyzed", ts: 123 };
  const next = applyEvent(state, {
    seq: 6,
    kind: "doc.marked",
    payload: { docId: "ramble-01", mark },
  });
  expect(next.docs[0]?.mark).toEqual({ ...mark, stale: false });
  expect(next.cursor).toBe(6);
});

test("doc.marked replaces an existing mark (latest wins)", () => {
  const state = {
    ...baseState(),
    docs: [
      {
        id: "ramble-01",
        title: "R1",
        kind: "ramble",
        kindAuthor: null,
        mark: { author: "agent", note: null, status: "skimmed", ts: 1, stale: true },
      },
    ],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "doc.marked",
    payload: {
      docId: "ramble-01",
      mark: { author: "agent", note: null, status: "analyzed", ts: 2 },
    },
  });
  expect(next.docs[0]?.mark?.status).toBe("analyzed");
  expect(next.docs[0]?.mark?.stale).toBe(false);
});

test("presence.changed sets presence and advances cursor", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "presence.changed",
    payload: { agents: 2 },
  });
  expect(next.presence).toEqual({ agents: 2 });
  expect(next.cursor).toBe(6);
});

// The ephemeral-event cursor clause (Contract 9 amendment): fire-once
// signals still consumed a seq on the bus, so they MUST advance the cursor
// here — the old hook early-returned look.here around the reducer, freezing
// the cursor so every later event read as a phantom gap (wholesale refetch
// per signal; fatal at agent.activity's 2–3×-per-turn rate).
test("look.here advances cursor without touching state", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "look.here",
    payload: { nodeId: "maren" },
  });
  expect(next.cursor).toBe(6);
  expect(next.lens).toEqual(baseState().lens);
  expect(next.nodes).toEqual(baseState().nodes);
});

test("agent.activity advances cursor without touching state", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "agent.activity",
    payload: { state: "thinking" },
  });
  expect(next.cursor).toBe(6);
  expect(next.conversation).toEqual([]);
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

// Round 3 (Claims Z1/Z2) — the zone event cases.

test("zone.created appends the zone (and dedupes a repeat)", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "zone.created",
    payload: { id: "wild-ideas", name: "Wild ideas" },
  });
  expect(next.zones).toEqual([{ id: "wild-ideas", name: "Wild ideas" }]);
  expect(next.cursor).toBe(6);
  const again = applyEvent(next, {
    seq: 7,
    kind: "zone.created",
    payload: { id: "wild-ideas", name: "Wild ideas" },
  });
  expect(again.zones).toHaveLength(1);
});

function zonedProposal(id: string, zoneId: string): ProjectState["proposals"][number] {
  return { ...baseState().proposals[0], id, zoneId } as ProjectState["proposals"][number];
}

test("zone.deleted drops the zone AND that zone's proposals — a scoped drop, never wholesale", () => {
  const state: ProjectState = {
    ...baseState(),
    zones: [
      { id: "wild-ideas", name: "Wild ideas" },
      { id: "keep", name: "Keep" },
    ],
    proposals: [
      ...baseState().proposals, // main-queue row (zoneId null)
      zonedProposal("z-1", "wild-ideas"),
      zonedProposal("z-2", "keep"),
    ],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "zone.deleted",
    payload: { id: "wild-ideas" },
  });
  expect(next.zones).toEqual([{ id: "keep", name: "Keep" }]);
  expect(next.proposals.map((p) => p.id)).toEqual(["prop-1", "z-2"]);
});

test("proposal.promoted clears zoneId on the row (thin event, move-not-duplicate)", () => {
  const state: ProjectState = {
    ...baseState(),
    zones: [{ id: "wild-ideas", name: "Wild ideas" }],
    proposals: [zonedProposal("z-1", "wild-ideas")],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "proposal.promoted",
    payload: { id: "z-1" },
  });
  expect(next.proposals[0]?.zoneId).toBeNull();
  expect(next.proposals[0]?.status).toBe("pending");
  expect(next.proposals[0]?.draft).toEqual(state.proposals[0]?.draft);
});

test("a zone-tagged proposal.added upserts into the INCLUSIVE store untouched (views segregate, not the reducer)", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "proposal.added",
    payload: {
      id: "z-new",
      kind: "node",
      draft: { title: "A wild one" },
      evidence: { docId: null, messageId: null, span: null },
      suggestedTier: "thread",
      status: "pending",
      author: "agent",
      zoneId: "wild-ideas",
    },
  });
  expect(next.proposals).toHaveLength(2);
  expect(next.proposals[1]?.zoneId).toBe("wild-ideas");
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

test("lens.set replaces the lens wholesale (docId always carried — null on a node lens)", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "lens.set",
    payload: { owner: "agent", nodeId: "maren", depth: 2, docId: null },
  });
  expect(next.lens).toEqual({ owner: "agent", nodeId: "maren", depth: 2, docId: null });
});

test("lens.set carries the doc variant (nodeId null, depth null, docId set)", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "lens.set",
    payload: { owner: "agent", nodeId: null, depth: null, docId: "ramble-01" },
  });
  expect(next.lens).toEqual({ owner: "agent", nodeId: null, depth: null, docId: "ramble-01" });
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

// Round 4 (A1) — actions.set {targetId, actions}: wholesale metadata
// replace onto whichever entity wears the target id (node OR pending
// proposal — disjoint UUID spaces, so one pass over both is unambiguous).

test("actions.set replaces the actions array on a matching node", () => {
  const slots = [{ id: "jungian", label: "Explore archetypes", seed: "Explore archetypes — " }];
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "actions.set",
    payload: { targetId: "maren", actions: slots },
  });
  expect(next.nodes[0]?.actions).toEqual(slots);
  expect(next.cursor).toBe(6);
});

test("actions.set replaces the actions array on a matching proposal", () => {
  const slots = [{ id: "a", label: "A", seed: "A — " }];
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "actions.set",
    payload: { targetId: "prop-1", actions: slots },
  });
  expect(next.proposals[0]?.actions).toEqual(slots);
});

test("actions.set is wholesale — a second set replaces, never merges", () => {
  const first = applyEvent(baseState(), {
    seq: 6,
    kind: "actions.set",
    payload: { targetId: "maren", actions: [{ id: "a", label: "A", seed: "A" }] },
  });
  const second = applyEvent(first, {
    seq: 7,
    kind: "actions.set",
    payload: { targetId: "maren", actions: [{ id: "b", label: "B", seed: "B" }] },
  });
  expect(second.nodes[0]?.actions).toEqual([{ id: "b", label: "B", seed: "B" }]);
});

test("actions.set with an empty array clears back to wire absence (absent = none)", () => {
  const withSlots = applyEvent(baseState(), {
    seq: 6,
    kind: "actions.set",
    payload: { targetId: "maren", actions: [{ id: "a", label: "A", seed: "A" }] },
  });
  const cleared = applyEvent(withSlots, {
    seq: 7,
    kind: "actions.set",
    payload: { targetId: "maren", actions: [] },
  });
  expect(cleared.nodes[0]?.actions).toBeUndefined();
});

test("actions.set on an unknown target advances the cursor and touches nothing", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "actions.set",
    payload: { targetId: "no-such-target", actions: [{ id: "a", label: "A", seed: "A" }] },
  });
  expect(next.cursor).toBe(6);
  expect(next.nodes).toEqual(baseState().nodes);
  expect(next.proposals).toEqual(baseState().proposals);
});

// The ratify re-home path (Contract 9 A1): NO actions.set is emitted when a
// proposal's slots re-home onto the minted node — the thin node.ratified
// event triggers the snapshot refetch that carries them to the new id. The
// reducer's half of that bargain: flip the proposal WITHOUT stripping its
// actions (nothing is lost in the window before the refetch lands).
test("node.ratified keeps the flipped proposal's actions intact for the refetch window", () => {
  const state = baseState();
  const target = state.proposals[0];
  if (!target) throw new Error("fixture missing");
  target.actions = [{ id: "a", label: "A", seed: "A" }];
  const next = applyEvent(state, {
    seq: 6,
    kind: "node.ratified",
    payload: { id: "the-hollow", proposalId: "prop-1" },
  });
  expect(next.proposals[0]?.status).toBe("ratified");
  expect(next.proposals[0]?.actions).toEqual([{ id: "a", label: "A", seed: "A" }]);
});

// R4 K1 — doc.kind {docId, kind, author}.

test("doc.kind sets kind + kindAuthor on the matching doc", () => {
  const state = {
    ...baseState(),
    docs: [{ id: "ramble-01", title: "R1", kind: null, kindAuthor: null }],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "doc.kind",
    payload: { docId: "ramble-01", kind: "bible", author: "user" },
  });
  expect(next.docs[0]?.kind).toBe("bible");
  expect(next.docs[0]?.kindAuthor).toBe("user");
  expect(next.cursor).toBe(6);
});

test("doc.kind with kind null clears BOTH kind and author (a clear un-attributes)", () => {
  const state = {
    ...baseState(),
    docs: [{ id: "ramble-01", title: "R1", kind: "story", kindAuthor: "agent" as const }],
  };
  const next = applyEvent(state, {
    seq: 6,
    kind: "doc.kind",
    payload: { docId: "ramble-01", kind: null, author: null },
  });
  expect(next.docs[0]?.kind).toBeNull();
  expect(next.docs[0]?.kindAuthor).toBeNull();
});

test("doc.kind on an unknown doc advances the cursor and touches nothing", () => {
  const next = applyEvent(baseState(), {
    seq: 6,
    kind: "doc.kind",
    payload: { docId: "no-such-doc", kind: "bible", author: "user" },
  });
  expect(next.cursor).toBe(6);
  expect(next.docs).toEqual(baseState().docs);
});

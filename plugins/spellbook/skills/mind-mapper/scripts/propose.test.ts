// P2 — propose-node/propose-edge insert a pending proposal row and emit
// proposal.added. The draft is opaque JSON to the daemon (Claim A: it
// doesn't validate the agent's extraction, only stores it).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { batchPropose, edgeDraftWarning, proposeEdge, proposeNode } from "./propose.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-propose-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("proposeNode round-trips a node draft + evidence verbatim", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda", tier: "thread", synopsis: "keeps the mill" },
      evidence: { docId: "ramble-01", span: "Edda keeps the mill" },
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.draft).toEqual({ title: "Edda", tier: "thread", synopsis: "keeps the mill" });
    expect(proposal.evidence).toEqual({
      docId: "ramble-01",
      messageId: null,
      span: "Edda keeps the mill",
    });

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals).toEqual([proposal]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposeEdge round-trips an edge draft + evidence verbatim", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const proposal = proposeEdge(db, bus, {
      draft: { source: "maren", target: "edda", label: "rivals with", provenance: "asserted" },
      evidence: { docId: "bible-maren" },
    });
    expect(proposal.kind).toBe("edge");
    expect(proposal.evidence).toEqual({ docId: "bible-maren", messageId: null, span: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("author round-trips: user stored as user, omitted defaults to agent", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const userSketch = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: {},
      author: "user",
    });
    expect(userSketch.author).toBe("user");
    const agentDefault = proposeNode(db, bus, { draft: { title: "Tam" }, evidence: {} });
    expect(agentDefault.author).toBe("agent");

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.map((p) => p.author)).toEqual(["user", "agent"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing draft is a clear intake error, not a NOT NULL constraint crash", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    for (const draft of [undefined, null]) {
      expect(() => proposeNode(db, bus, { draft, evidence: {} })).toThrow(
        /propose requires a draft/,
      );
    }
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad author value is rejected at intake", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(() =>
      proposeNode(db, bus, {
        draft: {},
        evidence: {},
        author: "robot" as unknown as "agent",
      }),
    ).toThrow(/author must be user or agent/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pre-author row (author NULL) reads back normalized to agent — wire never carries null", () => {
  const { dir, db } = tempDb();
  try {
    // Hand-insert the way pre-Claim-D code did: no author column value.
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, status) VALUES (?, 'node', '{}', 'pending')",
      ["p-old"],
    );
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals[0]?.author).toBe("agent");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("message evidence: rejects both docId+messageId, rejects unknown messageId, round-trips a real one", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(() =>
      proposeNode(db, bus, {
        draft: {},
        evidence: { docId: "ramble-01", messageId: "m1", span: "x" },
      }),
    ).toThrow(/doc OR a message, not both/);

    expect(() =>
      proposeNode(db, bus, { draft: {}, evidence: { messageId: "no-such-message" } }),
    ).toThrow(/evidence.messageId does not exist/);

    // A real message grounds cleanly — messageId is a UUID, no slug guard.
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, 'default', 1, 'user', 'turn', ?)",
      ["11111111-2222-3333-4444-555555555555", "the mill burned down in the flood year"],
    );
    const proposal = proposeNode(db, bus, {
      draft: { title: "The Flood Year" },
      evidence: { messageId: "11111111-2222-3333-4444-555555555555", span: "the flood year" },
    });
    expect(proposal.evidence).toEqual({
      docId: null,
      messageId: "11111111-2222-3333-4444-555555555555",
      span: "the flood year",
    });

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals[0]?.evidence.messageId).toBe("11111111-2222-3333-4444-555555555555");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposeNode emits a proposal.added patch, not the whole proposals array", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (event) => received.push(event));
    const proposal = proposeNode(db, bus, { draft: { title: "Tam" }, evidence: {} });
    expect(received).toEqual([
      { seq: 1, epoch: bus.epoch, kind: "proposal.added", payload: proposal },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// R3 gate rework: edgeDraftWarning is advisory shape-checking that never
// blocks intake — draft opacity (Contract 8) means wrong keys are STORED,
// but the caller gets told which keys the ratify path will actually read.
test("edgeDraftWarning: null for a well-keyed draft, names the missing endpoint key(s), tolerates junk", () => {
  expect(edgeDraftWarning({ source: "a", target: "b", label: "links" })).toBeNull();
  // Extra keys are fine — only the endpoint keys are load-bearing.
  expect(edgeDraftWarning({ source: "a", target: "b", note: "extra" })).toBeNull();

  expect(edgeDraftWarning({ from: "a", to: "b", label: "links" })).toContain("source/target");
  expect(edgeDraftWarning({ source: "a", label: "half" })).toContain("target");
  expect(edgeDraftWarning({ source: "a", label: "half" })).not.toContain("source/");
  // Non-string endpoint values warn too — ratify stringifies, but the intent
  // was almost certainly wrong.
  expect(edgeDraftWarning({ source: 1, target: "b" })).toContain("source");
  expect(edgeDraftWarning(null)).toContain("not an object");
  expect(edgeDraftWarning("just a string")).toContain("not an object");
});

test("a wrong-keyed edge draft still inserts (opacity holds) — the warning is advice, not a gate", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const proposal = proposeEdge(db, bus, {
      draft: { from: "a", to: "b", label: "links" },
      evidence: {},
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.draft).toEqual({ from: "a", to: "b", label: "links" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round 5 (CLI1) — batch propose: mint nodes, resolve edge endpoints against
// local refs, one transaction, emit per-proposal AFTER commit.
test("batchPropose resolves local edge refs to minted node ids and returns the ref→id map", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const emitted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    bus.subscribe(0, (e) => emitted.push({ kind: e.kind, payload: e.payload }));

    const { refToId, proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "n1", draft: { title: "Comedy", synopsis: "" } },
        { ref: "n2", draft: { title: "Darkness", synopsis: "" } },
      ],
      edges: [{ draft: { source: "n1", target: "n2", label: "contrasts" } }],
    });

    // ref→id map returned; both refs minted to real UUIDs.
    expect(typeof refToId.n1).toBe("string");
    expect(typeof refToId.n2).toBe("string");
    expect(refToId.n1).not.toBe(refToId.n2);
    expect(proposals).toHaveLength(3);

    // The stored edge draft carries the RESOLVED minted ids, not "n1"/"n2".
    const state = readState(db, { id: "default", title: "Default" });
    const edge = state.proposals.find((p) => p.kind === "edge");
    expect(edge?.draft).toMatchObject({
      source: refToId.n1,
      target: refToId.n2,
      label: "contrasts",
    });

    // Three rows persisted, three proposal.added events, all AFTER commit.
    expect(state.proposals).toHaveLength(3);
    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.kind === "proposal.added")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchPropose passes real node/proposal ids and unknown refs through unchanged (opacity)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    // A pre-existing real node the batch edge references by id.
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('real-node','concept','canon','R','')",
    );

    const { refToId } = batchPropose(db, bus, {
      nodes: [{ ref: "n1", draft: { title: "New", weird: { nested: true } } }],
      edges: [
        { draft: { source: "n1", target: "real-node", label: "links" } },
        // an unknown ref (neither a batch ref nor a real id) passes through —
        // ratify owns dangling-ref errors, not the batch.
        { draft: { source: "real-node", target: "ghost", label: "dangles" } },
      ],
    });

    const state = readState(db, { id: "default", title: "Default" });
    // Opaque node draft round-trips verbatim, nested keys and all.
    const node = state.proposals.find((p) => p.kind === "node");
    expect(node?.draft).toEqual({ title: "New", weird: { nested: true } });

    const edges = state.proposals.filter((p) => p.kind === "edge");
    const linked = edges.find((e) => (e.draft as { label: string }).label === "links");
    expect(linked?.draft).toMatchObject({ source: refToId.n1, target: "real-node" });
    const dangling = edges.find((e) => (e.draft as { label: string }).label === "dangles");
    expect(dangling?.draft).toMatchObject({ target: "ghost" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchPropose is atomic: a throwing batch leaves zero rows and leaks zero events", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const emitted: unknown[] = [];
    bus.subscribe(0, (e) => emitted.push(e));

    // The second node trips the evidence-slug guard — the whole batch aborts.
    expect(() =>
      batchPropose(db, bus, {
        nodes: [
          { ref: "n1", draft: { title: "Good" } },
          { ref: "n2", draft: { title: "Bad" }, evidence: { docId: "NOT A SLUG" } },
        ],
        edges: [{ draft: { source: "n1", target: "n2" } }],
      }),
    ).toThrow(/not a valid doc slug/);

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals).toEqual([]); // nothing persisted
    expect(emitted).toEqual([]); // nothing emitted
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchPropose rejects a missing or duplicate node ref", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(() =>
      batchPropose(db, bus, {
        nodes: [
          { ref: "n1", draft: { title: "A" } },
          { ref: "n1", draft: { title: "B" } },
        ],
      }),
    ).toThrow(/duplicate batch node ref/);
    expect(() =>
      batchPropose(db, bus, {
        nodes: [{ ref: "", draft: { title: "A" } }],
      }),
    ).toThrow(/non-empty string/);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// ── Round 12 · SEAM 1 — batch identity ──────────────────────────────────────

test("batchPropose MINTS a batchId and stamps every member — node and edge alike", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const result = batchPropose(db, bus, {
      nodes: [
        { ref: "n1", draft: { title: "Rich Ruth" } },
        { ref: "n2", draft: { title: "Fourth world" } },
      ],
      edges: [{ draft: { source: "n1", target: "n2", label: "adjacent to" } }],
    });
    expect(typeof result.batchId).toBe("string");
    expect(result.batchId.length).toBeGreaterThan(0);
    for (const p of result.proposals) expect(p.batchId).toBe(result.batchId);

    // And it rides the snapshot — the read side is the payoff.
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.every((p) => p.batchId === result.batchId)).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a batchId SURVIVES ratification, so a partial ratification is still queryable", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { batchId, proposals } = batchPropose(db, bus, {
      nodes: [{ ref: "n1", draft: { title: "Rich Ruth" } }],
      edges: [{ draft: { source: "n1", target: "n1", label: "self" } }],
    });
    // Ratify only the NODE (the drive-10 shape: the human rules on nodes, the
    // edges stay pending).
    const nodeProposal = proposals.find((p) => p.kind === "node") as { id: string };
    db.run("UPDATE proposals SET status = 'ratified', result_node_id = 'n-real' WHERE id = ?", [
      nodeProposal.id,
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    const members = state.proposals.filter((p) => p.batchId === batchId);
    expect(members).toHaveLength(2);
    // THE reconciliation the drive needed: what else came from that call, and
    // what is still pending?
    expect(members.filter((p) => p.status === "pending").map((p) => p.kind)).toEqual(["edge"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single propose is UNBATCHED unless the caller names an act (no auto-mint)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const lone = proposeNode(db, bus, { draft: { title: "Edda" }, evidence: {} });
    expect(lone.batchId).toBeNull();

    const joined = proposeNode(db, bus, {
      draft: { title: "Tam" },
      evidence: {},
      batchId: "batch-abc",
    });
    expect(joined.batchId).toBe("batch-abc");

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.map((p) => p.batchId)).toEqual([null, "batch-abc"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a caller-supplied batchId EXTENDS an existing act (the 'I forgot the edges' repair)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const first = batchPropose(db, bus, { nodes: [{ ref: "n1", draft: { title: "Rich Ruth" } }] });
    const second = batchPropose(db, bus, {
      batchId: first.batchId,
      edges: [{ draft: { source: "x", target: "y", label: "late" } }],
    });
    expect(second.batchId).toBe(first.batchId);

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.filter((p) => p.batchId === first.batchId)).toHaveLength(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-string batchId is a named intake error, not a silent drop", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(() =>
      proposeNode(db, bus, {
        draft: { title: "Edda" },
        evidence: {},
        batchId: 7 as unknown as string,
      }),
    ).toThrow(/batchId must be a non-empty string/);
    expect(() => batchPropose(db, bus, { batchId: "", nodes: [] })).toThrow(
      /batchId must be a non-empty string/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round 12 · SEAM 2 — edge endpoints by title ─────────────────────────────

function seedNode(db: import("bun:sqlite").Database, id: string, title: string): void {
  db.run(
    "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, 'concept', 'canon', ?, '')",
    [id, title],
  );
}

test("an edge endpoint may name a ratified node by title, resolved AT INTAKE to its id", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    seedNode(db, "node-rich", "Rich Ruth");
    seedNode(db, "node-fw", "Fourth world");
    const proposal = proposeEdge(db, bus, {
      draft: { source: "title:Rich Ruth", target: "title:Fourth world", label: "adjacent to" },
      evidence: {},
    });
    // The STORED draft carries real ids — a later retitle cannot re-point it,
    // and the caller sees the resolution in the response it already reads.
    expect(proposal.draft).toEqual({
      source: "node-rich",
      target: "node-fw",
      label: "adjacent to",
    });
    const state = readState(db, { id: "default", title: "Default" });
    expect((state.proposals[0] as { draft: { source: string } }).draft.source).toBe("node-rich");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an AMBIGUOUS title is an error that NAMES every candidate id", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    seedNode(db, "node-a", "Fourth world");
    seedNode(db, "node-b", "Fourth world");
    seedNode(db, "node-c", "Fourth world");
    let message = "";
    try {
      proposeEdge(db, bus, {
        draft: { source: "title:Fourth world", target: "node-a", label: "x" },
        evidence: {},
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("matches 3 nodes");
    for (const id of ["node-a", "node-b", "node-c"]) expect(message).toContain(id);
    expect(message).toContain("pass one of those ids");
    // Nothing was written — resolution is a pure read + throw before insert.
    expect(readState(db, { id: "default", title: "Default" }).proposals).toHaveLength(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unmatched title errors, names the exact-match contract, and points at search", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    seedNode(db, "node-rich", "Rich Ruth");
    let message = "";
    try {
      // Case differs — title refs are EXACT and case-sensitive by ruling.
      proposeEdge(db, bus, {
        draft: { source: "title:rich ruth", target: "node-rich", label: "x" },
        evidence: {},
      });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('no ratified node is titled "rich ruth"');
    expect(message).toContain("case-sensitive");
    expect(message).toContain("search");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("title refs resolve against ratified NODES ONLY — never a pending proposal's draft title", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    proposeNode(db, bus, { draft: { title: "Rich Ruth" }, evidence: {} });
    expect(() =>
      proposeEdge(db, bus, {
        draft: { source: "title:Rich Ruth", target: "x", label: "y" },
        evidence: {},
      }),
    ).toThrow(/never pending proposals/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a draft with NO title ref is stored byte-identically (opacity unchanged)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const draft = { source: "a", target: "b", label: "l", weirdKey: { deep: [1, 2] } };
    const proposal = proposeEdge(db, bus, { draft, evidence: {} });
    expect(proposal.draft).toEqual(draft);
    const stored = db.query("SELECT draft_json FROM proposals").get() as { draft_json: string };
    expect(stored.draft_json).toBe(JSON.stringify(draft));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch resolves LOCAL refs and title refs side by side, in one call", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    seedNode(db, "node-rich", "Rich Ruth");
    const { refToId, proposals } = batchPropose(db, bus, {
      nodes: [{ ref: "n1", draft: { title: "Fourth world" } }],
      edges: [{ draft: { source: "n1", target: "title:Rich Ruth", label: "adjacent to" } }],
    });
    const edge = proposals.find((p) => p.kind === "edge") as { draft: Record<string, unknown> };
    expect(edge.draft).toMatchObject({ source: refToId.n1, target: "node-rich" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unresolvable title ref inside a batch leaves ZERO rows (validate before the txn)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.subscribe(0, (e) => seen.push(e.kind));
    expect(() =>
      batchPropose(db, bus, {
        nodes: [{ ref: "n1", draft: { title: "Fourth world" } }],
        edges: [{ draft: { source: "n1", target: "title:Nobody", label: "x" } }],
      }),
    ).toThrow(/no ratified node is titled/);
    expect(readState(db, { id: "default", title: "Default" }).proposals).toHaveLength(0);
    expect(seen).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

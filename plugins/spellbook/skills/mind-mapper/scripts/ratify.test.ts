// P3 — ratify write-path: accept creates the node/edge + emits, reject
// touches only the proposal row, and an edge proposal referencing an
// unratified node proposal's id is rejected with a clear error (cassandra's
// P2 gate finding: this was previously accepted unvalidated).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { readState } from "./state.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-ratify-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

test("ratify accept creates a node, marks the proposal ratified, emits node.ratified", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda", synopsis: "keeps the mill" },
      evidence: { docId: "ramble-01", span: "Edda keeps the mill" },
    });
    const received: unknown[] = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e));

    const result = ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "thread" });
    expect(result.status).toBe("ratified");
    expect(typeof result.nodeId).toBe("string");

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals[0]).toMatchObject({ status: "ratified", resultNodeId: result.nodeId });
    expect(state.nodes[0]).toMatchObject({ id: result.nodeId, title: "Edda", tier: "thread" });
    expect(state.nodes[0]?.sources).toEqual([{ docId: "ramble-01", span: "Edda keeps the mill" }]);
    expect(received.some((e) => (e as { kind: string }).kind === "node.ratified")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify reject marks rejected, writes no node/edge, no doc-edit required", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, { draft: { title: "Sela" }, evidence: {} });
    const result = ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "reject" });
    expect(result).toEqual({ id: proposal.id, status: "rejected" });

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals[0]?.status).toBe("rejected");
    expect(state.nodes).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratifying an already-ratified proposal throws (idempotency guard)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, { draft: { title: "Sela" }, evidence: {} });
    ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "canon" });
    expect(() => ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "canon" })).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edge referencing an unratified node proposal's id throws a clear error", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    const bus = createEventBus();
    const nodeProposal = proposeNode(db, bus, { draft: { title: "Coralie" }, evidence: {} });
    const edgeProposal = proposeEdge(db, bus, {
      draft: { source: "maren", target: nodeProposal.id, label: "grieves for" },
      evidence: {},
    });
    expect(() =>
      ratify(db, bus, docsDir, { proposalId: edgeProposal.id, ruling: "canon" }),
    ).toThrow(/ratify node proposal .* first/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edge referencing a NOW-ratified node proposal's id resolves to the real node id", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    const nodeProposal = proposeNode(db, bus, { draft: { title: "Coralie" }, evidence: {} });
    const { nodeId } = ratify(db, bus, docsDir, { proposalId: nodeProposal.id, ruling: "canon" });

    const edgeProposal = proposeEdge(db, bus, {
      draft: { source: "maren", target: nodeProposal.id, label: "grieves for" },
      evidence: {},
    });
    const result = ratify(db, bus, docsDir, { proposalId: edgeProposal.id, ruling: "canon" });
    expect(result.status).toBe("ratified");

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.edges[0]).toMatchObject({ source: "maren", target: nodeId, label: "grieves for" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify with --doc-edit writes the file verbatim + appends a changelog line", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    writeFileSync(join(docsDir, "ramble-01.md"), "original prose");
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: { docId: "ramble-01", span: "keeps the mill" },
    });
    ratify(db, bus, docsDir, {
      proposalId: proposal.id,
      ruling: "canon",
      docEdit: "revised prose with Edda folded in",
    });
    expect(readFileSync(join(docsDir, "ramble-01.md"), "utf8")).toBe(
      "revised prose with Edda folded in",
    );
    expect(existsSync(join(docsDir, "..", "changelog.txt"))).toBe(true);
    expect(readFileSync(join(docsDir, "..", "changelog.txt"), "utf8")).toContain(proposal.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propose rejects a non-slug evidence.docId at intake (traversal guard)", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    expect(() =>
      proposeNode(db, bus, {
        draft: { title: "evil" },
        evidence: { docId: "../../../../tmp/evil", span: "x" },
      }),
    ).toThrow(/not a valid doc slug/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify refuses a doc edit when the stored evidence doc id is not a slug (defense in depth)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    // Bypass propose's intake guard by inserting the row directly — this is
    // the pre-guard/foreign-writer case the ratify-side check exists for.
    const id = crypto.randomUUID();
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_span, suggested_tier, status) VALUES (?, 'node', ?, ?, NULL, NULL, 'pending')",
      [id, JSON.stringify({ title: "evil" }), "../escape"],
    );
    expect(() =>
      ratify(db, bus, docsDir, { proposalId: id, ruling: "canon", docEdit: "# pwned" }),
    ).toThrow(/not a valid slug/);
    expect(existsSync(join(docsDir, "..", "escape.md"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("message-grounded accept inserts a message_sources row; state merges the union shape", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, 'default', 1, 'user', 'turn', ?)",
      ["msg-uuid-1", "the mill burned down in the flood year"],
    );
    const proposal = proposeNode(db, bus, {
      draft: { title: "The Flood Year" },
      evidence: { messageId: "msg-uuid-1", span: "the flood year" },
    });
    const result = ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "thread" });
    expect(result.status).toBe("ratified");

    const state = readState(db, { id: "default", title: "Default" });
    const node = state.nodes.find((n) => n.id === result.nodeId);
    expect(node?.sources).toEqual([{ messageId: "msg-uuid-1", span: "the flood year" }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify --doc-edit is invalid for message evidence (sharpened error)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, 'default', 1, 'user', 'turn', 'x')",
      ["msg-uuid-2"],
    );
    const proposal = proposeNode(db, bus, {
      draft: { title: "X" },
      evidence: { messageId: "msg-uuid-2" },
    });
    expect(() =>
      ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "canon", docEdit: "prose" }),
    ).toThrow(/message evidence — --doc-edit is invalid/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// P3 gate rework — ratify-time evidence attach (`--doc`/`--span`) for
// evidence-less proposals (the human-sketch inversion: the human already
// believes the claim; the agent drafts its doc home at ruling time).
function insertDoc(db: ReturnType<typeof tempProject>["db"], id: string, title: string) {
  db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, 'note', ?)", [
    id,
    title,
    `docs/${id}.md`,
  ]);
}

test("evidence-less accept with --doc/--doc-edit writes the doc + mints the sources row", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    writeFileSync(join(docsDir, "mill-bible.md"), "original prose");
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: {},
      author: "user",
    });
    const result = ratify(db, bus, docsDir, {
      proposalId: proposal.id,
      ruling: "canon",
      docId: "mill-bible",
      docEdit: "original prose\n\nEdda keeps the mill.",
      span: "Edda keeps the mill.",
    });
    expect(result.status).toBe("ratified");

    expect(readFileSync(join(docsDir, "mill-bible.md"), "utf8")).toBe(
      "original prose\n\nEdda keeps the mill.",
    );
    // FTS re-index followed the write — search must match the post-edit text.
    const fts = db.query("SELECT content FROM docs_fts WHERE doc_id = ?").get("mill-bible") as {
      content: string;
    } | null;
    expect(fts?.content).toContain("Edda keeps the mill.");
    expect(readFileSync(join(docsDir, "..", "changelog.txt"), "utf8")).toContain("mill-bible.md");

    const state = readState(db, { id: "default", title: "Default" });
    const node = state.nodes.find((n) => n.id === result.nodeId);
    expect(node?.sources).toEqual([{ docId: "mill-bible", span: "Edda keeps the mill." }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc without --span mints the sources row with a null span", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, { draft: { title: "Edda" }, evidence: {} });
    const result = ratify(db, bus, docsDir, {
      proposalId: proposal.id,
      ruling: "thread",
      docId: "mill-bible",
      docEdit: "Edda keeps the mill.",
    });
    const state = readState(db, { id: "default", title: "Default" });
    const node = state.nodes.find((n) => n.id === result.nodeId);
    expect(node?.sources).toEqual([{ docId: "mill-bible", span: null }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc is rejected when the proposal already carries doc evidence", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: { docId: "ramble-01", span: "keeps the mill" },
    });
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "mill-bible",
        docEdit: "prose",
      }),
    ).toThrow(/already carries evidence; --doc is for evidence-less proposals/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc is rejected when the proposal carries message evidence", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    const bus = createEventBus();
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, 'default', 1, 'user', 'turn', 'x')",
      ["msg-uuid-4"],
    );
    const proposal = proposeNode(db, bus, {
      draft: { title: "X" },
      evidence: { messageId: "msg-uuid-4" },
    });
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "mill-bible",
        docEdit: "prose",
      }),
    ).toThrow(/already carries evidence; --doc is for evidence-less proposals/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc without --doc-edit is rejected (the attach IS the agent drafting the doc home)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, { draft: { title: "Edda" }, evidence: {} });
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "mill-bible",
      }),
    ).toThrow(/--doc requires --doc-edit/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc is rejected for edge proposals (edges carry no sources rows)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    insertDoc(db, "mill-bible", "The Mill Bible");
    const bus = createEventBus();
    for (const id of ["maren", "edda"]) {
      db.run(
        "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, 'cast', 'canon', ?, '')",
        [id, id],
      );
    }
    const proposal = proposeEdge(db, bus, {
      draft: { source: "maren", target: "edda", label: "rivals with" },
      evidence: {},
    });
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "mill-bible",
        docEdit: "prose",
      }),
    ).toThrow(/--doc is invalid for edge proposals/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--doc validates slug shape and existence at intake (same spirit as mark)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, { draft: { title: "Edda" }, evidence: {} });
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "../escape",
        docEdit: "# pwned",
      }),
    ).toThrow(/not a valid doc slug/);
    expect(() =>
      ratify(db, bus, docsDir, {
        proposalId: proposal.id,
        ruling: "canon",
        docId: "no-such-doc",
        docEdit: "prose",
      }),
    ).toThrow(/unknown doc: no-such-doc/);
    expect(existsSync(join(docsDir, "..", "escape.md"))).toBe(false);
    // Nothing landed: the proposal is still pending, no node minted.
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals[0]?.status).toBe("pending");
    expect(state.nodes).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a node with BOTH doc- and message-grounded claims carries both source shapes", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, 'default', 1, 'user', 'turn', 'x')",
      ["msg-uuid-3"],
    );
    const docGrounded = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: { docId: "ramble-01", span: "keeps the mill" },
    });
    const result = ratify(db, bus, docsDir, { proposalId: docGrounded.id, ruling: "canon" });
    // Second provenance lands directly (the merge path, not the ratify path).
    db.run("INSERT INTO message_sources (node_id, message_id, span) VALUES (?, ?, ?)", [
      result.nodeId as string,
      "msg-uuid-3",
      "said in chat",
    ]);
    const state = readState(db, { id: "default", title: "Default" });
    const node = state.nodes.find((n) => n.id === result.nodeId);
    expect(node?.sources).toEqual([
      { docId: "ramble-01", span: "keeps the mill" },
      { messageId: "msg-uuid-3", span: "said in chat" },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

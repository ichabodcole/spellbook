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

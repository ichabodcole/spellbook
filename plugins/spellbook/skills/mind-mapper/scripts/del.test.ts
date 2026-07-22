// Round 6 (DEL) — node/proposal deletion: cited-guard counts, force cascade
// (edges gone, children re-parented to top-level NOT deleted, detritus gone,
// lens cleared, ratified proposal result_node_id intact), thin proposal
// delete, delete-a-rejected-proposal.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorNode } from "./anchor.ts";
import { openStore } from "./db.ts";
import { deleteNode, deleteProposal, NodeCitedError } from "./del.ts";
import { createEventBus } from "./events.ts";
import { setLens } from "./lens.ts";
import { proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { readState } from "./state.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-del-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}
const meta = { id: "default", title: "Default" };

// Ratify a bare node proposal → returns the minted node id.
function makeNode(
  db: ReturnType<typeof tempProject>["db"],
  docsDir: string,
  title: string,
): string {
  const bus = createEventBus();
  const p = proposeNode(db, bus, { draft: { title }, evidence: {} });
  return ratify(db, bus, docsDir, { proposalId: p.id, ruling: "canon" }).nodeId as string;
}

test("deleteNode returns null for an unknown id (server 404s)", () => {
  const { dir, db } = tempProject();
  try {
    expect(deleteNode(db, createEventBus(), "no-such-node", false)).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unforced delete of a cited node throws NodeCitedError with the counts", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = makeNode(db, docsDir, "A");
    const b = makeNode(db, docsDir, "B");
    const child = makeNode(db, docsDir, "Child");
    db.run(
      "INSERT INTO edges (id, source, target, label, provenance) VALUES (?, ?, ?, '', 'asserted')",
      ["e1", a, b],
    );
    anchorNode(db, bus, child, a); // child anchored under A → A has a submap
    try {
      deleteNode(db, bus, a, false);
      throw new Error("expected NodeCitedError");
    } catch (e) {
      expect(e).toBeInstanceOf(NodeCitedError);
      expect((e as NodeCitedError).citedBy).toEqual({ edges: 1, children: 1 });
    }
    // Nothing removed on the guarded path.
    expect(readState(db, meta).nodes.some((n) => n.id === a)).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("force cascade: edges gone, children re-parented to top-level, detritus gone, lens cleared, history kept", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = makeNode(db, docsDir, "A");
    const b = makeNode(db, docsDir, "B");
    const child = makeNode(db, docsDir, "Child");
    // A node proposal that ratified into A — its result_node_id is history.
    const aProposalId = (
      db.query("SELECT id FROM proposals WHERE result_node_id = ?").get(a) as { id: string }
    ).id;
    db.run(
      "INSERT INTO edges (id, source, target, label, provenance) VALUES (?, ?, ?, '', 'asserted')",
      ["e1", a, b],
    );
    anchorNode(db, bus, child, a);
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, 'some-doc', NULL)", [a]);
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES ('m1', 'default', 1, 'user', 'turn', 'x')",
    );
    db.run("INSERT INTO message_sources (node_id, message_id, span) VALUES (?, 'm1', NULL)", [a]);
    db.run("INSERT INTO node_actions (target_id, actions_json) VALUES (?, '[]')", [a]);
    setLens(db, bus, "default", { owner: "agent", nodeId: a, depth: 1, docId: null });

    const received: Array<{ kind: string; payload: unknown }> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as never));
    const result = deleteNode(db, bus, a, true);
    expect(result).toEqual({ id: a });

    const state = readState(db, meta);
    expect(state.nodes.some((n) => n.id === a)).toBe(false); // A gone
    expect(state.edges).toHaveLength(0); // edge cascaded
    // Child survives, re-parented to top-level (NOT deleted).
    const childNode = state.nodes.find((n) => n.id === child);
    expect(childNode).toBeDefined();
    expect(childNode?.anchorNodeId).toBeNull();
    // Detritus gone.
    expect(db.query("SELECT COUNT(*) AS n FROM sources WHERE node_id = ?").get(a)).toEqual({
      n: 0,
    });
    expect(db.query("SELECT COUNT(*) AS n FROM message_sources WHERE node_id = ?").get(a)).toEqual({
      n: 0,
    });
    expect(db.query("SELECT COUNT(*) AS n FROM node_actions WHERE target_id = ?").get(a)).toEqual({
      n: 0,
    });
    // Lens cleared.
    expect(state.lens).toBeNull();
    // History: the ratified proposal's result_node_id survives.
    expect(db.query("SELECT result_node_id FROM proposals WHERE id = ?").get(aProposalId)).toEqual({
      result_node_id: a,
    });
    // Thin node.deleted emitted.
    expect(
      received.some((e) => e.kind === "node.deleted" && (e.payload as { id: string }).id === a),
    ).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteProposal is thin: drops the row, cascades its actions, emits proposal.deleted", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const p = proposeNode(db, bus, { draft: { title: "raw" }, evidence: {}, author: "user" });
    db.run("INSERT INTO node_actions (target_id, actions_json) VALUES (?, '[]')", [p.id]);
    const received: Array<{ kind: string; payload: unknown }> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as never));
    expect(deleteProposal(db, bus, p.id)).toEqual({ id: p.id });
    expect(readState(db, meta).proposals).toHaveLength(0);
    expect(
      db.query("SELECT COUNT(*) AS n FROM node_actions WHERE target_id = ?").get(p.id),
    ).toEqual({
      n: 0,
    });
    expect(
      received.some(
        (e) => e.kind === "proposal.deleted" && (e.payload as { id: string }).id === p.id,
      ),
    ).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteProposal works on a rejected proposal (litter-clearing)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const p = proposeNode(db, bus, { draft: { title: "raw" }, evidence: {} });
    ratify(db, bus, docsDir, { proposalId: p.id, ruling: "reject" });
    expect(readState(db, meta).proposals[0]?.status).toBe("rejected");
    expect(deleteProposal(db, bus, p.id)).toEqual({ id: p.id });
    expect(readState(db, meta).proposals).toHaveLength(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteProposal returns null for an unknown id (server 404s)", () => {
  const { dir, db } = tempProject();
  try {
    expect(deleteProposal(db, createEventBus(), "no-such-proposal")).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

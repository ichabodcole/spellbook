// Round 6 (DEL) — the missing retract: hard delete for nodes and proposals,
// equal-capability for human and agent. Mirrors the doc-delete CitedError
// precedent (docs.ts): an unforced delete of a CITED node is a 409 carrying
// the citing counts the surface's confirm dialog renders; --force cascades.
//
// Ruling (plan-round6): a node's citing set = edges touching it + children
// anchored under it. Force cascade DELETES the edges but RE-PARENTS the
// children to top-level (clears anchor_node_id — the children are real
// ratified knowledge, not detritus; do NOT recursively delete the submap),
// deletes the node's OWNED detritus (sources / message_sources / node_actions),
// clears a lens pointing at it, and LEAVES the ratified proposal's
// result_node_id intact (history, the doc-delete precedent). Proposal delete
// is THIN — no guard: a dependent pending edge lives only in opaque draft_json
// and already fails safe at its own ratify.

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

// The node twin of docs.ts's CitedError — a 409 carrying the citing counts.
class NodeCitedError extends Error {
  citedBy: { edges: number; children: number };
  constructor(citedBy: { edges: number; children: number }) {
    super(
      `node is cited by ${citedBy.edges} edge(s) and anchors ${citedBy.children} child node(s)`,
    );
    this.name = "NodeCitedError";
    this.citedBy = citedBy;
  }
}

// Returns null for an unknown id — the server 404s first, before any
// cited/force reasoning. Throws NodeCitedError when unforced + cited.
function deleteNode(
  db: Database,
  bus: EventBus,
  id: string,
  force: boolean,
): { id: string } | null {
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(id)) return null;

  const edges = (
    db.query("SELECT COUNT(*) AS n FROM edges WHERE source = ? OR target = ?").get(id, id) as {
      n: number;
    }
  ).n;
  const children = (
    db.query("SELECT COUNT(*) AS n FROM nodes WHERE anchor_node_id = ?").get(id) as { n: number }
  ).n;
  if (!force && (edges > 0 || children > 0)) throw new NodeCitedError({ edges, children });

  db.transaction(() => {
    // Both-direction edges vanish (an edge to a deleted node dangles).
    db.run("DELETE FROM edges WHERE source = ? OR target = ?", [id, id]);
    // Children re-parent to top-level — they are real ratified knowledge; do
    // NOT recursively delete the submap.
    db.run("UPDATE nodes SET anchor_node_id = NULL WHERE anchor_node_id = ?", [id]);
    // Owned detritus.
    db.run("DELETE FROM sources WHERE node_id = ?", [id]);
    db.run("DELETE FROM message_sources WHERE node_id = ?", [id]);
    db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
    // TAGS: the node's tags are owned detritus too (twin of node_actions).
    db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
    // A lens pointing at this node loses its subject (per-project single row).
    db.run("DELETE FROM lens WHERE node_id = ?", [id]);
    // The ratified proposal's result_node_id is LEFT intact (history — the
    // doc-delete precedent: a source can vanish without un-recording it).
    db.run("DELETE FROM nodes WHERE id = ?", [id]);
  })();

  bus.emit("node.deleted", { id });
  return { id };
}

// Thin, NO guard (ruled): drop the row + cascade its action slots. A pending
// edge proposal that names this proposal as an endpoint lives only in opaque
// draft_json (Contract 8) and fails safe at its OWN ratify. Any status
// deletable (pending / rejected / ratified) — this is the litter-clearing
// path (clear a raw instruction-node through DELETE, not reject).
function deleteProposal(db: Database, bus: EventBus, id: string): { id: string } | null {
  if (!db.query("SELECT 1 FROM proposals WHERE id = ?").get(id)) return null;
  db.transaction(() => {
    db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
    // TAGS: cascade the proposal's tags with it (twin of node_actions).
    db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
    db.run("DELETE FROM proposals WHERE id = ?", [id]);
  })();
  bus.emit("proposal.deleted", { id });
  return { id };
}

// Round 12 (SEAM 5) — the inverse of ratify-batch. Clearing 44 stale proposals
// in drive #10 was 44 individual HTTP deletes in a loop.
//
// DELETE, not reject (ruled): reject is a RULING and leaves a tombstone, and R6
// already ruled that a reject is not a batch act ("a reject excludes a proposal
// from the batch — reject it singly"); that ruling stands, so a reject-batch
// would contradict it. Delete is litter-clearing, which is exactly what a batch
// is for.
//
// TRANSACTIONAL all-or-nothing, mirroring ratifyBatch: validate everything
// first, one txn, emits AFTER commit. Best-effort-with-a-report was considered
// and rejected — the agent's model after the call should be binary (all gone /
// nothing gone), because "I assumed the sweep worked" is the failure mode this
// whole round exists to prevent. An unknown id names EVERY unknown id, not just
// the first: a 44-id cleanup must never become a 44-round-trip bisect.
//
// NOT BUILT, deliberately: a `{batch: "<batchId>"}` shorthand. Drive #10's bug
// WAS an over-broad cleanup — the agent cleared its pending proposals and took
// the edges holding its ratified nodes together with them. The batch id exists
// so the agent LOOKS before it sweeps (`state --batch <id>` shows what ratified
// and what is still pending); making the sweep one keystroke would arm the
// exact bug this round is fixing. Explicit ids only.
function deleteProposalBatch(db: Database, bus: EventBus, ids: string[]): { deleted: string[] } {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('delete-batch requires a non-empty ids array — {"ids": ["<proposalId>", ...]}');
  }
  const bad = ids.filter((id) => typeof id !== "string" || id === "");
  if (bad.length > 0) {
    throw new Error(`delete-batch ids must be non-empty strings — got ${JSON.stringify(bad)}`);
  }
  // Validate ALL before the txn (pure reads + throw), so nothing is deleted
  // when any id is wrong — and name every offender at once.
  const unknown = ids.filter((id) => !db.query("SELECT 1 FROM proposals WHERE id = ?").get(id));
  if (unknown.length > 0) {
    throw new Error(
      `delete-batch is all-or-nothing and ${unknown.length} id(s) do not exist — nothing was deleted: ${unknown.join(", ")}`,
    );
  }
  const unique = [...new Set(ids)];
  db.transaction(() => {
    for (const id of unique) {
      db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
      db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
      db.run("DELETE FROM proposals WHERE id = ?", [id]);
    }
  })();
  // AFTER commit only — a rollback must never leak a proposal.deleted.
  for (const id of unique) bus.emit("proposal.deleted", { id });
  return { deleted: unique };
}

export { deleteNode, deleteProposal, deleteProposalBatch, NodeCitedError };

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
// exact bug this round is fixing. Explicit ids only. (The advisory below is the
// R12-gate follow-up to that ruling: refuse nothing, but never sweep silently.)

// R12 GATE FINDING 1 — the advisory that makes a sweep self-correcting.
//
// cassandra's cold gate reproduced drive #10 exactly and found that
// delete-batch happily deleted three pending edge proposals that were the LAST
// connection intent for already-ratified canon nodes, exit 0, silently. That is
// precisely the act that broke the human's map.
//
// This does NOT refuse — Contract 8's dumb-daemon clause holds, and a block
// would be the "prevent" reflex this round deliberately avoided. It follows the
// R3 intake-`warning` idiom instead: additive on the 200, mirrored to stderr by
// the CLI, exit unchanged. It converts "immediately visible to the HUMAN" (the
// orphan marker) into "immediately visible to the AGENT THAT CAUSED IT".
//
// The predicate deliberately MIRRORS circe's surface orphan rule (R12 surface
// convention), so the engine's warning and the board's marker can never disagree:
// a ratified node is orphaned when it has no real edge AND no remaining pending
// edge proposal names it. Here we ask that question about the state AFTER the
// proposed deletion, which is the only moment the agent can still act on it.
function orphanedByDeletion(db: Database, ids: string[]): { id: string; title: string }[] {
  const doomed = new Set(ids);
  // Endpoints of a pending edge proposal may be a real node id OR a node
  // proposal's id (ratify resolves the latter via result_node_id) — resolve
  // both to the node they mean, exactly as the surface does.
  const asNodeId = (endpoint: string): string => {
    const row = db.query("SELECT result_node_id FROM proposals WHERE id = ?").get(endpoint) as {
      result_node_id: string | null;
    } | null;
    return row?.result_node_id ?? endpoint;
  };
  const endpointsOf = (draftJson: string): string[] => {
    try {
      const d = JSON.parse(draftJson) as { source?: unknown; target?: unknown };
      return [d.source, d.target].filter((e): e is string => typeof e === "string");
    } catch {
      return [];
    }
  };
  const pendingEdges = db
    .query("SELECT id, draft_json FROM proposals WHERE kind = 'edge' AND status = 'pending'")
    .all() as { id: string; draft_json: string }[];

  // Nodes the doomed edges were speaking for.
  const touched = new Set<string>();
  for (const e of pendingEdges) {
    if (!doomed.has(e.id)) continue;
    for (const ep of endpointsOf(e.draft_json)) touched.add(asNodeId(ep));
  }
  // Intent that SURVIVES the deletion.
  const surviving = new Set<string>();
  for (const e of pendingEdges) {
    if (doomed.has(e.id)) continue;
    for (const ep of endpointsOf(e.draft_json)) surviving.add(asNodeId(ep));
  }

  const out: { id: string; title: string }[] = [];
  for (const nodeId of touched) {
    if (surviving.has(nodeId)) continue;
    const node = db.query("SELECT id, title FROM nodes WHERE id = ?").get(nodeId) as {
      id: string;
      title: string;
    } | null;
    if (!node) continue; // not a ratified node — nothing to strand
    const realEdges = db
      .query("SELECT 1 FROM edges WHERE source = ? OR target = ? LIMIT 1")
      .get(nodeId, nodeId);
    if (realEdges) continue; // still genuinely connected
    out.push(node);
  }
  return out;
}

function deleteProposalBatch(
  db: Database,
  bus: EventBus,
  ids: string[],
): { deleted: string[]; warning?: string } {
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
  // Computed BEFORE the txn (it reads the rows we're about to drop), reported
  // after. Advisory only — never a refusal.
  const stranded = orphanedByDeletion(db, unique);
  db.transaction(() => {
    for (const id of unique) {
      db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
      db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
      db.run("DELETE FROM proposals WHERE id = ?", [id]);
    }
  })();
  // AFTER commit only — a rollback must never leak a proposal.deleted.
  for (const id of unique) bus.emit("proposal.deleted", { id });
  if (stranded.length === 0) return { deleted: unique };
  return {
    deleted: unique,
    warning:
      `this deleted the last connection intent for ${stranded.length} ratified node(s), ` +
      `now unconnected: ${stranded.map((n) => `${n.title} (${n.id})`).join(", ")} — ` +
      `re-propose their edges (an edge endpoint may be title:<exact title>), or ` +
      `\`state --batch <id>\` to see what the act still holds`,
  };
}

export { deleteNode, deleteProposal, deleteProposalBatch, NodeCitedError };

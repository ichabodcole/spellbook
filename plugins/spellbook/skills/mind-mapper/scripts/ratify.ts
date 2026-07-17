// P3 — `ratify <proposalId> --ruling canon|thread|story-local|reject
// --doc-edit <file>` backing. On accept: writes the agent-supplied doc edit
// verbatim (the daemon never composes prose — house-style's review-queue
// contract), appends a one-line changelog entry, creates the ratified
// node/edge row, marks the proposal ratified, emits node.ratified/
// edge.ratified. On reject: marks rejected, touches nothing else, no
// justification required (ratified contract).
//
// Edge endpoint resolution (cassandra's P2 cold-agent gate finding): an edge
// draft's source/target may reference either a real node id OR a pending
// NODE proposal's id (the node doesn't exist yet, only its proposal does).
// ratify resolves the latter via proposals.result_node_id — set the moment
// that node proposal itself ratifies — and throws a clear error if the
// referenced node proposal hasn't ratified yet, rather than silently
// accepting a dangling reference.

import type { Database } from "bun:sqlite";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";

type Ruling = "canon" | "thread" | "story-local" | "reject";

interface RatifyInput {
  proposalId: string;
  ruling: Ruling;
  docEdit?: string; // full new content for the proposal's evidence doc
}

interface RatifyResult {
  id: string;
  status: "ratified" | "rejected";
  nodeId?: string;
  edgeId?: string;
}

interface ProposalRow {
  id: string;
  kind: string;
  draft_json: string;
  evidence_doc_id: string | null;
  evidence_span: string | null;
  status: string;
}

function resolveNodeRef(db: Database, ref: string): string {
  const node = db.query("SELECT 1 FROM nodes WHERE id = ?").get(ref);
  if (node) return ref;

  const proposal = db
    .query("SELECT kind, status, result_node_id FROM proposals WHERE id = ?")
    .get(ref) as { kind: string; status: string; result_node_id: string | null } | null;
  if (!proposal) throw new Error(`unresolved node reference: ${ref}`);
  if (proposal.kind !== "node") throw new Error(`reference ${ref} is not a node proposal`);
  if (proposal.status !== "ratified" || !proposal.result_node_id) {
    throw new Error(`unresolved proposal reference: ratify node proposal ${ref} first`);
  }
  return proposal.result_node_id;
}

function ratify(db: Database, bus: EventBus, docsDir: string, input: RatifyInput): RatifyResult {
  const row = db
    .query(
      "SELECT id, kind, draft_json, evidence_doc_id, evidence_span, status FROM proposals WHERE id = ?",
    )
    .get(input.proposalId) as ProposalRow | null;
  if (!row) throw new Error(`unknown proposal: ${input.proposalId}`);
  if (row.status !== "pending") {
    throw new Error(`proposal ${input.proposalId} already ${row.status}`);
  }

  if (input.ruling === "reject") {
    db.run("UPDATE proposals SET status = 'rejected' WHERE id = ?", [input.proposalId]);
    return { id: input.proposalId, status: "rejected" };
  }

  if (input.docEdit !== undefined) {
    if (!row.evidence_doc_id) {
      throw new Error(`proposal ${input.proposalId} has no evidence doc to edit`);
    }
    // Defense in depth: propose.ts rejects non-slug evidence ids at intake,
    // but this row may predate that guard (or come from another writer) —
    // never let a stored id reach the filesystem unvalidated.
    if (!SLUG_RE.test(row.evidence_doc_id)) {
      throw new Error(
        `refusing doc edit: evidence doc id is not a valid slug: ${row.evidence_doc_id}`,
      );
    }
    writeFileSync(join(docsDir, `${row.evidence_doc_id}.md`), input.docEdit);
    // Keep the search index true to the doc it indexes (Claim B: sqlite owns
    // search OVER the prose the docs own) — a ratified edit must re-index,
    // or search keeps matching the pre-edit text (review finding).
    db.run("DELETE FROM docs_fts WHERE doc_id = ?", [row.evidence_doc_id]);
    db.run("INSERT INTO docs_fts (doc_id, content) VALUES (?, ?)", [
      row.evidence_doc_id,
      input.docEdit,
    ]);
  }
  // Every accept logs, with or without a doc edit — the changelog is the
  // attributed what-changed record, not a doc-write side effect.
  appendFileSync(
    join(docsDir, "..", "changelog.txt"),
    `ratified ${input.proposalId} (${input.ruling})${row.evidence_doc_id ? ` -> ${row.evidence_doc_id}.md` : ""}${input.docEdit !== undefined ? " (doc edited)" : ""}\n`,
  );

  const draft = JSON.parse(row.draft_json) as Record<string, unknown>;

  if (row.kind === "node") {
    const nodeId = crypto.randomUUID();
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      nodeId,
      typeof draft.kind === "string" ? draft.kind : "concept",
      input.ruling,
      typeof draft.title === "string" ? draft.title : "Untitled",
      typeof draft.synopsis === "string" ? draft.synopsis : "",
    ]);
    if (row.evidence_doc_id) {
      db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
        nodeId,
        row.evidence_doc_id,
        row.evidence_span,
      ]);
    }
    db.run("UPDATE proposals SET status = 'ratified', result_node_id = ? WHERE id = ?", [
      nodeId,
      input.proposalId,
    ]);
    bus.emit("node.ratified", { id: nodeId, proposalId: input.proposalId });
    return { id: input.proposalId, status: "ratified", nodeId };
  }

  const source = resolveNodeRef(db, String(draft.source));
  const target = resolveNodeRef(db, String(draft.target));
  const edgeId = crypto.randomUUID();
  db.run(
    "INSERT INTO edges (id, source, target, label, provenance, direction) VALUES (?, ?, ?, ?, 'asserted', ?)",
    [
      edgeId,
      source,
      target,
      typeof draft.label === "string" ? draft.label : "",
      typeof draft.direction === "string" ? draft.direction : null,
    ],
  );
  db.run("UPDATE proposals SET status = 'ratified' WHERE id = ?", [input.proposalId]);
  bus.emit("edge.ratified", { id: edgeId, proposalId: input.proposalId });
  return { id: input.proposalId, status: "ratified", edgeId };
}

export type { RatifyInput, RatifyResult, Ruling };
export { ratify };

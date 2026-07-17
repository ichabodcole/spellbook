// P1 — assembles the ratified ProjectState snapshot from the sqlite tables in
// one read. Docs stay content-free (same envelope as the spike's /doc/:id —
// zero change to that endpoint's shape). `cursor` is not durable (no
// event-log table in V1 — events are derived-from-state, replayable via
// snapshot); the daemon passes in its live in-memory cursor, defaulting to 0
// on a fresh process (honest: nothing ratified is lost on restart, only the
// resume-point for events already ephemeral by design).

import type { Database } from "bun:sqlite";
import type { ProjectMeta } from "./project.ts";

interface Doc {
  id: string;
  title: string;
  kind: string;
}

interface NodeSource {
  docId: string;
  span: string | null;
}

interface Node {
  id: string;
  kind: string;
  tier: string;
  title: string;
  synopsis: string;
  sources: NodeSource[];
}

interface Edge {
  id: string;
  source: string;
  target: string;
  label: string;
  provenance: string;
  direction: string | null;
}

interface Proposal {
  id: string;
  kind: string;
  draft: unknown;
  evidence: { docId: string | null; span: string | null };
  suggestedTier: string | null;
  status: string;
  resultNodeId: string | null;
}

interface Message {
  id: string;
  seq: number;
  role: "user" | "agent";
  kind: string;
  text: string;
  ground: string[] | null;
  ts: number;
}

interface Lens {
  owner: string;
  nodeId: string | null;
  depth: number | null;
}

interface ProjectState {
  project: ProjectMeta;
  docs: Doc[];
  nodes: Node[];
  edges: Edge[];
  proposals: Proposal[];
  conversation: Message[];
  lens: Lens | null;
  cursor: number;
  epoch: string;
}

function readState(db: Database, project: ProjectMeta, cursor = 0, epoch = ""): ProjectState {
  const docs = db.query("SELECT id, title, kind FROM docs ORDER BY created_at").all() as Doc[];

  const nodeRows = db
    .query("SELECT id, kind, tier, title, synopsis FROM nodes ORDER BY created_at")
    .all() as Array<Omit<Node, "sources">>;
  const sourceRows = db.query("SELECT node_id, doc_id, span FROM sources").all() as Array<{
    node_id: string;
    doc_id: string;
    span: string | null;
  }>;
  const sourcesByNode = new Map<string, NodeSource[]>();
  for (const row of sourceRows) {
    const list = sourcesByNode.get(row.node_id) ?? [];
    list.push({ docId: row.doc_id, span: row.span });
    sourcesByNode.set(row.node_id, list);
  }
  const nodes: Node[] = nodeRows.map((row) => ({
    ...row,
    sources: sourcesByNode.get(row.id) ?? [],
  }));

  const edges = db
    .query("SELECT id, source, target, label, provenance, direction FROM edges ORDER BY created_at")
    .all() as Edge[];

  const proposalRows = db
    .query(
      "SELECT id, kind, draft_json, evidence_doc_id, evidence_span, suggested_tier, status, result_node_id FROM proposals ORDER BY created_at",
    )
    .all() as Array<{
    id: string;
    kind: string;
    draft_json: string;
    evidence_doc_id: string | null;
    evidence_span: string | null;
    suggested_tier: string | null;
    status: string;
    result_node_id: string | null;
  }>;
  const proposals: Proposal[] = proposalRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    draft: JSON.parse(row.draft_json),
    evidence: { docId: row.evidence_doc_id, span: row.evidence_span },
    suggestedTier: row.suggested_tier,
    status: row.status,
    resultNodeId: row.result_node_id,
  }));

  const messageRows = db
    .query(
      "SELECT id, seq, role, kind, text, ground_json, ts FROM messages WHERE project_id = ? ORDER BY seq",
    )
    .all(project.id) as Array<{
    id: string;
    seq: number;
    role: "user" | "agent";
    kind: string;
    text: string;
    ground_json: string | null;
    ts: number;
  }>;
  const conversation: Message[] = messageRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    text: row.text,
    ground: row.ground_json ? (JSON.parse(row.ground_json) as string[]) : null,
    ts: row.ts,
  }));

  const lensRow = db
    .query("SELECT owner, node_id, depth FROM lens WHERE project_id = ?")
    .get(project.id) as { owner: string; node_id: string | null; depth: number | null } | null;
  const lens: Lens | null = lensRow
    ? { owner: lensRow.owner, nodeId: lensRow.node_id, depth: lensRow.depth }
    : null;

  return { project, docs, nodes, edges, proposals, conversation, lens, cursor, epoch };
}

export type { Doc, Edge, Lens, Message, Node, NodeSource, ProjectState, Proposal };
export { readState };

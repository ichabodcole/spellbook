// P1 — assembles the ratified ProjectState snapshot from the sqlite tables in
// one read. Docs stay content-free (same envelope as the spike's /doc/:id —
// zero change to that endpoint's shape). `cursor` is not durable (no
// event-log table in V1 — events are derived-from-state, replayable via
// snapshot); the daemon passes in its live in-memory cursor, defaulting to 0
// on a fresh process (honest: nothing ratified is lost on restart, only the
// resume-point for events already ephemeral by design).

import type { Database } from "bun:sqlite";
import { type DocMark, docFileMtime, readDocMarks } from "./marks.ts";
import type { ProjectMeta } from "./project.ts";

interface Doc {
  id: string;
  title: string;
  kind: string;
  // Claim B: latest mark, with `stale` computed server-side at read time
  // (current file mtime vs the mark's snapshot; missing file → stale).
  // Absent when the doc has never been marked.
  mark?: DocMark & { stale: boolean };
}

// Claim E: node.sources[] is the union of doc-grounded and message-grounded
// provenance. Doc entries stay byte-identical to the pre-union shape
// ({docId, span}) — additive for every existing consumer.
type NodeSource =
  | { docId: string; span: string | null }
  | { messageId: string; span: string | null };

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
  evidence: { docId: string | null; messageId: string | null; span: string | null };
  suggestedTier: string | null;
  status: string;
  resultNodeId: string | null;
  // Claim D: the wire ALWAYS carries "user"|"agent", never null — a null
  // column value (pre-author row) normalizes to "agent" at read time.
  author: "user" | "agent";
  // Round 3 (Claim Z1, as ruled): the wire ALWAYS carries zoneId — null
  // means main queue. /state.proposals[] INCLUDES zoned rows (tagged, no
  // default exclusion) so snapshot merge and event ingestion obey ONE rule;
  // the main view is `zoneId == null` at render, and ?zone=<id> narrows.
  zoneId: string | null;
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

// Round 3 (Claim V2): one lens row, two modes — node XOR doc, enforced by
// construction (setLens writes every column on upsert; the /lens route
// validates the XOR). The wire ALWAYS carries docId (null on a node lens /
// clear) — additive-optional for pre-doc-lens consumers.
interface Lens {
  owner: string;
  nodeId: string | null;
  depth: number | null;
  docId: string | null;
}

interface Zone {
  id: string;
  name: string;
}

interface ProjectState {
  project: ProjectMeta;
  docs: Doc[];
  nodes: Node[];
  edges: Edge[];
  zones: Zone[];
  proposals: Proposal[];
  conversation: Message[];
  lens: Lens | null;
  cursor: number;
  epoch: string;
}

// `projectRoot` (the directory holding docs/) is needed only for mark
// staleness — without it, marks still merge but read as stale (an
// unverifiable mark vouches for nothing). The daemon always passes it.
function readState(
  db: Database,
  project: ProjectMeta,
  cursor = 0,
  epoch = "",
  projectRoot?: string,
): ProjectState {
  const docRows = db
    .query("SELECT id, title, kind, path FROM docs ORDER BY created_at")
    .all() as Array<{ id: string; title: string; kind: string; path: string }>;
  const pathByDoc = new Map(docRows.map((row) => [row.id, row.path]));
  const marks = readDocMarks(db, (docId) => {
    const relPath = pathByDoc.get(docId);
    if (projectRoot === undefined || relPath === undefined) return null;
    return docFileMtime(projectRoot, relPath);
  });
  const docs: Doc[] = docRows.map((row) => {
    const mark = marks.get(row.id);
    return mark
      ? { id: row.id, title: row.title, kind: row.kind, mark }
      : { id: row.id, title: row.title, kind: row.kind };
  });

  const nodeRows = db
    .query("SELECT id, kind, tier, title, synopsis FROM nodes ORDER BY created_at")
    .all() as Array<Omit<Node, "sources">>;
  const sourceRows = db.query("SELECT node_id, doc_id, span FROM sources").all() as Array<{
    node_id: string;
    doc_id: string;
    span: string | null;
  }>;
  const messageSourceRows = db
    .query("SELECT node_id, message_id, span FROM message_sources")
    .all() as Array<{
    node_id: string;
    message_id: string;
    span: string | null;
  }>;
  const sourcesByNode = new Map<string, NodeSource[]>();
  for (const row of sourceRows) {
    const list = sourcesByNode.get(row.node_id) ?? [];
    list.push({ docId: row.doc_id, span: row.span });
    sourcesByNode.set(row.node_id, list);
  }
  for (const row of messageSourceRows) {
    const list = sourcesByNode.get(row.node_id) ?? [];
    list.push({ messageId: row.message_id, span: row.span });
    sourcesByNode.set(row.node_id, list);
  }
  const nodes: Node[] = nodeRows.map((row) => ({
    ...row,
    sources: sourcesByNode.get(row.id) ?? [],
  }));

  const edges = db
    .query("SELECT id, source, target, label, provenance, direction FROM edges ORDER BY created_at")
    .all() as Edge[];

  const zones = db.query("SELECT id, name FROM zones ORDER BY ts, id").all() as Zone[];

  const proposalRows = db
    .query(
      "SELECT id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, result_node_id, author, zone_id FROM proposals ORDER BY created_at",
    )
    .all() as Array<{
    id: string;
    kind: string;
    draft_json: string;
    evidence_doc_id: string | null;
    evidence_message_id: string | null;
    evidence_span: string | null;
    suggested_tier: string | null;
    status: string;
    result_node_id: string | null;
    author: string | null;
    zone_id: string | null;
  }>;
  const proposals: Proposal[] = proposalRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    draft: JSON.parse(row.draft_json),
    evidence: {
      docId: row.evidence_doc_id,
      messageId: row.evidence_message_id,
      span: row.evidence_span,
    },
    suggestedTier: row.suggested_tier,
    status: row.status,
    resultNodeId: row.result_node_id,
    author: row.author === "user" ? "user" : "agent",
    zoneId: row.zone_id,
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
    .query("SELECT owner, node_id, depth, doc_id FROM lens WHERE project_id = ?")
    .get(project.id) as {
    owner: string;
    node_id: string | null;
    depth: number | null;
    doc_id: string | null;
  } | null;
  const lens: Lens | null = lensRow
    ? { owner: lensRow.owner, nodeId: lensRow.node_id, depth: lensRow.depth, docId: lensRow.doc_id }
    : null;

  return { project, docs, nodes, edges, zones, proposals, conversation, lens, cursor, epoch };
}

export type { Doc, Edge, Lens, Message, Node, NodeSource, ProjectState, Proposal, Zone };
export { readState };

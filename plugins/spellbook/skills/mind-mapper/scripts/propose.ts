// P2 — `propose-node`/`propose-edge` CLI verb backing. Inserts a pending
// proposals row, emits proposal.added. The draft is opaque JSON to the
// daemon — it doesn't validate the agent's extraction, only stores it
// (dumb daemon, Claim A).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";
import type { Proposal } from "./state.ts";

interface ProposeInput {
  draft: unknown;
  evidence: { docId?: string; span?: string };
  suggestedTier?: string;
}

function insertProposal(
  db: Database,
  bus: EventBus,
  kind: "node" | "edge",
  input: ProposeInput,
): Proposal {
  const id = crypto.randomUUID();
  const draftJson = JSON.stringify(input.draft);
  // The draft stays opaque (Claim A), but evidence.docId becomes a filesystem
  // path component at ratify time — reject non-slug ids at intake so a bad
  // one fails loud here, not as a file write later.
  if (input.evidence.docId !== undefined && !SLUG_RE.test(input.evidence.docId)) {
    throw new Error(`evidence.docId is not a valid doc slug: ${input.evidence.docId}`);
  }
  const evidenceDocId = input.evidence.docId ?? null;
  const evidenceSpan = input.evidence.span ?? null;
  const suggestedTier = input.suggestedTier ?? null;

  db.run(
    "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_span, suggested_tier, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    [id, kind, draftJson, evidenceDocId, evidenceSpan, suggestedTier],
  );

  const proposal: Proposal = {
    id,
    kind,
    draft: input.draft,
    evidence: { docId: evidenceDocId, span: evidenceSpan },
    suggestedTier,
    status: "pending",
    resultNodeId: null,
  };
  bus.emit("proposal.added", proposal as unknown as Record<string, unknown>);
  return proposal;
}

function proposeNode(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "node", input);
}

function proposeEdge(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "edge", input);
}

export type { ProposeInput };
export { proposeEdge, proposeNode };

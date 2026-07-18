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
  // Claim E: evidence grounds in EITHER a doc or a conversation message,
  // never both — mutual exclusion enforced at intake.
  evidence: { docId?: string; messageId?: string; span?: string };
  suggestedTier?: string;
  // Claim D: who sketched this proposal. Omitted → "agent" (the historical
  // default — every pre-author row was an agent proposal).
  author?: "user" | "agent";
}

function insertProposal(
  db: Database,
  bus: EventBus,
  kind: "node" | "edge",
  input: ProposeInput,
): Proposal {
  const id = crypto.randomUUID();
  // The draft stays OPAQUE (Claim A) but not ABSENT — a missing draft used
  // to surface as a raw "NOT NULL constraint failed: proposals.draft_json";
  // name the expected shape at intake instead.
  if (input.draft === undefined || input.draft === null) {
    throw new Error(
      'propose requires a draft — expected {"draft": {title, synopsis, ...}, "evidence": {docId|messageId, span}, "suggestedTier"?}',
    );
  }
  const draftJson = JSON.stringify(input.draft);
  // The draft stays opaque (Claim A), but evidence.docId becomes a filesystem
  // path component at ratify time — reject non-slug ids at intake so a bad
  // one fails loud here, not as a file write later. SLUG_RE guards docId
  // ONLY: a messageId is a UUID that never touches the filesystem.
  if (input.evidence.docId !== undefined && input.evidence.messageId !== undefined) {
    throw new Error("evidence must ground in a doc OR a message, not both");
  }
  if (input.evidence.docId !== undefined && !SLUG_RE.test(input.evidence.docId)) {
    throw new Error(`evidence.docId is not a valid doc slug: ${input.evidence.docId}`);
  }
  // A dangling message reference would make the proposal un-navigable the
  // moment it renders — fail loud at intake, not at surface click time.
  if (input.evidence.messageId !== undefined) {
    const exists = db
      .query("SELECT 1 FROM messages WHERE id = ?")
      .get(input.evidence.messageId) as unknown;
    if (exists === null) {
      throw new Error(`evidence.messageId does not exist: ${input.evidence.messageId}`);
    }
  }
  if (input.author !== undefined && input.author !== "user" && input.author !== "agent") {
    throw new Error(`author must be user or agent, got: ${String(input.author)}`);
  }
  const evidenceDocId = input.evidence.docId ?? null;
  const evidenceMessageId = input.evidence.messageId ?? null;
  const evidenceSpan = input.evidence.span ?? null;
  const suggestedTier = input.suggestedTier ?? null;
  // Written explicitly on every NEW row — the column stays nullable only so
  // the fresh-install shape equals the migrated shape (Claim D); the wire
  // never carries null (readState normalizes pre-column rows).
  const author = input.author ?? "agent";

  db.run(
    "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, author) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
    [id, kind, draftJson, evidenceDocId, evidenceMessageId, evidenceSpan, suggestedTier, author],
  );

  const proposal: Proposal = {
    id,
    kind,
    draft: input.draft,
    evidence: { docId: evidenceDocId, messageId: evidenceMessageId, span: evidenceSpan },
    suggestedTier,
    status: "pending",
    resultNodeId: null,
    author,
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

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
  // Round 3 (Claim Z1): stage this proposal in a zone. Omitted → main queue
  // (zone_id null). Must name an existing zone — a dangling zone_id would
  // orphan the proposal out of every view.
  zone?: string;
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
  // Zone intake guard (Round 3): same fail-loud-at-intake spirit as docId —
  // an unknown zone is a usage error here, never a dangling row later.
  if (input.zone !== undefined) {
    if (!SLUG_RE.test(input.zone)) {
      throw new Error(`zone is not a valid zone slug: ${input.zone}`);
    }
    if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(input.zone)) {
      throw new Error(`unknown zone: ${input.zone}`);
    }
  }
  const evidenceDocId = input.evidence.docId ?? null;
  const evidenceMessageId = input.evidence.messageId ?? null;
  const evidenceSpan = input.evidence.span ?? null;
  const suggestedTier = input.suggestedTier ?? null;
  // Written explicitly on every NEW row — the column stays nullable only so
  // the fresh-install shape equals the migrated shape (Claim D); the wire
  // never carries null (readState normalizes pre-column rows).
  const author = input.author ?? "agent";
  const zoneId = input.zone ?? null;

  db.run(
    "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, author, zone_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    [
      id,
      kind,
      draftJson,
      evidenceDocId,
      evidenceMessageId,
      evidenceSpan,
      suggestedTier,
      author,
      zoneId,
    ],
  );

  // propose emits the FULL proposal object, so proposal.added carries zoneId
  // for free — payload-tagging is the mechanism (events are project-scoped
  // and can never be zone-scoped; consumers filter by the tag).
  const proposal: Proposal = {
    id,
    kind,
    draft: input.draft,
    evidence: { docId: evidenceDocId, messageId: evidenceMessageId, span: evidenceSpan },
    suggestedTier,
    status: "pending",
    resultNodeId: null,
    author,
    zoneId,
  };
  bus.emit("proposal.added", proposal as unknown as Record<string, unknown>);
  return proposal;
}

// R3 gate rework (cassandra's cold drive): an edge draft with the WRONG
// endpoint keys (from/to, src/dst…) sails through opaque intake, bypasses
// promote's endpoint-order guard (unknown refs pass by design), and only
// dies at ratify — the worst possible distance from the mistake. This is a
// WARNING, never a reject: draft opacity stays sacred (Contract 8), the
// daemon just names the missing keys next to the accepted proposal so the
// cold agent hears about it in the same turn.
function edgeDraftWarning(draft: unknown): string | null {
  if (draft === null || typeof draft !== "object") {
    return 'edge draft is not an object — expected {"source": "<node-or-proposal-id>", "target": "<node-or-proposal-id>", "label": "..."}; stored as-is (opaque intake), but ratify will fail on it';
  }
  const d = draft as Record<string, unknown>;
  const missing = ["source", "target"].filter((key) => typeof d[key] !== "string");
  if (missing.length === 0) return null;
  return `edge draft has no string ${missing.join("/")} key(s) — endpoints ride "source"/"target" (node or pending node-proposal ids); other keys are NOT rejected (the draft is opaque to the daemon), but ratify will fail to resolve the endpoints`;
}

function proposeNode(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "node", input);
}

function proposeEdge(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "edge", input);
}

export type { ProposeInput };
export { edgeDraftWarning, proposeEdge, proposeNode };

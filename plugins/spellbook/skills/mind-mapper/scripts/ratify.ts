// P3 — `ratify <proposalId> --ruling canon|thread|story-local|reject
// --doc-edit <file>` backing. On accept: writes the agent-supplied doc edit
// verbatim (the daemon never composes prose — house-style's review-queue
// contract), appends a one-line changelog entry, creates the ratified
// node/edge row, marks the proposal ratified, emits node.ratified/
// edge.ratified. On reject: marks rejected, touches nothing else, no
// justification required (ratified contract).
//
// Ratify-time evidence attach (P3 gate ruling): `--doc <docId> --doc-edit
// <file> [--span <text>]` lets the ruling attach a doc home to an
// EVIDENCE-LESS node proposal (the human-sketch inversion) — writes the
// drafted doc, re-indexes, and mints the node's sources row.
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

// Round 4 (R1) — the in-zone refusal, typed (the CitedError/ZoneNotEmptyError
// family): carries the zoneId so a menu can branch on {error:"zoned", zoneId}
// (409 at the server) instead of string-matching prose. Semantics unchanged:
// ratification — reject included — is a main-queue act; promote first.
class ZonedError extends Error {
  zoneId: string;
  constructor(proposalId: string, zoneId: string) {
    super(
      `proposal ${proposalId} is in zone ${zoneId} — promote first (ratification is a main-queue act)`,
    );
    this.name = "ZonedError";
    this.zoneId = zoneId;
  }
}

interface RatifyInput {
  proposalId: string;
  ruling: Ruling;
  docEdit?: string; // full new content for the proposal's evidence doc (or --doc attach target)
  // Ratify-time evidence attach (P3 gate ruling): a doc home minted at
  // ruling time for an EVIDENCE-LESS node proposal — the human-sketch
  // inversion, where the human already believes the claim and the agent
  // drafts its doc home. Invalid whenever the proposal already carries
  // evidence (doc or message), and node proposals only (edges carry no
  // sources rows). Requires docEdit — the attach IS the drafted doc home.
  docId?: string;
  span?: string; // optional excerpt for the minted sources row (nullable)
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
  evidence_message_id: string | null;
  evidence_span: string | null;
  status: string;
  zone_id: string | null;
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
      "SELECT id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, status, zone_id FROM proposals WHERE id = ?",
    )
    .get(input.proposalId) as ProposalRow | null;
  if (!row) throw new Error(`unknown proposal: ${input.proposalId}`);
  if (row.status !== "pending") {
    throw new Error(`proposal ${input.proposalId} already ${row.status}`);
  }
  // Round 3 (Claim Z2): ratification is a MAIN-GRAPH act — a zoned proposal
  // must be promoted out of its staging pen before it can be ruled on
  // (rejection included: zone delete is the only in-zone disposal).
  if (row.zone_id !== null) {
    throw new ZonedError(input.proposalId, row.zone_id);
  }

  if (input.ruling === "reject") {
    db.run("UPDATE proposals SET status = 'rejected' WHERE id = ?", [input.proposalId]);
    // A1: a rejected proposal's action slots die with it — a slot on a dead
    // target would dangle out of every view.
    db.run("DELETE FROM node_actions WHERE target_id = ?", [input.proposalId]);
    return { id: input.proposalId, status: "rejected" };
  }

  // Ratify-time evidence attach (--doc): valid ONLY for an evidence-less
  // node proposal, and only alongside the doc-edit that drafts its home —
  // all constraints fail loud at intake (same spirit as mark), before any
  // write lands.
  if (input.docId !== undefined) {
    if (row.evidence_doc_id || row.evidence_message_id) {
      throw new Error(
        `proposal ${input.proposalId} already carries evidence; --doc is for evidence-less proposals`,
      );
    }
    if (input.docEdit === undefined) {
      throw new Error("--doc requires --doc-edit (the attach is the agent drafting the doc home)");
    }
    if (row.kind !== "node") {
      throw new Error(
        "--doc is invalid for edge proposals — edges carry no sources rows; attach evidence to the endpoint nodes instead",
      );
    }
    if (!SLUG_RE.test(input.docId)) {
      throw new Error(`--doc is not a valid doc slug: ${input.docId}`);
    }
    if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(input.docId)) {
      throw new Error(`unknown doc: ${input.docId}`);
    }
  }
  // The doc a --doc-edit lands in: the proposal's own evidence doc, or the
  // ratify-time attach target for an evidence-less proposal.
  const homeDocId = row.evidence_doc_id ?? input.docId ?? null;

  if (input.docEdit !== undefined) {
    if (!homeDocId) {
      // Claim E sharpening: message evidence takes no --doc-edit — the
      // transcript is the source and the daemon never writes messages.
      throw new Error(
        row.evidence_message_id
          ? `proposal ${input.proposalId} has message evidence — --doc-edit is invalid for message-grounded proposals`
          : `proposal ${input.proposalId} has no evidence doc to edit (attach one with --doc)`,
      );
    }
    // Defense in depth: propose.ts rejects non-slug evidence ids at intake,
    // but this row may predate that guard (or come from another writer) —
    // never let a stored id reach the filesystem unvalidated.
    if (!SLUG_RE.test(homeDocId)) {
      throw new Error(`refusing doc edit: evidence doc id is not a valid slug: ${homeDocId}`);
    }
    writeFileSync(join(docsDir, `${homeDocId}.md`), input.docEdit);
    // Keep the search index true to the doc it indexes (Claim B: sqlite owns
    // search OVER the prose the docs own) — a ratified edit must re-index,
    // or search keeps matching the pre-edit text (review finding).
    db.run("DELETE FROM docs_fts WHERE doc_id = ?", [homeDocId]);
    db.run("INSERT INTO docs_fts (doc_id, content) VALUES (?, ?)", [homeDocId, input.docEdit]);
  }
  // Every accept logs, with or without a doc edit — the changelog is the
  // attributed what-changed record, not a doc-write side effect.
  appendFileSync(
    join(docsDir, "..", "changelog.txt"),
    `ratified ${input.proposalId} (${input.ruling})${homeDocId ? ` -> ${homeDocId}.md` : ""}${input.docEdit !== undefined ? " (doc edited)" : ""}\n`,
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
    if (row.evidence_message_id) {
      db.run("INSERT INTO message_sources (node_id, message_id, span) VALUES (?, ?, ?)", [
        nodeId,
        row.evidence_message_id,
        row.evidence_span,
      ]);
    }
    // Ratify-time attach: the minted doc home becomes the node's source
    // (only reachable when the proposal was evidence-less — guarded above).
    if (input.docId !== undefined) {
      db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
        nodeId,
        input.docId,
        input.span ?? null,
      ]);
    }
    db.run("UPDATE proposals SET status = 'ratified', result_node_id = ? WHERE id = ?", [
      nodeId,
      input.proposalId,
    ]);
    // A1: re-home the proposal's action slots onto the minted node id (the
    // stigmergy payoff — slots survive ratification; nodeId is a fresh UUID,
    // so the PK move can never collide).
    db.run("UPDATE node_actions SET target_id = ? WHERE target_id = ?", [nodeId, input.proposalId]);
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
  // A1: actions live on ratified NODES and pending proposals only — an edge
  // proposal's slots have nowhere to re-home, so they die with the ruling.
  db.run("DELETE FROM node_actions WHERE target_id = ?", [input.proposalId]);
  bus.emit("edge.ratified", { id: edgeId, proposalId: input.proposalId });
  return { id: input.proposalId, status: "ratified", edgeId };
}

export type { RatifyInput, RatifyResult, Ruling };
export { ratify, ZonedError };

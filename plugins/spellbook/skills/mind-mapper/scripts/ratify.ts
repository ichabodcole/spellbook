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
import { anchorGuard } from "./anchor.ts";
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

// Round 6 (RB) — factor the ratify write-path exactly as buildProposal was
// factored from insertProposal: validate + resolve (pure reads + throws, no
// side effects), then return the deferred effects — a `writeDoc` fs closure, a
// db-only `apply`, the `changelogLine`, and a deferred `emit`. This is what
// lets ratify-batch loop `apply()` inside ONE db.transaction() and defer every
// fs write + emit to AFTER commit, so a throw at any stage leaks zero rows,
// zero events, zero changelog lines (the buildProposal atomicity lesson).
// Single `ratify()` keeps calling the pieces inline → behavior-identical.
//
// `resolveRef` overrides edge-endpoint resolution: single ratify resolves
// against the db (resolveNodeRef); batch resolves against its in-progress
// idMap (proposalId → minted nodeId) FIRST, since a batched node proposal's
// result_node_id isn't set until its own apply() runs inside the txn.
interface BuiltRatify {
  apply: () => void; // db-only writes (fts reindex + node/edge/sources/proposal/actions)
  writeDoc: (() => void) | null; // deferred fs doc-edit write (single ratify only)
  changelogLine: string | null;
  emit: () => void; // deferred bus emit
  result: RatifyResult;
}

function buildRatify(
  db: Database,
  docsDir: string,
  input: RatifyInput,
  bus: EventBus,
  resolveRef: (ref: string) => string = (ref) => resolveNodeRef(db, ref),
): BuiltRatify {
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
    // Round 6 (finding #4 root cause): reject used to emit NOTHING, so a
    // rejected node lingered on every surface until a manual refetch. A thin
    // proposal.rejected {id} makes reject LIVE — circe's reducer drops it.
    return {
      apply: () => {
        db.run("UPDATE proposals SET status = 'rejected' WHERE id = ?", [input.proposalId]);
        // A1: a rejected proposal's action slots die with it — a slot on a
        // dead target would dangle out of every view.
        db.run("DELETE FROM node_actions WHERE target_id = ?", [input.proposalId]);
      },
      writeDoc: null,
      changelogLine: null,
      emit: () => bus.emit("proposal.rejected", { id: input.proposalId }),
      result: { id: input.proposalId, status: "rejected" },
    };
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
  }
  // Deferred fs doc write (single ratify only — batch carries no docEdit).
  const writeDoc =
    input.docEdit !== undefined && homeDocId
      ? () => writeFileSync(join(docsDir, `${homeDocId}.md`), input.docEdit as string)
      : null;

  // Every accept logs, with or without a doc edit — the changelog is the
  // attributed what-changed record, not a doc-write side effect.
  const changelogLine = `ratified ${input.proposalId} (${input.ruling})${homeDocId ? ` -> ${homeDocId}.md` : ""}${input.docEdit !== undefined ? " (doc edited)" : ""}\n`;

  const draft = JSON.parse(row.draft_json) as Record<string, unknown>;

  if (row.kind === "node") {
    const nodeId = crypto.randomUUID();
    return {
      writeDoc,
      changelogLine,
      apply: () => {
        // fts re-index rides here (a db write) — keeps search true to the
        // ratified edit; the file write itself is the deferred writeDoc.
        if (input.docEdit !== undefined && homeDocId) {
          db.run("DELETE FROM docs_fts WHERE doc_id = ?", [homeDocId]);
          db.run("INSERT INTO docs_fts (doc_id, content) VALUES (?, ?)", [
            homeDocId,
            input.docEdit,
          ]);
        }
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
        // stigmergy payoff — slots survive ratification; nodeId is a fresh
        // UUID, so the PK move can never collide).
        db.run("UPDATE node_actions SET target_id = ? WHERE target_id = ?", [
          nodeId,
          input.proposalId,
        ]);
      },
      emit: () => bus.emit("node.ratified", { id: nodeId, proposalId: input.proposalId }),
      result: { id: input.proposalId, status: "ratified", nodeId },
    };
  }

  // Edge — resolve endpoints NOW (pure read + throw, before any write); batch
  // passes an idMap-aware resolver so an endpoint naming a batched node
  // proposal resolves to its just-minted id.
  const source = resolveRef(String(draft.source));
  const target = resolveRef(String(draft.target));
  const edgeId = crypto.randomUUID();
  return {
    writeDoc,
    changelogLine,
    apply: () => {
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
    },
    emit: () => bus.emit("edge.ratified", { id: edgeId, proposalId: input.proposalId }),
    result: { id: input.proposalId, status: "ratified", edgeId },
  };
}

// Single ratify — build, then run the pieces inline (writeDoc → apply →
// changelog → emit). No transaction, no batching: byte-for-byte the pre-R6
// behavior, now expressed through buildRatify.
function ratify(db: Database, bus: EventBus, docsDir: string, input: RatifyInput): RatifyResult {
  const built = buildRatify(db, docsDir, input, bus);
  built.writeDoc?.();
  built.apply();
  if (built.changelogLine)
    appendFileSync(join(docsDir, "..", "changelog.txt"), built.changelogLine);
  built.emit();
  return built.result;
}

interface RatifyBatchInput {
  ruling: Ruling;
  ids: string[];
  // Optional post-ratify anchors (submap nesting): each ref may be a batched
  // proposal id (resolved via idMap to its minted node) or a real node id.
  anchors?: Array<{ node: string; parent: string }>;
}

interface RatifyBatchResult {
  // old→new: batched NODE proposal id → the node id it minted. The point of
  // the batch — an edge (or a caller) names a node by its pre-ratify proposal
  // id and gets the real id back in one call.
  idMap: Record<string, string>;
  ratified: RatifyResult[];
}

// Round 6 (RB) — ratify a set in ONE call + one transaction. Auto-partitions
// nodes-before-edges by looking up each id's kind (no caller ordering); NO
// auto-include of unlisted edges (explicit only — no silent ratifications).
// One top-level ruling; reject is NOT a batch act. All validation/resolution
// runs BEFORE the txn (buildRatify is pure), all apply() INSIDE it, all
// changelog appends + emits AFTER commit — a throw at any stage leaves zero
// rows, zero events, zero changelog lines.
function ratifyBatch(
  db: Database,
  bus: EventBus,
  docsDir: string,
  input: RatifyBatchInput,
): RatifyBatchResult {
  if (input.ruling === "reject") {
    throw new Error(
      "ratify-batch does not reject — a reject excludes a proposal from the batch (reject it singly)",
    );
  }

  // Partition by kind (look up each id — the caller supplies no ordering).
  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  for (const id of input.ids) {
    const row = db.query("SELECT kind FROM proposals WHERE id = ?").get(id) as {
      kind: string;
    } | null;
    if (!row) throw new Error(`unknown proposal: ${id}`);
    if (row.kind === "node") nodeIds.push(id);
    else edgeIds.push(id);
  }

  const idMap: Record<string, string> = {};
  const built: BuiltRatify[] = [];
  const ratified: RatifyResult[] = [];

  // Nodes first — build (mints ids + validates) and register in the idMap so
  // edges + anchors can resolve their refs before any write lands.
  for (const id of nodeIds) {
    const b = buildRatify(db, docsDir, { proposalId: id, ruling: input.ruling }, bus);
    idMap[id] = b.result.nodeId as string;
    built.push(b);
    ratified.push(b.result);
  }
  // Edges — resolve endpoints via idMap first (a batched node proposal's
  // result_node_id isn't written until its apply runs in the txn), then real
  // ids / result_node_id via resolveNodeRef (which throws for an unratified,
  // unlisted node proposal — the NO-auto-include guarantee).
  const resolver = (ref: string) => idMap[ref] ?? resolveNodeRef(db, ref);
  for (const id of edgeIds) {
    const b = buildRatify(db, docsDir, { proposalId: id, ruling: input.ruling }, bus, resolver);
    built.push(b);
    ratified.push(b.result);
  }

  // Anchors — resolve refs via idMap-then-real, structural pre-check (both
  // resolve; no self-anchor). The full anchorGuard (existence + cycle walk)
  // runs INSIDE the txn after node inserts, since a just-minted node has no
  // row yet — atomically equivalent (a throw rolls the txn back).
  const anchorPlan = (input.anchors ?? []).map((a) => {
    const node = idMap[a.node] ?? a.node;
    const parent = idMap[a.parent] ?? a.parent;
    if (node === parent) throw new Error(`anchor: a node cannot anchor to itself (${node})`);
    // A ref that is neither a batched node nor an existing real node can never
    // resolve — fail loud before the txn.
    for (const [label, ref] of [
      ["node", node],
      ["parent", parent],
    ] as const) {
      const inBatch = Object.values(idMap).includes(ref);
      const isReal = db.query("SELECT 1 FROM nodes WHERE id = ?").get(ref) !== null;
      if (!inBatch && !isReal) {
        throw new Error(`anchor: ${label} ${ref} is not a batched node proposal or a real node`);
      }
    }
    return { node, parent };
  });

  const run = db.transaction(() => {
    for (const b of built) b.apply();
    for (const p of anchorPlan) {
      anchorGuard(db, p.node, p.parent);
      db.run("UPDATE nodes SET anchor_node_id = ? WHERE id = ?", [p.parent, p.node]);
    }
  });
  run();

  // AFTER commit only — a rollback must never leak a changelog line or event.
  for (const b of built) {
    if (b.changelogLine) appendFileSync(join(docsDir, "..", "changelog.txt"), b.changelogLine);
    b.emit();
  }
  for (const p of anchorPlan) {
    bus.emit("node.anchored", { nodeId: p.node, anchorNodeId: p.parent });
  }

  return { idMap, ratified };
}

export type { RatifyBatchInput, RatifyBatchResult, RatifyInput, RatifyResult, Ruling };
export { ratify, ratifyBatch, ZonedError };

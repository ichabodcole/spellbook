// P1 — the sqlite schema (Claim B: docs own prose, sqlite owns graph index,
// staging, conversation log, FTS5). One file, one version, idempotent
// CREATE TABLE IF NOT EXISTS — no separate migration runner in V1 (ratified,
// vine msg 6). Re-opening an existing store must never error or duplicate.
//
// Amendment (prospero's P1 gate finding, vine msg 20): CREATE TABLE IF NOT
// EXISTS does nothing for a table that already exists under an OLDER shape —
// an existing store opened by newer code needs its columns diffed and
// backfilled. Still not a migration runner: additive-only (nullable ADD
// COLUMN), applied on every open, no versioning/ordering to manage. Anything
// that can't be expressed as an additive ADD COLUMN (a type change, a new
// PRIMARY KEY) throws naming the store path — fail loud, don't corrupt.

import { Database } from "bun:sqlite";

// Columns added to a table after its original shape shipped. Declared
// nullable (no NOT NULL/DEFAULT beyond what ADD COLUMN allows) so they're
// always addable to a populated table.
const ADDITIVE_COLUMNS: Record<string, string[]> = {
  messages: ["id", "kind", "ground_json"],
  // Round 4 (K1): who asserted a doc's kind ("user"|"agent"). Nullable —
  // legacy rows are honestly unattributed (kindAuthor null on the wire).
  docs: ["kind_author"],
  // Round 5 (SG1): a node's parent in the submap tree (null = top-level).
  // Nullable — legacy rows are top-level by construction. Real-nodes-only:
  // proposals are never anchored (they ratify into a node, THEN can be
  // anchored). kind_author precedent (additive after the shape shipped).
  nodes: ["anchor_node_id"],
  proposals: ["result_node_id", "author", "evidence_message_id", "zone_id"],
  // Round 3 (Claim V2): doc-lens — lens rows written before the doc mode
  // shipped simply carry a null doc_id (a node lens, unchanged).
  lens: ["doc_id"],
};

function backfillColumns(db: Database, path: string): void {
  for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
    const existing = new Set(
      (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const column of columns) {
      if (existing.has(column)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      } catch (e) {
        throw new Error(
          `mind-mapper: non-additive schema change needed for ${table}.${column} in ${path}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
  }
}

const SCHEMA = `
-- kind (Round 4, K1): SQLite cannot relax NOT NULL additively (measured,
-- ratify scratch 2026-07-19), so "untyped" is the '' sentinel at rest,
-- null-normalized at read everywhere it rides the wire. The ingest defaults
-- ("ramble"/"story") died with this — a fresh doc is '' until someone
-- asserts a kind. kind_author is nullable-TEXT-only because it arrived via
-- ADDITIVE_COLUMNS after the original shape shipped (fresh-equals-migrated).
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  kind_author TEXT
);

-- anchor_node_id (Round 5, SG1): a node's parent in the submap tree —
-- nullable-TEXT-only because it arrived via ADDITIVE_COLUMNS after the
-- original shape shipped (fresh-equals-migrated). null = top-level; a strict
-- tree (one anchor per node), orthogonal to zone_id. Cycle-freedom is
-- enforced at the write path (anchor.ts ancestor-walk), never by the schema.
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  anchor_node_id TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT NOT NULL,
  provenance TEXT NOT NULL,
  direction TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sources (
  node_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  span TEXT
);

-- result_node_id: set when a NODE proposal is ratified, to the id of the
-- node it produced — lets an edge proposal reference an unratified node's
-- proposal id as its source/target and have ratify resolve it once that
-- node proposal itself ratifies (P3 finding from cassandra's cold-agent
-- drive: this endpoint-resolution mechanism was previously unvalidated).
--
-- author/evidence_message_id (V1.x Claims D/E): nullable-TEXT-only because
-- they arrived via ADDITIVE_COLUMNS after the original shape shipped — the
-- fresh-install shape must equal the migrated shape. "author defaults to
-- agent" is expressed as null-normalized-at-read (state.ts), never as a
-- NOT NULL DEFAULT here. evidence_message_id is mutually exclusive with
-- evidence_doc_id (enforced at propose intake, not by the schema).
-- zone_id (Round 3, Claim Z1): nullable — the main graph is zone_id IS NULL,
-- so every pre-zones row is a main-queue proposal by construction. Zone
-- contents are PROPOSALS ONLY (nodes/edges never carry zone_id): a zone is
-- staging, and promotion (zone_id -> NULL) is the only exit.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  evidence_doc_id TEXT,
  evidence_span TEXT,
  suggested_tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  result_node_id TEXT,
  author TEXT,
  evidence_message_id TEXT,
  zone_id TEXT
);

-- Round 3 (Claim Z1): a zone is a named staging pen for proposals — nothing
-- else. Ids are SLUGS derived from the name (conversational
-- referenceability, ruled); no rename in this round. Per-project by
-- construction (each project owns its own store.sqlite).
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- V1.x Claim B: append-only mark trail; latest-per-doc is the live mark.
-- doc_mtime snapshots the doc file's mtime (ms) at mark time — staleness is
-- computed at read time (current mtime > doc_mtime), never stored or
-- emitted. New table, additive by construction — no migration machinery.
CREATE TABLE IF NOT EXISTS doc_marks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  author TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,
  doc_mtime INTEGER,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- V1.x Claim E: conversation evidence. sources.doc_id is NOT NULL and SQLite
-- can't relax that additively, so message-grounded provenance gets a sibling
-- table instead of a nullable column — readState merges both into
-- node.sources[] as the union {docId, span} | {messageId, span}.
CREATE TABLE IF NOT EXISTS message_sources (
  node_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  span TEXT
);

-- id/kind/ground_json are nullable here even though application code always
-- supplies them for new rows — they were added after messages' original
-- shape shipped, and an ADD COLUMN backfill (below) can only add nullable
-- columns to a populated table, so the fresh-install shape matches what a
-- migrated store ends up with (no drift between the two paths).
CREATE TABLE IF NOT EXISTS messages (
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  id TEXT,
  kind TEXT,
  ground_json TEXT
);

-- doc_id (Round 3, Claim V2): the doc-lens variant. node_id XOR doc_id is
-- enforced at the write path (setLens writes every column on upsert, the
-- /lens route validates the XOR) — the schema stays permissive so the
-- ADD COLUMN backfill can land on populated stores.
CREATE TABLE IF NOT EXISTS lens (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  node_id TEXT,
  depth INTEGER,
  doc_id TEXT
);

-- Round 4 (A1): agent-authored action slots, target-keyed — target_id is a
-- node id OR a PENDING proposal's id (disjoint UUID spaces, measured; the
-- lens precedent: agent-writable metadata, not staged, not ratified).
-- Lifecycle rides the owners: ratify re-homes the row onto the minted node
-- id, reject deletes it, zone delete cascades it, promote is a no-op.
CREATE TABLE IF NOT EXISTS node_actions (
  target_id TEXT PRIMARY KEY,
  actions_json TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, content);

-- Explicit dual-write from send.ts at insert time (not a trigger) — simpler,
-- and search should find things said in conversation, not just written to
-- docs (proposal.md's hybrid-search stance).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content);
`;

function openStore(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  backfillColumns(db, path);
  return db;
}

export { openStore };

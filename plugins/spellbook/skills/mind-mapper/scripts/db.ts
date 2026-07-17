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
  proposals: ["result_node_id"],
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
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL,
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  evidence_doc_id TEXT,
  evidence_span TEXT,
  suggested_tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  result_node_id TEXT
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

CREATE TABLE IF NOT EXISTS lens (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  node_id TEXT,
  depth INTEGER
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

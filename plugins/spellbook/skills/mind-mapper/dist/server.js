#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/mind-mapper/backend/server.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync4 } from "fs";
import { homedir } from "os";
import { join as join6 } from "path";
import { parseArgs } from "util";

// src/mind-mapper/backend/actions.ts
var ACTIONS_SOFT_CAP = 4;
var ACTIONS_BYTE_CAP = 16 * 1024;
function parseActions(raw) {
  if (!Array.isArray(raw)) {
    throw new Error(`the request body IS the action array \u2014 send a BARE JSON array of {"id","label","seed"} string triples (empty array clears), NOT {"actions":[...]}; got ${typeof raw === "object" && raw !== null ? `an object with keys: ${Object.keys(raw).join(", ")}` : typeof raw}`);
  }
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`actions[${i}] is not an object \u2014 expected {"id", "label", "seed"}`);
    }
    const { id, label, seed } = entry;
    if (typeof id !== "string" || typeof label !== "string" || typeof seed !== "string") {
      throw new Error(`actions[${i}] needs string id/label/seed`);
    }
    return { id, label, seed };
  });
}
function resolveTarget(db, targetId) {
  if (db.query("SELECT 1 FROM nodes WHERE id = ?").get(targetId))
    return "node";
  const proposal = db.query("SELECT status FROM proposals WHERE id = ?").get(targetId);
  if (proposal?.status === "pending")
    return "proposal";
  return null;
}
function setActions(db, bus, targetId, rawActions) {
  if (resolveTarget(db, targetId) === null)
    return null;
  const actions = parseActions(rawActions);
  if (actions.length === 0) {
    db.run("DELETE FROM node_actions WHERE target_id = ?", [targetId]);
    bus.emit("actions.set", { targetId, actions: [] });
    return { targetId, actions: [] };
  }
  const json = JSON.stringify(actions);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > ACTIONS_BYTE_CAP) {
    throw new Error(`actions payload is ${bytes} bytes \u2014 over the ${ACTIONS_BYTE_CAP}-byte cap; trim the seeds`);
  }
  db.run("INSERT INTO node_actions (target_id, actions_json) VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET actions_json = excluded.actions_json", [targetId, json]);
  bus.emit("actions.set", { targetId, actions });
  const result = { targetId, actions };
  if (actions.length > ACTIONS_SOFT_CAP) {
    result.warning = `${actions.length} actions on one target \u2014 surfaces render ${ACTIONS_SOFT_CAP} plus scroll; consider fewer, sharper slots`;
  }
  return result;
}
function clearActions(db, bus, targetId) {
  return setActions(db, bus, targetId, []);
}
function readActions(db) {
  const rows = db.query("SELECT target_id, actions_json FROM node_actions").all();
  const out = new Map;
  for (const row of rows) {
    try {
      out.set(row.target_id, JSON.parse(row.actions_json));
    } catch {}
  }
  return out;
}

// src/mind-mapper/backend/anchor.ts
class AnchorError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnchorError";
  }
}
function anchorGuard(db, nodeId, parentId) {
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(nodeId)) {
    throw new AnchorError(`unknown node: ${nodeId}`);
  }
  if (parentId === null)
    return;
  if (parentId === nodeId)
    throw new AnchorError("a node cannot anchor to itself");
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(parentId)) {
    throw new AnchorError(`unknown anchor target: ${parentId}`);
  }
  let cur = parentId;
  const seen = new Set;
  while (cur !== null) {
    if (cur === nodeId) {
      throw new AnchorError(`cycle: ${nodeId} is already an ancestor of ${parentId}`);
    }
    if (seen.has(cur))
      break;
    seen.add(cur);
    const row = db.query("SELECT anchor_node_id FROM nodes WHERE id = ?").get(cur);
    cur = row?.anchor_node_id ?? null;
  }
}
function anchorNode(db, bus, nodeId, parentId) {
  anchorGuard(db, nodeId, parentId);
  db.run("UPDATE nodes SET anchor_node_id = ? WHERE id = ?", [parentId, nodeId]);
  bus.emit("node.anchored", { nodeId, anchorNodeId: parentId });
  return { nodeId, anchorNodeId: parentId };
}

// src/mind-mapper/backend/jobs.ts
var JOB_STATUSES = ["queued", "running", "blocked", "done", "failed", "canceled"];

class ClaimConflictError extends Error {
  claimedBy;
  constructor(claimedBy) {
    super(`job already claimed by ${claimedBy}`);
    this.name = "ClaimConflictError";
    this.claimedBy = claimedBy;
  }
}
function assertStatus(status) {
  if (typeof status !== "string" || !JOB_STATUSES.includes(status)) {
    throw new Error(`status must be one of ${JOB_STATUSES.join("|")}`);
  }
  return status;
}
function parseSubtasks(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr))
      return [];
    return arr.filter((s) => s !== null && typeof s === "object").map((s) => ({
      id: String(s.id),
      label: String(s.label),
      done: Boolean(s.done)
    }));
  } catch {
    return [];
  }
}
var JOB_COLUMNS = "id, project, title, status, claimed_by, deliverable, subtasks_json, detail, created_at, updated_at";
function rowToJob(row) {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    status: assertStatusLenient(row.status),
    claimedBy: row.claimed_by,
    deliverable: row.deliverable,
    subtasks: parseSubtasks(row.subtasks_json),
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function assertStatusLenient(status) {
  return status;
}
function buildJob(input) {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new Error("job requires a non-empty title");
  }
  if (typeof input.project !== "string" || input.project === "") {
    throw new Error("job requires a project scope");
  }
  const status = input.status === undefined ? "queued" : assertStatus(input.status);
  const id = crypto.randomUUID();
  const now = Date.now();
  const job = {
    id,
    project: input.project,
    title: input.title,
    status,
    claimedBy: null,
    deliverable: input.deliverable ?? null,
    subtasks: [],
    detail: input.detail ?? null,
    createdAt: now,
    updatedAt: now
  };
  const insert = (db) => {
    db.run(`INSERT INTO jobs (${JOB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      job.project,
      job.title,
      status,
      null,
      job.deliverable,
      "[]",
      job.detail,
      now,
      now
    ]);
  };
  return { job, insert };
}
function readJob(db, id) {
  const row = db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id);
  return row ? rowToJob(row) : null;
}
function readJobs(db) {
  const rows = db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at`).all();
  return rows.map(rowToJob);
}
function createJob(db, bus, input) {
  const { job, insert } = buildJob(input);
  insert(db);
  const fresh = readJob(db, job.id);
  if (fresh)
    bus.emit("job.added", fresh);
  return job;
}
function updateJob(db, bus, id, patch) {
  if (readJob(db, id) === null)
    return null;
  const sets = [];
  const args = [];
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string" || patch.title.trim() === "") {
      throw new Error("title must be a non-empty string");
    }
    sets.push("title = ?");
    args.push(patch.title);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(assertStatus(patch.status));
  }
  if (patch.deliverable !== undefined) {
    sets.push("deliverable = ?");
    args.push(patch.deliverable);
  }
  if (patch.detail !== undefined) {
    sets.push("detail = ?");
    args.push(patch.detail);
  }
  if (sets.length === 0)
    throw new Error("update needs at least one of title|status|deliverable|detail");
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);
  db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args);
  const fresh = readJob(db, id);
  if (fresh)
    bus.emit("job.updated", fresh);
  return fresh;
}
function claimJob(db, bus, id, owner) {
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new Error("claim requires a non-empty owner");
  }
  const result = db.query("UPDATE jobs SET claimed_by = ?, status = 'running', updated_at = ? WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)").run(owner, Date.now(), id, owner);
  if (result.changes === 0) {
    const existing = db.query("SELECT claimed_by FROM jobs WHERE id = ?").get(id);
    if (existing === null)
      return null;
    throw new ClaimConflictError(String(existing.claimed_by));
  }
  const fresh = readJob(db, id);
  if (fresh)
    bus.emit("job.claimed", fresh);
  return fresh;
}
function releaseJob(db, bus, id) {
  if (readJob(db, id) === null)
    return null;
  db.run("UPDATE jobs SET claimed_by = NULL, updated_at = ? WHERE id = ?", [Date.now(), id]);
  const fresh = readJob(db, id);
  if (fresh)
    bus.emit("job.updated", fresh);
  return fresh;
}
function mutateSubtasks(db, bus, id, mutate) {
  const job = readJob(db, id);
  if (job === null)
    return null;
  const subtasks = job.subtasks;
  mutate(subtasks);
  db.run("UPDATE jobs SET subtasks_json = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(subtasks),
    Date.now(),
    id
  ]);
  const fresh = readJob(db, id);
  if (fresh)
    bus.emit("job.updated", fresh);
  return fresh;
}
function addSubtask(db, bus, id, label) {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("subtask add requires a non-empty label");
  }
  return mutateSubtasks(db, bus, id, (subtasks) => {
    subtasks.push({ id: crypto.randomUUID(), label, done: false });
  });
}
function setSubtaskDone(db, bus, id, subtaskId, done) {
  if (readJob(db, id) === null)
    return null;
  return mutateSubtasks(db, bus, id, (subtasks) => {
    const subtask = subtasks.find((s) => s.id === subtaskId);
    if (subtask === undefined)
      throw new Error(`unknown subtask: ${subtaskId}`);
    subtask.done = done;
  });
}
function deleteJob(db, bus, id) {
  if (readJob(db, id) === null)
    return null;
  db.run("DELETE FROM jobs WHERE id = ?", [id]);
  bus.emit("job.deleted", { id });
  return { id };
}

// src/mind-mapper/backend/marks.ts
import { statSync } from "fs";
import { join as join2 } from "path";

// src/mind-mapper/backend/project.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// src/mind-mapper/backend/db.ts
import { Database } from "bun:sqlite";
var ADDITIVE_COLUMNS = {
  messages: ["id", "kind", "ground_json"],
  docs: ["kind_author"],
  nodes: ["anchor_node_id"],
  proposals: ["result_node_id", "author", "evidence_message_id", "zone_id", "batch_id"],
  lens: ["doc_id"]
};
function backfillColumns(db, path) {
  for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
    const existing = new Set(db.query(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const column of columns) {
      if (existing.has(column))
        continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      } catch (e) {
        throw new Error(`mind-mapper: non-additive schema change needed for ${table}.${column} in ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
var SCHEMA = `
-- kind (Round 4, K1): SQLite cannot relax NOT NULL additively (measured,
-- ratify scratch 2026-07-19), so "untyped" is the '' sentinel at rest,
-- null-normalized at read everywhere it rides the wire. The ingest defaults
-- ("ramble"/"story") died with this \u2014 a fresh doc is '' until someone
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

-- anchor_node_id (Round 5, SG1): a node's parent in the submap tree \u2014
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
-- node it produced \u2014 lets an edge proposal reference an unratified node's
-- proposal id as its source/target and have ratify resolve it once that
-- node proposal itself ratifies (P3 finding from cassandra's cold-agent
-- drive: this endpoint-resolution mechanism was previously unvalidated).
--
-- author/evidence_message_id (V1.x Claims D/E): nullable-TEXT-only because
-- they arrived via ADDITIVE_COLUMNS after the original shape shipped \u2014 the
-- fresh-install shape must equal the migrated shape. "author defaults to
-- agent" is expressed as null-normalized-at-read (state.ts), never as a
-- NOT NULL DEFAULT here. evidence_message_id is mutually exclusive with
-- evidence_doc_id (enforced at propose intake, not by the schema).
-- zone_id (Round 3, Claim Z1): nullable \u2014 the main graph is zone_id IS NULL,
-- so every pre-zones row is a main-queue proposal by construction. Zone
-- contents are PROPOSALS ONLY (nodes/edges never carry zone_id): a zone is
-- staging, and promotion (zone_id -> NULL) is the only exit.
-- batch_id (Round 12, SEAM 1): the staging ACT this proposal came from \u2014 minted
-- per POST /proposals/batch call (or supplied by the caller to JOIN an
-- existing act). Nullable-TEXT-only because it arrived via ADDITIVE_COLUMNS
-- after the shape shipped; null = unbatched, the honest reading of a single
-- propose and of every pre-R12 row. It survives ratification because the
-- PROPOSAL ROW survives ratification \u2014 that IS the point: after a PARTIAL
-- ratification the agent can ask "what else came from that call".
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
  zone_id TEXT,
  batch_id TEXT
);

-- Round 3 (Claim Z1): a zone is a named staging pen for proposals \u2014 nothing
-- else. Ids are SLUGS derived from the name (conversational
-- referenceability, ruled); no rename in this round. Per-project by
-- construction (each project owns its own store.sqlite).
CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- V1.x Claim B: append-only mark trail; latest-per-doc is the live mark.
-- doc_mtime snapshots the doc file's mtime (ms) at mark time \u2014 staleness is
-- computed at read time (current mtime > doc_mtime), never stored or
-- emitted. New table, additive by construction \u2014 no migration machinery.
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
-- table instead of a nullable column \u2014 readState merges both into
-- node.sources[] as the union {docId, span} | {messageId, span}.
CREATE TABLE IF NOT EXISTS message_sources (
  node_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  span TEXT
);

-- id/kind/ground_json are nullable here even though application code always
-- supplies them for new rows \u2014 they were added after messages' original
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
-- /lens route validates the XOR) \u2014 the schema stays permissive so the
-- ADD COLUMN backfill can land on populated stores.
CREATE TABLE IF NOT EXISTS lens (
  project_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  node_id TEXT,
  depth INTEGER,
  doc_id TEXT
);

-- Round 4 (A1): agent-authored action slots, target-keyed \u2014 target_id is a
-- node id OR a PENDING proposal's id (disjoint UUID spaces, measured; the
-- lens precedent: agent-writable metadata, not staged, not ratified).
-- Lifecycle rides the owners: ratify re-homes the row onto the minted node
-- id, reject deletes it, zone delete cascades it, promote is a no-op.
CREATE TABLE IF NOT EXISTS node_actions (
  target_id TEXT PRIMARY KEY,
  actions_json TEXT NOT NULL
);

-- Round 7 (TAGS): freeform agent-curated tags, target-keyed \u2014 the exact twin
-- of node_actions. target_id is a node id OR a PENDING proposal's id (the same
-- disjoint-UUID-space, pending-carry, re-home-on-ratify lifecycle). Stored as a
-- json string[] (FREEFORM \u2014 the engine stores strings; vocab/curation is a
-- surface concern). New table, additive by construction (CREATE TABLE IF NOT
-- EXISTS \u2014 no ADDITIVE_COLUMNS entry, like zones/node_actions).
CREATE TABLE IF NOT EXISTS node_tags (
  target_id TEXT PRIMARY KEY,
  tags_json TEXT NOT NULL
);

-- Round 9 (Job Queue): a first-class, persisted unit of AGENT WORK \u2014 status +
-- sub-tasks + a deliverable + an OWNER (claimed_by, the lease). New table,
-- additive by construction (CREATE TABLE IF NOT EXISTS \u2014 NO ADDITIVE_COLUMNS
-- entry, the zones/node_actions/node_tags precedent). First-class-with-a-
-- status-column follows the proposals shape. claimed_by / deliverable / detail
-- are nullable (unclaimed / no output / no notes); subtasks_json defaults '[]'
-- ([{id,label,done}], D4 \u2014 the checklist rides its job, no child table).
-- created_at/updated_at are app-written epoch MS (NOT a unixepoch() default \u2014
-- updated_at must bump on every mutation with sub-second ordering). Liveness is
-- DERIVED client-side from agent.activity (D2) \u2014 there is deliberately NO
-- last_seen/heartbeat column here.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_by TEXT,
  deliverable TEXT,
  subtasks_json TEXT NOT NULL DEFAULT '[]',
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, content);

-- Explicit dual-write from send.ts at insert time (not a trigger) \u2014 simpler,
-- and search should find things said in conversation, not just written to
-- docs (proposal.md's hybrid-search stance).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, content);
`;
function openStore(path) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  backfillColumns(db, path);
  return db;
}

// src/mind-mapper/backend/project.ts
var DEFAULT_PROJECT_ID = "default";
var SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
var ID_RE = SLUG_RE;
function projectDir(home, id) {
  return join(home, "projects", id);
}
function readMeta(dir, id) {
  const metaFile = join(dir, "project.json");
  if (existsSync(metaFile)) {
    try {
      const parsed = JSON.parse(readFileSync(metaFile, "utf8"));
      if (typeof parsed.title === "string")
        return { id, title: parsed.title };
    } catch {}
  }
  return { id, title: id };
}
function ensureProjectDirs(dir) {
  mkdirSync(join(dir, "docs"), { recursive: true });
}
function createProject(home, id, title) {
  if (!ID_RE.test(id))
    throw new Error(`invalid project id: ${id}`);
  const dir = projectDir(home, id);
  if (existsSync(dir))
    throw new Error(`project already exists: ${id}`);
  ensureProjectDirs(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify({ title }, null, 2));
  openStore(join(dir, "store.sqlite")).close();
  return { id, title };
}

class NeedsProjectError extends Error {
  constructor() {
    super("no project scope and no default project \u2014 create or pick one");
    this.name = "NeedsProjectError";
  }
}

class UnknownProjectError extends Error {
  constructor(id) {
    super(`unknown project: ${id}`);
    this.name = "UnknownProjectError";
  }
}
function resolveProject(home, id) {
  if (id === undefined) {
    const dir2 = projectDir(home, DEFAULT_PROJECT_ID);
    if (!existsSync(dir2))
      throw new NeedsProjectError;
    return readMeta(dir2, DEFAULT_PROJECT_ID);
  }
  const dir = projectDir(home, id);
  if (!existsSync(dir))
    throw new UnknownProjectError(id);
  return readMeta(dir, id);
}
function listProjects(home) {
  const root = join(home, "projects");
  if (!existsSync(root))
    return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readMeta(join(root, entry.name), entry.name));
}

// src/mind-mapper/backend/marks.ts
function docFileMtime(projectDir2, relPath) {
  try {
    return Math.floor(statSync(join2(projectDir2, relPath)).mtimeMs);
  } catch {
    return null;
  }
}
function isStale(markedMtime, currentMtime) {
  if (markedMtime === null || currentMtime === null)
    return true;
  return currentMtime > markedMtime;
}
function latestPerDoc(rows) {
  const latest = new Map;
  for (const row of rows)
    latest.set(row.doc_id, row);
  return latest;
}
function markDoc(db, bus, projectDir2, input) {
  if (!SLUG_RE.test(input.docId))
    throw new Error(`invalid doc id: ${input.docId}`);
  const doc = db.query("SELECT path FROM docs WHERE id = ?").get(input.docId);
  if (!doc)
    throw new Error(`unknown doc: ${input.docId}`);
  if (typeof input.status !== "string" || input.status.length === 0) {
    throw new Error("mark requires a non-empty status");
  }
  const docMtime = docFileMtime(projectDir2, doc.path);
  const ts = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO doc_marks (id, doc_id, author, note, status, doc_mtime, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    crypto.randomUUID(),
    input.docId,
    input.author,
    input.note ?? null,
    input.status,
    docMtime,
    ts
  ]);
  const mark = {
    author: input.author,
    note: input.note ?? null,
    status: input.status,
    ts
  };
  bus.emit("doc.marked", { docId: input.docId, mark });
  return mark;
}
function readDocMarks(db, mtimeOf) {
  const rows = db.query("SELECT doc_id, author, note, status, doc_mtime, ts FROM doc_marks ORDER BY rowid").all();
  const out = new Map;
  for (const [docId, row] of latestPerDoc(rows)) {
    out.set(docId, {
      author: row.author,
      note: row.note,
      status: row.status,
      stale: isStale(row.doc_mtime, mtimeOf(docId)),
      ts: row.ts
    });
  }
  return out;
}

// src/mind-mapper/backend/tags.ts
var TAGS_BYTE_CAP = 16 * 1024;
function parseTags(raw) {
  if (!Array.isArray(raw)) {
    throw new Error(`the request body IS the tag array \u2014 send a BARE JSON array of strings like ["ambient","fourth world"] (empty array clears), NOT {"tags":[...]}; got ${Array.isArray(raw) ? "an array" : typeof raw === "object" && raw !== null ? `an object with keys: ${Object.keys(raw).join(", ")}` : typeof raw}`);
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(`tags[${i}] is not a string \u2014 tags are freeform strings`);
    }
    return entry;
  });
}
function resolveTarget2(db, targetId) {
  if (db.query("SELECT 1 FROM nodes WHERE id = ?").get(targetId))
    return "node";
  const proposal = db.query("SELECT status FROM proposals WHERE id = ?").get(targetId);
  if (proposal?.status === "pending")
    return "proposal";
  return null;
}
function setTags(db, bus, targetId, rawTags) {
  if (resolveTarget2(db, targetId) === null)
    return null;
  const tags = parseTags(rawTags);
  if (tags.length === 0) {
    db.run("DELETE FROM node_tags WHERE target_id = ?", [targetId]);
    bus.emit("tags.set", { targetId, tags: [] });
    return { targetId, tags: [] };
  }
  const json = JSON.stringify(tags);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > TAGS_BYTE_CAP) {
    throw new Error(`tags payload is ${bytes} bytes \u2014 over the ${TAGS_BYTE_CAP}-byte cap; trim the list`);
  }
  db.run("INSERT INTO node_tags (target_id, tags_json) VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET tags_json = excluded.tags_json", [targetId, json]);
  bus.emit("tags.set", { targetId, tags });
  return { targetId, tags };
}
function clearTags(db, bus, targetId) {
  return setTags(db, bus, targetId, []);
}
function readTags(db) {
  const rows = db.query("SELECT target_id, tags_json FROM node_tags").all();
  const out = new Map;
  for (const row of rows) {
    try {
      out.set(row.target_id, JSON.parse(row.tags_json));
    } catch {}
  }
  return out;
}

// src/mind-mapper/backend/state.ts
function readState(db, project, cursor = 0, epoch = "", projectRoot) {
  const docRows = db.query("SELECT id, title, kind, path, kind_author FROM docs ORDER BY created_at").all();
  const pathByDoc = new Map(docRows.map((row) => [row.id, row.path]));
  const marks = readDocMarks(db, (docId) => {
    const relPath = pathByDoc.get(docId);
    if (projectRoot === undefined || relPath === undefined)
      return null;
    return docFileMtime(projectRoot, relPath);
  });
  const docs = docRows.map((row) => {
    const mark = marks.get(row.id);
    const kind = row.kind === "" ? null : row.kind;
    const kindAuthor = row.kind_author === "user" || row.kind_author === "agent" ? row.kind_author : null;
    return mark ? { id: row.id, title: row.title, kind, kindAuthor, mark } : { id: row.id, title: row.title, kind, kindAuthor };
  });
  const nodeRows = db.query("SELECT id, kind, tier, title, synopsis, anchor_node_id FROM nodes ORDER BY created_at").all();
  const childCountRows = db.query("SELECT anchor_node_id AS parent, COUNT(*) AS n FROM nodes WHERE anchor_node_id IS NOT NULL GROUP BY anchor_node_id").all();
  const submapChildCount = new Map(childCountRows.map((r) => [r.parent, r.n]));
  const sourceRows = db.query("SELECT node_id, doc_id, span FROM sources").all();
  const messageSourceRows = db.query("SELECT node_id, message_id, span FROM message_sources").all();
  const sourcesByNode = new Map;
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
  const actionsByTarget = readActions(db);
  const tagsByTarget = readTags(db);
  const nodes = nodeRows.map((row) => {
    const actions = actionsByTarget.get(row.id);
    const tags = tagsByTarget.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      tier: row.tier,
      title: row.title,
      synopsis: row.synopsis,
      anchorNodeId: row.anchor_node_id,
      submapChildCount: submapChildCount.get(row.id) ?? 0,
      sources: sourcesByNode.get(row.id) ?? [],
      ...actions ? { actions } : {},
      ...tags ? { tags } : {}
    };
  });
  const edges = db.query("SELECT id, source, target, label, provenance, direction FROM edges ORDER BY created_at").all();
  const zones = db.query("SELECT id, name FROM zones ORDER BY ts, id").all();
  const proposalRows = db.query("SELECT id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, result_node_id, author, zone_id, batch_id FROM proposals ORDER BY created_at").all();
  const proposals = proposalRows.map((row) => {
    const actions = actionsByTarget.get(row.id);
    const tags = tagsByTarget.get(row.id);
    return {
      id: row.id,
      kind: row.kind,
      draft: JSON.parse(row.draft_json),
      evidence: {
        docId: row.evidence_doc_id,
        messageId: row.evidence_message_id,
        span: row.evidence_span
      },
      suggestedTier: row.suggested_tier,
      status: row.status,
      resultNodeId: row.result_node_id,
      author: row.author === "user" ? "user" : "agent",
      zoneId: row.zone_id,
      batchId: row.batch_id,
      ...actions ? { actions } : {},
      ...tags ? { tags } : {}
    };
  });
  const messageRows = db.query("SELECT id, seq, role, kind, text, ground_json, ts FROM messages WHERE project_id = ? ORDER BY seq").all(project.id);
  const conversation = messageRows.map((row) => ({
    id: row.id,
    seq: row.seq,
    role: row.role,
    kind: row.kind,
    text: row.text,
    ground: row.ground_json ? JSON.parse(row.ground_json) : null,
    ts: row.ts
  }));
  const lensRow = db.query("SELECT owner, node_id, depth, doc_id FROM lens WHERE project_id = ?").get(project.id);
  const lens = lensRow ? { owner: lensRow.owner, nodeId: lensRow.node_id, depth: lensRow.depth, docId: lensRow.doc_id } : null;
  const jobs = readJobs(db);
  return {
    project,
    docs,
    nodes,
    edges,
    zones,
    proposals,
    conversation,
    jobs,
    lens,
    cursor,
    epoch
  };
}
function readNodeById(db, id) {
  const row = db.query("SELECT id, kind, tier, title, synopsis, anchor_node_id FROM nodes WHERE id = ?").get(id);
  if (!row)
    return null;
  const sources = [
    ...db.query("SELECT doc_id, span FROM sources WHERE node_id = ?").all(id).map((s) => ({ docId: s.doc_id, span: s.span })),
    ...db.query("SELECT message_id, span FROM message_sources WHERE node_id = ?").all(id).map((s) => ({ messageId: s.message_id, span: s.span }))
  ];
  const childCount = db.query("SELECT COUNT(*) AS n FROM nodes WHERE anchor_node_id = ?").get(id).n;
  const actions = readActions(db).get(id);
  const tags = readTags(db).get(id);
  return {
    id: row.id,
    kind: row.kind,
    tier: row.tier,
    title: row.title,
    synopsis: row.synopsis,
    anchorNodeId: row.anchor_node_id,
    submapChildCount: childCount,
    sources,
    ...actions ? { actions } : {},
    ...tags ? { tags } : {}
  };
}
function readProposalById(db, id) {
  const row = db.query("SELECT id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, result_node_id, author, zone_id, batch_id FROM proposals WHERE id = ?").get(id);
  if (!row)
    return null;
  const actions = readActions(db).get(row.id);
  const tags = readTags(db).get(row.id);
  return {
    id: row.id,
    kind: row.kind,
    draft: JSON.parse(row.draft_json),
    evidence: {
      docId: row.evidence_doc_id,
      messageId: row.evidence_message_id,
      span: row.evidence_span
    },
    suggestedTier: row.suggested_tier,
    status: row.status,
    resultNodeId: row.result_node_id,
    author: row.author === "user" ? "user" : "agent",
    zoneId: row.zone_id,
    batchId: row.batch_id,
    ...actions ? { actions } : {},
    ...tags ? { tags } : {}
  };
}

// src/mind-mapper/backend/changes.ts
var NOT_COVERED = [
  "DELETIONS of anything (node, edge, proposal, doc, zone) \u2014 a delete drops the row, so a deleted entity is indistinguishable from one that never existed",
  "proposal REJECTIONS and any other status flip that mints no row (a ratify DOES appear here, as the node/edge it created; a reject does not)",
  "EDITS in place: node.edited (title/synopsis), doc kind, doc marks, tags, actions, anchors (node.anchored), zone moves (proposal.promoted), lens",
  "jobs \u2014 the jobs table timestamps in epoch MILLISECONDS, a different unit from this query's seconds; mixing them in one watermark would be a silent off-by-1000",
  "WHO acted: nothing here is attributable to the human vs the agent (Contract 10's actor-tagging deferral is unchanged)"
];
var NOTE = "ADDITIONS ONLY, derived from created_at \u2014 this is a reconciliation AID, not a replacement for a full /state refetch, and NOT a replacement for actor tagging. Read notCovered before trusting an empty response: 'nothing added' is not 'nothing changed'. Pass `now` as your next `since`. `since` is INCLUSIVE and the granularity is whole seconds, so entities created in the boundary second may repeat (over-reporting is the safe direction). Unlike the event bus this survives a daemon restart \u2014 created_at is durable, cursors and epochs are not.";
function readChanges(db, project, since, projectRoot) {
  if (!Number.isFinite(since) || !Number.isInteger(since) || since < 0) {
    throw new Error(`since must be a non-negative integer in epoch SECONDS (use 0 for everything, then pass back the \`now\` from a previous response), got: ${JSON.stringify(since)}`);
  }
  const state = readState(db, project, 0, "", projectRoot);
  const idsSince = (table, column = "created_at") => new Set(db.query(`SELECT id FROM ${table} WHERE ${column} >= ?`).all(since).map((r) => r.id));
  const nodeIds = idsSince("nodes");
  const edgeIds = idsSince("edges");
  const proposalIds = idsSince("proposals");
  const docIds = idsSince("docs");
  const zoneIds = idsSince("zones", "ts");
  const additions = {
    nodes: state.nodes.filter((n) => nodeIds.has(n.id)),
    edges: state.edges.filter((e) => edgeIds.has(e.id)),
    proposals: state.proposals.filter((p) => proposalIds.has(p.id)),
    docs: state.docs.filter((d) => docIds.has(d.id)),
    zones: state.zones.filter((z) => zoneIds.has(z.id)),
    messages: state.conversation.filter((m) => m.ts >= since)
  };
  return {
    since,
    now: Math.floor(Date.now() / 1000),
    granularity: "seconds",
    inclusive: true,
    additions,
    counts: Object.fromEntries(Object.entries(additions).map(([key, list]) => [key, list.length])),
    notCovered: [...NOT_COVERED],
    note: NOTE
  };
}

// src/mind-mapper/backend/del.ts
class NodeCitedError extends Error {
  citedBy;
  constructor(citedBy) {
    super(`node is cited by ${citedBy.edges} edge(s) and anchors ${citedBy.children} child node(s)`);
    this.name = "NodeCitedError";
    this.citedBy = citedBy;
  }
}
function deleteNode(db, bus, id, force) {
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(id))
    return null;
  const edges = db.query("SELECT COUNT(*) AS n FROM edges WHERE source = ? OR target = ?").get(id, id).n;
  const children = db.query("SELECT COUNT(*) AS n FROM nodes WHERE anchor_node_id = ?").get(id).n;
  if (!force && (edges > 0 || children > 0))
    throw new NodeCitedError({ edges, children });
  db.transaction(() => {
    db.run("DELETE FROM edges WHERE source = ? OR target = ?", [id, id]);
    db.run("UPDATE nodes SET anchor_node_id = NULL WHERE anchor_node_id = ?", [id]);
    db.run("DELETE FROM sources WHERE node_id = ?", [id]);
    db.run("DELETE FROM message_sources WHERE node_id = ?", [id]);
    db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
    db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
    db.run("DELETE FROM lens WHERE node_id = ?", [id]);
    db.run("DELETE FROM nodes WHERE id = ?", [id]);
  })();
  bus.emit("node.deleted", { id });
  return { id };
}
function deleteProposal(db, bus, id) {
  if (!db.query("SELECT 1 FROM proposals WHERE id = ?").get(id))
    return null;
  db.transaction(() => {
    db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
    db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
    db.run("DELETE FROM proposals WHERE id = ?", [id]);
  })();
  bus.emit("proposal.deleted", { id });
  return { id };
}
function orphanedByDeletion(db, ids) {
  const doomed = new Set(ids);
  const asNodeId = (endpoint) => {
    const row = db.query("SELECT result_node_id FROM proposals WHERE id = ?").get(endpoint);
    return row?.result_node_id ?? endpoint;
  };
  const endpointsOf = (draftJson) => {
    try {
      const d = JSON.parse(draftJson);
      return [d.source, d.target].filter((e) => typeof e === "string");
    } catch {
      return [];
    }
  };
  const pendingEdges = db.query("SELECT id, draft_json FROM proposals WHERE kind = 'edge' AND status = 'pending'").all();
  const touched = new Set;
  for (const e of pendingEdges) {
    if (!doomed.has(e.id))
      continue;
    for (const ep of endpointsOf(e.draft_json))
      touched.add(asNodeId(ep));
  }
  const surviving = new Set;
  for (const e of pendingEdges) {
    if (doomed.has(e.id))
      continue;
    for (const ep of endpointsOf(e.draft_json))
      surviving.add(asNodeId(ep));
  }
  const out = [];
  for (const nodeId of touched) {
    if (surviving.has(nodeId))
      continue;
    const node = db.query("SELECT id, title FROM nodes WHERE id = ?").get(nodeId);
    if (!node)
      continue;
    const realEdges = db.query("SELECT 1 FROM edges WHERE source = ? OR target = ? LIMIT 1").get(nodeId, nodeId);
    if (realEdges)
      continue;
    out.push(node);
  }
  return out;
}
function deleteProposalBatch(db, bus, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('delete-batch requires a non-empty ids array \u2014 {"ids": ["<proposalId>", ...]}');
  }
  const bad = ids.filter((id) => typeof id !== "string" || id === "");
  if (bad.length > 0) {
    throw new Error(`delete-batch ids must be non-empty strings \u2014 got ${JSON.stringify(bad)}`);
  }
  const unknown = ids.filter((id) => !db.query("SELECT 1 FROM proposals WHERE id = ?").get(id));
  if (unknown.length > 0) {
    throw new Error(`delete-batch is all-or-nothing and ${unknown.length} id(s) do not exist \u2014 nothing was deleted: ${unknown.join(", ")}`);
  }
  const unique = [...new Set(ids)];
  const stranded = orphanedByDeletion(db, unique);
  db.transaction(() => {
    for (const id of unique) {
      db.run("DELETE FROM node_actions WHERE target_id = ?", [id]);
      db.run("DELETE FROM node_tags WHERE target_id = ?", [id]);
      db.run("DELETE FROM proposals WHERE id = ?", [id]);
    }
  })();
  for (const id of unique)
    bus.emit("proposal.deleted", { id });
  if (stranded.length === 0)
    return { deleted: unique };
  return {
    deleted: unique,
    warning: `this deleted the last connection intent for ${stranded.length} ratified node(s), ` + `now unconnected: ${stranded.map((n) => `${n.title} (${n.id})`).join(", ")} \u2014 ` + `re-propose their edges (an edge endpoint may be title:<exact title>), or ` + `\`state --batch <id>\` to see what the act still holds`
  };
}

// src/mind-mapper/backend/docs.ts
import { existsSync as existsSync2, unlinkSync } from "fs";
import { join as join3 } from "path";
class CitedError extends Error {
  citedBy;
  constructor(citedBy) {
    super(`doc is cited by ${citedBy.nodes} node(s) and ${citedBy.proposals} pending proposal(s)`);
    this.name = "CitedError";
    this.citedBy = citedBy;
  }
}
function deleteDoc(db, bus, projectDir2, id, force) {
  if (!SLUG_RE.test(id))
    return null;
  const row = db.query("SELECT path FROM docs WHERE id = ?").get(id);
  if (!row)
    return null;
  const nodes = db.query("SELECT COUNT(DISTINCT node_id) as n FROM sources WHERE doc_id = ?").get(id).n;
  const proposals = db.query("SELECT COUNT(*) as n FROM proposals WHERE evidence_doc_id = ? AND status = 'pending'").get(id).n;
  if (!force && (nodes > 0 || proposals > 0))
    throw new CitedError({ nodes, proposals });
  const file = join3(projectDir2, row.path);
  if (existsSync2(file))
    unlinkSync(file);
  db.run("DELETE FROM docs WHERE id = ?", [id]);
  db.run("DELETE FROM docs_fts WHERE doc_id = ?", [id]);
  db.run("DELETE FROM sources WHERE doc_id = ?", [id]);
  db.run("UPDATE proposals SET evidence_doc_id = NULL, evidence_span = NULL WHERE evidence_doc_id = ? AND status = 'pending'", [id]);
  bus.emit("doc.deleted", { id });
  return { id };
}
function setDocKind(db, bus, input) {
  if (!SLUG_RE.test(input.docId))
    return null;
  if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(input.docId))
    return null;
  if (input.kind !== null && (typeof input.kind !== "string" || input.kind === "")) {
    throw new Error("kind must be a non-empty string, or null to clear");
  }
  let kindAuthor = null;
  if (input.kind !== null) {
    if (input.author !== "user" && input.author !== "agent") {
      throw new Error("setting a kind requires author user|agent");
    }
    kindAuthor = input.author;
  }
  db.run("UPDATE docs SET kind = ?, kind_author = ? WHERE id = ?", [
    input.kind ?? "",
    kindAuthor,
    input.docId
  ]);
  bus.emit("doc.kind", { docId: input.docId, kind: input.kind, author: kindAuthor });
  return { docId: input.docId, kind: input.kind, kindAuthor };
}

// src/mind-mapper/backend/edit.ts
var EDITABLE = 'expected {"title"?: string, "synopsis"?: string} \u2014 at least one';
function editNode(db, bus, id, input) {
  const hasTitle = input.title !== undefined;
  const hasSynopsis = input.synopsis !== undefined;
  if (!hasTitle && !hasSynopsis) {
    throw new Error(`node edit needs something to write \u2014 ${EDITABLE}. tier is the human's ruling and kind is a ratification-time classification; neither is editable (re-propose to re-classify)`);
  }
  if (hasTitle && (typeof input.title !== "string" || input.title.trim() === "")) {
    throw new Error(`node edit title must be a non-empty string (it is the search key and the \`title:\` endpoint-resolution key) \u2014 ${EDITABLE}`);
  }
  if (hasSynopsis && typeof input.synopsis !== "string") {
    throw new Error(`node edit synopsis must be a string (empty string clears it) \u2014 ${EDITABLE}`);
  }
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(id))
    return null;
  if (hasTitle)
    db.run("UPDATE nodes SET title = ? WHERE id = ?", [input.title, id]);
  if (hasSynopsis) {
    db.run("UPDATE nodes SET synopsis = ? WHERE id = ?", [input.synopsis, id]);
  }
  const node = readNodeById(db, id);
  bus.emit("node.edited", node);
  return node;
}

// src/mind-mapper/backend/events.ts
var REPLAY_BUFFER_SIZE = 1000;
var ALL_EVENT_KINDS = [
  "actions.set",
  "tags.set",
  "doc.added",
  "doc.deleted",
  "doc.kind",
  "doc.marked",
  "node.ratified",
  "node.edited",
  "node.deleted",
  "edge.ratified",
  "node.anchored",
  "proposal.added",
  "proposal.promoted",
  "proposal.rejected",
  "proposal.deleted",
  "zone.created",
  "zone.deleted",
  "job.added",
  "job.updated",
  "job.claimed",
  "job.deleted",
  "message.posted",
  "lens.set",
  "look.here",
  "presence.changed",
  "agent.activity"
];
function createEventBus() {
  let seq = 0;
  const epoch = crypto.randomUUID();
  const buffer = [];
  const listeners = new Set;
  return {
    epoch,
    emit(kind, payload) {
      seq += 1;
      const event = { seq, epoch, kind, payload };
      buffer.push(event);
      if (buffer.length > REPLAY_BUFFER_SIZE)
        buffer.shift();
      for (const listener of listeners)
        listener(event);
      return event;
    },
    subscribe(since, listener) {
      for (const event of buffer) {
        if (event.seq > since)
          listener(event);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cursor() {
      return seq;
    }
  };
}
var INBOUND_WATCHED = [
  { kind: "message.posted", field: "role", value: "user" },
  { kind: "proposal.added", field: "author", value: "user" }
];
var INBOUND_NOT_WATCHED = ALL_EVENT_KINDS.filter((k) => !INBOUND_WATCHED.some((w) => w.kind === k));
function isInboundEvent(event) {
  for (const w of INBOUND_WATCHED) {
    if (event.kind === w.kind && event.payload[w.field] === w.value)
      return true;
  }
  return false;
}
var MESSAGE_CHANNELS = [
  "turn",
  "analyze",
  "canvas"
];
function inboundGrounding() {
  return {
    kind: "grounding",
    inbound: true,
    watching: INBOUND_WATCHED.map((w) => `${w.kind}[${w.field}=${w.value}]`),
    notWatching: INBOUND_NOT_WATCHED,
    messageChannels: [...MESSAGE_CHANNELS],
    note: "Human board-acts on shared routes (ratify/promote/zone-move/delete/tags/actions/anchor/doc) carry no actor and are NOT attributable in V1 \u2014 a named follow-on (actor tagging on those routes). Refetch /state to reconcile the board. A human message's `kind` is its channel (messageChannels above); the set is known but NOT closed \u2014 an unknown channel is stored and streamed, never rejected, so read `kind` tolerantly."
  };
}

// src/mind-mapper/backend/ingest.ts
import { existsSync as existsSync3, writeFileSync as writeFileSync2 } from "fs";
import { join as join4 } from "path";
function slugify(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "doc";
}
function uniqueId(db, title) {
  const base = slugify(title);
  let id = base;
  let n = 2;
  while (db.query("SELECT 1 FROM docs WHERE id = ?").get(id) !== null) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}
function storeDoc(db, bus, docsDir, title, content) {
  const id = uniqueId(db, title);
  if (!existsSync3(docsDir))
    throw new Error(`docs dir does not exist: ${docsDir}`);
  writeFileSync2(join4(docsDir, `${id}.md`), content);
  db.run("INSERT INTO docs (id, title, kind, path, kind_author) VALUES (?, ?, '', ?, NULL)", [
    id,
    title,
    `docs/${id}.md`
  ]);
  db.run("INSERT INTO docs_fts (rowid, doc_id, content) VALUES (last_insert_rowid(), ?, ?)", [
    id,
    content
  ]);
  const doc = { id, title, kind: null, kindAuthor: null };
  bus.emit("doc.added", doc);
  return doc;
}
function ingestText(db, bus, docsDir, title, text) {
  return storeDoc(db, bus, docsDir, title, text);
}
function ingestFile(db, bus, docsDir, title, content) {
  return storeDoc(db, bus, docsDir, title, content);
}

// src/mind-mapper/backend/lens.ts
function setLens(db, bus, projectId, lens) {
  db.run("INSERT INTO lens (project_id, owner, node_id, depth, doc_id) VALUES (?, ?, ?, ?, ?) " + "ON CONFLICT(project_id) DO UPDATE SET owner = excluded.owner, node_id = excluded.node_id, depth = excluded.depth, doc_id = excluded.doc_id", [projectId, lens.owner, lens.nodeId, lens.depth, lens.docId]);
  bus.emit("lens.set", lens);
  return lens;
}
function clearLens(db, bus, projectId) {
  db.run("DELETE FROM lens WHERE project_id = ?", [projectId]);
  bus.emit("lens.set", { owner: null, nodeId: null, depth: null, docId: null });
}
function lookHere(bus, nodeId) {
  bus.emit("look.here", { nodeId });
}

// src/mind-mapper/backend/neighbors.ts
function neighbors(db, nodeId, depth) {
  const allEdges = db.query("SELECT id, source, target, label FROM edges").all();
  const titleById = new Map(db.query("SELECT id, title FROM nodes").all().map((n) => [n.id, n.title]));
  const visited = new Map;
  let frontier = [nodeId];
  const seen = new Set([nodeId]);
  for (let d = 1;d <= depth; d++) {
    const next = [];
    for (const current of frontier) {
      for (const edge of allEdges) {
        let neighborId = null;
        let direction = null;
        if (edge.source === current) {
          neighborId = edge.target;
          direction = "outgoing";
        } else if (edge.target === current) {
          neighborId = edge.source;
          direction = "incoming";
        }
        if (!neighborId || seen.has(neighborId))
          continue;
        seen.add(neighborId);
        next.push(neighborId);
        visited.set(neighborId, {
          id: neighborId,
          title: titleById.get(neighborId) ?? neighborId,
          depth: d,
          via: {
            edgeId: edge.id,
            label: edge.label,
            direction
          }
        });
      }
    }
    frontier = next;
  }
  return [...visited.values()];
}

// src/mind-mapper/backend/propose.ts
var TITLE_REF_PREFIX = "title:";
function isTitleRef(ref) {
  return typeof ref === "string" && ref.startsWith(TITLE_REF_PREFIX);
}
function resolveTitleRef(db, ref) {
  const title = ref.slice(TITLE_REF_PREFIX.length);
  if (title === "") {
    throw new Error('empty title reference \u2014 expected "title:<exact node title>" (exact, case-sensitive, ratified nodes only)');
  }
  const rows = db.query("SELECT id FROM nodes WHERE title = ?").all(title);
  if (rows.length === 0) {
    throw new Error(`no ratified node is titled "${title}" \u2014 title refs match EXACTLY (case-sensitive) and resolve against ratified nodes ONLY, never pending proposals (name those by local ref or proposal id); use \`search\` to find the node, or pass its id`);
  }
  if (rows.length > 1) {
    throw new Error(`title "${title}" matches ${rows.length} nodes: ${rows.map((r) => r.id).join(", ")} \u2014 titles are not unique; pass one of those ids instead`);
  }
  return rows[0].id;
}
function resolveEdgeTitleRefs(db, draft) {
  if (draft === null || typeof draft !== "object")
    return draft;
  const d = draft;
  if (!isTitleRef(d.source) && !isTitleRef(d.target))
    return draft;
  return {
    ...d,
    ...isTitleRef(d.source) ? { source: resolveTitleRef(db, d.source) } : {},
    ...isTitleRef(d.target) ? { target: resolveTitleRef(db, d.target) } : {}
  };
}
function buildProposal(db, kind, input) {
  const id = crypto.randomUUID();
  if (input.draft === undefined || input.draft === null) {
    throw new Error('propose requires a draft \u2014 expected {"draft": {title, synopsis, ...}, "evidence": {docId|messageId, span}, "suggestedTier"?}');
  }
  const draft = kind === "edge" ? resolveEdgeTitleRefs(db, input.draft) : input.draft;
  const draftJson = JSON.stringify(draft);
  if (input.evidence.docId !== undefined && input.evidence.messageId !== undefined) {
    throw new Error("evidence must ground in a doc OR a message, not both");
  }
  if (input.evidence.docId !== undefined && !SLUG_RE.test(input.evidence.docId)) {
    throw new Error(`evidence.docId is not a valid doc slug: ${input.evidence.docId}`);
  }
  if (input.evidence.messageId !== undefined) {
    const exists = db.query("SELECT 1 FROM messages WHERE id = ?").get(input.evidence.messageId);
    if (exists === null) {
      throw new Error(`evidence.messageId does not exist: ${input.evidence.messageId}`);
    }
  }
  if (input.author !== undefined && input.author !== "user" && input.author !== "agent") {
    throw new Error(`author must be user or agent, got: ${String(input.author)}`);
  }
  if (input.zone !== undefined) {
    if (!SLUG_RE.test(input.zone)) {
      throw new Error(`zone is not a valid zone slug: ${input.zone}`);
    }
    if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(input.zone)) {
      throw new Error(`unknown zone: ${input.zone}`);
    }
  }
  const tags = input.tags !== undefined ? parseTags(input.tags) : [];
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
  const evidenceDocId = input.evidence.docId ?? null;
  const evidenceMessageId = input.evidence.messageId ?? null;
  const evidenceSpan = input.evidence.span ?? null;
  const suggestedTier = input.suggestedTier ?? null;
  const author = input.author ?? "agent";
  const zoneId = input.zone ?? null;
  if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId === "")) {
    throw new Error(`batchId must be a non-empty string (the id returned by \`propose-batch\`), got: ${JSON.stringify(input.batchId)}`);
  }
  const batchId = input.batchId ?? null;
  const proposal = {
    id,
    kind,
    draft,
    evidence: { docId: evidenceDocId, messageId: evidenceMessageId, span: evidenceSpan },
    suggestedTier,
    status: "pending",
    resultNodeId: null,
    author,
    zoneId,
    batchId,
    ...tags.length > 0 ? { tags } : {}
  };
  const insert = () => {
    db.run("INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, author, zone_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)", [
      id,
      kind,
      draftJson,
      evidenceDocId,
      evidenceMessageId,
      evidenceSpan,
      suggestedTier,
      author,
      zoneId,
      batchId
    ]);
    if (tagsJson !== null) {
      db.run("INSERT INTO node_tags (target_id, tags_json) VALUES (?, ?)", [id, tagsJson]);
    }
  };
  return { proposal, insert };
}
function insertProposal(db, bus, kind, input) {
  const { proposal, insert } = buildProposal(db, kind, input);
  insert();
  bus.emit("proposal.added", proposal);
  return proposal;
}
function batchPropose(db, bus, input) {
  if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId === "")) {
    throw new Error(`batchId must be a non-empty string (omit it to have one minted), got: ${JSON.stringify(input.batchId)}`);
  }
  const batchId = input.batchId ?? crypto.randomUUID();
  const refToId = new Map;
  const built = [];
  for (const n of input.nodes ?? []) {
    if (typeof n.ref !== "string" || n.ref === "") {
      throw new Error('each batch node needs a non-empty string "ref"');
    }
    if (refToId.has(n.ref))
      throw new Error(`duplicate batch node ref: ${n.ref}`);
    const b = buildProposal(db, "node", {
      draft: n.draft,
      evidence: n.evidence ?? {},
      suggestedTier: n.suggestedTier,
      author: n.author,
      tags: n.tags,
      batchId
    });
    refToId.set(n.ref, b.proposal.id);
    built.push(b);
  }
  for (const e of input.edges ?? []) {
    let draft = e.draft;
    if (draft !== null && typeof draft === "object") {
      const d = draft;
      draft = {
        ...d,
        source: refToId.get(String(d.source)) ?? d.source,
        target: refToId.get(String(d.target)) ?? d.target
      };
    }
    built.push(buildProposal(db, "edge", {
      draft,
      evidence: e.evidence ?? {},
      suggestedTier: e.suggestedTier,
      author: e.author,
      batchId
    }));
  }
  const run = db.transaction(() => {
    for (const b of built)
      b.insert();
  });
  run();
  for (const b of built) {
    bus.emit("proposal.added", b.proposal);
  }
  return { batchId, refToId: Object.fromEntries(refToId), proposals: built.map((b) => b.proposal) };
}
function edgeDraftWarning(draft) {
  if (draft === null || typeof draft !== "object") {
    return 'edge draft is not an object \u2014 expected {"source": "<node-or-proposal-id>", "target": "<node-or-proposal-id>", "label": "..."}; stored as-is (opaque intake), but ratify will fail on it';
  }
  const d = draft;
  const missing = ["source", "target"].filter((key) => typeof d[key] !== "string");
  if (missing.length === 0)
    return null;
  return `edge draft has no string ${missing.join("/")} key(s) \u2014 endpoints ride "source"/"target" (node or pending node-proposal ids); other keys are NOT rejected (the draft is opaque to the daemon), but ratify will fail to resolve the endpoints`;
}
function proposeNode(db, bus, input) {
  return insertProposal(db, bus, "node", input);
}
function proposeEdge(db, bus, input) {
  return insertProposal(db, bus, "edge", input);
}

// src/mind-mapper/backend/ratify.ts
import { appendFileSync, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";
class ZonedError extends Error {
  zoneId;
  constructor(proposalId, zoneId) {
    super(`proposal ${proposalId} is in zone ${zoneId} \u2014 promote first (ratification is a main-queue act)`);
    this.name = "ZonedError";
    this.zoneId = zoneId;
  }
}
function resolveNodeRef(db, ref) {
  const node = db.query("SELECT 1 FROM nodes WHERE id = ?").get(ref);
  if (node)
    return ref;
  const proposal = db.query("SELECT kind, status, result_node_id FROM proposals WHERE id = ?").get(ref);
  if (!proposal)
    throw new Error(`unresolved node reference: ${ref}`);
  if (proposal.kind !== "node")
    throw new Error(`reference ${ref} is not a node proposal`);
  if (proposal.status !== "ratified" || !proposal.result_node_id) {
    throw new Error(`unresolved proposal reference: ratify node proposal ${ref} first`);
  }
  return proposal.result_node_id;
}
function buildRatify(db, docsDir, input, bus, resolveRef = (ref) => resolveNodeRef(db, ref)) {
  const row = db.query("SELECT id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, status, zone_id FROM proposals WHERE id = ?").get(input.proposalId);
  if (!row)
    throw new Error(`unknown proposal: ${input.proposalId}`);
  if (row.status !== "pending") {
    throw new Error(`proposal ${input.proposalId} already ${row.status}`);
  }
  if (row.zone_id !== null) {
    throw new ZonedError(input.proposalId, row.zone_id);
  }
  if (input.ruling === "reject") {
    return {
      apply: () => {
        db.run("UPDATE proposals SET status = 'rejected' WHERE id = ?", [input.proposalId]);
        db.run("DELETE FROM node_actions WHERE target_id = ?", [input.proposalId]);
        db.run("DELETE FROM node_tags WHERE target_id = ?", [input.proposalId]);
      },
      writeDoc: null,
      changelogLine: null,
      emit: () => bus.emit("proposal.rejected", { id: input.proposalId }),
      result: { id: input.proposalId, status: "rejected" }
    };
  }
  if (input.docId !== undefined) {
    if (row.evidence_doc_id || row.evidence_message_id) {
      throw new Error(`proposal ${input.proposalId} already carries evidence; --doc is for evidence-less proposals`);
    }
    if (input.docEdit === undefined) {
      throw new Error("--doc requires --doc-edit (the attach is the agent drafting the doc home)");
    }
    if (row.kind !== "node") {
      throw new Error("--doc is invalid for edge proposals \u2014 edges carry no sources rows; attach evidence to the endpoint nodes instead");
    }
    if (!SLUG_RE.test(input.docId)) {
      throw new Error(`--doc is not a valid doc slug: ${input.docId}`);
    }
    if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(input.docId)) {
      throw new Error(`unknown doc: ${input.docId}`);
    }
  }
  const homeDocId = row.evidence_doc_id ?? input.docId ?? null;
  if (input.docEdit !== undefined) {
    if (!homeDocId) {
      throw new Error(row.evidence_message_id ? `proposal ${input.proposalId} has message evidence \u2014 --doc-edit is invalid for message-grounded proposals` : `proposal ${input.proposalId} has no evidence doc to edit (attach one with --doc)`);
    }
    if (!SLUG_RE.test(homeDocId)) {
      throw new Error(`refusing doc edit: evidence doc id is not a valid slug: ${homeDocId}`);
    }
  }
  const writeDoc = input.docEdit !== undefined && homeDocId ? () => writeFileSync3(join5(docsDir, `${homeDocId}.md`), input.docEdit) : null;
  const changelogLine = `ratified ${input.proposalId} (${input.ruling})${homeDocId ? ` -> ${homeDocId}.md` : ""}${input.docEdit !== undefined ? " (doc edited)" : ""}
`;
  const draft = JSON.parse(row.draft_json);
  if (row.kind === "node") {
    const nodeId = crypto.randomUUID();
    return {
      writeDoc,
      changelogLine,
      apply: () => {
        if (input.docEdit !== undefined && homeDocId) {
          db.run("DELETE FROM docs_fts WHERE doc_id = ?", [homeDocId]);
          db.run("INSERT INTO docs_fts (doc_id, content) VALUES (?, ?)", [
            homeDocId,
            input.docEdit
          ]);
        }
        db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
          nodeId,
          typeof draft.kind === "string" ? draft.kind : "concept",
          input.ruling,
          typeof draft.title === "string" ? draft.title : "Untitled",
          typeof draft.synopsis === "string" ? draft.synopsis : ""
        ]);
        if (row.evidence_doc_id) {
          db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
            nodeId,
            row.evidence_doc_id,
            row.evidence_span
          ]);
        }
        if (row.evidence_message_id) {
          db.run("INSERT INTO message_sources (node_id, message_id, span) VALUES (?, ?, ?)", [
            nodeId,
            row.evidence_message_id,
            row.evidence_span
          ]);
        }
        if (input.docId !== undefined) {
          db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
            nodeId,
            input.docId,
            input.span ?? null
          ]);
        }
        db.run("UPDATE proposals SET status = 'ratified', result_node_id = ? WHERE id = ?", [
          nodeId,
          input.proposalId
        ]);
        db.run("UPDATE node_actions SET target_id = ? WHERE target_id = ?", [
          nodeId,
          input.proposalId
        ]);
        db.run("UPDATE node_tags SET target_id = ? WHERE target_id = ?", [
          nodeId,
          input.proposalId
        ]);
      },
      emit: () => bus.emit("node.ratified", { id: nodeId, proposalId: input.proposalId }),
      result: { id: input.proposalId, status: "ratified", nodeId }
    };
  }
  const source = resolveRef(String(draft.source));
  const target = resolveRef(String(draft.target));
  const edgeId = crypto.randomUUID();
  return {
    writeDoc,
    changelogLine,
    apply: () => {
      db.run("INSERT INTO edges (id, source, target, label, provenance, direction) VALUES (?, ?, ?, ?, 'asserted', ?)", [
        edgeId,
        source,
        target,
        typeof draft.label === "string" ? draft.label : "",
        typeof draft.direction === "string" ? draft.direction : null
      ]);
      db.run("UPDATE proposals SET status = 'ratified' WHERE id = ?", [input.proposalId]);
      db.run("DELETE FROM node_actions WHERE target_id = ?", [input.proposalId]);
      db.run("DELETE FROM node_tags WHERE target_id = ?", [input.proposalId]);
    },
    emit: () => bus.emit("edge.ratified", { id: edgeId, proposalId: input.proposalId }),
    result: { id: input.proposalId, status: "ratified", edgeId }
  };
}
function ratify(db, bus, docsDir, input) {
  const built = buildRatify(db, docsDir, input, bus);
  built.writeDoc?.();
  built.apply();
  if (built.changelogLine)
    appendFileSync(join5(docsDir, "..", "changelog.txt"), built.changelogLine);
  built.emit();
  return built.result;
}
function ratifyBatch(db, bus, docsDir, input) {
  if (input.ruling === "reject") {
    throw new Error("ratify-batch does not reject \u2014 a reject excludes a proposal from the batch (reject it singly)");
  }
  const nodeIds = [];
  const edgeIds = [];
  for (const id of input.ids) {
    const row = db.query("SELECT kind FROM proposals WHERE id = ?").get(id);
    if (!row)
      throw new Error(`unknown proposal: ${id}`);
    if (row.kind === "node")
      nodeIds.push(id);
    else
      edgeIds.push(id);
  }
  const idMap = {};
  const built = [];
  const ratified = [];
  for (const id of nodeIds) {
    const b = buildRatify(db, docsDir, { proposalId: id, ruling: input.ruling }, bus);
    idMap[id] = b.result.nodeId;
    built.push(b);
    ratified.push(b.result);
  }
  const resolver = (ref) => idMap[ref] ?? resolveNodeRef(db, ref);
  for (const id of edgeIds) {
    const b = buildRatify(db, docsDir, { proposalId: id, ruling: input.ruling }, bus, resolver);
    built.push(b);
    ratified.push(b.result);
  }
  const anchorPlan = (input.anchors ?? []).map((a) => {
    const node = idMap[a.node] ?? a.node;
    const parent = idMap[a.parent] ?? a.parent;
    if (node === parent)
      throw new Error(`anchor: a node cannot anchor to itself (${node})`);
    for (const [label, ref] of [
      ["node", node],
      ["parent", parent]
    ]) {
      const inBatch = Object.values(idMap).includes(ref);
      const isReal = db.query("SELECT 1 FROM nodes WHERE id = ?").get(ref) !== null;
      if (!inBatch && !isReal) {
        throw new Error(`anchor: ${label} ${ref} is not a batched node proposal or a real node`);
      }
    }
    return { node, parent };
  });
  const run = db.transaction(() => {
    for (const b of built)
      b.apply();
    for (const p of anchorPlan) {
      anchorGuard(db, p.node, p.parent);
      db.run("UPDATE nodes SET anchor_node_id = ? WHERE id = ?", [p.parent, p.node]);
    }
  });
  run();
  for (const b of built) {
    if (b.changelogLine)
      appendFileSync(join5(docsDir, "..", "changelog.txt"), b.changelogLine);
    b.emit();
  }
  for (const p of anchorPlan) {
    bus.emit("node.anchored", { nodeId: p.node, anchorNodeId: p.parent });
  }
  return { idMap, ratified };
}

// src/mind-mapper/backend/search.ts
function ftsPhrase(query) {
  return `"${query.replace(/"/g, '""')}"`;
}
function search(db, query) {
  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const nodeRows = db.query(`SELECT id, title, synopsis,
              (CASE WHEN title LIKE ? ESCAPE '\\' THEN 2 ELSE 1 END) as score
       FROM nodes WHERE title LIKE ? ESCAPE '\\' OR synopsis LIKE ? ESCAPE '\\'`).all(like, like, like);
  const nodeHits = nodeRows.map((row) => ({
    kind: "node",
    id: row.id,
    title: row.title,
    snippet: row.synopsis || undefined,
    score: row.score * 10
  }));
  const lowerQuery = query.toLowerCase();
  const proposalRows = db.query("SELECT id, draft_json, zone_id FROM proposals WHERE status = 'pending'").all();
  const proposalHits = [];
  if (lowerQuery !== "") {
    for (const row of proposalRows) {
      let draft;
      try {
        draft = JSON.parse(row.draft_json);
      } catch {
        continue;
      }
      const title = typeof draft.title === "string" ? draft.title : "";
      const synopsis = typeof draft.synopsis === "string" ? draft.synopsis : "";
      const titleMatch = title.toLowerCase().includes(lowerQuery);
      const synopsisMatch = synopsis.toLowerCase().includes(lowerQuery);
      if (!titleMatch && !synopsisMatch)
        continue;
      proposalHits.push({
        kind: "proposal",
        id: row.id,
        title: title || "Untitled",
        snippet: synopsis || undefined,
        score: (titleMatch ? 2 : 1) * 9,
        zoneId: row.zone_id
      });
    }
  }
  const phrase = ftsPhrase(query);
  const docRows = db.query(`SELECT docs.id as id, docs.title as title, rank as rank,
              snippet(docs_fts, 1, '', '', '...', 8) as snippet
       FROM docs_fts JOIN docs ON docs.id = docs_fts.doc_id
       WHERE docs_fts MATCH ? ORDER BY rank`).all(phrase);
  const docHits = docRows.map((row) => ({
    kind: "doc",
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    score: -row.rank
  }));
  const messageRows = db.query(`SELECT messages.id as id, messages.text as text, rank as rank,
              snippet(messages_fts, 1, '', '', '...', 8) as snippet
       FROM messages_fts JOIN messages ON messages.id = messages_fts.message_id
       WHERE messages_fts MATCH ? ORDER BY rank`).all(phrase);
  const messageHits = messageRows.map((row) => ({
    kind: "message",
    id: row.id,
    title: row.text,
    snippet: row.snippet,
    score: -row.rank
  }));
  return [...nodeHits, ...proposalHits, ...docHits, ...messageHits].sort((a, b) => {
    if (b.score !== a.score)
      return b.score - a.score;
    if (a.kind === "node" && b.kind !== "node")
      return -1;
    if (b.kind === "node" && a.kind !== "node")
      return 1;
    return 0;
  });
}

// src/mind-mapper/backend/send.ts
function channelWarning(kind) {
  if (MESSAGE_CHANNELS.includes(kind))
    return;
  return `kind "${kind}" is not a known message channel (${MESSAGE_CHANNELS.join(", ")}) \u2014 it was stored verbatim, but the surface renders unknown channels generically. Channels are open by design; add it to MESSAGE_CHANNELS if it's real.`;
}
function nextSeq(db, projectId) {
  const row = db.query("SELECT COALESCE(MAX(seq), 0) as maxSeq FROM messages WHERE project_id = ?").get(projectId);
  return row.maxSeq + 1;
}
function sendMessage(db, bus, projectId, input) {
  const id = crypto.randomUUID();
  const seq = nextSeq(db, projectId);
  const ground = input.ground ?? null;
  const ts = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO messages (id, project_id, seq, role, kind, text, ground_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    projectId,
    seq,
    input.role,
    input.kind,
    input.text,
    ground ? JSON.stringify(ground) : null,
    ts
  ]);
  db.run("INSERT INTO messages_fts (rowid, message_id, content) VALUES (last_insert_rowid(), ?, ?)", [id, input.text]);
  const message = {
    id,
    seq,
    role: input.role,
    kind: input.kind,
    text: input.text,
    ground,
    ts
  };
  bus.emit("message.posted", message);
  return message;
}

// src/mind-mapper/backend/zones.ts
function slugify2(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function createZone(db, bus, name) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("zone create requires a name");
  }
  const id = slugify2(name);
  if (!SLUG_RE.test(id))
    throw new Error(`zone name does not yield a valid slug: ${name}`);
  if (db.query("SELECT 1 FROM zones WHERE id = ?").get(id)) {
    throw new Error(`zone already exists: ${id}`);
  }
  db.run("INSERT INTO zones (id, name) VALUES (?, ?)", [id, name]);
  const zone = { id, name };
  bus.emit("zone.created", { id, name });
  return zone;
}
function listZones(db) {
  return db.query("SELECT id, name FROM zones ORDER BY ts, id").all();
}

class ZoneNotEmptyError extends Error {
  proposals;
  constructor(proposals) {
    super(`zone holds ${proposals} proposal(s) \u2014 pass --yes to delete them with it`);
    this.name = "ZoneNotEmptyError";
    this.proposals = proposals;
  }
}
function deleteZone(db, bus, id, yes) {
  if (!SLUG_RE.test(id))
    return null;
  if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(id))
    return null;
  const count = db.query("SELECT COUNT(*) as n FROM proposals WHERE zone_id = ?").get(id).n;
  if (!yes && count > 0)
    throw new ZoneNotEmptyError(count);
  db.run("DELETE FROM node_actions WHERE target_id IN (SELECT id FROM proposals WHERE zone_id = ?)", [id]);
  db.run("DELETE FROM node_tags WHERE target_id IN (SELECT id FROM proposals WHERE zone_id = ?)", [
    id
  ]);
  db.run("DELETE FROM proposals WHERE zone_id = ?", [id]);
  db.run("DELETE FROM zones WHERE id = ?", [id]);
  bus.emit("zone.deleted", { id });
  return { id };
}
function promote(db, bus, proposalId) {
  const row = db.query("SELECT id, kind, draft_json, status, zone_id FROM proposals WHERE id = ?").get(proposalId);
  if (!row)
    throw new Error(`unknown proposal: ${proposalId}`);
  if (row.status !== "pending") {
    throw new Error(`proposal ${proposalId} already ${row.status} \u2014 promote is for pending proposals`);
  }
  if (row.zone_id === null) {
    throw new Error(`proposal ${proposalId} is not in a zone \u2014 nothing to promote`);
  }
  if (row.kind === "edge") {
    const draft = JSON.parse(row.draft_json);
    for (const end of ["source", "target"]) {
      const ref = String(draft[end]);
      const endpoint = db.query("SELECT id, zone_id FROM proposals WHERE id = ?").get(ref);
      if (endpoint && endpoint.zone_id !== null) {
        throw new Error(`edge ${end} references proposal ${ref}, still in zone ${endpoint.zone_id} \u2014 promote it first`);
      }
    }
  }
  db.run("UPDATE proposals SET zone_id = NULL WHERE id = ?", [proposalId]);
  bus.emit("proposal.promoted", { id: proposalId });
  return { id: proposalId };
}

class UnknownZoneError extends Error {
  constructor(zoneId) {
    super(`unknown zone: ${zoneId}`);
    this.name = "UnknownZoneError";
  }
}
function moveProposalToZone(db, bus, proposalId, zoneId) {
  const row = db.query("SELECT id, status, zone_id FROM proposals WHERE id = ?").get(proposalId);
  if (!row)
    return null;
  if (row.status !== "pending") {
    throw new Error(`proposal ${proposalId} already ${row.status} \u2014 only pending proposals move between zones`);
  }
  if (zoneId === null) {
    promote(db, bus, proposalId);
    return { id: proposalId, zoneId: null };
  }
  if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(zoneId)) {
    throw new UnknownZoneError(zoneId);
  }
  db.run("UPDATE proposals SET zone_id = ? WHERE id = ?", [zoneId, proposalId]);
  const proposal = readProposalById(db, proposalId);
  if (proposal)
    bus.emit("proposal.added", proposal);
  return { id: proposalId, zoneId };
}

// src/mind-mapper/backend/server.ts
var SCRIPT_DIR = import.meta.dir;
var SKILL_ROOT = join6(SCRIPT_DIR, "..");
var DIST_DIR = join6(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync4(join6(DIST_DIR, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(path) {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (rel.includes("..") || rel.includes("/"))
    return null;
  const file = join6(DIST_DIR, rel);
  if (!existsSync4(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
var HOME = process.env.MIND_MAPPER_HOME ?? join6(homedir(), ".mind-mapper");
var PORT_FILE = join6(HOME, "daemon.port");
var PID_FILE = join6(HOME, "daemon.pid");
var projects = new Map;
function loadProject(id) {
  const meta = resolveProject(HOME, id);
  const existing = projects.get(meta.id);
  if (existing)
    return existing;
  const dir = projectDir(HOME, meta.id);
  const db = openStore(join6(dir, "store.sqlite"));
  const entry = {
    db,
    bus: createEventBus(),
    meta,
    agents: 0,
    activityTimer: null,
    activityState: null,
    activitySource: null,
    activityMessageId: null
  };
  projects.set(meta.id, entry);
  return entry;
}
function projectFailure(e) {
  if (e instanceof NeedsProjectError) {
    return new Response(JSON.stringify({ error: "needs-project", projects: listProjects(HOME) }), {
      status: 409,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (e instanceof UnknownProjectError) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
  throw e;
}
function badRequest(e, expected) {
  const error = e instanceof Error ? e.message : String(e);
  return new Response(JSON.stringify(expected ? { error, expected } : { error }), {
    status: 400,
    headers: { "Content-Type": "application/json" }
  });
}
function adjustAgents(entry, delta) {
  entry.agents = Math.max(0, entry.agents + delta);
  entry.bus.emit("presence.changed", { agents: entry.agents });
}
function activityTtlMs() {
  const v = Number.parseInt(process.env.MIND_MAPPER_ACTIVITY_TTL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}
function stallTtlMs() {
  const v = Number.parseInt(process.env.MIND_MAPPER_STALL_TTL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 150000;
}
function postActivity(entry, state, source, messageId) {
  if (entry.activityTimer !== null) {
    clearTimeout(entry.activityTimer);
    entry.activityTimer = null;
  }
  const tiedTo = messageId ?? entry.activityMessageId ?? null;
  entry.activityState = state === "idle" ? null : state;
  entry.activitySource = state === "idle" ? null : source;
  entry.activityMessageId = state === "idle" ? null : tiedTo;
  const tie = tiedTo ? { messageId: tiedTo } : {};
  entry.bus.emit("agent.activity", { state, ...tie });
  if (state === "received") {
    entry.activityTimer = setTimeout(() => {
      entry.activityTimer = null;
      entry.activityState = "stalled";
      entry.activitySource = "auto";
      entry.bus.emit("agent.activity", { state: "stalled", ...tie });
    }, stallTtlMs());
  } else if (state === "thinking") {
    entry.activityTimer = setTimeout(() => {
      entry.activityTimer = null;
      entry.activityState = null;
      entry.activitySource = null;
      entry.activityMessageId = null;
      entry.bus.emit("agent.activity", { state: "idle", ...tie });
    }, activityTtlMs());
  }
}
function resolveActivity(entry, opts = {}) {
  const resolvesExplicitThinking = opts.terminalAct === true && entry.activitySource === "explicit" && entry.activityState === "thinking";
  if (entry.activitySource === "auto" || resolvesExplicitThinking) {
    postActivity(entry, "idle", "auto");
  }
}
function readDoc(db, dir, id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    return null;
  const row = db.query("SELECT title, kind, path FROM docs WHERE id = ?").get(id);
  if (!row)
    return null;
  const file = join6(dir, "..", row.path);
  if (!existsSync4(file))
    return null;
  try {
    return {
      id,
      title: row.title,
      kind: row.kind === "" ? null : row.kind,
      content: readFileSync2(file, "utf8")
    };
  } catch {
    return null;
  }
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    Bun.spawn([cmd, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
function keepaliveMs() {
  const v = Number.parseInt(process.env.MIND_MAPPER_KEEPALIVE_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 15000;
}
function sseResponse(bus, since, hooks = {}, signal, inbound = false) {
  let unsubscribe = null;
  let keepalive = null;
  let closed = false;
  const teardown = () => {
    if (closed)
      return;
    closed = true;
    if (keepalive !== null)
      clearInterval(keepalive);
    unsubscribe?.();
    hooks.onClose?.();
  };
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder;
      const safeEnqueue = (chunk) => {
        if (closed)
          return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          teardown();
        }
      };
      safeEnqueue(`: connected

`);
      if (inbound)
        safeEnqueue(`data: ${JSON.stringify(inboundGrounding())}

`);
      unsubscribe = bus.subscribe(since, (event) => {
        if (inbound && !isInboundEvent(event))
          return;
        safeEnqueue(`data: ${JSON.stringify(event)}

`);
      });
      keepalive = setInterval(() => safeEnqueue(`: keepalive

`), keepaliveMs());
      signal?.addEventListener("abort", teardown, { once: true });
      hooks.onOpen?.();
    },
    cancel() {
      teardown();
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  });
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        "no-open": { type: "boolean", default: false }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    return 2;
  }
  const host = parsed.values.host;
  const port = Number.parseInt(parsed.values.port, 10);
  const mode = resolveMode();
  const devIndex = mode === "dev" ? (await import("../../../../../src/mind-mapper/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
      idleTimeout: 255,
      fetch: (req, srv) => {
        const url2 = new URL(req.url);
        const path = url2.pathname;
        const projectId = url2.searchParams.get("project") ?? undefined;
        try {
          if (path === "/events") {
            const entry = loadProject(projectId);
            if (req.headers.get("upgrade") === "websocket") {
              const since2 = Number.parseInt(url2.searchParams.get("since") ?? "0", 10);
              const ok = srv.upgrade(req, {
                data: { since: Number.isFinite(since2) ? since2 : 0, projectId }
              });
              if (ok)
                return;
              return new Response("upgrade failed", { status: 500 });
            }
            const since = Number.parseInt(url2.searchParams.get("since") ?? "0", 10);
            const inbound = url2.searchParams.get("inbound") === "1";
            return sseResponse(entry.bus, Number.isFinite(since) ? since : 0, {
              onOpen: () => adjustAgents(entry, 1),
              onClose: () => adjustAgents(entry, -1)
            }, req.signal, inbound);
          }
          if (req.method === "GET" && path === "/state") {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const state = readState(db, meta, bus.cursor(), bus.epoch, projectDir(HOME, meta.id));
            const zoneId = url2.searchParams.get("zone");
            if (zoneId !== null) {
              if (!state.zones.some((z) => z.id === zoneId)) {
                return new Response(JSON.stringify({ error: `unknown zone: ${zoneId}` }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              state.proposals = state.proposals.filter((p) => p.zoneId === zoneId);
            }
            const batchId = url2.searchParams.get("batch");
            if (batchId !== null) {
              const members = state.proposals.filter((p) => p.batchId === batchId);
              if (members.length === 0) {
                return new Response(JSON.stringify({
                  error: `no proposal carries batch ${batchId} \u2014 either the id is wrong, or every member of that act has been DELETED (delete drops the row, so a batch fades as it is cleared; ratified/rejected members would still be listed)`
                }), { status: 404, headers: { "Content-Type": "application/json" } });
              }
              state.proposals = members;
            }
            const anchorId = url2.searchParams.get("anchor");
            if (anchorId !== null) {
              if (!state.nodes.some((n) => n.id === anchorId)) {
                return new Response(JSON.stringify({ error: `unknown anchor node: ${anchorId}` }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              state.nodes = state.nodes.filter((n) => n.anchorNodeId === anchorId || n.id === anchorId);
              const visible = new Set(state.nodes.map((n) => n.id));
              state.edges = state.edges.filter((e) => visible.has(e.source) && visible.has(e.target));
            }
            const activity = entry.activityState ? {
              state: entry.activityState,
              ...entry.activityMessageId ? { messageId: entry.activityMessageId } : {}
            } : null;
            return Response.json({
              ...state,
              presence: { agents: entry.agents },
              activity
            });
          }
          if (req.method === "GET" && path === "/changes") {
            const { db, meta } = loadProject(projectId);
            const raw = url2.searchParams.get("since");
            try {
              if (raw === null)
                throw new Error("missing ?since=<epochSeconds>");
              if (!/^\d+$/.test(raw.trim())) {
                throw new Error(`since must be a non-negative integer in epoch SECONDS (use 0 for everything, then pass back the \`now\` from a previous response), got: ${JSON.stringify(raw)}`);
              }
              return Response.json(readChanges(db, meta, Number(raw), projectDir(HOME, meta.id)));
            } catch (e) {
              return badRequest(e, "GET /changes?since=<epochSeconds> \u2014 use 0 for everything, then pass back the `now` from the previous response");
            }
          }
          if (path === "/zones" && req.method === "GET") {
            const { db } = loadProject(projectId);
            return Response.json({ zones: listZones(db) });
          }
          if (path === "/zones" && req.method === "POST") {
            const { db, bus } = loadProject(projectId);
            return req.json().then((body) => {
              const { name } = body;
              if (typeof name !== "string")
                throw new Error("name required");
              return Response.json(createZone(db, bus, name));
            }).catch((e) => badRequest(e, '{"name": "<zone name>"}'));
          }
          if (req.method === "DELETE" && path.startsWith("/zones/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/zones/".length);
            const yes = url2.searchParams.has("yes");
            try {
              const result = deleteZone(db, bus, id, yes);
              if (!result) {
                return new Response('{"error":"unknown zone"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json({ ok: true, id });
            } catch (e) {
              if (e instanceof ZoneNotEmptyError) {
                return new Response(JSON.stringify({ error: "zone-not-empty", proposals: e.proposals }), { status: 409, headers: { "Content-Type": "application/json" } });
              }
              return badRequest(e, "DELETE /zones/<id>[?yes=1] \u2014 a populated zone needs ?yes=1 (delete cascades its proposals)");
            }
          }
          if ((req.method === "PUT" || req.method === "DELETE") && path.startsWith("/actions/")) {
            const { db, bus } = loadProject(projectId);
            const targetId = path.slice("/actions/".length);
            const handle = req.method === "DELETE" ? Promise.resolve(clearActions(db, bus, targetId)) : req.json().then((body) => setActions(db, bus, targetId, body));
            return handle.then((result) => {
              if (!result) {
                return new Response('{"error":"unknown target (node or pending proposal)"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(result);
            }).catch((e) => badRequest(e, '{"actions": [...]} is WRONG \u2014 PUT the BARE JSON array: [{"id","label","seed"}] (empty array clears)'));
          }
          if ((req.method === "PUT" || req.method === "DELETE") && path.startsWith("/tags/")) {
            const { db, bus } = loadProject(projectId);
            const targetId = path.slice("/tags/".length);
            const handle = req.method === "DELETE" ? Promise.resolve(clearTags(db, bus, targetId)) : req.json().then((body) => setTags(db, bus, targetId, body));
            return handle.then((result) => {
              if (!result) {
                return new Response('{"error":"unknown target (node or pending proposal)"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(result);
            }).catch((e) => badRequest(e, '{"tags": [...]} is WRONG \u2014 PUT the BARE JSON array of strings: ["tag", ...] (empty array clears)'));
          }
          if (req.method === "GET" && path === "/jobs") {
            const { db } = loadProject(projectId);
            return Response.json({ jobs: readJobs(db) });
          }
          if (req.method === "POST" && path === "/jobs") {
            const { db, bus, meta } = loadProject(projectId);
            return req.json().then((body) => {
              const { title, status, deliverable, detail } = body;
              const job = createJob(db, bus, {
                project: meta.id,
                title,
                status: typeof status === "string" ? status : undefined,
                deliverable: typeof deliverable === "string" ? deliverable : null,
                detail: typeof detail === "string" ? detail : null
              });
              return Response.json(job);
            }).catch((e) => badRequest(e, '{"title": string, "status"?, "deliverable"?, "detail"?}'));
          }
          if (req.method === "POST" && path.startsWith("/jobs/") && path.endsWith("/claim")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/jobs/".length, -"/claim".length);
            return req.json().then((body) => {
              const { owner } = body;
              const job = claimJob(db, bus, id, owner);
              if (!job) {
                return new Response('{"error":"unknown job"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(job);
            }).catch((e) => {
              if (e instanceof ClaimConflictError) {
                return new Response(JSON.stringify({ error: "claimed", claimedBy: e.claimedBy }), { status: 409, headers: { "Content-Type": "application/json" } });
              }
              return badRequest(e, '{"owner": string}');
            });
          }
          if (req.method === "POST" && path.startsWith("/jobs/") && path.endsWith("/release")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/jobs/".length, -"/release".length);
            const job = releaseJob(db, bus, id);
            if (!job) {
              return new Response('{"error":"unknown job"}', {
                status: 404,
                headers: { "Content-Type": "application/json" }
              });
            }
            return Response.json(job);
          }
          if (req.method === "POST" && path.startsWith("/jobs/") && path.endsWith("/subtask")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/jobs/".length, -"/subtask".length);
            return req.json().then((body) => {
              const { op, label, subtaskId } = body;
              let job = null;
              if (op === "add") {
                job = addSubtask(db, bus, id, label);
              } else if (op === "check" || op === "uncheck") {
                job = setSubtaskDone(db, bus, id, subtaskId, op === "check");
              } else {
                throw new Error("op must be add|check|uncheck");
              }
              if (!job) {
                return new Response('{"error":"unknown job"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(job);
            }).catch((e) => badRequest(e, '{"op":"add","label":string} | {"op":"check"|"uncheck","subtaskId":string}'));
          }
          if (req.method === "DELETE" && path.startsWith("/jobs/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/jobs/".length);
            const result = deleteJob(db, bus, id);
            if (!result) {
              return new Response('{"error":"unknown job"}', {
                status: 404,
                headers: { "Content-Type": "application/json" }
              });
            }
            return Response.json({ ok: true, id });
          }
          if (req.method === "POST" && path.startsWith("/jobs/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/jobs/".length);
            return req.json().then((body) => {
              const { title, status, deliverable, detail } = body;
              const patch = {};
              if (title !== undefined)
                patch.title = title;
              if (status !== undefined)
                patch.status = status;
              if (deliverable !== undefined)
                patch.deliverable = deliverable;
              if (detail !== undefined)
                patch.detail = detail;
              const job = updateJob(db, bus, id, patch);
              if (!job) {
                return new Response('{"error":"unknown job"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(job);
            }).catch((e) => badRequest(e, '{"title"?, "status"?, "deliverable"?, "detail"?} (at least one)'));
          }
          if (req.method === "POST" && path === "/activity") {
            const entry = loadProject(projectId);
            return req.json().then((body) => {
              const { state, messageId } = body;
              if (state === "stalled") {
                throw new Error("stalled is daemon-synthesized only \u2014 post received|thinking|idle");
              }
              if (state !== "received" && state !== "thinking" && state !== "idle") {
                throw new Error("state must be received|thinking|idle");
              }
              let tie;
              if (messageId !== undefined && messageId !== null) {
                if (typeof messageId !== "string") {
                  throw new Error("messageId must be a message id string");
                }
                const known = entry.db.query("SELECT id FROM messages WHERE id = ? AND project_id = ?").get(messageId, entry.meta.id);
                if (!known)
                  throw new Error(`unknown messageId: ${messageId}`);
                tie = messageId;
              }
              postActivity(entry, state, "explicit", tie);
              return Response.json({
                ok: true,
                state,
                ...entry.activityMessageId ? { messageId: entry.activityMessageId } : {}
              });
            }).catch((e) => badRequest(e, '{"state":"received"|"thinking"|"idle", "messageId"?: "<message id>"}'));
          }
          if (req.method === "GET" && path === "/projects") {
            return Response.json({ projects: listProjects(HOME) });
          }
          if (req.method === "POST" && path === "/projects") {
            const projectsExpected = '{"id": "<slug>", "title": "<Title>"} \u2014 BOTH required; the id is the ' + "slug used by ?project= and is NOT derived from the title";
            return req.json().then((body) => {
              const { id, title } = body;
              if (typeof id !== "string" || typeof title !== "string") {
                return badRequest(new Error("id and title required"), projectsExpected);
              }
              const meta = createProject(HOME, id, title);
              return Response.json(meta);
            }).catch((e) => badRequest(e, projectsExpected));
          }
          if (req.method === "POST" && path === "/ingest") {
            const { db, bus, meta } = loadProject(projectId);
            const docsDir = join6(projectDir(HOME, meta.id), "docs");
            const contentType = req.headers.get("content-type") ?? "";
            const handle = contentType.includes("multipart/form-data") ? req.formData().then(async (form) => {
              const file = form.get("file");
              if (!(file instanceof File))
                throw new Error("multipart body missing 'file'");
              const title = form.get("title") ?? file.name;
              return ingestFile(db, bus, docsDir, title, await file.text());
            }) : req.json().then((body) => {
              const { title, text } = body;
              if (typeof title !== "string" || typeof text !== "string") {
                throw new Error("title and text required");
              }
              return ingestText(db, bus, docsDir, title, text);
            });
            return handle.then((doc) => Response.json(doc)).catch((e) => badRequest(e, '{"title": string, "text": string, "kind"?: string} (the body key is `text`, not `content`)'));
          }
          if (req.method === "POST" && path === "/proposals/batch") {
            const entry = loadProject(projectId);
            const { db, bus } = entry;
            return req.json().then((body) => {
              const { nodes, edges, batchId } = body;
              const result = batchPropose(db, bus, {
                nodes: Array.isArray(nodes) ? nodes : [],
                edges: Array.isArray(edges) ? edges : [],
                batchId
              });
              if (result.proposals.some((p) => p.author === "agent"))
                resolveActivity(entry);
              return Response.json(result);
            }).catch((e) => badRequest(e, '{"nodes":[{"ref","draft","evidence"?,"tags"?}], "edges":[{"draft":{"source","target","label"?}}], "batchId"?} \u2014 an edge endpoint may be a local ref, a node/proposal id, or "title:<exact node title>"'));
          }
          if (req.method === "POST" && path === "/proposals/ratify-batch") {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const docsDir = join6(projectDir(HOME, meta.id), "docs");
            return req.json().then((body) => {
              const { ruling, ids, anchors } = body;
              if (ruling !== "canon" && ruling !== "thread" && ruling !== "story-local" && ruling !== "reject") {
                throw new Error("ruling must be canon|thread|story-local|reject");
              }
              if (!Array.isArray(ids))
                throw new Error("ratify-batch requires ids: [proposalId]");
              const result = ratifyBatch(db, bus, docsDir, {
                ruling,
                ids,
                anchors: Array.isArray(anchors) ? anchors : undefined
              });
              resolveActivity(entry);
              return Response.json(result);
            }).catch((e) => {
              if (e instanceof ZonedError) {
                return new Response(JSON.stringify({ error: "zoned", zoneId: e.zoneId }), {
                  status: 409,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return badRequest(e, '{"ruling":"canon"|"thread"|"story-local", "ids":["<proposalId>"], "anchors"?:[{"node","parent"}]} \u2014 reject is NOT a batch act');
            });
          }
          if (req.method === "POST" && path === "/proposals") {
            const entry = loadProject(projectId);
            const { db, bus } = entry;
            return req.json().then((body) => {
              const { kind, draft, evidence, suggestedTier, author, zone, tags, batchId } = body;
              if (kind !== "node" && kind !== "edge")
                throw new Error("kind must be node or edge");
              if (author !== undefined && author !== "user" && author !== "agent") {
                throw new Error("author must be user or agent");
              }
              const input = {
                draft,
                evidence: evidence ?? {},
                suggestedTier: typeof suggestedTier === "string" ? suggestedTier : undefined,
                author,
                zone: typeof zone === "string" ? zone : undefined,
                tags: Array.isArray(tags) ? tags : undefined,
                batchId
              };
              const proposal = kind === "node" ? proposeNode(db, bus, input) : proposeEdge(db, bus, input);
              const warning = kind === "edge" ? edgeDraftWarning(input.draft) : null;
              if (proposal.author === "agent")
                resolveActivity(entry);
              return Response.json(warning ? { ...proposal, warning } : proposal);
            }).catch((e) => badRequest(e, `{"kind":"node"|"edge", "draft":{...}, "evidence"?:{docId|messageId,span}, "suggestedTier"?, "author"?, "zone"?, "tags"?:[string], "batchId"?} \u2014 an edge draft's source/target may be a node id, a pending node-proposal id, or "title:<exact node title>"`));
          }
          if (req.method === "POST" && path === "/send") {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            return req.json().then((body) => {
              const { role, kind, text, ground } = body;
              if (role !== "user" && role !== "agent" || typeof text !== "string") {
                throw new Error("role (user|agent) and text required");
              }
              const message = sendMessage(db, bus, meta.id, {
                role,
                kind: typeof kind === "string" ? kind : "turn",
                text,
                ground: Array.isArray(ground) ? ground : undefined
              });
              if (role === "user" && entry.agents >= 1) {
                postActivity(entry, "received", "auto", message.id);
              } else if (role === "agent") {
                resolveActivity(entry, { terminalAct: true });
              }
              const warning = channelWarning(message.kind);
              return Response.json(warning ? { ...message, warning } : message);
            }).catch((e) => badRequest(e, '{"text": string, "role"?: "user"|"agent", "kind"?: "<channel>", "ground"?: [string]}'));
          }
          if (req.method === "GET" && path === "/search") {
            const { db } = loadProject(projectId);
            const q = url2.searchParams.get("q") ?? "";
            return Response.json({ hits: search(db, q) });
          }
          if (req.method === "GET" && path.startsWith("/message/")) {
            const { db, meta } = loadProject(projectId);
            const id = path.slice("/message/".length);
            const row = db.query("SELECT id, seq, role, kind, text, ground_json, ts FROM messages WHERE id = ? AND project_id = ?").get(id, meta.id);
            if (!row) {
              return new Response('{"error":"unknown message"}', {
                status: 404,
                headers: { "Content-Type": "application/json" }
              });
            }
            return Response.json({
              id: row.id,
              seq: row.seq,
              role: row.role,
              kind: row.kind,
              text: row.text,
              ground: row.ground_json ? JSON.parse(row.ground_json) : null,
              ts: row.ts
            });
          }
          if (req.method === "GET" && path.startsWith("/neighbors/")) {
            const { db } = loadProject(projectId);
            const depth = Number.parseInt(url2.searchParams.get("depth") ?? "1", 10);
            const id = path.slice("/neighbors/".length);
            return Response.json({
              neighbors: neighbors(db, id, Number.isFinite(depth) && depth > 0 ? depth : 1)
            });
          }
          if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/zone")) {
            const { db, bus } = loadProject(projectId);
            const proposalId = path.slice("/proposals/".length, -"/zone".length);
            return req.json().then((body) => {
              const { zoneId } = body;
              if (zoneId !== null && typeof zoneId !== "string") {
                throw new Error("zoneId must be a zone id string, or null to move to main");
              }
              const result = moveProposalToZone(db, bus, proposalId, zoneId);
              if (!result) {
                return new Response('{"error":"unknown proposal"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(result);
            }).catch((e) => {
              if (e instanceof UnknownZoneError) {
                return new Response(JSON.stringify({ error: e.message }), {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return badRequest(e, '{"zoneId": "<zone id>" | null}');
            });
          }
          if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/promote")) {
            const { db, bus } = loadProject(projectId);
            const proposalId = path.slice("/proposals/".length, -"/promote".length);
            try {
              return Response.json(promote(db, bus, proposalId));
            } catch (e) {
              return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
            }
          }
          if (req.method === "POST" && path.startsWith("/nodes/") && path.endsWith("/anchor")) {
            const { db, bus } = loadProject(projectId);
            const nodeId = path.slice("/nodes/".length, -"/anchor".length);
            return req.json().then((body) => {
              const { parentId } = body;
              if (parentId !== null && typeof parentId !== "string") {
                throw new Error("parentId must be a node id string, or null to clear");
              }
              return Response.json(anchorNode(db, bus, nodeId, parentId));
            }).catch((e) => badRequest(e, '{"parentId": "<node id>" | null}'));
          }
          if (req.method === "POST" && path.startsWith("/nodes/")) {
            const { db, bus } = loadProject(projectId);
            const nodeId = path.slice("/nodes/".length);
            return req.json().then((body) => {
              const { title, synopsis } = body;
              const node = editNode(db, bus, nodeId, {
                title,
                synopsis
              });
              if (!node) {
                return new Response('{"error":"unknown node"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(node);
            }).catch((e) => badRequest(e, '{"title"?: string, "synopsis"?: string} (at least one)'));
          }
          if (req.method === "DELETE" && path.startsWith("/nodes/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/nodes/".length);
            const force = url2.searchParams.has("force");
            try {
              const result = deleteNode(db, bus, id, force);
              if (!result) {
                return new Response('{"error":"unknown node"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json({ ok: true, id });
            } catch (e) {
              if (e instanceof NodeCitedError) {
                return new Response(JSON.stringify({ error: "cited", citedBy: e.citedBy }), {
                  status: 409,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return badRequest(e, "DELETE /nodes/<id>[?force=1] \u2014 a cited node needs ?force=1");
            }
          }
          if (req.method === "POST" && path === "/proposals/delete-batch") {
            const { db, bus } = loadProject(projectId);
            return req.json().then((body) => {
              const { ids } = body;
              return Response.json(deleteProposalBatch(db, bus, ids));
            }).catch((e) => badRequest(e, '{"ids": ["<proposalId>", ...]} \u2014 all-or-nothing; there is deliberately no {"batch": id} shorthand (look with `state --batch <id>` before you sweep)'));
          }
          if (req.method === "DELETE" && path.startsWith("/proposals/")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/proposals/".length);
            const result = deleteProposal(db, bus, id);
            if (!result) {
              return new Response('{"error":"unknown proposal"}', {
                status: 404,
                headers: { "Content-Type": "application/json" }
              });
            }
            return Response.json({ ok: true, id });
          }
          if (req.method === "POST" && path.startsWith("/proposals/") && path.endsWith("/ruling")) {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const proposalId = path.slice("/proposals/".length, -"/ruling".length);
            const docsDir = join6(projectDir(HOME, meta.id), "docs");
            return req.json().then((body) => {
              const { ruling, docEdit, docId, span, anchor } = body;
              if (ruling !== "canon" && ruling !== "thread" && ruling !== "story-local" && ruling !== "reject") {
                throw new Error("ruling must be canon|thread|story-local|reject");
              }
              if (typeof anchor === "string") {
                if (ruling === "reject")
                  throw new Error("--anchor is invalid with a reject ruling");
                const batch = ratifyBatch(db, bus, docsDir, {
                  ruling,
                  ids: [proposalId],
                  anchors: [{ node: proposalId, parent: anchor }]
                });
                resolveActivity(entry);
                return Response.json({ ...batch.ratified[0], idMap: batch.idMap });
              }
              const result = ratify(db, bus, docsDir, {
                proposalId,
                ruling,
                docEdit: typeof docEdit === "string" ? docEdit : undefined,
                docId: typeof docId === "string" ? docId : undefined,
                span: typeof span === "string" ? span : undefined
              });
              resolveActivity(entry);
              return Response.json(result);
            }).catch((e) => {
              if (e instanceof ZonedError) {
                return new Response(JSON.stringify({ error: "zoned", zoneId: e.zoneId }), {
                  status: 409,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return badRequest(e, '{"ruling":"canon"|"thread"|"story-local"|"reject", "docEdit"?, "docId"?, "span"?, "anchor"?}');
            });
          }
          if (req.method === "POST" && path === "/lens") {
            const { db, bus, meta } = loadProject(projectId);
            return req.json().then((body) => {
              const { owner, nodeId, depth, docId } = body;
              if (typeof owner !== "string")
                throw new Error("owner required");
              const hasNode = typeof nodeId === "string";
              const hasDoc = typeof docId === "string";
              if (hasNode === hasDoc) {
                throw new Error("lens requires exactly one of nodeId or docId");
              }
              if (hasDoc && depth !== undefined && depth !== null) {
                throw new Error("depth applies to a node lens only");
              }
              if (hasDoc) {
                if (!SLUG_RE.test(docId)) {
                  throw new Error(`docId is not a valid doc slug: ${String(docId)}`);
                }
                if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(docId)) {
                  throw new Error(`unknown doc: ${String(docId)}`);
                }
              }
              const lens = setLens(db, bus, meta.id, {
                owner,
                nodeId: hasNode ? nodeId : null,
                depth: hasNode && typeof depth === "number" ? depth : null,
                docId: hasDoc ? docId : null
              });
              return Response.json(lens);
            }).catch((e) => badRequest(e, '{"owner": string, "nodeId": string} | {"owner": string, "docId": string} (node XOR doc), "depth"? number'));
          }
          if (req.method === "DELETE" && path === "/lens") {
            const { db, bus, meta } = loadProject(projectId);
            clearLens(db, bus, meta.id);
            return Response.json({ ok: true });
          }
          if (req.method === "POST" && path.startsWith("/look-here/")) {
            const { bus } = loadProject(projectId);
            lookHere(bus, path.slice("/look-here/".length));
            return Response.json({ ok: true });
          }
          if (req.method === "DELETE" && path.startsWith("/doc/")) {
            const { db, bus, meta } = loadProject(projectId);
            const id = path.slice("/doc/".length);
            const force = url2.searchParams.has("force");
            try {
              const result = deleteDoc(db, bus, projectDir(HOME, meta.id), id, force);
              if (!result) {
                return new Response('{"error":"unknown doc"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json({ ok: true, id });
            } catch (e) {
              if (e instanceof CitedError) {
                return new Response(JSON.stringify({ error: "cited", citedBy: e.citedBy }), {
                  status: 409,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return badRequest(e, "DELETE /doc/<slug>[?force=1] \u2014 a cited doc needs ?force=1");
            }
          }
          if (req.method === "POST" && path.startsWith("/doc/") && path.endsWith("/kind")) {
            const { db, bus } = loadProject(projectId);
            const id = path.slice("/doc/".length, -"/kind".length);
            return req.json().then((body) => {
              const { kind, author } = body;
              if (kind !== null && typeof kind !== "string") {
                throw new Error("kind must be a string, or null to clear");
              }
              const result = setDocKind(db, bus, {
                docId: id,
                kind,
                author: typeof author === "string" ? author : undefined
              });
              if (!result) {
                return new Response('{"error":"unknown doc"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" }
                });
              }
              return Response.json(result);
            }).catch((e) => badRequest(e, '{"kind": string, "author"?: "user"|"agent"}'));
          }
          if (req.method === "POST" && path.startsWith("/doc/") && path.endsWith("/mark")) {
            const entry = loadProject(projectId);
            const { db, bus, meta } = entry;
            const id = path.slice("/doc/".length, -"/mark".length);
            return req.json().then((body) => {
              const { author, note, status } = body;
              if (typeof status !== "string")
                throw new Error("mark requires a status string");
              const resolvedAuthor = typeof author === "string" ? author : "agent";
              const mark = markDoc(db, bus, projectDir(HOME, meta.id), {
                docId: id,
                author: resolvedAuthor,
                note: typeof note === "string" ? note : undefined,
                status
              });
              if (resolvedAuthor === "agent")
                resolveActivity(entry);
              return Response.json({ docId: id, mark });
            }).catch((e) => badRequest(e, '{"status": string, "author": string, "note"?: string}'));
          }
          if (req.method === "GET" && path.startsWith("/doc/")) {
            const { db, meta } = loadProject(projectId);
            const doc = readDoc(db, join6(projectDir(HOME, meta.id), "docs"), path.slice("/doc/".length));
            if (doc)
              return Response.json(doc);
            return new Response('{"error":"unknown doc"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          if (mode === "release") {
            const asset = serveDist(path);
            if (asset)
              return asset;
          }
          return new Response('{"error":"not found"}', {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return projectFailure(e);
        }
      },
      websocket: {
        open(ws) {
          const data = ws.data;
          const { bus } = loadProject(data.projectId);
          data.unsubscribe = bus.subscribe(data.since, (event) => {
            ws.send(JSON.stringify(event));
          });
        },
        close(ws) {
          ws.data.unsubscribe?.();
        },
        message() {}
      }
    });
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ event: "bind_error", host, port, error: e instanceof Error ? e.message : String(e) })}
`);
    return 2;
  }
  const url = `http://${host}:${server.port}`;
  try {
    mkdirSync2(HOME, { recursive: true });
    writeFileSync4(PORT_FILE, String(server.port));
    writeFileSync4(PID_FILE, String(process.pid));
  } catch (e) {
    process.stderr.write(`mind-mapper: could not write discovery files: ${e instanceof Error ? e.message : String(e)}
`);
  }
  process.stdout.write(`${JSON.stringify({ url, port: server.port, mode })}
`);
  if (!parsed.values["no-open"])
    openBrowser(url);
  await new Promise((resolve) => {
    const shutdown = () => resolve();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
  try {
    if (existsSync4(PID_FILE) && readFileSync2(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync2(PID_FILE);
      unlinkSync2(PORT_FILE);
    }
  } catch {}
  for (const { db } of projects.values())
    db.close();
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  return 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  readDoc,
  run,
  sseResponse
};

//# debugId=436E9448E9C5576164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2FjdGlvbnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYW5jaG9yLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2pvYnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvbWFya3MudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJvamVjdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC9kYi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC90YWdzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL3N0YXRlLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2NoYW5nZXMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvZGVsLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2RvY3MudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvZWRpdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC9ldmVudHMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvaW5nZXN0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2xlbnMudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvbmVpZ2hib3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL3Byb3Bvc2UudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcmF0aWZ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlYXJjaC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZW5kLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL3pvbmVzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBtaW5kLW1hcHBlciDigJQgUDEgZGFlbW9uLiBSZWFsIHBlci1wcm9qZWN0IHN0YXRlIChzcWxpdGUgKyBkb2NzLykgcmVwbGFjZXNcbi8vIHRoZSBzcGlrZSdzIHN0dWItSlNPTiAvc3RhdGU7IGRldi1tb2RlIHNlcnZlIChzZWFtcyBDb250cmFjdCAxKSBhbmQgdGhlXG4vLyByZWFkRG9jIGVudmVsb3BlIHNoYXBlIGFyZSBrZXB0IHZlcmJhdGltIGZyb20gdGhlIHNwaWtlLiBCYWNrZW5kIHNoaXBzIGFzXG4vLyBzb3VyY2UgKENvbnRyYWN0IDMpLiBObyBkYWVtb24tc2lkZSBpbnRlbGxpZ2VuY2UgYW55d2hlcmUgYmVsb3cgKENsYWltIEEpIOKAlFxuLy8gdGhpcyBmaWxlIHN0b3JlcyBhbmQgc2VydmVzLCBub3RoaW5nIG1vcmUuXG4vL1xuLy8gU3VyZmFjZSBzb3VyY2UgbGl2ZXMgYXQgc3JjL21pbmQtbWFwcGVyL3N1cmZhY2UvIChzZWFtcyBDb250cmFjdCA0KTsgdGhlXG4vLyBpbXBvcnQgYmVsb3cgaXMgRFlOQU1JQyArIGRldi1vbmx5IHNvIGEgZnV0dXJlIHJlbGVhc2UtbW9kZSBkYWVtb24gY2FuIGJvb3Rcbi8vIHdpdGhvdXQgdGhlIHN1cmZhY2UgYnVpbGQgZ3JhcGggcHJlc2VudCAoQ29udHJhY3QgMSdzIFwid2h5IGl0IGJpdGVzXCIpLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIG1rZGlyU3luYywgcmVhZEZpbGVTeW5jLCB1bmxpbmtTeW5jLCB3cml0ZUZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IGNsZWFyQWN0aW9ucywgc2V0QWN0aW9ucyB9IGZyb20gXCIuL2FjdGlvbnMudHNcIjtcbmltcG9ydCB7IGFuY2hvck5vZGUgfSBmcm9tIFwiLi9hbmNob3IudHNcIjtcbmltcG9ydCB7IHJlYWRDaGFuZ2VzIH0gZnJvbSBcIi4vY2hhbmdlcy50c1wiO1xuaW1wb3J0IHsgb3BlblN0b3JlIH0gZnJvbSBcIi4vZGIudHNcIjtcbmltcG9ydCB7IGRlbGV0ZU5vZGUsIGRlbGV0ZVByb3Bvc2FsLCBkZWxldGVQcm9wb3NhbEJhdGNoLCBOb2RlQ2l0ZWRFcnJvciB9IGZyb20gXCIuL2RlbC50c1wiO1xuaW1wb3J0IHsgQ2l0ZWRFcnJvciwgZGVsZXRlRG9jLCBzZXREb2NLaW5kIH0gZnJvbSBcIi4vZG9jcy50c1wiO1xuaW1wb3J0IHsgZWRpdE5vZGUgfSBmcm9tIFwiLi9lZGl0LnRzXCI7XG5pbXBvcnQgeyBjcmVhdGVFdmVudEJ1cywgdHlwZSBFdmVudEJ1cywgaW5ib3VuZEdyb3VuZGluZywgaXNJbmJvdW5kRXZlbnQgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcbmltcG9ydCB7IGluZ2VzdEZpbGUsIGluZ2VzdFRleHQgfSBmcm9tIFwiLi9pbmdlc3QudHNcIjtcbmltcG9ydCB7XG4gIGFkZFN1YnRhc2ssXG4gIENsYWltQ29uZmxpY3RFcnJvcixcbiAgY2xhaW1Kb2IsXG4gIGNyZWF0ZUpvYixcbiAgZGVsZXRlSm9iLFxuICByZWFkSm9icyxcbiAgcmVsZWFzZUpvYixcbiAgc2V0U3VidGFza0RvbmUsXG4gIHVwZGF0ZUpvYixcbn0gZnJvbSBcIi4vam9icy50c1wiO1xuaW1wb3J0IHsgY2xlYXJMZW5zLCBsb29rSGVyZSwgc2V0TGVucyB9IGZyb20gXCIuL2xlbnMudHNcIjtcbmltcG9ydCB7IG1hcmtEb2MgfSBmcm9tIFwiLi9tYXJrcy50c1wiO1xuaW1wb3J0IHsgbmVpZ2hib3JzIH0gZnJvbSBcIi4vbmVpZ2hib3JzLnRzXCI7XG5pbXBvcnQge1xuICBjcmVhdGVQcm9qZWN0LFxuICBsaXN0UHJvamVjdHMsXG4gIE5lZWRzUHJvamVjdEVycm9yLFxuICB0eXBlIFByb2plY3RNZXRhLFxuICBwcm9qZWN0RGlyLFxuICByZXNvbHZlUHJvamVjdCxcbiAgU0xVR19SRSxcbiAgVW5rbm93blByb2plY3RFcnJvcixcbn0gZnJvbSBcIi4vcHJvamVjdC50c1wiO1xuaW1wb3J0IHtcbiAgdHlwZSBCYXRjaElucHV0LFxuICBiYXRjaFByb3Bvc2UsXG4gIGVkZ2VEcmFmdFdhcm5pbmcsXG4gIHByb3Bvc2VFZGdlLFxuICBwcm9wb3NlTm9kZSxcbn0gZnJvbSBcIi4vcHJvcG9zZS50c1wiO1xuaW1wb3J0IHsgcmF0aWZ5LCByYXRpZnlCYXRjaCwgWm9uZWRFcnJvciB9IGZyb20gXCIuL3JhdGlmeS50c1wiO1xuaW1wb3J0IHsgc2VhcmNoIH0gZnJvbSBcIi4vc2VhcmNoLnRzXCI7XG5pbXBvcnQgeyBjaGFubmVsV2FybmluZywgc2VuZE1lc3NhZ2UgfSBmcm9tIFwiLi9zZW5kLnRzXCI7XG5pbXBvcnQgeyByZWFkU3RhdGUgfSBmcm9tIFwiLi9zdGF0ZS50c1wiO1xuaW1wb3J0IHsgY2xlYXJUYWdzLCBzZXRUYWdzIH0gZnJvbSBcIi4vdGFncy50c1wiO1xuaW1wb3J0IHtcbiAgY3JlYXRlWm9uZSxcbiAgZGVsZXRlWm9uZSxcbiAgbGlzdFpvbmVzLFxuICBtb3ZlUHJvcG9zYWxUb1pvbmUsXG4gIHByb21vdGUsXG4gIFVua25vd25ab25lRXJyb3IsXG4gIFpvbmVOb3RFbXB0eUVycm9yLFxufSBmcm9tIFwiLi96b25lcy50c1wiO1xuXG4vLyDim5QgQ09NUFVURUQgRlJPTSBUSEUgQVJUSUZBQ1QnUyBBRERSRVNTLCBXSElDSCBJU1xuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9taW5kLW1hcHBlci9kaXN0L3NlcnZlci5qc2Ag4oCUIG5vdCBmcm9tIHRoaXMgc291cmNlXG4vLyBmaWxlLiBgZGlzdC9gIHNpdHMgYXQgdGhlIHNhbWUgZGVwdGggdW5kZXIgdGhlIHNraWxsIHJvb3QgYXMgdGhlIGBzY3JpcHRzL2AgaXRcbi8vIHJlcGxhY2VkLCBzbyB0aGUgY2xpbWIgaXMgdW5jaGFuZ2VkIGJ5IHRoZSBwb3J0OyB0aGF0IGlzIGEgQ09JTkNJREVOQ0UgT0Zcbi8vIERFUFRIIGFuZCBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIGlzIHdoYXQgYXNzZXJ0cyBpdCByYXRoZXIgdGhhblxuLy8gYXNzdW1pbmcgaXQgKHBsYXlib29rIEI0L0I1KS5cbmNvbnN0IFNDUklQVF9ESVIgPSBpbXBvcnQubWV0YS5kaXI7XG4vLyBBYnNvbHV0ZSBza2lsbC1yb290IHBhdGggKG5vdCBjd2QpIOKAlCBzZWFtcyBDb250cmFjdCAxJ3MgcmVsZWFzZS1tb2RlXG4vLyByZXF1aXJlbWVudCwgc28gZGlzdC8gcmVzb2x2ZXMgdGhlIHNhbWUgcmVnYXJkbGVzcyBvZiB0aGUgZGFlbW9uJ3Ncbi8vIHdvcmtpbmcgZGlyZWN0b3J5LlxuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8vIHJlbGVhc2UgaWZmIGRpc3QvaW5kZXguaHRtbCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3QsIGVsc2UgZGV2OyBlbnZcbi8vIG92ZXJyaWRlIHdpbnMgZWl0aGVyIHdheSAoc2VhbXMgQ29udHJhY3QgMSkuIFJlbGVhc2U6IHplcm8gcmVhZHMgb2Zcbi8vIHN1cmZhY2UvIG9yIGJ1bmZpZy50b21sIOKAlCBzdGF0aWMgZmlsZXMgb25seS4gRGV2OiB0aGUgZXhpc3RpbmcgZHluYW1pY1xuLy8gaW1wb3J0ICsgQnVuJ3Mgc2VydmUtdGltZSBidW5kbGluZy5cbmZ1bmN0aW9uIHJlc29sdmVNb2RlKCk6IFwiZGV2XCIgfCBcInJlbGVhc2VcIiB7XG4gIGNvbnN0IG92ZXJyaWRlID0gcHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERTtcbiAgaWYgKG92ZXJyaWRlID09PSBcImRldlwiIHx8IG92ZXJyaWRlID09PSBcInJlbGVhc2VcIikgcmV0dXJuIG92ZXJyaWRlO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gXCJyZWxlYXNlXCIgOiBcImRldlwiO1xufVxuXG5jb25zdCBTVEFUSUNfQ09OVEVOVF9UWVBFUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuaHRtbFwiOiBcInRleHQvaHRtbFwiLFxuICBcIi5qc1wiOiBcInRleHQvamF2YXNjcmlwdFwiLFxuICBcIi5jc3NcIjogXCJ0ZXh0L2Nzc1wiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5zdmdcIjogXCJpbWFnZS9zdmcreG1sXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxufTtcblxuLy8gU2VydmVzIGRpc3QvIHZlcmJhdGltIOKAlCBlbnRyeSBpbmRleC5odG1sLCBoYXNoZWQgY2h1bmstKi5qcy9jc3MgYnkgcGF0aFxuLy8gKENvbnRyYWN0IDIncyBmbGF0LCByZWxhdGl2ZS1ocmVmIGxheW91dCkuIFBhdGggdHJhdmVyc2FsIGd1YXJkZWQgKGFcbi8vIHN0YXRpYyBhc3NldCByZXF1ZXN0IGlzIGFsd2F5cyBhIGJhcmUgZmlsZW5hbWUsIG5ldmVyIG5lc3RlZCkuXG5mdW5jdGlvbiBzZXJ2ZURpc3QocGF0aDogc3RyaW5nKTogUmVzcG9uc2UgfCBudWxsIHtcbiAgY29uc3QgcmVsID0gcGF0aCA9PT0gXCIvXCIgPyBcImluZGV4Lmh0bWxcIiA6IHBhdGguc2xpY2UoMSk7XG4gIGlmIChyZWwuaW5jbHVkZXMoXCIuLlwiKSB8fCByZWwuaW5jbHVkZXMoXCIvXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oRElTVF9ESVIsIHJlbCk7XG4gIGlmICghZXhpc3RzU3luYyhmaWxlKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGV4dCA9IHJlbC5zbGljZShyZWwubGFzdEluZGV4T2YoXCIuXCIpKTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShCdW4uZmlsZShmaWxlKSwge1xuICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogU1RBVElDX0NPTlRFTlRfVFlQRVNbZXh0XSA/PyBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiIH0sXG4gIH0pO1xufVxuXG4vLyBEaXNjb3Zlcnkgcm9vdCDigJQgY2xpLnRzIGRlcml2ZXMgdGhlIHNhbWUgcGF0aCB0byBmaW5kIChvciBza2lwIHNwYXduaW5nKSB1cy5cbmNvbnN0IEhPTUUgPSBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5taW5kLW1hcHBlclwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oSE9NRSwgXCJkYWVtb24ucG9ydFwiKTtcbmNvbnN0IFBJRF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5waWRcIik7XG5cbi8vIE9uZSBvcGVuIERhdGFiYXNlICsgZXZlbnQgYnVzIHBlciBwcm9qZWN0LCBvcGVuZWQgbGF6aWx5IGFuZCBrZXB0IG9wZW4gZm9yXG4vLyB0aGUgZGFlbW9uJ3MgbGlmZXRpbWUgKHNxbGl0ZSBjb25uZWN0aW9ucyBhcmUgY2hlYXAgdG8gaG9sZCwgZXhwZW5zaXZlIHRvXG4vLyByZW9wZW4gcGVyIHJlcXVlc3QpLiBgYWdlbnRzYCBpcyBDbGFpbSBDJ3Mgc3RhbmRpbmctcHJlc2VuY2UgY291bnRlciDigJQgaXRcbi8vIGxpdmVzIEhFUkUgKHBlci1wcm9qZWN0IG1hcCBlbnRyeSwgYWRqdXN0ZWQgYXQgdGhlIFNTRSBzdWJzY3JpcHRpb24gc2l0ZSlcbi8vIGJlY2F1c2UgdGhlIGJ1cydzIGxpc3RlbmVyIHNldCBpcyB0cmFuc3BvcnQtYmxpbmQ6IG9ubHkgdGhlIHN1YnNjcmlwdGlvblxuLy8gc2l0ZSBrbm93cyBhbiBhZ2VudCB0YWlsIGZyb20gYSBicm93c2VyIFdTLlxuLy9cbi8vIFJvdW5kIDQgKEFDVDEpOiBhY3Rpdml0eVN0YXRlL2FjdGl2aXR5U291cmNlIHRyYWNrIHRoZSBMSVZFIGFjdGl2aXR5IHNvXG4vLyBhZ2VudCB3cml0ZXMgY2FuIHJlc29sdmUgaXQg4oCUIFwiYXV0b1wiIGlzIGEgZGFlbW9uLWZsaXBwZWQgc3RhdGUgKHRoZSAvc2VuZFxuLy8gYXV0by1yZWNlaXZlZCwgdGhlIFRUTCdkIHN0YWxsZWQpLCBcImV4cGxpY2l0XCIgaXMgYSBQT1NUIC9hY3Rpdml0eS4gQWxsXG4vLyBpbi1tZW1vcnk6IGEgcmVzdGFydCBob25lc3RseSBjbGVhcnMgdG8gbm8tc2lnbmFsLlxuaW50ZXJmYWNlIFByb2plY3RFbnRyeSB7XG4gIGRiOiBEYXRhYmFzZTtcbiAgYnVzOiBFdmVudEJ1cztcbiAgbWV0YTogUHJvamVjdE1ldGE7XG4gIGFnZW50czogbnVtYmVyO1xuICBhY3Rpdml0eVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG4gIGFjdGl2aXR5U3RhdGU6IHN0cmluZyB8IG51bGw7XG4gIGFjdGl2aXR5U291cmNlOiBcImF1dG9cIiB8IFwiZXhwbGljaXRcIiB8IG51bGw7XG4gIC8vIFJvdW5kIDExIChTRUFNIDIsIHJ1bGluZyBCKTogV0hJQ0ggbWVzc2FnZSB0aGUgY3VycmVudCBhY3Rpdml0eSBpcyBhYm91dC5cbiAgLy8gQSBwcm9wZXJ0eSBvZiB0aGUgT1BFTiBsYWRkZXIsIG5vdCBvZiBhIHNpbmdsZSBlbWl0IOKAlCBzdGFtcGVkIHdoZW4gdGhlXG4gIC8vIGxhZGRlciBvcGVucyAodGhlIC9zZW5kIGF1dG8tZmxpcCBoYXMgdGhlIG1lc3NhZ2UgaW4gaGFuZCksIGluaGVyaXRlZCBieVxuICAvLyBsYXRlciBzdGF0ZXMgd2hpbGUgaXQgc3RheXMgb3BlbiwgY2FycmllZCBvbiB0aGUgcmVzb2x2aW5nIGlkbGUsIHRoZW5cbiAgLy8gY2xlYXJlZC4gSW4tbWVtb3J5IGxpa2UgdGhlIHJlc3Q6IGEgcmVzdGFydCBob25lc3RseSBjbGVhcnMgdG8gbm8tc2lnbmFsLlxuICBhY3Rpdml0eU1lc3NhZ2VJZDogc3RyaW5nIHwgbnVsbDtcbn1cblxuY29uc3QgcHJvamVjdHMgPSBuZXcgTWFwPHN0cmluZywgUHJvamVjdEVudHJ5PigpO1xuXG4vLyBBIGNvbm5lY3Rpb24gV0lUSE9VVCA/cHJvamVjdD0gKHRoZSBicm93c2VyIFdTIG9uIGZpcnN0IG1vdW50LCBhbiB1bnNjb3BlZFxuLy8gYWdlbnQgdGFpbCkgcmVzb2x2ZXMgdGhyb3VnaCB0aGUgc2FtZSBkZWZhdWx0LXByb2plY3QgcGF0aCBhcyBldmVyeSBvdGhlclxuLy8gdW5zY29wZWQgcmVxdWVzdCDigJQgYXR0cmlidXRpb24gdG8gdGhlIGRhZW1vbi1yZXNvbHZlZCBkZWZhdWx0IHByb2plY3QgKElGXG4vLyBvbmUgZXhpc3RzLCBSb3VuZCAzIG5hcnJvd2luZykgaXMgd2hhdCBrZWVwcyBwcm9qZWN0LXNjb3BlZFxuLy8gcHJlc2VuY2UuY2hhbmdlZCBmYW4tb3V0IGhvbmVzdCAocGxhbi12MXgsIENsYWltIEMgc2NvcGluZyBlZGdlKS5cbi8vXG4vLyBSb3VuZCAzIChDbGFpbSBQMSk6IG5vIGF1dG8tbWludCwgbm8gZGVtbyBzZWVkIOKAlCByZXNvbHZlUHJvamVjdCB0aHJvd3Ncbi8vIE5lZWRzUHJvamVjdEVycm9yIG9uIGEgcHJvamVjdGxlc3MgdW5zY29wZWQgcmVxdWVzdCwgYW5kIHRoZSBmZXRjaFxuLy8gaGFuZGxlcidzIHByb2plY3RGYWlsdXJlIGZ1bm5lbCB0dXJucyB0aGF0IGludG8gdGhlIHJhdGlmaWVkIDQwOS4gU1NFIGFuZFxuLy8gV1MgYm90aCBwYXNzIHRocm91Z2ggaGVyZSBCRUZPUkUgYW55IHN0cmVhbS91cGdyYWRlIGV4aXN0cywgc28gYSByZWZ1c2VkXG4vLyBjb25uZWN0aW9uIG5ldmVyIHRvdWNoZXMgcHJlc2VuY2UuXG5mdW5jdGlvbiBsb2FkUHJvamVjdChpZD86IHN0cmluZyk6IFByb2plY3RFbnRyeSB7XG4gIGNvbnN0IG1ldGEgPSByZXNvbHZlUHJvamVjdChIT01FLCBpZCk7XG4gIGNvbnN0IGV4aXN0aW5nID0gcHJvamVjdHMuZ2V0KG1ldGEuaWQpO1xuICBpZiAoZXhpc3RpbmcpIHJldHVybiBleGlzdGluZztcblxuICBjb25zdCBkaXIgPSBwcm9qZWN0RGlyKEhPTUUsIG1ldGEuaWQpO1xuICBjb25zdCBkYiA9IG9wZW5TdG9yZShqb2luKGRpciwgXCJzdG9yZS5zcWxpdGVcIikpO1xuICBjb25zdCBlbnRyeTogUHJvamVjdEVudHJ5ID0ge1xuICAgIGRiLFxuICAgIGJ1czogY3JlYXRlRXZlbnRCdXMoKSxcbiAgICBtZXRhLFxuICAgIGFnZW50czogMCxcbiAgICBhY3Rpdml0eVRpbWVyOiBudWxsLFxuICAgIGFjdGl2aXR5U3RhdGU6IG51bGwsXG4gICAgYWN0aXZpdHlTb3VyY2U6IG51bGwsXG4gICAgYWN0aXZpdHlNZXNzYWdlSWQ6IG51bGwsXG4gIH07XG4gIHByb2plY3RzLnNldChtZXRhLmlkLCBlbnRyeSk7XG4gIHJldHVybiBlbnRyeTtcbn1cblxuLy8gVGhlIG9uZSBob25lc3Qgc2hhcGUgZm9yIFwieW91IGNhbid0IGhhdmUgYSBib2FyZCB5ZXRcIiAocmF0aWZpZWQgb3ZlciBhXG4vLyAyMDAtbWFya2VyIOKAlCBhIGZha2UgUHJvamVjdFN0YXRlIGxpZXMgdG8gY29uc3VtZXJzOyBvbmUgZmV0Y2ggYnJhbmNoIGlzXG4vLyBob25lc3QpOiA0MDkge2Vycm9yOlwibmVlZHMtcHJvamVjdFwiLCBwcm9qZWN0czpbLi4uXX0gZm9yIGEgcHJvamVjdGxlc3Ncbi8vIHN0b3JlLCA0MDQgZm9yIGEgbmFtZWQtYnV0LXVua25vd24gc2NvcGUuIEFueXRoaW5nIGVsc2UgcmV0aHJvd3MuXG5mdW5jdGlvbiBwcm9qZWN0RmFpbHVyZShlOiB1bmtub3duKTogUmVzcG9uc2Uge1xuICBpZiAoZSBpbnN0YW5jZW9mIE5lZWRzUHJvamVjdEVycm9yKSB7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcIm5lZWRzLXByb2plY3RcIiwgcHJvamVjdHM6IGxpc3RQcm9qZWN0cyhIT01FKSB9KSwge1xuICAgICAgc3RhdHVzOiA0MDksXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgfSk7XG4gIH1cbiAgaWYgKGUgaW5zdGFuY2VvZiBVbmtub3duUHJvamVjdEVycm9yKSB7XG4gICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlLm1lc3NhZ2UgfSksIHtcbiAgICAgIHN0YXR1czogNDA0LFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgIH0pO1xuICB9XG4gIHRocm93IGU7XG59XG5cbi8vIOKUgOKUgCBSb3VuZCAxMiDCtyBTRUFNIDcg4oCUIGV2ZXJ5IGFnZW50LWZhY2luZyA0MDAgTkFNRVMgdGhlIHNoYXBlIGl0IHdhbnRlZCDilIDilIDilIDilIBcbi8vXG4vLyBEcml2ZSAjMTAgcmFua2VkIHRoaXM6IHRoZSBlZGdlLWVuZHBvaW50IGVycm9yIChcInJhdGlmeSBub2RlIHByb3Bvc2FsIDxpZD5cbi8vIGZpcnN0XCIpIGlzIHRoZSBiZXN0IGVycm9yIGluIHRoZSBzeXN0ZW0gYW5kIGlzIHRoZSBtb2RlbDsgYFBVVCAvdGFncy86aWRgXG4vLyA0MDAnZCB3aXRoIG5vdGhpbmcgYWJvdXQgdGhlIGV4cGVjdGVkIGJvZHkgKGl0IHdhbnRzIGEgQkFSRSBhcnJheSwgbm90XG4vLyB7dGFnczpbLi4uXX0pIGFuZCBjb3N0IGEgcHJvYmUgdG8gZGlzY292ZXIuXG4vL1xuLy8gVGhlIHN0YW5kYXJkIGlzIGEgRlVOTkVMLCBub3QgYSBwcm9zZSBzd2VlcCDigJQgZXZlcnkgcm91dGUncyA0MDAgZ29lcyB0aHJvdWdoXG4vLyBoZXJlIHdpdGggdGhlIGJvZHkgc2hhcGUgaXQgZXhwZWN0cywgc28gdGhlIHNoYXBlIGlzIChhKSBhdHRhY2hlZCBldmVuIHdoZW5cbi8vIHRoZSB0aHJvdyBjYW1lIGZyb20gQnVuJ3MgSlNPTiBwYXJzZXIgcmF0aGVyIHRoYW4gb3VyIG93biB2YWxpZGF0b3IgKGFcbi8vIG1hbGZvcm1lZCBvciBlbXB0eSBib2R5IHVzZWQgdG8gNDAwIHdpdGggXCJVbmV4cGVjdGVkIGVuZCBvZiBKU09OIGlucHV0XCIgYW5kXG4vLyBubyByb3V0ZSBjb250ZXh0IGF0IGFsbCksIGFuZCAoYikgbWFjaGluZS1yZWFkYWJsZSBpbiBhbiBhZGRpdGl2ZSBgZXhwZWN0ZWRgXG4vLyBmaWVsZCBiZXNpZGUgdGhlIGh1bWFuLXJlYWRhYmxlIGBlcnJvcmAuIEEgcm91dGUgYWRkZWQgbGF0ZXIgaW5oZXJpdHMgdGhlXG4vLyBzdGFuZGFyZCBieSB1c2luZyB0aGUgZnVubmVsOyBpdCBjYW5ub3QgaW5oZXJpdCBhIHByb3NlIGNvbnZlbnRpb24uXG5mdW5jdGlvbiBiYWRSZXF1ZXN0KGU6IHVua25vd24sIGV4cGVjdGVkPzogc3RyaW5nKTogUmVzcG9uc2Uge1xuICBjb25zdCBlcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeShleHBlY3RlZCA/IHsgZXJyb3IsIGV4cGVjdGVkIH0gOiB7IGVycm9yIH0pLCB7XG4gICAgc3RhdHVzOiA0MDAsXG4gICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICB9KTtcbn1cblxuLy8gUHJlc2VuY2UgPSB3aG8gaXMgcmVjZWl2aW5nICh0aGUgZ3JhcGV2aW5lIGB3aG9gIG1vZGVsKTogYWdlbnRzLW9ubHksXG4vLyBjb3VudGVkIGF0IFNTRSBzdWJzY3JpYmUvdW5zdWJzY3JpYmUuIEFjY3VyYWN5IGlzIGJvdW5kZWQgYnkgdGhlIGtlZXBhbGl2ZVxuLy8gKENsYWltIEYpOiBhIGRlYWQgc29ja2V0IG9ubHkgdGVhcnMgZG93biB3aGVuIHRoZSBuZXh0IGtlZXBhbGl2ZSB3cml0ZVxuLy8gdGhyb3dzLCBzbyB0aGUgZGVjcmVtZW50IGNhbiBsYWcgYnkgdXAgdG8gb25lIHRpY2sg4oCUIG5ldmVyIGRhbmdsZS5cbmZ1bmN0aW9uIGFkanVzdEFnZW50cyhlbnRyeTogUHJvamVjdEVudHJ5LCBkZWx0YTogbnVtYmVyKTogdm9pZCB7XG4gIGVudHJ5LmFnZW50cyA9IE1hdGgubWF4KDAsIGVudHJ5LmFnZW50cyArIGRlbHRhKTtcbiAgZW50cnkuYnVzLmVtaXQoXCJwcmVzZW5jZS5jaGFuZ2VkXCIsIHsgYWdlbnRzOiBlbnRyeS5hZ2VudHMgfSk7XG59XG5cbmZ1bmN0aW9uIGFjdGl2aXR5VHRsTXMoKTogbnVtYmVyIHtcbiAgY29uc3QgdiA9IE51bWJlci5wYXJzZUludChwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9BQ1RJVklUWV9UVExfTVMgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHYpICYmIHYgPiAwID8gdiA6IDYwXzAwMDtcbn1cblxuLy8gUm91bmQgNSAoU1cxKSDigJQgdGhlIHN0YWxsIHdpbmRvdyBpcyBpdHMgb3duIGtub2Igbm93LiBgcmVjZWl2ZWQg4oaSIHN0YWxsZWRgXG4vLyBpcyBhIERJRkZFUkVOVCBqdWRnbWVudCB0aGFuIGB0aGlua2luZyDihpIgaWRsZWA6IGl0IGZpcmVzIHdoaWxlIHRoZSBhZ2VudCBpc1xuLy8gZGVsaWJlcmF0aW5nIChhIGxvbmdlciwgaHVtYW4tcGFjZWQgYmVhdCksIG5vdCB3aGlsZSBhIGNyYXNoZWQgYWdlbnQgbGVhdmVzXG4vLyBcInRoaW5raW5n4oCmXCIgc3R1Y2suIDYwcyBmYWxzZS1maXJlZCB0d2ljZSBkdXJpbmcgbm9ybWFsIGRyaXZlLTQgZGVsaWJlcmF0aW9uLFxuLy8gc28gdGhlIHJlY2VpdmVkLWdyYWNlIHdpZGVucyB0byAxNTBzIGJ5IGRlZmF1bHQgd2hpbGUgdGhpbmtpbmcga2VlcHMgdGhlXG4vLyB0aWdodGVyIDYwcyAoYSBzdHVjayBzcGlubmVyIHNob3VsZCBjbGVhciBmYXN0KS4gVGhlIGxpdmVuZXNzLWdhdGUgd2FzXG4vLyByZWplY3RlZDogYSBjb25uZWN0ZWQgdGFpbCBwcm92ZXMgdHJhbnNwb3J0LCBub3QgYWdlbnQgbGl2ZW5lc3MgKGEgaHVuZ1xuLy8gYWdlbnQga2VlcHMgaXRzIHRhaWwgb3BlbikuXG5mdW5jdGlvbiBzdGFsbFR0bE1zKCk6IG51bWJlciB7XG4gIGNvbnN0IHYgPSBOdW1iZXIucGFyc2VJbnQocHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfU1RBTExfVFRMX01TID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2KSAmJiB2ID4gMCA/IHYgOiAxNTBfMDAwO1xufVxuXG4vLyBDbGFpbSBDJ3MgYWN0aXZlLWF0dGVudGlvbiBoYWxmLCBSb3VuZCA0IChBQ1QxKSBzdXBlcnNlc3Npb24gb2YgdGhlIFRUTFxuLy8gY2xhdXNlOiBmaXJlLWFuZC1mb3JnZXQsIG5vIHRhYmxlLCBubyBwZXJzaXN0ZW5jZS4gVFRMIGVzY2FsYXRpb24gaXNcbi8vIHN0YXRlLWF3YXJlIG5vdyDigJQgYHJlY2VpdmVkYCBvbGRlciB0aGFuIHRoZSBUVEwgZXNjYWxhdGVzIHRvIGFcbi8vIGRhZW1vbi1zeW50aGVzaXplZCBgc3RhbGxlZGAgKFwiYWdlbnQgbWF5IGJlIHN0dWNrXCI7IHBlcnNpc3RzLCBOTyBmdXJ0aGVyXG4vLyB0aW1lciksIHdoaWxlIGB0aGlua2luZ2Agc3RpbGwgZGVjYXlzIHRvIGEgc3ludGhldGljIGBpZGxlYCAoYSBjcmFzaGVkXG4vLyBhZ2VudCBjYW4ndCBsZWF2ZSBcInRoaW5raW5n4oCmXCIgc3R1Y2sgb24gdGhlIHN1cmZhY2UpLiBgc3RhbGxlZGAgaXNcbi8vIGRhZW1vbi1vbmx5IHZvY2FidWxhcnkg4oCUIFBPU1QgL2FjdGl2aXR5IHJlamVjdHMgaXQgKHRoZSBlcG9jaC5jaGFuZ2VkXG4vLyBhc3ltbWV0cnkgcHJlY2VkZW50KS4gRXZlcnkgZW1pdCByaWRlcyB0aGUgbm9ybWFsIGJ1cyBwYXRoIChzZXEtY29uc3VtaW5nXG4vLyDigJQgdGhlIGVwaGVtZXJhbC1jdXJzb3IgY2xhdXNlIGhvbGRzKS5cbi8vIFJvdW5kIDExIChTRUFNIDIsIHJ1bGluZyBCKTogZXZlcnkgZW1pdCBjYXJyaWVzIGFuIGFkZGl0aXZlLW9wdGlvbmFsXG4vLyBgbWVzc2FnZUlkYCDigJQgdGhlIG1lc3NhZ2UgdGhpcyBhY3Rpdml0eSBpcyBBQk9VVCwgc28gdGhlIHN1cmZhY2UgY2FuIGJhZGdlXG4vLyBUSEFUIGJ1YmJsZSBpbnN0ZWFkIG9mIGd1ZXNzaW5nIFwidGhlIGxhdGVzdCB1c2VyIG1lc3NhZ2VcIiAodGhlIGd1ZXNzIGJyZWFrc1xuLy8gZXhhY3RseSB3aGVuIHR3byBtZXNzYWdlcyBhcmUgaW4gZmxpZ2h0IG9yIHRoZSBhZ2VudCB3b3JrcyBhbiBvbGRlciBvbmUg4oCUXG4vLyB3aGljaCBJUyB0aGUgXCJJIGNhbid0IHRlbGwgd2hhdCdzIGhhcHBlbmluZ1wiIGJ1ZyBGMyBuYW1lcykuIEFuIE9NSVRURURcbi8vIG1lc3NhZ2VJZCBJTkhFUklUUyB0aGUgb3BlbiBsYWRkZXInczogdGhlIGNhc3RpbmcgYWdlbnQncyBvcmRpbmFyeVxuLy8gYGFjdGl2aXR5IHRoaW5raW5nYCBhZnRlciBhIGh1bWFuIHNlbmQgY2FycmllcyBubyBpZCwgYW5kIGRyb3BwaW5nIHRoZSB0aWVcbi8vIHRoZXJlIHdvdWxkIGhhbGYtZml4IEYzIGZvciBldmVyeSBhbHJlYWR5LXNoaXBwZWQgYWdlbnQuIGBpZGxlYCBjbG9zZXMgdGhlXG4vLyBsYWRkZXIg4oCUIGl0IGNhcnJpZXMgdGhlIGlkIGl0IGlzIHJlc29sdmluZywgVEhFTiBjbGVhcnMgKGEgY29uc3VtZXIgbmVlZHMgdG9cbi8vIGtub3cgd2hpY2ggYmFkZ2UgdG8gY2xlYXIpLlxuZnVuY3Rpb24gcG9zdEFjdGl2aXR5KFxuICBlbnRyeTogUHJvamVjdEVudHJ5LFxuICBzdGF0ZTogXCJyZWNlaXZlZFwiIHwgXCJ0aGlua2luZ1wiIHwgXCJpZGxlXCIsXG4gIHNvdXJjZTogXCJhdXRvXCIgfCBcImV4cGxpY2l0XCIsXG4gIG1lc3NhZ2VJZD86IHN0cmluZyxcbik6IHZvaWQge1xuICBpZiAoZW50cnkuYWN0aXZpdHlUaW1lciAhPT0gbnVsbCkge1xuICAgIGNsZWFyVGltZW91dChlbnRyeS5hY3Rpdml0eVRpbWVyKTtcbiAgICBlbnRyeS5hY3Rpdml0eVRpbWVyID0gbnVsbDtcbiAgfVxuICBjb25zdCB0aWVkVG8gPSBtZXNzYWdlSWQgPz8gZW50cnkuYWN0aXZpdHlNZXNzYWdlSWQgPz8gbnVsbDtcbiAgZW50cnkuYWN0aXZpdHlTdGF0ZSA9IHN0YXRlID09PSBcImlkbGVcIiA/IG51bGwgOiBzdGF0ZTtcbiAgZW50cnkuYWN0aXZpdHlTb3VyY2UgPSBzdGF0ZSA9PT0gXCJpZGxlXCIgPyBudWxsIDogc291cmNlO1xuICBlbnRyeS5hY3Rpdml0eU1lc3NhZ2VJZCA9IHN0YXRlID09PSBcImlkbGVcIiA/IG51bGwgOiB0aWVkVG87XG4gIGNvbnN0IHRpZSA9IHRpZWRUbyA/IHsgbWVzc2FnZUlkOiB0aWVkVG8gfSA6IHt9O1xuICBlbnRyeS5idXMuZW1pdChcImFnZW50LmFjdGl2aXR5XCIsIHsgc3RhdGUsIC4uLnRpZSB9KTtcbiAgaWYgKHN0YXRlID09PSBcInJlY2VpdmVkXCIpIHtcbiAgICBlbnRyeS5hY3Rpdml0eVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBlbnRyeS5hY3Rpdml0eVRpbWVyID0gbnVsbDtcbiAgICAgIGVudHJ5LmFjdGl2aXR5U3RhdGUgPSBcInN0YWxsZWRcIjtcbiAgICAgIGVudHJ5LmFjdGl2aXR5U291cmNlID0gXCJhdXRvXCI7IC8vIHJlc29sdmFibGUgYnkgYW55IGFnZW50IHdyaXRlLCB3aG9ldmVyIHNldCB0aGUgcmVjZWl2ZWRcbiAgICAgIC8vIFRoZSBzdGFsbCBpcyBhYm91dCB0aGUgU0FNRSBtZXNzYWdlIOKAlCBpdCBpcyB0aGF0IG1lc3NhZ2UgdGhhdCdzIHN0dWNrLlxuICAgICAgZW50cnkuYnVzLmVtaXQoXCJhZ2VudC5hY3Rpdml0eVwiLCB7IHN0YXRlOiBcInN0YWxsZWRcIiwgLi4udGllIH0pO1xuICAgIH0sIHN0YWxsVHRsTXMoKSk7XG4gIH0gZWxzZSBpZiAoc3RhdGUgPT09IFwidGhpbmtpbmdcIikge1xuICAgIGVudHJ5LmFjdGl2aXR5VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIGVudHJ5LmFjdGl2aXR5VGltZXIgPSBudWxsO1xuICAgICAgZW50cnkuYWN0aXZpdHlTdGF0ZSA9IG51bGw7XG4gICAgICBlbnRyeS5hY3Rpdml0eVNvdXJjZSA9IG51bGw7XG4gICAgICBlbnRyeS5hY3Rpdml0eU1lc3NhZ2VJZCA9IG51bGw7XG4gICAgICBlbnRyeS5idXMuZW1pdChcImFnZW50LmFjdGl2aXR5XCIsIHsgc3RhdGU6IFwiaWRsZVwiLCAuLi50aWUgfSk7XG4gICAgfSwgYWN0aXZpdHlUdGxNcygpKTtcbiAgfVxufVxuXG4vLyBBQ1QxJ3MgcmVzb2x1dGlvbiBoYWxmOiBhbiBhZ2VudC1hdXRob3JlZCB3cml0ZSBpcyBldmlkZW5jZSB0aGUgYWdlbnQgaXNcbi8vIGFsaXZlIGFuZCBhY3RpbmcsIHNvIGl0IHJlc29sdmVzIGFueSBBVVRPIHN0YXRlIChyZWNlaXZlZC9zdGFsbGVkKSB0b1xuLy8gaWRsZS4gQSByb2xlOlwiYWdlbnRcIiBzZW5kIEFMU08gcmVzb2x2ZXMgZXhwbGljaXQgYHRoaW5raW5nYCDigJQgYSByZXBseSBpc1xuLy8gdGhlIHR1cm4ncyB0ZXJtaW5hbCBhY3QgKGNsb3NlZCBvcGVuLXF1ZXN0aW9uOyByZS1zZXQgdGhpbmtpbmcgZXhwbGljaXRseVxuLy8gZm9yIHNlbmQtdGhlbi1tb3JlLXdvcmspLiBPdGhlciBleHBsaWNpdCBzdGF0ZXMgc3RhbmQgdW50aWwgYW4gZXhwbGljaXRcbi8vIGlkbGUgb3IgdGhlIFRUTC5cbmZ1bmN0aW9uIHJlc29sdmVBY3Rpdml0eShlbnRyeTogUHJvamVjdEVudHJ5LCBvcHRzOiB7IHRlcm1pbmFsQWN0PzogYm9vbGVhbiB9ID0ge30pOiB2b2lkIHtcbiAgY29uc3QgcmVzb2x2ZXNFeHBsaWNpdFRoaW5raW5nID1cbiAgICBvcHRzLnRlcm1pbmFsQWN0ID09PSB0cnVlICYmXG4gICAgZW50cnkuYWN0aXZpdHlTb3VyY2UgPT09IFwiZXhwbGljaXRcIiAmJlxuICAgIGVudHJ5LmFjdGl2aXR5U3RhdGUgPT09IFwidGhpbmtpbmdcIjtcbiAgaWYgKGVudHJ5LmFjdGl2aXR5U291cmNlID09PSBcImF1dG9cIiB8fCByZXNvbHZlc0V4cGxpY2l0VGhpbmtpbmcpIHtcbiAgICBwb3N0QWN0aXZpdHkoZW50cnksIFwiaWRsZVwiLCBcImF1dG9cIik7XG4gIH1cbn1cblxuLy8gU2VhbSB2MiAodmluZSBtc2dzIDEz4oCTMTcpOiBHRVQgL2RvYy86aWQg4oaSIHsgaWQsIHRpdGxlLCBraW5kLCBjb250ZW50IH0g4oCUXG4vLyB0aXRsZS9raW5kL3BhdGggZnJvbSB0aGUgZG9jcyB0YWJsZSwgY29udGVudCBmcm9tIHRoZSBmaWxlIGF0IHRoYXQgcGF0aCxcbi8vIGJvdGggcmVhZCBwZXItcmVxdWVzdC4gSlNPTiA0MDQgZm9yIGFuIHVua25vd24gaWQgT1IgYSBtaXNzaW5nIGZpbGUuXG4vLyBSb3VuZCA0IChLMSk6IGtpbmQgbG9vc2VucyB0byBzdHJpbmcgfCBudWxsIOKAlCB0aGUgJycgc2VudGluZWwgYXQgcmVzdFxuLy8gbm9ybWFsaXplcyB0byBudWxsIGhlcmUsIHNhbWUgYXMgL3N0YXRlLmRvY3NbXS5cbmZ1bmN0aW9uIHJlYWREb2MoXG4gIGRiOiBEYXRhYmFzZSxcbiAgZGlyOiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4pOiB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGtpbmQ6IHN0cmluZyB8IG51bGw7IGNvbnRlbnQ6IHN0cmluZyB9IHwgbnVsbCB7XG4gIC8vIFNsdWcgZ3VhcmQg4oCUIGlkcyBhcmUgYWdyZWVkIHNsdWdzOyBhbnl0aGluZyBlbHNlIChwYXRoIHRyYXZlcnNhbCxcbiAgLy8gc2VwYXJhdG9ycykgaXMgbm90IGEgZG9jLlxuICBpZiAoIS9eW2EtejAtOV1bYS16MC05LV0qJC8udGVzdChpZCkpIHJldHVybiBudWxsO1xuICBjb25zdCByb3cgPSBkYi5xdWVyeShcIlNFTEVDVCB0aXRsZSwga2luZCwgcGF0aCBGUk9NIGRvY3MgV0hFUkUgaWQgPSA/XCIpLmdldChpZCkgYXMge1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAga2luZDogc3RyaW5nO1xuICAgIHBhdGg6IHN0cmluZztcbiAgfSB8IG51bGw7XG4gIGlmICghcm93KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZmlsZSA9IGpvaW4oZGlyLCBcIi4uXCIsIHJvdy5wYXRoKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICB0aXRsZTogcm93LnRpdGxlLFxuICAgICAga2luZDogcm93LmtpbmQgPT09IFwiXCIgPyBudWxsIDogcm93LmtpbmQsXG4gICAgICBjb250ZW50OiByZWFkRmlsZVN5bmMoZmlsZSwgXCJ1dGY4XCIpLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIG9wZW5Ccm93c2VyKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNtZCA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICB0cnkge1xuICAgIEJ1bi5zcGF3bihbY21kLCB1cmxdLCB7IHN0ZG91dDogXCJpZ25vcmVcIiwgc3RkZXJyOiBcImlnbm9yZVwiIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvKiBiZXN0LWVmZm9ydCAqL1xuICB9XG59XG5cbi8vIEtlZXBhbGl2ZSB0aWNrIChDbGFpbSBGKTogYSBjb21tZW50IGZyYW1lIGV2ZXJ5IH4xNXMga2VlcHMgYSBoZWFsdGh5IFNTRVxuLy8gY29ubmVjdGlvbiBvYnNlcnZhYmx5IGFsaXZlIOKAlCB0aGUgY2xpJ3MgaWRsZSB3YXRjaGRvZyBpcyBjYWxpYnJhdGVkIHRvIH4zXG4vLyBtaXNzZWQgdGlja3MuIEVudiBvdmVycmlkZSBpcyBmb3IgdGVzdHMgb25seS5cbi8vXG4vLyBEZWFkLXNvY2tldCBkZXRlY3Rpb24gKG1lYXN1cmVkLCBCdW4gMS4zLjE0IOKAlCBjb3JyZWN0cyB0aGUgcmF0aWZpZWRcbi8vIGVucXVldWUtdGhyb3cgbWVjaGFuaXNtKTogZW5xdWV1ZSBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gTkVWRVIgdGhyb3dzIChpdFxuLy8gYnVmZmVycyBzaWxlbnRseSksIGJ1dCBhIHZhbmlzaGVkIGNsaWVudCDigJQgcmF3IHNvY2tldCBkZWF0aCBvciBhblxuLy8gYWJvcnRlZCBjbGllbnQgZmV0Y2gg4oCUIGZpcmVzIEJPVEggcmVxLnNpZ25hbCBcImFib3J0XCIgYW5kIHRoZSBzdHJlYW0nc1xuLy8gY2FuY2VsKCkuIFRlYXJkb3duIHRoZXJlZm9yZSBsaXN0ZW5zIG9uIHRoZSByZXF1ZXN0IHNpZ25hbCBhbmQga2VlcHMgdGhlXG4vLyBlbnF1ZXVlIHRyeS9jYXRjaCBvbmx5IGFzIGJlbHQtYW5kLWJyYWNlcy4gKEtub3duIGhvbGUsIGFjY2VwdGVkOiBCdW4nc1xuLy8gb3duIGZldGNoIHJlYWRlci5jYW5jZWwoKSBjbG9zZXMgbm90aGluZyBjbGllbnQtc2lkZSBhbmQgaXMgaW52aXNpYmxlIHRvXG4vLyB0aGUgc2VydmVyIOKAlCByZWFsIGNsaWVudHMgY2xvc2UgdGhlIHNvY2tldC4pXG5mdW5jdGlvbiBrZWVwYWxpdmVNcygpOiBudW1iZXIge1xuICBjb25zdCB2ID0gTnVtYmVyLnBhcnNlSW50KHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0tFRVBBTElWRV9NUyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodikgJiYgdiA+IDAgPyB2IDogMTVfMDAwO1xufVxuXG5mdW5jdGlvbiBzc2VSZXNwb25zZShcbiAgYnVzOiBFdmVudEJ1cyxcbiAgc2luY2U6IG51bWJlcixcbiAgaG9va3M6IHsgb25PcGVuPzogKCkgPT4gdm9pZDsgb25DbG9zZT86ICgpID0+IHZvaWQgfSA9IHt9LFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbiAgLy8gUm91bmQgMTAgwrcgU0VBTSAxOiB3aGVuIHRydWUsIHRoaXMgaXMgYSBgdGFpbCAtLWluYm91bmRgIHN0cmVhbSDigJQgdGhlXG4gIC8vIHNlcnZlciBmaWx0ZXJzIHRvIGV2ZW50cyBhIEhVTUFOIG9yaWdpbmF0ZWQgKGlzSW5ib3VuZEV2ZW50LCBPcHRpb24gQSkgYW5kXG4gIC8vIG9wZW5zIHdpdGggYSBncm91bmRpbmcgZnJhbWUgbmFtaW5nIHdhdGNoZWQvbm90LXdhdGNoZWQgY2hhbm5lbHMuIFRoZVxuICAvLyBicm93c2VyIFdTIG5ldmVyIHNldHMgdGhpcyAodGhlIHN1cmZhY2UgdXNlcyB0aGUgZnVsbCBXUyBzdHJlYW0gdW5jaGFuZ2VkKS5cbiAgaW5ib3VuZCA9IGZhbHNlLFxuKTogUmVzcG9uc2Uge1xuICBsZXQgdW5zdWJzY3JpYmU6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBsZXQga2VlcGFsaXZlOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZCA9IGZhbHNlO1xuICAvLyBFdmVyeSBleGl0IHBhdGggKGNsZWFuIGNhbmNlbCwgZW5xdWV1ZS10aHJvdyBvbiBhIGRlYWQgY29udHJvbGxlcilcbiAgLy8gZnVubmVscyB0aHJvdWdoIGhlcmUgZXhhY3RseSBvbmNlIOKAlCBDbGFpbSBDJ3MgcHJlc2VuY2UgZGVjcmVtZW50IHJpZGVzXG4gIC8vIGhvb2tzLm9uQ2xvc2UsIHNvIHRoaXMgZnVubmVsIGlzIHdoYXQgYm91bmRzIHByZXNlbmNlIGFjY3VyYWN5LlxuICBjb25zdCB0ZWFyZG93biA9ICgpID0+IHtcbiAgICBpZiAoY2xvc2VkKSByZXR1cm47XG4gICAgY2xvc2VkID0gdHJ1ZTtcbiAgICBpZiAoa2VlcGFsaXZlICE9PSBudWxsKSBjbGVhckludGVydmFsKGtlZXBhbGl2ZSk7XG4gICAgdW5zdWJzY3JpYmU/LigpO1xuICAgIGhvb2tzLm9uQ2xvc2U/LigpO1xuICB9O1xuICBjb25zdCBzdHJlYW0gPSBuZXcgUmVhZGFibGVTdHJlYW0oe1xuICAgIHN0YXJ0KGNvbnRyb2xsZXIpIHtcbiAgICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgICAgIGNvbnN0IHNhZmVFbnF1ZXVlID0gKGNodW5rOiBzdHJpbmcpID0+IHtcbiAgICAgICAgaWYgKGNsb3NlZCkgcmV0dXJuO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnRyb2xsZXIuZW5xdWV1ZShlbmNvZGVyLmVuY29kZShjaHVuaykpO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICB0ZWFyZG93bigpO1xuICAgICAgICB9XG4gICAgICB9O1xuICAgICAgLy8gQW4gb3BlbmluZyBjb21tZW50IGZsdXNoZXMgdGhlIHJlc3BvbnNlIGhlYWRlcnMgaW1tZWRpYXRlbHkg4oCUIHNvbWVcbiAgICAgIC8vIEhUVFAgY2xpZW50cyAoQnVuJ3Mgb3duIGZldGNoKCkgaW5jbHVkZWQpIG90aGVyd2lzZSBidWZmZXIgdW50aWwgdGhlXG4gICAgICAvLyBmaXJzdCBieXRlIG9mIGJvZHkgYXJyaXZlcywgc28gYW4gU1NFIHN0cmVhbSB0aGF0J3MgZ2VudWluZWx5IHF1aWV0XG4gICAgICAvLyBiZXR3ZWVuIGV2ZW50cyB3b3VsZCBsZWF2ZSB0aGUgY2FsbGVyJ3MgZmV0Y2goKSB1bnJlc29sdmVkLlxuICAgICAgc2FmZUVucXVldWUoXCI6IGNvbm5lY3RlZFxcblxcblwiKTtcbiAgICAgIC8vIEY1IGJlbHQtYW5kLXN1c3BlbmRlcnM6IGFuIGluYm91bmQgc3RyZWFtIG9wZW5zIGJ5IE5BTUlORyB0aGUgY2hhbm5lbHNcbiAgICAgIC8vIGl0IHdhdGNoZXMgKyBkb2VzIG5vdCB3YXRjaCwgc28gYSBtaXNzaW5nIGNoYW5uZWwgaXMgdmlzaWJsZS4gRW1pdHRlZFxuICAgICAgLy8gc2VydmVyLXNpZGUgKG5vdCBDTEktc3ludGhlc2l6ZWQpIHNvIHRoZSBsaXN0IGlzIGRlcml2ZWQgZnJvbSB0aGUgc2FtZVxuICAgICAgLy8gcHJlZGljYXRlIHRoYXQgZmlsdGVycyDigJQgaXQgY2Fubm90IGRyaWZ0LiBObyBzZXEvZXBvY2g6IGl0IG5ldmVyXG4gICAgICAvLyBhZHZhbmNlcyB0aGUgdGFpbCdzIGN1cnNvciAodGhlIGVwb2NoLmNoYW5nZWQgc2VwYXJhdGlvbikuXG4gICAgICBpZiAoaW5ib3VuZCkgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoaW5ib3VuZEdyb3VuZGluZygpKX1cXG5cXG5gKTtcbiAgICAgIHVuc3Vic2NyaWJlID0gYnVzLnN1YnNjcmliZShzaW5jZSwgKGV2ZW50KSA9PiB7XG4gICAgICAgIGlmIChpbmJvdW5kICYmICFpc0luYm91bmRFdmVudChldmVudCkpIHJldHVybjtcbiAgICAgICAgc2FmZUVucXVldWUoYGRhdGE6ICR7SlNPTi5zdHJpbmdpZnkoZXZlbnQpfVxcblxcbmApO1xuICAgICAgfSk7XG4gICAgICBrZWVwYWxpdmUgPSBzZXRJbnRlcnZhbCgoKSA9PiBzYWZlRW5xdWV1ZShcIjoga2VlcGFsaXZlXFxuXFxuXCIpLCBrZWVwYWxpdmVNcygpKTtcbiAgICAgIHNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIHRlYXJkb3duLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgICBob29rcy5vbk9wZW4/LigpO1xuICAgIH0sXG4gICAgY2FuY2VsKCkge1xuICAgICAgdGVhcmRvd24oKTtcbiAgICB9LFxuICB9KTtcbiAgcmV0dXJuIG5ldyBSZXNwb25zZShzdHJlYW0sIHtcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvZXZlbnQtc3RyZWFtXCIsXG4gICAgICBcIkNhY2hlLUNvbnRyb2xcIjogXCJuby1jYWNoZVwiLFxuICAgICAgQ29ubmVjdGlvbjogXCJrZWVwLWFsaXZlXCIsXG4gICAgfSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IFwiMFwiIH0sXG4gICAgICAgIGhvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxMjcuMC4wLjFcIiB9LFxuICAgICAgICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiwgZGVmYXVsdDogZmFsc2UgfSxcbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgaG9zdCA9IHBhcnNlZC52YWx1ZXMuaG9zdCBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5wb3J0IGFzIHN0cmluZywgMTApO1xuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuXG4gIC8vIGRldjogdGhlIGR5bmFtaWMgc3RyaW5nLWxpdGVyYWwgaW1wb3J0IGtlZXBzIHRoZSBzdXJmYWNlIGdyYXBoIG9mZiB0aGVcbiAgLy8gbW9kdWxlIGxvYWQgcGF0aCAoQ29udHJhY3QgMSdzIFwid2h5IGl0IGJpdGVzXCIg4oCUIGEgdG9wLWxldmVsIHN0YXRpY1xuICAvLyBpbXBvcnQgd291bGQgZm9yY2UgQnVuIHRvIHJlc29sdmUgaXQgYXQgZGFlbW9uIExPQUQsIGNyYXNoaW5nIGFcbiAgLy8gc3VyZmFjZS1zb3VyY2UtZnJlZSBkZXN0aW5hdGlvbiBiZWZvcmUgaXQgY291bGQgZXZlciBzZXJ2ZSBkaXN0Lyk7IEJ1blxuICAvLyBidW5kbGVzIC50c3ggKyBUYWlsd2luZCBhdCBzZXJ2ZSB0aW1lIChidW5maWcudG9tbCB2aWEgY3dkIOKAlCBjbGkudHMgcGluc1xuICAvLyBjd2QgdG8gc3JjL21pbmQtbWFwcGVyLykuIGhtciBvbiBmb3IgY2lyY2UncyBpdGVyYXRpb24gbG9vcC5cbiAgLy8gcmVsZWFzZTogZGlzdC8gaXMgc3RhdGljLCBwcmUtYnVpbHQgKENvbnRyYWN0IDIpIOKAlCBubyBzdXJmYWNlLWdyYXBoXG4gIC8vIHJlYWQgYXQgYWxsLCBzbyB0aGlzIGJyYW5jaCBuZXZlciB0b3VjaGVzIHN1cmZhY2UvIG9yIGJ1bmZpZy50b21sLlxuICAvLyBCdW4ncyBSb3V0ZXMgdHlwZSB0aWVzIHRoZSBcIi9cIiB2YWx1ZSdzIHR5cGUgdG8gdGhlIGxpdGVyYWwgb2JqZWN0IHNoYXBlLFxuICAvLyBzbyBhIG1vZGUtdGVybmFyeSB1bmlvbiBjb25mdXNlcyBpdHMgb3ZlcmxvYWQgcmVzb2x1dGlvbiDigJQgdGhlIHJ1bnRpbWVcbiAgLy8gYmVoYXZpb3IgKEhUTUxCdW5kbGUgaW4gZGV2LCBhYnNlbnQgaW4gcmVsZWFzZSkgaXMgY29ycmVjdCBlaXRoZXIgd2F5LlxuICBjb25zdCBkZXZJbmRleCA9XG4gICAgbW9kZSA9PT0gXCJkZXZcIlxuICAgICAgPyAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL3N1cmZhY2UvaW5kZXguaHRtbFwiKSkuZGVmYXVsdFxuICAgICAgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJvdXRlcyA9IChkZXZJbmRleCA/IHsgXCIvXCI6IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+O1xuXG4gIGxldCBzZXJ2ZXI6IFJldHVyblR5cGU8dHlwZW9mIEJ1bi5zZXJ2ZT47XG4gIHRyeSB7XG4gICAgc2VydmVyID0gQnVuLnNlcnZlKHtcbiAgICAgIHBvcnQsXG4gICAgICBob3N0bmFtZTogaG9zdCxcbiAgICAgIHJvdXRlcyxcbiAgICAgIGRldmVsb3BtZW50OiB7IGhtcjogbW9kZSA9PT0gXCJkZXZcIiB9LFxuICAgICAgLy8gU1NFL1dTIGNvbm5lY3Rpb25zIG9uIC9ldmVudHMgc2l0IGlkbGUgYmV0d2VlbiBlbWl0cyBieSBkZXNpZ24g4oCUIHRoZVxuICAgICAgLy8gZGVmYXVsdCAxMHMgaWRsZSB0aW1lb3V0IHdvdWxkIG90aGVyd2lzZSByZXNldCBhIHF1aWV0IHN0cmVhbS5cbiAgICAgIC8vIEJ1biBjbGFtcHMgdGhpcyB0byBhIHVpbnQ4IChtYXggMjU1cyk7IDAgZGlzYWJsZXMgaXQgZm9yIHRoZSB3aG9sZVxuICAgICAgLy8gcmVxdWVzdCBidXQgYWxzbyAoZW1waXJpY2FsbHkpIHN0YWxscyB0aGUgaW5pdGlhbCByZXNwb25zZSDigJQgdXNlIHRoZVxuICAgICAgLy8gbWF4IGluc3RlYWQuXG4gICAgICBpZGxlVGltZW91dDogMjU1LFxuICAgICAgZmV0Y2g6IChyZXEsIHNydikgPT4ge1xuICAgICAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwpO1xuICAgICAgICBjb25zdCBwYXRoID0gdXJsLnBhdGhuYW1lO1xuICAgICAgICBjb25zdCBwcm9qZWN0SWQgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcInByb2plY3RcIikgPz8gdW5kZWZpbmVkO1xuXG4gICAgICAgIC8vIEV2ZXJ5IHNjb3BlZCByb3V0ZSBjYWxscyBsb2FkUHJvamVjdCBTWU5DSFJPTk9VU0xZIGJlZm9yZSBhbnlcbiAgICAgICAgLy8gYm9keS9zdHJlYW0gd29yaywgc28gdGhpcyBvbmUgZnVubmVsIHR1cm5zIGEgcHJvamVjdC1yZXNvbHV0aW9uXG4gICAgICAgIC8vIGZhaWx1cmUgaW50byB0aGUgcmF0aWZpZWQgNDA5LzQwNCBldmVyeXdoZXJlIGF0IG9uY2Ug4oCUIHRoZSBTU0VcbiAgICAgICAgLy8gcmVzcG9uc2UgaXMgcmVmdXNlZCBwcmUtc3RyZWFtIGFuZCB0aGUgV1MgdXBncmFkZSBpcyByZWZ1c2VkXG4gICAgICAgIC8vIG91dHJpZ2h0IChubyBwcmVzZW5jZSBpbmNyZW1lbnQgb24gZWl0aGVyKS5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBpZiAocGF0aCA9PT0gXCIvZXZlbnRzXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGlmIChyZXEuaGVhZGVycy5nZXQoXCJ1cGdyYWRlXCIpID09PSBcIndlYnNvY2tldFwiKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHNpbmNlID0gTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwic2luY2VcIikgPz8gXCIwXCIsIDEwKTtcbiAgICAgICAgICAgICAgY29uc3Qgb2sgPSBzcnYudXBncmFkZShyZXEsIHtcbiAgICAgICAgICAgICAgICBkYXRhOiB7IHNpbmNlOiBOdW1iZXIuaXNGaW5pdGUoc2luY2UpID8gc2luY2UgOiAwLCBwcm9qZWN0SWQgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIGlmIChvaykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcInVwZ3JhZGUgZmFpbGVkXCIsIHsgc3RhdHVzOiA1MDAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBzaW5jZSA9IE51bWJlci5wYXJzZUludCh1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpID8/IFwiMFwiLCAxMCk7XG4gICAgICAgICAgICAvLyBSb3VuZCAxMCDCtyBTRUFNIDE6ID9pbmJvdW5kPTEgZmlsdGVycyB0aGUgU1NFIHRvIGh1bWFuLW9yaWdpbmF0ZWRcbiAgICAgICAgICAgIC8vIGV2ZW50cyBzZXJ2ZXItc2lkZSAoT3B0aW9uIEEpIOKAlCBjb3JyZWN0bmVzcyBvd25lZCBieSB0aGUgc3VyZmFjZSxcbiAgICAgICAgICAgIC8vIG5vdCB0aGUgYWdlbnQncyBncmVwLlxuICAgICAgICAgICAgY29uc3QgaW5ib3VuZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaW5ib3VuZFwiKSA9PT0gXCIxXCI7XG4gICAgICAgICAgICAvLyBTU0UgPSBhbiBhZ2VudCB0YWlsICh0aGUgYnJvd3NlciByaWRlcyB0aGUgV1MgYWJvdmU7IHByZXNlbmNlIGlzXG4gICAgICAgICAgICAvLyBhZ2VudHMtb25seSwgcnVsZWQpLiBUaGUgc3Vic2NyaXB0aW9uIHNpdGUgaXMgdGhlIE9ORSBwbGFjZSB0aGF0XG4gICAgICAgICAgICAvLyBrbm93cyB0aGlzLCBzbyB0aGUgcHJlc2VuY2UgY291bnRlciBhZGp1c3RzIGhlcmUuXG4gICAgICAgICAgICByZXR1cm4gc3NlUmVzcG9uc2UoXG4gICAgICAgICAgICAgIGVudHJ5LmJ1cyxcbiAgICAgICAgICAgICAgTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIG9uT3BlbjogKCkgPT4gYWRqdXN0QWdlbnRzKGVudHJ5LCAxKSxcbiAgICAgICAgICAgICAgICBvbkNsb3NlOiAoKSA9PiBhZGp1c3RBZ2VudHMoZW50cnksIC0xKSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcmVxLnNpZ25hbCxcbiAgICAgICAgICAgICAgaW5ib3VuZCxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvc3RhdGVcIikge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzLCBtZXRhIH0gPSBlbnRyeTtcbiAgICAgICAgICAgIGNvbnN0IHN0YXRlID0gcmVhZFN0YXRlKGRiLCBtZXRhLCBidXMuY3Vyc29yKCksIGJ1cy5lcG9jaCwgcHJvamVjdERpcihIT01FLCBtZXRhLmlkKSk7XG4gICAgICAgICAgICAvLyA/em9uZT08aWQ+IG5hcnJvd3MgcHJvcG9zYWxzW10gdG8gdGhhdCB6b25lIOKAlCBhIGNvbnZlbmllbmNlIGZvclxuICAgICAgICAgICAgLy8gZm9jdXNlZCBhZ2VudCByZWFkcyAodGhlIGRlZmF1bHQgcmVzcG9uc2UgaXMgSU5DTFVTSVZFLCB0YWdnZWRcbiAgICAgICAgICAgIC8vIHdpdGggem9uZUlkOyB0aGUgbWFpbiB2aWV3IGlzIHpvbmVJZCA9PSBudWxsIGF0IHJlbmRlciwgcnVsZWQpLlxuICAgICAgICAgICAgY29uc3Qgem9uZUlkID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJ6b25lXCIpO1xuICAgICAgICAgICAgaWYgKHpvbmVJZCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgICBpZiAoIXN0YXRlLnpvbmVzLnNvbWUoKHopID0+IHouaWQgPT09IHpvbmVJZCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGB1bmtub3duIHpvbmU6ICR7em9uZUlkfWAgfSksIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHN0YXRlLnByb3Bvc2FscyA9IHN0YXRlLnByb3Bvc2Fscy5maWx0ZXIoKHApID0+IHAuem9uZUlkID09PSB6b25lSWQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gUm91bmQgMTIgKFNFQU0gMSk6ID9iYXRjaD08aWQ+IG5hcnJvd3MgcHJvcG9zYWxzW10gdG8gT05FIHN0YWdpbmdcbiAgICAgICAgICAgIC8vIGFjdCDigJQgdGhlIHJlYWQgc2lkZSBpcyB0aGUgd2hvbGUgcGF5b2ZmIChGNS4xOiBhZnRlciBhIFBBUlRJQUxcbiAgICAgICAgICAgIC8vIHJhdGlmaWNhdGlvbiwgXCJ3aGF0IGVsc2UgY2FtZSBmcm9tIHRoYXQgY2FsbD9cIiBiZWNvbWVzIGEgcXVlcnlcbiAgICAgICAgICAgIC8vIGluc3RlYWQgb2YgYWdlbnQgbWVtb3J5KS4gRGVsaWJlcmF0ZWx5IElOQ0xVU0lWRSBvZiBldmVyeSBzdGF0dXM6XG4gICAgICAgICAgICAvLyB0aGUgcmF0aWZpZWQgbWVtYmVycyAod2l0aCB0aGVpciByZXN1bHROb2RlSWQpIGFyZSBleGFjdGx5IHdoYXRcbiAgICAgICAgICAgIC8vIG1ha2VzIHRoZSByZWNvbmNpbGlhdGlvbiBwb3NzaWJsZS5cbiAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAvLyBBbiB1bmtub3duIGJhdGNoIGlkIGlzIGEgNDA0LCBOT1QgYW4gZW1wdHkgbGlzdC4gQW4gZW1wdHkgbGlzdFxuICAgICAgICAgICAgLy8gd291bGQgcmVhZCBhcyBcInRoYXQgYWN0IGlzIGZ1bGx5IGNsZWFyZWRcIiDigJQgdGhlIHNpbmdsZSBtb3N0XG4gICAgICAgICAgICAvLyBkYW5nZXJvdXMgYW5zd2VyIHRvIGdpdmUgYW4gYWdlbnQgbWlkLWNsZWFudXAsIGFuZCBhIHR5cG8gd291bGRcbiAgICAgICAgICAgIC8vIHByb2R1Y2UgaXQuIEV4aXN0ZW5jZSA9IFwic29tZSBwcm9wb3NhbCBzdGlsbCBjYXJyaWVzIHRoaXMgaWRcIiwgc29cbiAgICAgICAgICAgIC8vIHRoZSBtZXNzYWdlIG5hbWVzIEJPVEggcmVhZGluZ3MgKGEgYmF0Y2ggZmFkZXMgYXMgaXRzIG1lbWJlcnMgYXJlXG4gICAgICAgICAgICAvLyBkZWxldGVkOyBkZWxldGUgaXMgYSByb3ctZHJvcCwgbm90IGEgdG9tYnN0b25lKS5cbiAgICAgICAgICAgIGNvbnN0IGJhdGNoSWQgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImJhdGNoXCIpO1xuICAgICAgICAgICAgaWYgKGJhdGNoSWQgIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgY29uc3QgbWVtYmVycyA9IHN0YXRlLnByb3Bvc2Fscy5maWx0ZXIoKHApID0+IHAuYmF0Y2hJZCA9PT0gYmF0Y2hJZCk7XG4gICAgICAgICAgICAgIGlmIChtZW1iZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoXG4gICAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgIGVycm9yOiBgbm8gcHJvcG9zYWwgY2FycmllcyBiYXRjaCAke2JhdGNoSWR9IOKAlCBlaXRoZXIgdGhlIGlkIGlzIHdyb25nLCBvciBldmVyeSBtZW1iZXIgb2YgdGhhdCBhY3QgaGFzIGJlZW4gREVMRVRFRCAoZGVsZXRlIGRyb3BzIHRoZSByb3csIHNvIGEgYmF0Y2ggZmFkZXMgYXMgaXQgaXMgY2xlYXJlZDsgcmF0aWZpZWQvcmVqZWN0ZWQgbWVtYmVycyB3b3VsZCBzdGlsbCBiZSBsaXN0ZWQpYCxcbiAgICAgICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwNCwgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0sXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBzdGF0ZS5wcm9wb3NhbHMgPSBtZW1iZXJzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gUm91bmQgNSAoU0cxKTogP2FuY2hvcj08aWQ+IGlzIGEgc2VydmVyLXNpZGUgQ0xJL2FnZW50IG5hcnJvdyB0b1xuICAgICAgICAgICAgLy8gb25lIG5vZGUncyBzdWJtYXAg4oCUIHRoZSBhbmNob3Igbm9kZSBpdHNlbGYgcGx1cyBpdHMgZGlyZWN0XG4gICAgICAgICAgICAvLyBjaGlsZHJlbiwgYW5kIHRoZSBlZGdlcyBhbW9uZyB0aGF0IHNldC4gVGhlIFNVUkZBQ0UgZG9lcyBOT1QgdXNlXG4gICAgICAgICAgICAvLyB0aGlzIChpdCBjb25zdW1lcyB0aGUgaW5jbHVzaXZlIHNuYXBzaG90ICsgc3VibWFwQ2hpbGRDb3VudCBhbmRcbiAgICAgICAgICAgIC8vIGRlcml2ZXMgdGhlIHN1Ym1hcCBjbGllbnQtc2lkZSwgc28gdGhlIGJyZWFkY3J1bWIgcGFyZW50LXdhbGtcbiAgICAgICAgICAgIC8vIHN0YXlzIHBvc3NpYmxlKTsgdGhpcyBpcyBhIGNvbnZlbmllbmNlIGZvciBjb250ZXh0LWJ1ZGdldGVkIGFnZW50XG4gICAgICAgICAgICAvLyByZWFkcywgbWlycm9yaW5nID96b25lLiBVbmtub3duIGFuY2hvciBpZCDihpIgNDA0LlxuICAgICAgICAgICAgY29uc3QgYW5jaG9ySWQgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImFuY2hvclwiKTtcbiAgICAgICAgICAgIGlmIChhbmNob3JJZCAhPT0gbnVsbCkge1xuICAgICAgICAgICAgICBpZiAoIXN0YXRlLm5vZGVzLnNvbWUoKG4pID0+IG4uaWQgPT09IGFuY2hvcklkKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoSlNPTi5zdHJpbmdpZnkoeyBlcnJvcjogYHVua25vd24gYW5jaG9yIG5vZGU6ICR7YW5jaG9ySWR9YCB9KSwge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgc3RhdGUubm9kZXMgPSBzdGF0ZS5ub2Rlcy5maWx0ZXIoXG4gICAgICAgICAgICAgICAgKG4pID0+IG4uYW5jaG9yTm9kZUlkID09PSBhbmNob3JJZCB8fCBuLmlkID09PSBhbmNob3JJZCxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgY29uc3QgdmlzaWJsZSA9IG5ldyBTZXQoc3RhdGUubm9kZXMubWFwKChuKSA9PiBuLmlkKSk7XG4gICAgICAgICAgICAgIHN0YXRlLmVkZ2VzID0gc3RhdGUuZWRnZXMuZmlsdGVyKFxuICAgICAgICAgICAgICAgIChlKSA9PiB2aXNpYmxlLmhhcyhlLnNvdXJjZSkgJiYgdmlzaWJsZS5oYXMoZS50YXJnZXQpLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gUm91bmQgMTEgKFNFQU0gMik6IHRoZSBMSVZFIGFjdGl2aXR5IHJpZGVzIC9zdGF0ZSBiZXNpZGUgcHJlc2VuY2VcbiAgICAgICAgICAgIC8vIOKAlCBzYW1lIGRhZW1vbi1sZXZlbC1mYWN0IHJlYXNvbiwgYW5kIHdpdGhvdXQgaXQgYSBicm93c2VyIHJlbG9hZFxuICAgICAgICAgICAgLy8gbWlkLXRoaW5rIGxvc2VzIHRoZSBcIndvcmtpbmcgb24gdGhpc1wiIGJhZGdlIGVudGlyZWx5IChGMyB3YW50cyBpdFxuICAgICAgICAgICAgLy8gdW5taXNzYWJsZSwgYW5kIGEgc2lnbmFsIHRoYXQgb25seSBleGlzdHMgYXMgYW4gZXZlbnQgaXMgbWlzc2FibGVcbiAgICAgICAgICAgIC8vIGJ5IGV4YWN0bHkgb25lIHJlZnJlc2gpLiBudWxsID0gbm8gbGl2ZSBzaWduYWwuXG4gICAgICAgICAgICBjb25zdCBhY3Rpdml0eSA9IGVudHJ5LmFjdGl2aXR5U3RhdGVcbiAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICBzdGF0ZTogZW50cnkuYWN0aXZpdHlTdGF0ZSxcbiAgICAgICAgICAgICAgICAgIC4uLihlbnRyeS5hY3Rpdml0eU1lc3NhZ2VJZCA/IHsgbWVzc2FnZUlkOiBlbnRyeS5hY3Rpdml0eU1lc3NhZ2VJZCB9IDoge30pLFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oe1xuICAgICAgICAgICAgICAuLi5zdGF0ZSxcbiAgICAgICAgICAgICAgcHJlc2VuY2U6IHsgYWdlbnRzOiBlbnRyeS5hZ2VudHMgfSxcbiAgICAgICAgICAgICAgYWN0aXZpdHksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCAxMiAoU0VBTSAzKTogdGhlIGJvdW5kZWQsIHNlbGYtZGVjbGFyaW5nIGRlbHRhLiBBZGRpdGlvbnNcbiAgICAgICAgICAvLyBvbmx5LCBkZXJpdmVkIGZyb20gY3JlYXRlZF9hdCwgd2l0aCBub3RDb3ZlcmVkIG9uIGV2ZXJ5IHJlc3BvbnNlIOKAlFxuICAgICAgICAgIC8vIHNlZSBjaGFuZ2VzLnRzIGZvciB0aGUgcnVsaW5nIChvcHRpb24gQiwgYW4gYXBwZW5kLW9ubHkgY2hhbmdlc1xuICAgICAgICAgIC8vIHRhYmxlLCBJUyBDb250cmFjdCA4J3Mgbm8tZHVyYWJsZS1ldmVudC1sb2cgY2xhdXNlLCBub3Qgb3J0aG9nb25hbFxuICAgICAgICAgIC8vIHRvIGl0KS5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9jaGFuZ2VzXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIG1ldGEgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCByYXcgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcInNpbmNlXCIpO1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgaWYgKHJhdyA9PT0gbnVsbCkgdGhyb3cgbmV3IEVycm9yKFwibWlzc2luZyA/c2luY2U9PGVwb2NoU2Vjb25kcz5cIik7XG4gICAgICAgICAgICAgIC8vIFIxMiBnYXRlIGZpbmRpbmcgNTogZWNobyB3aGF0IHRoZSBjYWxsZXIgQUNUVUFMTFkgc2VudC4gTnVtYmVyKFwiYWJjXCIpXG4gICAgICAgICAgICAgIC8vIGlzIE5hTiBhbmQgSlNPTi5zdHJpbmdpZnkoTmFOKSBpcyBcIm51bGxcIiwgc28gcmVhZENoYW5nZXMnIG93biBndWFyZFxuICAgICAgICAgICAgICAvLyBjb3VsZCBvbmx5IGV2ZXIgcmVwb3J0IGBnb3Q6IG51bGxgIOKAlCB0aGUgb25lIHRoaW5nIHRoYXQgaXNuJ3QgdXNlZnVsLlxuICAgICAgICAgICAgICAvLyBUaGUgcmF3IHN0cmluZyBvbmx5IGV4aXN0cyBoZXJlLCBzbyB0aGUgZWNobyBoYXMgdG8gaGFwcGVuIGhlcmUuXG4gICAgICAgICAgICAgIGlmICghL15cXGQrJC8udGVzdChyYXcudHJpbSgpKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgIGBzaW5jZSBtdXN0IGJlIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIgaW4gZXBvY2ggU0VDT05EUyAodXNlIDAgZm9yIGV2ZXJ5dGhpbmcsIGAgK1xuICAgICAgICAgICAgICAgICAgICBgdGhlbiBwYXNzIGJhY2sgdGhlIFxcYG5vd1xcYCBmcm9tIGEgcHJldmlvdXMgcmVzcG9uc2UpLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkocmF3KX1gLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocmVhZENoYW5nZXMoZGIsIG1ldGEsIE51bWJlcihyYXcpLCBwcm9qZWN0RGlyKEhPTUUsIG1ldGEuaWQpKSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIHJldHVybiBiYWRSZXF1ZXN0KFxuICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgXCJHRVQgL2NoYW5nZXM/c2luY2U9PGVwb2NoU2Vjb25kcz4g4oCUIHVzZSAwIGZvciBldmVyeXRoaW5nLCB0aGVuIHBhc3MgYmFjayB0aGUgYG5vd2AgZnJvbSB0aGUgcHJldmlvdXMgcmVzcG9uc2VcIixcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocGF0aCA9PT0gXCIvem9uZXNcIiAmJiByZXEubWV0aG9kID09PSBcIkdFVFwiKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyB6b25lczogbGlzdFpvbmVzKGRiKSB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHBhdGggPT09IFwiL3pvbmVzXCIgJiYgcmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgbmFtZSB9ID0gYm9keSBhcyB7IG5hbWU/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJuYW1lIHJlcXVpcmVkXCIpO1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGNyZWF0ZVpvbmUoZGIsIGJ1cywgbmFtZSkpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuY2F0Y2goKGUpID0+IGJhZFJlcXVlc3QoZSwgJ3tcIm5hbWVcIjogXCI8em9uZSBuYW1lPlwifScpKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiREVMRVRFXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL3pvbmVzL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgaWQgPSBwYXRoLnNsaWNlKFwiL3pvbmVzL1wiLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCB5ZXMgPSB1cmwuc2VhcmNoUGFyYW1zLmhhcyhcInllc1wiKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGRlbGV0ZVpvbmUoZGIsIGJ1cywgaWQsIHllcyk7XG4gICAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcInVua25vd24gem9uZVwifScsIHtcbiAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUsIGlkIH0pO1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBpZiAoZSBpbnN0YW5jZW9mIFpvbmVOb3RFbXB0eUVycm9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcbiAgICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IFwiem9uZS1ub3QtZW1wdHlcIiwgcHJvcG9zYWxzOiBlLnByb3Bvc2FscyB9KSxcbiAgICAgICAgICAgICAgICAgIHsgc3RhdHVzOiA0MDksIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSB9LFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIGJhZFJlcXVlc3QoXG4gICAgICAgICAgICAgICAgZSxcbiAgICAgICAgICAgICAgICBcIkRFTEVURSAvem9uZXMvPGlkPls/eWVzPTFdIOKAlCBhIHBvcHVsYXRlZCB6b25lIG5lZWRzID95ZXM9MSAoZGVsZXRlIGNhc2NhZGVzIGl0cyBwcm9wb3NhbHMpXCIsXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUm91bmQgNCAoQTEpOiBQVVQgcmVwbGFjZXMgYSB0YXJnZXQncyBhY3Rpb24gc2xvdHMgd2hvbGVzYWxlXG4gICAgICAgICAgLy8gKGVtcHR5IGFycmF5IGNsZWFycyksIERFTEVURSBjbGVhcnMg4oCUIHRhcmdldCBpcyBhIG5vZGUgb3IgYVxuICAgICAgICAgIC8vIFBFTkRJTkcgcHJvcG9zYWwsIGFueXRoaW5nIGVsc2UgNDA0czsgc2hhcGUvYnl0ZS1jYXAgZmFpbCA0MDAuXG4gICAgICAgICAgaWYgKChyZXEubWV0aG9kID09PSBcIlBVVFwiIHx8IHJlcS5tZXRob2QgPT09IFwiREVMRVRFXCIpICYmIHBhdGguc3RhcnRzV2l0aChcIi9hY3Rpb25zL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgdGFyZ2V0SWQgPSBwYXRoLnNsaWNlKFwiL2FjdGlvbnMvXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZSA9XG4gICAgICAgICAgICAgIHJlcS5tZXRob2QgPT09IFwiREVMRVRFXCJcbiAgICAgICAgICAgICAgICA/IFByb21pc2UucmVzb2x2ZShjbGVhckFjdGlvbnMoZGIsIGJ1cywgdGFyZ2V0SWQpKVxuICAgICAgICAgICAgICAgIDogcmVxLmpzb24oKS50aGVuKChib2R5KSA9PiBzZXRBY3Rpb25zKGRiLCBidXMsIHRhcmdldElkLCBib2R5KSk7XG4gICAgICAgICAgICByZXR1cm4gaGFuZGxlXG4gICAgICAgICAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcInVua25vd24gdGFyZ2V0IChub2RlIG9yIHBlbmRpbmcgcHJvcG9zYWwpXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHJlc3VsdCk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT5cbiAgICAgICAgICAgICAgICBiYWRSZXF1ZXN0KFxuICAgICAgICAgICAgICAgICAgZSxcbiAgICAgICAgICAgICAgICAgICd7XCJhY3Rpb25zXCI6IFsuLi5dfSBpcyBXUk9ORyDigJQgUFVUIHRoZSBCQVJFIEpTT04gYXJyYXk6IFt7XCJpZFwiLFwibGFiZWxcIixcInNlZWRcIn1dIChlbXB0eSBhcnJheSBjbGVhcnMpJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFJvdW5kIDcgKFRBR1MpOiBQVVQgcmVwbGFjZXMgYSB0YXJnZXQncyB0YWdzIHdob2xlc2FsZSAoZW1wdHkgYXJyYXlcbiAgICAgICAgICAvLyBjbGVhcnMpLCBERUxFVEUgY2xlYXJzIOKAlCB0YXJnZXQgaXMgYSBub2RlIG9yIGEgUEVORElORyBwcm9wb3NhbCxcbiAgICAgICAgICAvLyBhbnl0aGluZyBlbHNlIDQwNHM7IHNoYXBlL2J5dGUtY2FwIGZhaWwgNDAwLiBUd2luIG9mIC9hY3Rpb25zLy5cbiAgICAgICAgICBpZiAoKHJlcS5tZXRob2QgPT09IFwiUFVUXCIgfHwgcmVxLm1ldGhvZCA9PT0gXCJERUxFVEVcIikgJiYgcGF0aC5zdGFydHNXaXRoKFwiL3RhZ3MvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCB0YXJnZXRJZCA9IHBhdGguc2xpY2UoXCIvdGFncy9cIi5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgaGFuZGxlID1cbiAgICAgICAgICAgICAgcmVxLm1ldGhvZCA9PT0gXCJERUxFVEVcIlxuICAgICAgICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKGNsZWFyVGFncyhkYiwgYnVzLCB0YXJnZXRJZCkpXG4gICAgICAgICAgICAgICAgOiByZXEuanNvbigpLnRoZW4oKGJvZHkpID0+IHNldFRhZ3MoZGIsIGJ1cywgdGFyZ2V0SWQsIGJvZHkpKTtcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVcbiAgICAgICAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biB0YXJnZXQgKG5vZGUgb3IgcGVuZGluZyBwcm9wb3NhbClcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocmVzdWx0KTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PlxuICAgICAgICAgICAgICAgIGJhZFJlcXVlc3QoXG4gICAgICAgICAgICAgICAgICBlLFxuICAgICAgICAgICAgICAgICAgJ3tcInRhZ3NcIjogWy4uLl19IGlzIFdST05HIOKAlCBQVVQgdGhlIEJBUkUgSlNPTiBhcnJheSBvZiBzdHJpbmdzOiBbXCJ0YWdcIiwgLi4uXSAoZW1wdHkgYXJyYXkgY2xlYXJzKScsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCA5IChKb2IgUXVldWUpIOKAlCAvam9icyogcm91dGVzLiBPcmRlciBtYXR0ZXJzOiB0aGUgZXhhY3RcbiAgICAgICAgICAvLyAvam9icyByb3V0ZXMgYW5kIHRoZSAvam9icy86aWQvPHN1Yj4gcm91dGVzIGFyZSBjaGVja2VkIEJFRk9SRSB0aGVcbiAgICAgICAgICAvLyBiYXJlIFBPU1QgL2pvYnMvOmlkIHVwZGF0ZSAodGhlIC9wcm9wb3NhbHMvOmlkL3pvbmUtYmVmb3JlLURFTEVURVxuICAgICAgICAgIC8vIHByZWNlZGVudCkuIEV2ZXJ5IGhhbmRsZXIgaXMgbG9hZFByb2plY3Qg4oaSIG11dGF0b3Ig4oaSIHs0MDQgb24gbnVsbCxcbiAgICAgICAgICAvLyA0MDAgb24gdGhyb3csIDQwOSBvbiBhIHR5cGVkIGNsYWltIGNvbmZsaWN0fS5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9qb2JzXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGpvYnM6IHJlYWRKb2JzKGRiKSB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL2pvYnNcIikge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzLCBtZXRhIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAgIC50aGVuKChib2R5KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyB0aXRsZSwgc3RhdHVzLCBkZWxpdmVyYWJsZSwgZGV0YWlsIH0gPSBib2R5IGFzIHtcbiAgICAgICAgICAgICAgICAgIHRpdGxlPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIHN0YXR1cz86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBkZWxpdmVyYWJsZT86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBkZXRhaWw/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgY29uc3Qgam9iID0gY3JlYXRlSm9iKGRiLCBidXMsIHtcbiAgICAgICAgICAgICAgICAgIHByb2plY3Q6IG1ldGEuaWQsXG4gICAgICAgICAgICAgICAgICB0aXRsZTogdGl0bGUgYXMgc3RyaW5nLFxuICAgICAgICAgICAgICAgICAgc3RhdHVzOiB0eXBlb2Ygc3RhdHVzID09PSBcInN0cmluZ1wiID8gc3RhdHVzIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgZGVsaXZlcmFibGU6IHR5cGVvZiBkZWxpdmVyYWJsZSA9PT0gXCJzdHJpbmdcIiA/IGRlbGl2ZXJhYmxlIDogbnVsbCxcbiAgICAgICAgICAgICAgICAgIGRldGFpbDogdHlwZW9mIGRldGFpbCA9PT0gXCJzdHJpbmdcIiA/IGRldGFpbCA6IG51bGwsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oam9iKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PlxuICAgICAgICAgICAgICAgIGJhZFJlcXVlc3QoZSwgJ3tcInRpdGxlXCI6IHN0cmluZywgXCJzdGF0dXNcIj8sIFwiZGVsaXZlcmFibGVcIj8sIFwiZGV0YWlsXCI/fScpLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2pvYnMvXCIpICYmIHBhdGguZW5kc1dpdGgoXCIvY2xhaW1cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gcGF0aC5zbGljZShcIi9qb2JzL1wiLmxlbmd0aCwgLVwiL2NsYWltXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgb3duZXIgfSA9IGJvZHkgYXMgeyBvd25lcj86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICBjb25zdCBqb2IgPSBjbGFpbUpvYihkYiwgYnVzLCBpZCwgb3duZXIgYXMgc3RyaW5nKTtcbiAgICAgICAgICAgICAgICBpZiAoIWpvYikge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcInVua25vd24gam9iXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGpvYik7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlIGluc3RhbmNlb2YgQ2xhaW1Db25mbGljdEVycm9yKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKFxuICAgICAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcImNsYWltZWRcIiwgY2xhaW1lZEJ5OiBlLmNsYWltZWRCeSB9KSxcbiAgICAgICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwOSwgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0sXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gYmFkUmVxdWVzdChlLCAne1wib3duZXJcIjogc3RyaW5nfScpO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9qb2JzL1wiKSAmJiBwYXRoLmVuZHNXaXRoKFwiL3JlbGVhc2VcIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gcGF0aC5zbGljZShcIi9qb2JzL1wiLmxlbmd0aCwgLVwiL3JlbGVhc2VcIi5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3Qgam9iID0gcmVsZWFzZUpvYihkYiwgYnVzLCBpZCk7XG4gICAgICAgICAgICBpZiAoIWpvYikge1xuICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBqb2JcIn0nLCB7XG4gICAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGpvYik7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvam9icy9cIikgJiYgcGF0aC5lbmRzV2l0aChcIi9zdWJ0YXNrXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvam9icy9cIi5sZW5ndGgsIC1cIi9zdWJ0YXNrXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgb3AsIGxhYmVsLCBzdWJ0YXNrSWQgfSA9IGJvZHkgYXMge1xuICAgICAgICAgICAgICAgICAgb3A/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgbGFiZWw/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgc3VidGFza0lkPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGxldCBqb2IgPSBudWxsO1xuICAgICAgICAgICAgICAgIGlmIChvcCA9PT0gXCJhZGRcIikge1xuICAgICAgICAgICAgICAgICAgam9iID0gYWRkU3VidGFzayhkYiwgYnVzLCBpZCwgbGFiZWwgYXMgc3RyaW5nKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKG9wID09PSBcImNoZWNrXCIgfHwgb3AgPT09IFwidW5jaGVja1wiKSB7XG4gICAgICAgICAgICAgICAgICBqb2IgPSBzZXRTdWJ0YXNrRG9uZShkYiwgYnVzLCBpZCwgc3VidGFza0lkIGFzIHN0cmluZywgb3AgPT09IFwiY2hlY2tcIik7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIm9wIG11c3QgYmUgYWRkfGNoZWNrfHVuY2hlY2tcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICgham9iKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBqb2JcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oam9iKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PlxuICAgICAgICAgICAgICAgIGJhZFJlcXVlc3QoXG4gICAgICAgICAgICAgICAgICBlLFxuICAgICAgICAgICAgICAgICAgJ3tcIm9wXCI6XCJhZGRcIixcImxhYmVsXCI6c3RyaW5nfSB8IHtcIm9wXCI6XCJjaGVja1wifFwidW5jaGVja1wiLFwic3VidGFza0lkXCI6c3RyaW5nfScsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiREVMRVRFXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2pvYnMvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvam9icy9cIi5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gZGVsZXRlSm9iKGRiLCBidXMsIGlkKTtcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJ1bmtub3duIGpvYlwifScsIHtcbiAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgaWQgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEJhcmUgdXBkYXRlIOKAlCBNVVNUIGNvbWUgYWZ0ZXIgdGhlIC9qb2JzLzppZC88c3ViPiByb3V0ZXMgYWJvdmUuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9qb2JzL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgaWQgPSBwYXRoLnNsaWNlKFwiL2pvYnMvXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgdGl0bGUsIHN0YXR1cywgZGVsaXZlcmFibGUsIGRldGFpbCB9ID0gYm9keSBhcyB7XG4gICAgICAgICAgICAgICAgICB0aXRsZT86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBzdGF0dXM/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgZGVsaXZlcmFibGU/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgZGV0YWlsPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGNvbnN0IHBhdGNoOiB7XG4gICAgICAgICAgICAgICAgICB0aXRsZT86IHN0cmluZztcbiAgICAgICAgICAgICAgICAgIHN0YXR1cz86IHN0cmluZztcbiAgICAgICAgICAgICAgICAgIGRlbGl2ZXJhYmxlPzogc3RyaW5nIHwgbnVsbDtcbiAgICAgICAgICAgICAgICAgIGRldGFpbD86IHN0cmluZyB8IG51bGw7XG4gICAgICAgICAgICAgICAgfSA9IHt9O1xuICAgICAgICAgICAgICAgIGlmICh0aXRsZSAhPT0gdW5kZWZpbmVkKSBwYXRjaC50aXRsZSA9IHRpdGxlIGFzIHN0cmluZztcbiAgICAgICAgICAgICAgICBpZiAoc3RhdHVzICE9PSB1bmRlZmluZWQpIHBhdGNoLnN0YXR1cyA9IHN0YXR1cyBhcyBzdHJpbmc7XG4gICAgICAgICAgICAgICAgaWYgKGRlbGl2ZXJhYmxlICE9PSB1bmRlZmluZWQpIHBhdGNoLmRlbGl2ZXJhYmxlID0gZGVsaXZlcmFibGUgYXMgc3RyaW5nIHwgbnVsbDtcbiAgICAgICAgICAgICAgICBpZiAoZGV0YWlsICE9PSB1bmRlZmluZWQpIHBhdGNoLmRldGFpbCA9IGRldGFpbCBhcyBzdHJpbmcgfCBudWxsO1xuICAgICAgICAgICAgICAgIGNvbnN0IGpvYiA9IHVwZGF0ZUpvYihkYiwgYnVzLCBpZCwgcGF0Y2gpO1xuICAgICAgICAgICAgICAgIGlmICgham9iKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBqb2JcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oam9iKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PlxuICAgICAgICAgICAgICAgIGJhZFJlcXVlc3QoZSwgJ3tcInRpdGxlXCI/LCBcInN0YXR1c1wiPywgXCJkZWxpdmVyYWJsZVwiPywgXCJkZXRhaWxcIj99IChhdCBsZWFzdCBvbmUpJyksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL2FjdGl2aXR5XCIpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgc3RhdGUsIG1lc3NhZ2VJZCB9ID0gYm9keSBhcyB7IHN0YXRlPzogdW5rbm93bjsgbWVzc2FnZUlkPzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgIC8vIEFDVDE6IGBzdGFsbGVkYCBpcyBkYWVtb24tc3ludGhlc2l6ZWQgdm9jYWJ1bGFyeSBPTkxZIOKAlFxuICAgICAgICAgICAgICAgIC8vIHJlamVjdGluZyBpdCBoZXJlIGlzIHRoZSBlcG9jaC5jaGFuZ2VkIGFzeW1tZXRyeSBhZ2FpbiAoYVxuICAgICAgICAgICAgICAgIC8vIGNsaWVudCBtYXkgaGVhciBpdCwgbmV2ZXIgc2F5IGl0KS5cbiAgICAgICAgICAgICAgICBpZiAoc3RhdGUgPT09IFwic3RhbGxlZFwiKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgIFwic3RhbGxlZCBpcyBkYWVtb24tc3ludGhlc2l6ZWQgb25seSDigJQgcG9zdCByZWNlaXZlZHx0aGlua2luZ3xpZGxlXCIsXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoc3RhdGUgIT09IFwicmVjZWl2ZWRcIiAmJiBzdGF0ZSAhPT0gXCJ0aGlua2luZ1wiICYmIHN0YXRlICE9PSBcImlkbGVcIikge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwic3RhdGUgbXVzdCBiZSByZWNlaXZlZHx0aGlua2luZ3xpZGxlXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyBSb3VuZCAxMSAoU0VBTSAyKTogYW4gZXhwbGljaXQgcG9zdCBNQVkgbmFtZSB0aGUgbWVzc2FnZSBpdCdzXG4gICAgICAgICAgICAgICAgLy8gYWJvdXQgKHdvcmtpbmcgYW4gb2xkZXIgb25lLCBvciByZS1vcGVuaW5nIGEgbGFkZGVyKS4gSXQgbXVzdFxuICAgICAgICAgICAgICAgIC8vIEVYSVNUIOKAlCB0aGUgaW50YWtlLWd1YXJkIHJlZmxleDogYSBtaXN0eXBlZCBpZCB3b3VsZCBvdGhlcndpc2VcbiAgICAgICAgICAgICAgICAvLyBiZSBhIHNpbGVudCBzdXJmYWNlIG5vLW9wICh0aGUgYmFkZ2Ugc2ltcGx5IG5ldmVyIGFwcGVhcnMpLFxuICAgICAgICAgICAgICAgIC8vIHRocmVlIHN0ZXBzIGZyb20gdGhlIG1pc3Rha2UuXG4gICAgICAgICAgICAgICAgbGV0IHRpZTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgICAgICAgICAgIGlmIChtZXNzYWdlSWQgIT09IHVuZGVmaW5lZCAmJiBtZXNzYWdlSWQgIT09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgbWVzc2FnZUlkICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIm1lc3NhZ2VJZCBtdXN0IGJlIGEgbWVzc2FnZSBpZCBzdHJpbmdcIik7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICBjb25zdCBrbm93biA9IGVudHJ5LmRiXG4gICAgICAgICAgICAgICAgICAgIC5xdWVyeShcIlNFTEVDVCBpZCBGUk9NIG1lc3NhZ2VzIFdIRVJFIGlkID0gPyBBTkQgcHJvamVjdF9pZCA9ID9cIilcbiAgICAgICAgICAgICAgICAgICAgLmdldChtZXNzYWdlSWQsIGVudHJ5Lm1ldGEuaWQpO1xuICAgICAgICAgICAgICAgICAgaWYgKCFrbm93bikgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIG1lc3NhZ2VJZDogJHttZXNzYWdlSWR9YCk7XG4gICAgICAgICAgICAgICAgICB0aWUgPSBtZXNzYWdlSWQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHBvc3RBY3Rpdml0eShlbnRyeSwgc3RhdGUsIFwiZXhwbGljaXRcIiwgdGllKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgIHN0YXRlLFxuICAgICAgICAgICAgICAgICAgLi4uKGVudHJ5LmFjdGl2aXR5TWVzc2FnZUlkID8geyBtZXNzYWdlSWQ6IGVudHJ5LmFjdGl2aXR5TWVzc2FnZUlkIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT5cbiAgICAgICAgICAgICAgICBiYWRSZXF1ZXN0KFxuICAgICAgICAgICAgICAgICAgZSxcbiAgICAgICAgICAgICAgICAgICd7XCJzdGF0ZVwiOlwicmVjZWl2ZWRcInxcInRoaW5raW5nXCJ8XCJpZGxlXCIsIFwibWVzc2FnZUlkXCI/OiBcIjxtZXNzYWdlIGlkPlwifScsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aCA9PT0gXCIvcHJvamVjdHNcIikge1xuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBwcm9qZWN0czogbGlzdFByb2plY3RzKEhPTUUpIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvcHJvamVjdHNcIikge1xuICAgICAgICAgICAgLy8gUjEyIGdhdGUgZmluZGluZyAzOiB0aGlzIHJvdXRlIGJ5cGFzc2VkIHRoZSBTRUFNIDcgZnVubmVsIG9uIEJPVEhcbiAgICAgICAgICAgIC8vIHBhdGhzIChpdHMgdmFsaWRhdG9yIGFuZCBpdHMgSlNPTi1wYXJzZSBjYXRjaCksIHNvIGEgY2FsbGVyIHdob1xuICAgICAgICAgICAgLy8gc2VudCB7dGl0bGV9IOKAlCB0aGUgc2hhcGUgY2lyY2UgYWN0dWFsbHkgcmVhY2hlZCBmb3Ig4oCUIGdvdCBhIGJhcmVcbiAgICAgICAgICAgIC8vIGVycm9yIHdpdGggbm8gYGV4cGVjdGVkYC4gQSBmdW5uZWwgb25seSBidXlzIGEgd2lyZS13aWRlIGd1YXJhbnRlZVxuICAgICAgICAgICAgLy8gaWYgZXZlcnkgcm91dGUgaXMgYWN0dWFsbHkgaW4gaXQuXG4gICAgICAgICAgICBjb25zdCBwcm9qZWN0c0V4cGVjdGVkID1cbiAgICAgICAgICAgICAgJ3tcImlkXCI6IFwiPHNsdWc+XCIsIFwidGl0bGVcIjogXCI8VGl0bGU+XCJ9IOKAlCBCT1RIIHJlcXVpcmVkOyB0aGUgaWQgaXMgdGhlICcgK1xuICAgICAgICAgICAgICBcInNsdWcgdXNlZCBieSA/cHJvamVjdD0gYW5kIGlzIE5PVCBkZXJpdmVkIGZyb20gdGhlIHRpdGxlXCI7XG4gICAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgICAgLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IGlkLCB0aXRsZSB9ID0gYm9keSBhcyB7IGlkPzogdW5rbm93bjsgdGl0bGU/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBpZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdGl0bGUgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBiYWRSZXF1ZXN0KG5ldyBFcnJvcihcImlkIGFuZCB0aXRsZSByZXF1aXJlZFwiKSwgcHJvamVjdHNFeHBlY3RlZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IG1ldGEgPSBjcmVhdGVQcm9qZWN0KEhPTUUsIGlkLCB0aXRsZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24obWV0YSk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT4gYmFkUmVxdWVzdChlLCBwcm9qZWN0c0V4cGVjdGVkKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9pbmdlc3RcIikge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzLCBtZXRhIH0gPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgZG9jc0RpciA9IGpvaW4ocHJvamVjdERpcihIT01FLCBtZXRhLmlkKSwgXCJkb2NzXCIpO1xuICAgICAgICAgICAgY29uc3QgY29udGVudFR5cGUgPSByZXEuaGVhZGVycy5nZXQoXCJjb250ZW50LXR5cGVcIikgPz8gXCJcIjtcbiAgICAgICAgICAgIGNvbnN0IGhhbmRsZSA9IGNvbnRlbnRUeXBlLmluY2x1ZGVzKFwibXVsdGlwYXJ0L2Zvcm0tZGF0YVwiKVxuICAgICAgICAgICAgICA/IHJlcS5mb3JtRGF0YSgpLnRoZW4oYXN5bmMgKGZvcm0pID0+IHtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGZpbGUgPSBmb3JtLmdldChcImZpbGVcIik7XG4gICAgICAgICAgICAgICAgICBpZiAoIShmaWxlIGluc3RhbmNlb2YgRmlsZSkpIHRocm93IG5ldyBFcnJvcihcIm11bHRpcGFydCBib2R5IG1pc3NpbmcgJ2ZpbGUnXCIpO1xuICAgICAgICAgICAgICAgICAgY29uc3QgdGl0bGUgPSAoZm9ybS5nZXQoXCJ0aXRsZVwiKSBhcyBzdHJpbmcgfCBudWxsKSA/PyBmaWxlLm5hbWU7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gaW5nZXN0RmlsZShkYiwgYnVzLCBkb2NzRGlyLCB0aXRsZSwgYXdhaXQgZmlsZS50ZXh0KCkpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIDogcmVxLmpzb24oKS50aGVuKChib2R5KSA9PiB7XG4gICAgICAgICAgICAgICAgICBjb25zdCB7IHRpdGxlLCB0ZXh0IH0gPSBib2R5IGFzIHsgdGl0bGU/OiB1bmtub3duOyB0ZXh0PzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB0aXRsZSAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdGV4dCAhPT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ0aXRsZSBhbmQgdGV4dCByZXF1aXJlZFwiKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIHJldHVybiBpbmdlc3RUZXh0KGRiLCBidXMsIGRvY3NEaXIsIHRpdGxlLCB0ZXh0KTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBoYW5kbGVcbiAgICAgICAgICAgICAgLnRoZW4oKGRvYykgPT4gUmVzcG9uc2UuanNvbihkb2MpKVxuICAgICAgICAgICAgICAuY2F0Y2goKGUpID0+XG4gICAgICAgICAgICAgICAgYmFkUmVxdWVzdChcbiAgICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgICAne1widGl0bGVcIjogc3RyaW5nLCBcInRleHRcIjogc3RyaW5nLCBcImtpbmRcIj86IHN0cmluZ30gKHRoZSBib2R5IGtleSBpcyBgdGV4dGAsIG5vdCBgY29udGVudGApJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFJvdW5kIDUgKENMSTEpOiBiYXRjaCBwcm9wb3NlIOKAlCBtaW50IG5vZGVzLCByZXNvbHZlIGVkZ2UgZW5kcG9pbnRzXG4gICAgICAgICAgLy8gYWdhaW5zdCB0aGUganVzdC1taW50ZWQgaWRzIChsb2NhbCByZWZzKSwgaW5zZXJ0IGluIE9ORVxuICAgICAgICAgIC8vIHRyYW5zYWN0aW9uLCBlbWl0IHBlci1wcm9wb3NhbCBBRlRFUiBjb21taXQuIEtpbGxzIHRoZVxuICAgICAgICAgIC8vIE4tc3VicHJvY2VzcyBjYXN0aW5nIHNjcmlwdCAoZmluZGluZyAjMTApLiBDaGVja2VkIGJlZm9yZSB0aGVcbiAgICAgICAgICAvLyBleGFjdC1tYXRjaCAvcHJvcG9zYWxzIHJvdXRlIGJlbG93IChkaXNqb2ludCBwYXRoIGFueXdheSkuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL3Byb3Bvc2Fscy9iYXRjaFwiKSB7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGVudHJ5O1xuICAgICAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAgIC50aGVuKChib2R5KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyBub2RlcywgZWRnZXMsIGJhdGNoSWQgfSA9IGJvZHkgYXMge1xuICAgICAgICAgICAgICAgICAgbm9kZXM/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgZWRnZXM/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgYmF0Y2hJZD86IHVua25vd247XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBiYXRjaFByb3Bvc2UoZGIsIGJ1cywge1xuICAgICAgICAgICAgICAgICAgbm9kZXM6IEFycmF5LmlzQXJyYXkobm9kZXMpID8gKG5vZGVzIGFzIEJhdGNoSW5wdXRbXCJub2Rlc1wiXSkgOiBbXSxcbiAgICAgICAgICAgICAgICAgIGVkZ2VzOiBBcnJheS5pc0FycmF5KGVkZ2VzKSA/IChlZGdlcyBhcyBCYXRjaElucHV0W1wiZWRnZXNcIl0pIDogW10sXG4gICAgICAgICAgICAgICAgICAvLyBTRUFNIDE6IG9taXR0ZWQg4oaSIHRoZSBkYWVtb24gbWludHMgb25lIGFuZCByZXR1cm5zIGl0IGFzXG4gICAgICAgICAgICAgICAgICAvLyBgYmF0Y2hJZGA7IHN1cHBsaWVkIOKGkiB0aGlzIGNhbGwgSk9JTlMgdGhhdCBhY3QuXG4gICAgICAgICAgICAgICAgICBiYXRjaElkOiBiYXRjaElkIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAvLyBBIGJhdGNoIGlzIHRoZSBjYXN0aW5nIGFnZW50J3MgYnVsayB3cml0ZSDigJQgYW4gYWdlbnQtYXV0aG9yZWRcbiAgICAgICAgICAgICAgICAvLyBwcm9wb3NhbCBpbiBpdCBpcyBldmlkZW5jZSBvZiBhY3Rpdml0eSAocmVzb2x2ZXMgYXV0byBzdGF0ZXMsXG4gICAgICAgICAgICAgICAgLy8gc2FtZSBhcyBhIHNpbmdsZSBhZ2VudCBwcm9wb3NlKS4gQSB3aG9sbHkgdXNlci1za2V0Y2hlZCBiYXRjaFxuICAgICAgICAgICAgICAgIC8vIGlzIG5vdCB0aGUgYWdlbnQncy5cbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0LnByb3Bvc2Fscy5zb21lKChwKSA9PiBwLmF1dGhvciA9PT0gXCJhZ2VudFwiKSkgcmVzb2x2ZUFjdGl2aXR5KGVudHJ5KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihyZXN1bHQpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuY2F0Y2goKGUpID0+XG4gICAgICAgICAgICAgICAgYmFkUmVxdWVzdChcbiAgICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgICAne1wibm9kZXNcIjpbe1wicmVmXCIsXCJkcmFmdFwiLFwiZXZpZGVuY2VcIj8sXCJ0YWdzXCI/fV0sIFwiZWRnZXNcIjpbe1wiZHJhZnRcIjp7XCJzb3VyY2VcIixcInRhcmdldFwiLFwibGFiZWxcIj99fV0sIFwiYmF0Y2hJZFwiP30g4oCUIGFuIGVkZ2UgZW5kcG9pbnQgbWF5IGJlIGEgbG9jYWwgcmVmLCBhIG5vZGUvcHJvcG9zYWwgaWQsIG9yIFwidGl0bGU6PGV4YWN0IG5vZGUgdGl0bGU+XCInLFxuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUm91bmQgNiAoUkIpOiByYXRpZnkgYSBub2RlK2VkZ2Ugc2V0IGluIE9ORSBjYWxsL3R4biwgcmV0dXJuaW5nIHRoZVxuICAgICAgICAgIC8vIG9sZOKGkm5ldyBpZCBtYXAuIEF1dG8tcGFydGl0aW9ucyBub2Rlcy1iZWZvcmUtZWRnZXM7IE5PIGF1dG8taW5jbHVkZVxuICAgICAgICAgIC8vIG9mIHVubGlzdGVkIGVkZ2VzOyBvbmUgdG9wLWxldmVsIHJ1bGluZzsgYW5jaG9yc1tdIHJhdGlmeS10aGVuLW5lc3QuXG4gICAgICAgICAgLy8gQ2hlY2tlZCBiZWZvcmUgdGhlIC9wcm9wb3NhbHMvOmlkL3J1bGluZyByb3V0ZSAoZGlzam9pbnQgcGF0aCkuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL3Byb3Bvc2Fscy9yYXRpZnktYmF0Y2hcIikge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzLCBtZXRhIH0gPSBlbnRyeTtcbiAgICAgICAgICAgIGNvbnN0IGRvY3NEaXIgPSBqb2luKHByb2plY3REaXIoSE9NRSwgbWV0YS5pZCksIFwiZG9jc1wiKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgcnVsaW5nLCBpZHMsIGFuY2hvcnMgfSA9IGJvZHkgYXMge1xuICAgICAgICAgICAgICAgICAgcnVsaW5nPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIGlkcz86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBhbmNob3JzPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgIHJ1bGluZyAhPT0gXCJjYW5vblwiICYmXG4gICAgICAgICAgICAgICAgICBydWxpbmcgIT09IFwidGhyZWFkXCIgJiZcbiAgICAgICAgICAgICAgICAgIHJ1bGluZyAhPT0gXCJzdG9yeS1sb2NhbFwiICYmXG4gICAgICAgICAgICAgICAgICBydWxpbmcgIT09IFwicmVqZWN0XCJcbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInJ1bGluZyBtdXN0IGJlIGNhbm9ufHRocmVhZHxzdG9yeS1sb2NhbHxyZWplY3RcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheShpZHMpKSB0aHJvdyBuZXcgRXJyb3IoXCJyYXRpZnktYmF0Y2ggcmVxdWlyZXMgaWRzOiBbcHJvcG9zYWxJZF1cIik7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gcmF0aWZ5QmF0Y2goZGIsIGJ1cywgZG9jc0Rpciwge1xuICAgICAgICAgICAgICAgICAgcnVsaW5nLFxuICAgICAgICAgICAgICAgICAgaWRzOiBpZHMgYXMgc3RyaW5nW10sXG4gICAgICAgICAgICAgICAgICBhbmNob3JzOiBBcnJheS5pc0FycmF5KGFuY2hvcnMpXG4gICAgICAgICAgICAgICAgICAgID8gKGFuY2hvcnMgYXMgQXJyYXk8eyBub2RlOiBzdHJpbmc7IHBhcmVudDogc3RyaW5nIH0+KVxuICAgICAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAvLyBBIGJhdGNoIHJhdGlmeSBpcyBhbiBhZ2VudCB3cml0ZSAobm8gYXV0aG9yc2hpcCBvbiB0aGUgd2lyZSlcbiAgICAgICAgICAgICAgICAvLyDigJQgaXQgcmVzb2x2ZXMgYXV0byBhY3Rpdml0eSBzdGF0ZXMsIHNhbWUgYXMgc2luZ2xlIHJhdGlmeS5cbiAgICAgICAgICAgICAgICByZXNvbHZlQWN0aXZpdHkoZW50cnkpO1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHJlc3VsdCk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChlIGluc3RhbmNlb2YgWm9uZWRFcnJvcikge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcInpvbmVkXCIsIHpvbmVJZDogZS56b25lSWQgfSksIHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDksXG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gYmFkUmVxdWVzdChcbiAgICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgICAne1wicnVsaW5nXCI6XCJjYW5vblwifFwidGhyZWFkXCJ8XCJzdG9yeS1sb2NhbFwiLCBcImlkc1wiOltcIjxwcm9wb3NhbElkPlwiXSwgXCJhbmNob3JzXCI/Olt7XCJub2RlXCIsXCJwYXJlbnRcIn1dfSDigJQgcmVqZWN0IGlzIE5PVCBhIGJhdGNoIGFjdCcsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGggPT09IFwiL3Byb3Bvc2Fsc1wiKSB7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGVudHJ5O1xuICAgICAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAgIC50aGVuKChib2R5KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyBraW5kLCBkcmFmdCwgZXZpZGVuY2UsIHN1Z2dlc3RlZFRpZXIsIGF1dGhvciwgem9uZSwgdGFncywgYmF0Y2hJZCB9ID1cbiAgICAgICAgICAgICAgICAgIGJvZHkgYXMge1xuICAgICAgICAgICAgICAgICAgICBraW5kPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgICAgZHJhZnQ/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgICBldmlkZW5jZT86IHVua25vd247XG4gICAgICAgICAgICAgICAgICAgIHN1Z2dlc3RlZFRpZXI/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgICBhdXRob3I/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgICB6b25lPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgICAgdGFncz86IHVua25vd247XG4gICAgICAgICAgICAgICAgICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBpZiAoa2luZCAhPT0gXCJub2RlXCIgJiYga2luZCAhPT0gXCJlZGdlXCIpXG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJraW5kIG11c3QgYmUgbm9kZSBvciBlZGdlXCIpO1xuICAgICAgICAgICAgICAgIGlmIChhdXRob3IgIT09IHVuZGVmaW5lZCAmJiBhdXRob3IgIT09IFwidXNlclwiICYmIGF1dGhvciAhPT0gXCJhZ2VudFwiKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhdXRob3IgbXVzdCBiZSB1c2VyIG9yIGFnZW50XCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBpbnB1dCA9IHtcbiAgICAgICAgICAgICAgICAgIGRyYWZ0LFxuICAgICAgICAgICAgICAgICAgZXZpZGVuY2U6XG4gICAgICAgICAgICAgICAgICAgIChldmlkZW5jZSBhc1xuICAgICAgICAgICAgICAgICAgICAgIHwgeyBkb2NJZD86IHN0cmluZzsgbWVzc2FnZUlkPzogc3RyaW5nOyBzcGFuPzogc3RyaW5nIH1cbiAgICAgICAgICAgICAgICAgICAgICB8IHVuZGVmaW5lZCkgPz8ge30sXG4gICAgICAgICAgICAgICAgICBzdWdnZXN0ZWRUaWVyOiB0eXBlb2Ygc3VnZ2VzdGVkVGllciA9PT0gXCJzdHJpbmdcIiA/IHN1Z2dlc3RlZFRpZXIgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICBhdXRob3I6IGF1dGhvciBhcyBcInVzZXJcIiB8IFwiYWdlbnRcIiB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgIHpvbmU6IHR5cGVvZiB6b25lID09PSBcInN0cmluZ1wiID8gem9uZSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgIC8vIFRBR1M6IHByb3Bvc2UtdGltZSB0YWdzIHJpZGUgdGhyb3VnaDsgYnVpbGRQcm9wb3NhbCdzIHBhcnNlXG4gICAgICAgICAgICAgICAgICAvLyBndWFyZCB2YWxpZGF0ZXMgdGhlIHNoYXBlICg0MDAgb24gYSBub24tc3RyaW5nW10pLlxuICAgICAgICAgICAgICAgICAgdGFnczogQXJyYXkuaXNBcnJheSh0YWdzKSA/ICh0YWdzIGFzIHN0cmluZ1tdKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICAgIC8vIFNFQU0gMTogYSBzaW5nbGUgcHJvcG9zZSBpcyB1bmJhdGNoZWQgdW5sZXNzIHRoZSBjYWxsZXJcbiAgICAgICAgICAgICAgICAgIC8vIG5hbWVzIHRoZSBhY3QgaXQgYmVsb25ncyB0byAobm8gYXV0by1taW50IOKAlCBzZWUgcHJvcG9zZS50cykuXG4gICAgICAgICAgICAgICAgICBiYXRjaElkOiBiYXRjaElkIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGNvbnN0IHByb3Bvc2FsID1cbiAgICAgICAgICAgICAgICAgIGtpbmQgPT09IFwibm9kZVwiID8gcHJvcG9zZU5vZGUoZGIsIGJ1cywgaW5wdXQpIDogcHJvcG9zZUVkZ2UoZGIsIGJ1cywgaW5wdXQpO1xuICAgICAgICAgICAgICAgIC8vIEdhdGUgcmV3b3JrOiBhbiBlZGdlIGRyYWZ0IHdpdGggbWlzc2luZy93cm9uZyBlbmRwb2ludCBrZXlzXG4gICAgICAgICAgICAgICAgLy8gaXMgQUNDRVBURUQgKG9wYXF1ZSBpbnRha2UsIENvbnRyYWN0IDgpIGJ1dCB0aGUgcmVzcG9uc2VcbiAgICAgICAgICAgICAgICAvLyBjYXJyaWVzIGFuIGFkZGl0aXZlIGB3YXJuaW5nYCBuYW1pbmcgdGhlIGV4cGVjdGVkIGtleXMg4oCUXG4gICAgICAgICAgICAgICAgLy8gdGhlIGNvbGQgYWdlbnQgaGVhcnMgYWJvdXQgdGhlIGZ1bWJsZSBpbiB0aGUgc2FtZSB0dXJuLFxuICAgICAgICAgICAgICAgIC8vIG5vdCBhdCByYXRpZnkuIE5ldmVyIHN0b3JlZCwgbmV2ZXIgaW4gL3N0YXRlLlxuICAgICAgICAgICAgICAgIGNvbnN0IHdhcm5pbmcgPSBraW5kID09PSBcImVkZ2VcIiA/IGVkZ2VEcmFmdFdhcm5pbmcoaW5wdXQuZHJhZnQpIDogbnVsbDtcbiAgICAgICAgICAgICAgICAvLyBBQ1QxOiBhbiBBR0VOVC1hdXRob3JlZCBwcm9wb3NlIChhdXRob3IgZGVmYXVsdHMgdG8gYWdlbnQpXG4gICAgICAgICAgICAgICAgLy8gaXMgZXZpZGVuY2Ugb2YgYWN0aXZpdHkg4oCUIGl0IHJlc29sdmVzIGF1dG8gc3RhdGVzOyBhXG4gICAgICAgICAgICAgICAgLy8gdXNlci1za2V0Y2hlZCBwcm9wb3NhbCAoc3VyZmFjZSBjYW52YXMpIGlzIG5vdCB0aGUgYWdlbnQncy5cbiAgICAgICAgICAgICAgICBpZiAocHJvcG9zYWwuYXV0aG9yID09PSBcImFnZW50XCIpIHJlc29sdmVBY3Rpdml0eShlbnRyeSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24od2FybmluZyA/IHsgLi4ucHJvcG9zYWwsIHdhcm5pbmcgfSA6IHByb3Bvc2FsKTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PlxuICAgICAgICAgICAgICAgIGJhZFJlcXVlc3QoXG4gICAgICAgICAgICAgICAgICBlLFxuICAgICAgICAgICAgICAgICAgJ3tcImtpbmRcIjpcIm5vZGVcInxcImVkZ2VcIiwgXCJkcmFmdFwiOnsuLi59LCBcImV2aWRlbmNlXCI/Ontkb2NJZHxtZXNzYWdlSWQsc3Bhbn0sIFwic3VnZ2VzdGVkVGllclwiPywgXCJhdXRob3JcIj8sIFwiem9uZVwiPywgXCJ0YWdzXCI/OltzdHJpbmddLCBcImJhdGNoSWRcIj99IOKAlCBhbiBlZGdlIGRyYWZ0XFwncyBzb3VyY2UvdGFyZ2V0IG1heSBiZSBhIG5vZGUgaWQsIGEgcGVuZGluZyBub2RlLXByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9zZW5kXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IGVudHJ5ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cywgbWV0YSB9ID0gZW50cnk7XG4gICAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgICAgLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IHJvbGUsIGtpbmQsIHRleHQsIGdyb3VuZCB9ID0gYm9keSBhcyB7XG4gICAgICAgICAgICAgICAgICByb2xlPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIGtpbmQ/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgdGV4dD86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBncm91bmQ/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgaWYgKChyb2xlICE9PSBcInVzZXJcIiAmJiByb2xlICE9PSBcImFnZW50XCIpIHx8IHR5cGVvZiB0ZXh0ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJyb2xlICh1c2VyfGFnZW50KSBhbmQgdGV4dCByZXF1aXJlZFwiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IHNlbmRNZXNzYWdlKGRiLCBidXMsIG1ldGEuaWQsIHtcbiAgICAgICAgICAgICAgICAgIHJvbGUsXG4gICAgICAgICAgICAgICAgICBraW5kOiB0eXBlb2Yga2luZCA9PT0gXCJzdHJpbmdcIiA/IGtpbmQgOiBcInR1cm5cIixcbiAgICAgICAgICAgICAgICAgIHRleHQsXG4gICAgICAgICAgICAgICAgICBncm91bmQ6IEFycmF5LmlzQXJyYXkoZ3JvdW5kKSA/IChncm91bmQgYXMgc3RyaW5nW10pIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIC8vIEFDVDEgYXV0by1mbGlwOiBhIGh1bWFuIG1lc3NhZ2Ugd2l0aCBhbiBhZ2VudCB0YWlsIG9uIHRoaXNcbiAgICAgICAgICAgICAgICAvLyBwcm9qZWN0IHJlYWRzIGFzIFwicmVjZWl2ZWRcIiB3aXRob3V0IHRoZSBhZ2VudCBzYXlpbmcgc28g4oCUXG4gICAgICAgICAgICAgICAgLy8gZW1pdHRlZCBBRlRFUiBtZXNzYWdlLnBvc3RlZCAodHdvIHNlcXMsIG9yZGVyZWQpLiBObyBhZ2VudFxuICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCDihpIgbm8gZmxpcCAodGhlIHByZXNlbmNlIGRvdCBhbHJlYWR5IHNheXMgbm9ib2R5J3NcbiAgICAgICAgICAgICAgICAvLyBob21lKS4gQW4gYWdlbnQgc2VuZCBpcyB0aGUgdHVybidzIHRlcm1pbmFsIGFjdDogaXRcbiAgICAgICAgICAgICAgICAvLyByZXNvbHZlcyBhdXRvIHN0YXRlcyBBTkQgZXhwbGljaXQgdGhpbmtpbmcgdG8gaWRsZS5cbiAgICAgICAgICAgICAgICAvL1xuICAgICAgICAgICAgICAgIC8vIFJvdW5kIDExIChTRUFNIDIpOiB0aGUgYXV0by1mbGlwIFNUQU1QUyB0aGUgbWVzc2FnZSB0aGF0XG4gICAgICAgICAgICAgICAgLy8gdHJpZ2dlcmVkIGl0IOKAlCB0aGlzIHNpdGUgYWxyZWFkeSBoYWQgaXQgaW4gaGFuZCwgd2hpY2ggaXMgd2h5XG4gICAgICAgICAgICAgICAgLy8gcnVsaW5nIEIgY29zdHMgbm90aGluZyBoZXJlLlxuICAgICAgICAgICAgICAgIGlmIChyb2xlID09PSBcInVzZXJcIiAmJiBlbnRyeS5hZ2VudHMgPj0gMSkge1xuICAgICAgICAgICAgICAgICAgcG9zdEFjdGl2aXR5KGVudHJ5LCBcInJlY2VpdmVkXCIsIFwiYXV0b1wiLCBtZXNzYWdlLmlkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHJvbGUgPT09IFwiYWdlbnRcIikge1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZUFjdGl2aXR5KGVudHJ5LCB7IHRlcm1pbmFsQWN0OiB0cnVlIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyBSb3VuZCAxMSAoU0VBTSAxKTogYGtpbmRgIGlzIHRoZSBDSEFOTkVMOyBhbiB1bmtub3duIG9uZSBpc1xuICAgICAgICAgICAgICAgIC8vIHN0b3JlZCB2ZXJiYXRpbSB3aXRoIGFuIGFkZGl0aXZlIGFkdmlzb3J5IChuZXZlciBhIDQwMCkuXG4gICAgICAgICAgICAgICAgY29uc3Qgd2FybmluZyA9IGNoYW5uZWxXYXJuaW5nKG1lc3NhZ2Uua2luZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24od2FybmluZyA/IHsgLi4ubWVzc2FnZSwgd2FybmluZyB9IDogbWVzc2FnZSk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT5cbiAgICAgICAgICAgICAgICBiYWRSZXF1ZXN0KFxuICAgICAgICAgICAgICAgICAgZSxcbiAgICAgICAgICAgICAgICAgICd7XCJ0ZXh0XCI6IHN0cmluZywgXCJyb2xlXCI/OiBcInVzZXJcInxcImFnZW50XCIsIFwia2luZFwiPzogXCI8Y2hhbm5lbD5cIiwgXCJncm91bmRcIj86IFtzdHJpbmddfScsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoID09PSBcIi9zZWFyY2hcIikge1xuICAgICAgICAgICAgY29uc3QgeyBkYiB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IHEgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcInFcIikgPz8gXCJcIjtcbiAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgaGl0czogc2VhcmNoKGRiLCBxKSB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCA1IChDTEkxKTogcmVhZCBvbmUgZnVsbCBtZXNzYWdlIGJ5IGlkIChncmFwZXZpbmUgYHJlYWRgXG4gICAgICAgICAgLy8gcHJlY2VkZW50KSBzbyB0aGUgY2FzdGluZyBhZ2VudCBzdG9wcyBzY3JhcGluZyB0aGUgdGFpbCBsb2cgZm9yIGFcbiAgICAgICAgICAvLyBtZXNzYWdlIGJvZHkuIFByb2plY3Qtc2NvcGVkIOKAlCBhIG1lc3NhZ2UgZnJvbSBhbm90aGVyIHByb2plY3QgaXMgYVxuICAgICAgICAgIC8vIDQwNCBoZXJlLCBzYW1lIGFzIGV2ZXJ5IG90aGVyIHNjb3BlZCByZWFkLiBHcm91bmQgZ3JhbW1hciBtYXRjaGVzXG4gICAgICAgICAgLy8gcmVhZFN0YXRlIChncm91bmRfanNvbiDihpIgc3RyaW5nW10gfCBudWxsKS5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvbWVzc2FnZS9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIG1ldGEgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvbWVzc2FnZS9cIi5sZW5ndGgpO1xuICAgICAgICAgICAgY29uc3Qgcm93ID0gZGJcbiAgICAgICAgICAgICAgLnF1ZXJ5KFxuICAgICAgICAgICAgICAgIFwiU0VMRUNUIGlkLCBzZXEsIHJvbGUsIGtpbmQsIHRleHQsIGdyb3VuZF9qc29uLCB0cyBGUk9NIG1lc3NhZ2VzIFdIRVJFIGlkID0gPyBBTkQgcHJvamVjdF9pZCA9ID9cIixcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAuZ2V0KGlkLCBtZXRhLmlkKSBhcyB7XG4gICAgICAgICAgICAgIGlkOiBzdHJpbmc7XG4gICAgICAgICAgICAgIHNlcTogbnVtYmVyO1xuICAgICAgICAgICAgICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAgICAgICAgICAgICAga2luZDogc3RyaW5nO1xuICAgICAgICAgICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICAgICAgICAgIGdyb3VuZF9qc29uOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICAgICAgICB0czogbnVtYmVyO1xuICAgICAgICAgICAgfSB8IG51bGw7XG4gICAgICAgICAgICBpZiAoIXJvdykge1xuICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBtZXNzYWdlXCJ9Jywge1xuICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7XG4gICAgICAgICAgICAgIGlkOiByb3cuaWQsXG4gICAgICAgICAgICAgIHNlcTogcm93LnNlcSxcbiAgICAgICAgICAgICAgcm9sZTogcm93LnJvbGUsXG4gICAgICAgICAgICAgIGtpbmQ6IHJvdy5raW5kLFxuICAgICAgICAgICAgICB0ZXh0OiByb3cudGV4dCxcbiAgICAgICAgICAgICAgZ3JvdW5kOiByb3cuZ3JvdW5kX2pzb24gPyAoSlNPTi5wYXJzZShyb3cuZ3JvdW5kX2pzb24pIGFzIHN0cmluZ1tdKSA6IG51bGwsXG4gICAgICAgICAgICAgIHRzOiByb3cudHMsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvbmVpZ2hib3JzL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBkYiB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IGRlcHRoID0gTnVtYmVyLnBhcnNlSW50KHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiZGVwdGhcIikgPz8gXCIxXCIsIDEwKTtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gcGF0aC5zbGljZShcIi9uZWlnaGJvcnMvXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHtcbiAgICAgICAgICAgICAgbmVpZ2hib3JzOiBuZWlnaGJvcnMoZGIsIGlkLCBOdW1iZXIuaXNGaW5pdGUoZGVwdGgpICYmIGRlcHRoID4gMCA/IGRlcHRoIDogMSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCA1IChJQy1jKTogbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgaW50byBhIHpvbmUgKG9yIG51bGwgPVxuICAgICAgICAgIC8vIHRvIG1haW4pIOKAlCB0aGUgaW52ZXJzZSBvZiBwcm9tb3RlLiBVbmtub3duIHByb3Bvc2FsIOKGkiA0MDQsXG4gICAgICAgICAgLy8gdW5rbm93biB6b25lIOKGkiA0MDQgKHR5cGVkKSwgbm9uLXBlbmRpbmcg4oaSIDQwMC5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL3Byb3Bvc2Fscy9cIikgJiYgcGF0aC5lbmRzV2l0aChcIi96b25lXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBwcm9wb3NhbElkID0gcGF0aC5zbGljZShcIi9wcm9wb3NhbHMvXCIubGVuZ3RoLCAtXCIvem9uZVwiLmxlbmd0aCk7XG4gICAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgICAgLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IHpvbmVJZCB9ID0gYm9keSBhcyB7IHpvbmVJZD86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICBpZiAoem9uZUlkICE9PSBudWxsICYmIHR5cGVvZiB6b25lSWQgIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInpvbmVJZCBtdXN0IGJlIGEgem9uZSBpZCBzdHJpbmcsIG9yIG51bGwgdG8gbW92ZSB0byBtYWluXCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBtb3ZlUHJvcG9zYWxUb1pvbmUoZGIsIGJ1cywgcHJvcG9zYWxJZCwgem9uZUlkKTtcbiAgICAgICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcInVua25vd24gcHJvcG9zYWxcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocmVzdWx0KTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBVbmtub3duWm9uZUVycm9yKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IGUubWVzc2FnZSB9KSwge1xuICAgICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBiYWRSZXF1ZXN0KGUsICd7XCJ6b25lSWRcIjogXCI8em9uZSBpZD5cIiB8IG51bGx9Jyk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmXG4gICAgICAgICAgICBwYXRoLnN0YXJ0c1dpdGgoXCIvcHJvcG9zYWxzL1wiKSAmJlxuICAgICAgICAgICAgcGF0aC5lbmRzV2l0aChcIi9wcm9tb3RlXCIpXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBwcm9wb3NhbElkID0gcGF0aC5zbGljZShcIi9wcm9wb3NhbHMvXCIubGVuZ3RoLCAtXCIvcHJvbW90ZVwiLmxlbmd0aCk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbihwcm9tb3RlKGRiLCBidXMsIHByb3Bvc2FsSWQpKTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShcbiAgICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkgfSksXG4gICAgICAgICAgICAgICAgeyBzdGF0dXM6IDQwMCwgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0sXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUm91bmQgNSAoU0cxKTogYW5jaG9yIGEgcmVhbCBub2RlIHVuZGVyIGEgcGFyZW50IChzdWJtYXAgdHJlZSksIG9yXG4gICAgICAgICAgLy8gY2xlYXIgaXQgKHBhcmVudElkOiBudWxsIOKGkiB0b3AtbGV2ZWwpLiBUaGUgRklSU1QgL25vZGVzLyogcm91dGUuXG4gICAgICAgICAgLy8gQ3ljbGUgZ3VhcmQgbGl2ZXMgaW4gYW5jaG9yLnRzIChhbmNlc3Rvci13YWxrICsgZGVmZW5zaXZlIHNlZW4pO1xuICAgICAgICAgIC8vIEFuY2hvckVycm9yIOKGkiA0MDAsIGV2ZXJ5dGhpbmcgZWxzZSBpcyB0aGUgZ2VuZXJpYyA0MDAuIEVtaXRzXG4gICAgICAgICAgLy8gbm9kZS5hbmNob3JlZCAodGhpbikuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9ub2Rlcy9cIikgJiYgcGF0aC5lbmRzV2l0aChcIi9hbmNob3JcIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IG5vZGVJZCA9IHBhdGguc2xpY2UoXCIvbm9kZXMvXCIubGVuZ3RoLCAtXCIvYW5jaG9yXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgcGFyZW50SWQgfSA9IGJvZHkgYXMgeyBwYXJlbnRJZD86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICBpZiAocGFyZW50SWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcmVudElkICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJwYXJlbnRJZCBtdXN0IGJlIGEgbm9kZSBpZCBzdHJpbmcsIG9yIG51bGwgdG8gY2xlYXJcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGFuY2hvck5vZGUoZGIsIGJ1cywgbm9kZUlkLCBwYXJlbnRJZCkpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuY2F0Y2goKGUpID0+IGJhZFJlcXVlc3QoZSwgJ3tcInBhcmVudElkXCI6IFwiPG5vZGUgaWQ+XCIgfCBudWxsfScpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCAxMiAoU0VBTSA0KTogZWRpdCBhIHJhdGlmaWVkIG5vZGUncyB0aXRsZS9zeW5vcHNpcy4gT3JkZXJlZFxuICAgICAgICAgIC8vIEFGVEVSIC9ub2Rlcy86aWQvYW5jaG9yIChhIHN1ZmZpeCByb3V0ZSBtaXMtb3JkZXJlZCBiZWhpbmQgYSBiYXJlXG4gICAgICAgICAgLy8gOmlkIHJvdXRlIGlzIHNoYWRvd2VkIOKAlCB0aGUgL2pvYnMgcHJlY2VkZW50KSBhbmQgQkVGT1JFIHRoZSBERUxFVEVcbiAgICAgICAgICAvLyAoZGlmZmVyZW50IG1ldGhvZCwgYnV0IGtlZXAgdGhlIGZhbWlseSB0b2dldGhlcikuIDQwNCB1bmtub3duIG5vZGUsXG4gICAgICAgICAgLy8gNDAwIGVtcHR5L2lsbC1zaGFwZWQgcGF0Y2guIEVtaXRzIG5vZGUuZWRpdGVkIChGVUxMIGVudGl0eSkuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9ub2Rlcy9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IG5vZGVJZCA9IHBhdGguc2xpY2UoXCIvbm9kZXMvXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgdGl0bGUsIHN5bm9wc2lzIH0gPSBib2R5IGFzIHsgdGl0bGU/OiB1bmtub3duOyBzeW5vcHNpcz86IHVua25vd24gfTtcbiAgICAgICAgICAgICAgICBjb25zdCBub2RlID0gZWRpdE5vZGUoZGIsIGJ1cywgbm9kZUlkLCB7XG4gICAgICAgICAgICAgICAgICB0aXRsZTogdGl0bGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgc3lub3BzaXM6IHN5bm9wc2lzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBpZiAoIW5vZGUpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJ1bmtub3duIG5vZGVcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24obm9kZSk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT5cbiAgICAgICAgICAgICAgICBiYWRSZXF1ZXN0KGUsICd7XCJ0aXRsZVwiPzogc3RyaW5nLCBcInN5bm9wc2lzXCI/OiBzdHJpbmd9IChhdCBsZWFzdCBvbmUpJyksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gUm91bmQgNiAoREVMKTogaGFyZC1kZWxldGUgYSBub2RlLiBVbmZvcmNlZCArIGNpdGVkIOKGkiB0eXBlZCA0MDlcbiAgICAgICAgICAvLyB7ZXJyb3I6XCJjaXRlZFwiLCBjaXRlZEJ5OntlZGdlcywgY2hpbGRyZW59fTsgdW5rbm93biDihpIgNDA0OyBmb3JjZVxuICAgICAgICAgIC8vIGNhc2NhZGVzIChlZGdlcyBnb25lLCBjaGlsZHJlbiByZS1wYXJlbnRlZCB0byB0b3AtbGV2ZWwsIGRldHJpdHVzXG4gICAgICAgICAgLy8gZ29uZSwgbGVucyBjbGVhcmVkKS4gRW1pdHMgbm9kZS5kZWxldGVkICh0aGluKS5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJERUxFVEVcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvbm9kZXMvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvbm9kZXMvXCIubGVuZ3RoKTtcbiAgICAgICAgICAgIGNvbnN0IGZvcmNlID0gdXJsLnNlYXJjaFBhcmFtcy5oYXMoXCJmb3JjZVwiKTtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGRlbGV0ZU5vZGUoZGIsIGJ1cywgaWQsIGZvcmNlKTtcbiAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBub2RlXCJ9Jywge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgaWQgfSk7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIGlmIChlIGluc3RhbmNlb2YgTm9kZUNpdGVkRXJyb3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IFwiY2l0ZWRcIiwgY2l0ZWRCeTogZS5jaXRlZEJ5IH0pLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwOSxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gYmFkUmVxdWVzdChlLCBcIkRFTEVURSAvbm9kZXMvPGlkPls/Zm9yY2U9MV0g4oCUIGEgY2l0ZWQgbm9kZSBuZWVkcyA/Zm9yY2U9MVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCAxMiAoU0VBTSA1KTogdGhlIGludmVyc2Ugb2YgcmF0aWZ5LWJhdGNoIOKAlCBvbmUgdHJhbnNhY3Rpb25hbFxuICAgICAgICAgIC8vIGNsZWFyIG9mIGEgc2V0IG9mIHByb3Bvc2Fscy4gTVVTVCBiZSBtYXRjaGVkIGJlZm9yZSB0aGUgYmFyZVxuICAgICAgICAgIC8vIERFTEVURSAvcHJvcG9zYWxzLzppZCAoZGlmZmVyZW50IG1ldGhvZCwgYnV0IGtlZXAgaXQgYWJvdmUgdGhlXG4gICAgICAgICAgLy8gL3Byb3Bvc2Fscy86aWQvcnVsaW5nIGZhbWlseSB0b28g4oCUIHRoZSAvam9icyByb3V0ZS1vcmRlciBwcmVjZWRlbnQpLlxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9wcm9wb3NhbHMvZGVsZXRlLWJhdGNoXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgaWRzIH0gPSBib2R5IGFzIHsgaWRzPzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGRlbGV0ZVByb3Bvc2FsQmF0Y2goZGIsIGJ1cywgaWRzIGFzIHN0cmluZ1tdKSk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT5cbiAgICAgICAgICAgICAgICBiYWRSZXF1ZXN0KFxuICAgICAgICAgICAgICAgICAgZSxcbiAgICAgICAgICAgICAgICAgICd7XCJpZHNcIjogW1wiPHByb3Bvc2FsSWQ+XCIsIC4uLl19IOKAlCBhbGwtb3Itbm90aGluZzsgdGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIHtcImJhdGNoXCI6IGlkfSBzaG9ydGhhbmQgKGxvb2sgd2l0aCBgc3RhdGUgLS1iYXRjaCA8aWQ+YCBiZWZvcmUgeW91IHN3ZWVwKScsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCA2IChERUwpOiB0aGluIHByb3Bvc2FsIGRlbGV0ZSDigJQgTk8gZ3VhcmQgKGEgZGVwZW5kZW50IHBlbmRpbmdcbiAgICAgICAgICAvLyBlZGdlIGxpdmVzIGluIG9wYXF1ZSBkcmFmdF9qc29uIGFuZCBmYWlscyBzYWZlIGF0IGl0cyBvd24gcmF0aWZ5KS5cbiAgICAgICAgICAvLyBVbmtub3duIOKGkiA0MDQ7IGVtaXRzIHByb3Bvc2FsLmRlbGV0ZWQgKHRoaW4pLlxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkRFTEVURVwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9wcm9wb3NhbHMvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvcHJvcG9zYWxzL1wiLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBkZWxldGVQcm9wb3NhbChkYiwgYnVzLCBpZCk7XG4gICAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBwcm9wb3NhbFwifScsIHtcbiAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSwgaWQgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9wcm9wb3NhbHMvXCIpICYmIHBhdGguZW5kc1dpdGgoXCIvcnVsaW5nXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBlbnRyeSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMsIG1ldGEgfSA9IGVudHJ5O1xuICAgICAgICAgICAgY29uc3QgcHJvcG9zYWxJZCA9IHBhdGguc2xpY2UoXCIvcHJvcG9zYWxzL1wiLmxlbmd0aCwgLVwiL3J1bGluZ1wiLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBkb2NzRGlyID0gam9pbihwcm9qZWN0RGlyKEhPTUUsIG1ldGEuaWQpLCBcImRvY3NcIik7XG4gICAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgICAgLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgICAgICAgICAvLyBkb2NJZC9zcGFuIGFyZSB0aGUgYWRkaXRpdmUgcmF0aWZ5LXRpbWUtYXR0YWNoIGZpZWxkcyAoUDNcbiAgICAgICAgICAgICAgICAvLyBnYXRlIHJ1bGluZykg4oCUIHBhc3NlZCB0aHJvdWdoIHZlcmJhdGltOyByYXRpZnkoKSBvd25zIGV2ZXJ5XG4gICAgICAgICAgICAgICAgLy8gY29uc3RyYWludCAoZXZpZGVuY2UtbGVzcyBvbmx5LCBub2RlLW9ubHksIHNsdWcsIGV4aXN0ZW5jZSkuXG4gICAgICAgICAgICAgICAgLy8gUm91bmQgNiAoUkIpOiBhZGRpdGl2ZSBgYW5jaG9yYCA9IHRoZSBzaW5nbGUtY2FsbCByYXRpZnktYW5kLVxuICAgICAgICAgICAgICAgIC8vIG5lc3QgdHdpbiDigJQgaW1wbGVtZW50ZWQgQVMgcmF0aWZ5QmF0Y2goe2lkczpbaWRdLCBhbmNob3JzOltcbiAgICAgICAgICAgICAgICAvLyB7bm9kZTppZCwgcGFyZW50OmFuY2hvcn1dfSksIHNvIG5vZGUtb25seSArIGF0b21pYyBmYWxsIG91dC5cbiAgICAgICAgICAgICAgICBjb25zdCB7IHJ1bGluZywgZG9jRWRpdCwgZG9jSWQsIHNwYW4sIGFuY2hvciB9ID0gYm9keSBhcyB7XG4gICAgICAgICAgICAgICAgICBydWxpbmc/OiB1bmtub3duO1xuICAgICAgICAgICAgICAgICAgZG9jRWRpdD86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBkb2NJZD86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBzcGFuPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIGFuY2hvcj86IHVua25vd247XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICBydWxpbmcgIT09IFwiY2Fub25cIiAmJlxuICAgICAgICAgICAgICAgICAgcnVsaW5nICE9PSBcInRocmVhZFwiICYmXG4gICAgICAgICAgICAgICAgICBydWxpbmcgIT09IFwic3RvcnktbG9jYWxcIiAmJlxuICAgICAgICAgICAgICAgICAgcnVsaW5nICE9PSBcInJlamVjdFwiXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJydWxpbmcgbXVzdCBiZSBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0XCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGFuY2hvciA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgICAgaWYgKHJ1bGluZyA9PT0gXCJyZWplY3RcIilcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiLS1hbmNob3IgaXMgaW52YWxpZCB3aXRoIGEgcmVqZWN0IHJ1bGluZ1wiKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGJhdGNoID0gcmF0aWZ5QmF0Y2goZGIsIGJ1cywgZG9jc0Rpciwge1xuICAgICAgICAgICAgICAgICAgICBydWxpbmcsXG4gICAgICAgICAgICAgICAgICAgIGlkczogW3Byb3Bvc2FsSWRdLFxuICAgICAgICAgICAgICAgICAgICBhbmNob3JzOiBbeyBub2RlOiBwcm9wb3NhbElkLCBwYXJlbnQ6IGFuY2hvciB9XSxcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZUFjdGl2aXR5KGVudHJ5KTtcbiAgICAgICAgICAgICAgICAgIC8vIFJldHVybiB0aGUgc2luZ2xlIFJhdGlmeVJlc3VsdCAodGhlIHR3aW4ncyBzaGFwZSksIHBsdXMgdGhlXG4gICAgICAgICAgICAgICAgICAvLyBpZE1hcCBmb3IgdGhlIGNhbGxlciB0aGF0IHdhbnRzIHRoZSBtaW50ZWQgaWQuXG4gICAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IC4uLmJhdGNoLnJhdGlmaWVkWzBdLCBpZE1hcDogYmF0Y2guaWRNYXAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHJhdGlmeShkYiwgYnVzLCBkb2NzRGlyLCB7XG4gICAgICAgICAgICAgICAgICBwcm9wb3NhbElkLFxuICAgICAgICAgICAgICAgICAgcnVsaW5nLFxuICAgICAgICAgICAgICAgICAgZG9jRWRpdDogdHlwZW9mIGRvY0VkaXQgPT09IFwic3RyaW5nXCIgPyBkb2NFZGl0IDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgZG9jSWQ6IHR5cGVvZiBkb2NJZCA9PT0gXCJzdHJpbmdcIiA/IGRvY0lkIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgICAgc3BhbjogdHlwZW9mIHNwYW4gPT09IFwic3RyaW5nXCIgPyBzcGFuIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIC8vIEFDVDE6IHJhdGlmeSBpcyBvbiB0aGUgYWdlbnQtd3JpdGUgbGlzdCAobm8gYXV0aG9yc2hpcCBvblxuICAgICAgICAgICAgICAgIC8vIHRoaXMgd2lyZSkg4oCUIGl0IHJlc29sdmVzIGF1dG8gc3RhdGVzIHVuY29uZGl0aW9uYWxseS5cbiAgICAgICAgICAgICAgICByZXNvbHZlQWN0aXZpdHkoZW50cnkpO1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHJlc3VsdCk7XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgICAgICAgIC8vIFIxOiB0aGUgaW4tem9uZSByZWZ1c2FsIGlzIHR5cGVkIOKAlCA0MDkge2Vycm9yOlwiem9uZWRcIixcbiAgICAgICAgICAgICAgICAvLyB6b25lSWR9IHNvIG1lbnVzIGJyYW5jaCB3aXRob3V0IHN0cmluZy1tYXRjaGluZyAodGhlXG4gICAgICAgICAgICAgICAgLy8gQ2l0ZWRFcnJvci9ab25lTm90RW1wdHlFcnJvciBmYW1pbHkpLlxuICAgICAgICAgICAgICAgIGlmIChlIGluc3RhbmNlb2YgWm9uZWRFcnJvcikge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcInpvbmVkXCIsIHpvbmVJZDogZS56b25lSWQgfSksIHtcbiAgICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDksXG4gICAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gYmFkUmVxdWVzdChcbiAgICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgICAne1wicnVsaW5nXCI6XCJjYW5vblwifFwidGhyZWFkXCJ8XCJzdG9yeS1sb2NhbFwifFwicmVqZWN0XCIsIFwiZG9jRWRpdFwiPywgXCJkb2NJZFwiPywgXCJzcGFuXCI/LCBcImFuY2hvclwiP30nLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9sZW5zXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cywgbWV0YSB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIHJldHVybiByZXFcbiAgICAgICAgICAgICAgLmpzb24oKVxuICAgICAgICAgICAgICAudGhlbigoYm9keSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgb3duZXIsIG5vZGVJZCwgZGVwdGgsIGRvY0lkIH0gPSBib2R5IGFzIHtcbiAgICAgICAgICAgICAgICAgIG93bmVyPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIG5vZGVJZD86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBkZXB0aD86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBkb2NJZD86IHVua25vd247XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIG93bmVyICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoXCJvd25lciByZXF1aXJlZFwiKTtcbiAgICAgICAgICAgICAgICAvLyBDbGFpbSBWMiBpbnRha2U6IG5vZGUgWE9SIGRvYywgZXhhY3RseSBvbmU7IGRlcHRoIGlzIGFcbiAgICAgICAgICAgICAgICAvLyBub2RlLWxlbnMga25vYiBvbmx5OyBhIGRvYyBsZW5zIG11c3QgbmFtZSBhIHJlYWwgZG9jIHNsdWdcbiAgICAgICAgICAgICAgICAvLyAoc2FtZSBmYWlsLWxvdWQgc3Bpcml0IGFzIG1hcmsvcHJvcG9zZSBpbnRha2UpLlxuICAgICAgICAgICAgICAgIGNvbnN0IGhhc05vZGUgPSB0eXBlb2Ygbm9kZUlkID09PSBcInN0cmluZ1wiO1xuICAgICAgICAgICAgICAgIGNvbnN0IGhhc0RvYyA9IHR5cGVvZiBkb2NJZCA9PT0gXCJzdHJpbmdcIjtcbiAgICAgICAgICAgICAgICBpZiAoaGFzTm9kZSA9PT0gaGFzRG9jKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJsZW5zIHJlcXVpcmVzIGV4YWN0bHkgb25lIG9mIG5vZGVJZCBvciBkb2NJZFwiKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGhhc0RvYyAmJiBkZXB0aCAhPT0gdW5kZWZpbmVkICYmIGRlcHRoICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJkZXB0aCBhcHBsaWVzIHRvIGEgbm9kZSBsZW5zIG9ubHlcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChoYXNEb2MpIHtcbiAgICAgICAgICAgICAgICAgIGlmICghU0xVR19SRS50ZXN0KGRvY0lkIGFzIHN0cmluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkb2NJZCBpcyBub3QgYSB2YWxpZCBkb2Mgc2x1ZzogJHtTdHJpbmcoZG9jSWQpfWApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gZG9jcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGRvY0lkIGFzIHN0cmluZykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIGRvYzogJHtTdHJpbmcoZG9jSWQpfWApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBjb25zdCBsZW5zID0gc2V0TGVucyhkYiwgYnVzLCBtZXRhLmlkLCB7XG4gICAgICAgICAgICAgICAgICBvd25lcixcbiAgICAgICAgICAgICAgICAgIG5vZGVJZDogaGFzTm9kZSA/IChub2RlSWQgYXMgc3RyaW5nKSA6IG51bGwsXG4gICAgICAgICAgICAgICAgICBkZXB0aDogaGFzTm9kZSAmJiB0eXBlb2YgZGVwdGggPT09IFwibnVtYmVyXCIgPyBkZXB0aCA6IG51bGwsXG4gICAgICAgICAgICAgICAgICBkb2NJZDogaGFzRG9jID8gKGRvY0lkIGFzIHN0cmluZykgOiBudWxsLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKGxlbnMpO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuY2F0Y2goKGUpID0+XG4gICAgICAgICAgICAgICAgYmFkUmVxdWVzdChcbiAgICAgICAgICAgICAgICAgIGUsXG4gICAgICAgICAgICAgICAgICAne1wib3duZXJcIjogc3RyaW5nLCBcIm5vZGVJZFwiOiBzdHJpbmd9IHwge1wib3duZXJcIjogc3RyaW5nLCBcImRvY0lkXCI6IHN0cmluZ30gKG5vZGUgWE9SIGRvYyksIFwiZGVwdGhcIj8gbnVtYmVyJyxcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJERUxFVEVcIiAmJiBwYXRoID09PSBcIi9sZW5zXCIpIHtcbiAgICAgICAgICAgIGNvbnN0IHsgZGIsIGJ1cywgbWV0YSB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNsZWFyTGVucyhkYiwgYnVzLCBtZXRhLmlkKTtcbiAgICAgICAgICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUgfSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9sb29rLWhlcmUvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGJ1cyB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGxvb2tIZXJlKGJ1cywgcGF0aC5zbGljZShcIi9sb29rLWhlcmUvXCIubGVuZ3RoKSk7XG4gICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlIH0pO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChyZXEubWV0aG9kID09PSBcIkRFTEVURVwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9kb2MvXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMsIG1ldGEgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvZG9jL1wiLmxlbmd0aCk7XG4gICAgICAgICAgICBjb25zdCBmb3JjZSA9IHVybC5zZWFyY2hQYXJhbXMuaGFzKFwiZm9yY2VcIik7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBkZWxldGVEb2MoZGIsIGJ1cywgcHJvamVjdERpcihIT01FLCBtZXRhLmlkKSwgaWQsIGZvcmNlKTtcbiAgICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBkb2NcIn0nLCB7XG4gICAgICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiB0cnVlLCBpZCB9KTtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBDaXRlZEVycm9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZShKU09OLnN0cmluZ2lmeSh7IGVycm9yOiBcImNpdGVkXCIsIGNpdGVkQnk6IGUuY2l0ZWRCeSB9KSwge1xuICAgICAgICAgICAgICAgICAgc3RhdHVzOiA0MDksXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuIGJhZFJlcXVlc3QoZSwgXCJERUxFVEUgL2RvYy88c2x1Zz5bP2ZvcmNlPTFdIOKAlCBhIGNpdGVkIGRvYyBuZWVkcyA/Zm9yY2U9MVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSb3VuZCA0IChLMSkg4oCUIG1hcmsgcm91dGUgZmFtaWx5OiA0MDQtZmlyc3QgZm9yIHVua25vd24vbm9uLXNsdWdcbiAgICAgICAgICAvLyBpZHMsIDQwMCBmb3IgYSBiYWQgcGF5bG9hZC4ga2luZDogbnVsbCBjbGVhcnMgKGF1dGhvciBudWxsZWQgdG9vKS5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2RvYy9cIikgJiYgcGF0aC5lbmRzV2l0aChcIi9raW5kXCIpKSB7XG4gICAgICAgICAgICBjb25zdCB7IGRiLCBidXMgfSA9IGxvYWRQcm9qZWN0KHByb2plY3RJZCk7XG4gICAgICAgICAgICBjb25zdCBpZCA9IHBhdGguc2xpY2UoXCIvZG9jL1wiLmxlbmd0aCwgLVwiL2tpbmRcIi5sZW5ndGgpO1xuICAgICAgICAgICAgcmV0dXJuIHJlcVxuICAgICAgICAgICAgICAuanNvbigpXG4gICAgICAgICAgICAgIC50aGVuKChib2R5KSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgeyBraW5kLCBhdXRob3IgfSA9IGJvZHkgYXMgeyBraW5kPzogdW5rbm93bjsgYXV0aG9yPzogdW5rbm93biB9O1xuICAgICAgICAgICAgICAgIGlmIChraW5kICE9PSBudWxsICYmIHR5cGVvZiBraW5kICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJraW5kIG11c3QgYmUgYSBzdHJpbmcsIG9yIG51bGwgdG8gY2xlYXJcIik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHNldERvY0tpbmQoZGIsIGJ1cywge1xuICAgICAgICAgICAgICAgICAgZG9jSWQ6IGlkLFxuICAgICAgICAgICAgICAgICAga2luZDoga2luZCBhcyBzdHJpbmcgfCBudWxsLFxuICAgICAgICAgICAgICAgICAgYXV0aG9yOiB0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiID8gYXV0aG9yIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwidW5rbm93biBkb2NcIn0nLCB7XG4gICAgICAgICAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIFJlc3BvbnNlLmpzb24ocmVzdWx0KTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PiBiYWRSZXF1ZXN0KGUsICd7XCJraW5kXCI6IHN0cmluZywgXCJhdXRob3JcIj86IFwidXNlclwifFwiYWdlbnRcIn0nKSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgPT09IFwiUE9TVFwiICYmIHBhdGguc3RhcnRzV2l0aChcIi9kb2MvXCIpICYmIHBhdGguZW5kc1dpdGgoXCIvbWFya1wiKSkge1xuICAgICAgICAgICAgY29uc3QgZW50cnkgPSBsb2FkUHJvamVjdChwcm9qZWN0SWQpO1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgYnVzLCBtZXRhIH0gPSBlbnRyeTtcbiAgICAgICAgICAgIGNvbnN0IGlkID0gcGF0aC5zbGljZShcIi9kb2MvXCIubGVuZ3RoLCAtXCIvbWFya1wiLmxlbmd0aCk7XG4gICAgICAgICAgICByZXR1cm4gcmVxXG4gICAgICAgICAgICAgIC5qc29uKClcbiAgICAgICAgICAgICAgLnRoZW4oKGJvZHkpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IGF1dGhvciwgbm90ZSwgc3RhdHVzIH0gPSBib2R5IGFzIHtcbiAgICAgICAgICAgICAgICAgIGF1dGhvcj86IHVua25vd247XG4gICAgICAgICAgICAgICAgICBub3RlPzogdW5rbm93bjtcbiAgICAgICAgICAgICAgICAgIHN0YXR1cz86IHVua25vd247XG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHN0YXR1cyAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKFwibWFyayByZXF1aXJlcyBhIHN0YXR1cyBzdHJpbmdcIik7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzb2x2ZWRBdXRob3IgPSB0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiID8gYXV0aG9yIDogXCJhZ2VudFwiO1xuICAgICAgICAgICAgICAgIGNvbnN0IG1hcmsgPSBtYXJrRG9jKGRiLCBidXMsIHByb2plY3REaXIoSE9NRSwgbWV0YS5pZCksIHtcbiAgICAgICAgICAgICAgICAgIGRvY0lkOiBpZCxcbiAgICAgICAgICAgICAgICAgIGF1dGhvcjogcmVzb2x2ZWRBdXRob3IsXG4gICAgICAgICAgICAgICAgICBub3RlOiB0eXBlb2Ygbm90ZSA9PT0gXCJzdHJpbmdcIiA/IG5vdGUgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICBzdGF0dXMsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgLy8gQUNUMTogYW4gYWdlbnQtYXV0aG9yZWQgbWFyayByZXNvbHZlcyBhdXRvIHN0YXRlcy5cbiAgICAgICAgICAgICAgICBpZiAocmVzb2x2ZWRBdXRob3IgPT09IFwiYWdlbnRcIikgcmVzb2x2ZUFjdGl2aXR5KGVudHJ5KTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IGRvY0lkOiBpZCwgbWFyayB9KTtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLmNhdGNoKChlKSA9PiBiYWRSZXF1ZXN0KGUsICd7XCJzdGF0dXNcIjogc3RyaW5nLCBcImF1dGhvclwiOiBzdHJpbmcsIFwibm90ZVwiPzogc3RyaW5nfScpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBpZiAocmVxLm1ldGhvZCA9PT0gXCJHRVRcIiAmJiBwYXRoLnN0YXJ0c1dpdGgoXCIvZG9jL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgeyBkYiwgbWV0YSB9ID0gbG9hZFByb2plY3QocHJvamVjdElkKTtcbiAgICAgICAgICAgIGNvbnN0IGRvYyA9IHJlYWREb2MoXG4gICAgICAgICAgICAgIGRiLFxuICAgICAgICAgICAgICBqb2luKHByb2plY3REaXIoSE9NRSwgbWV0YS5pZCksIFwiZG9jc1wiKSxcbiAgICAgICAgICAgICAgcGF0aC5zbGljZShcIi9kb2MvXCIubGVuZ3RoKSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoZG9jKSByZXR1cm4gUmVzcG9uc2UuanNvbihkb2MpO1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcInVua25vd24gZG9jXCJ9Jywge1xuICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICAgICAgY29uc3QgYXNzZXQgPSBzZXJ2ZURpc3QocGF0aCk7XG4gICAgICAgICAgICBpZiAoYXNzZXQpIHJldHVybiBhc3NldDtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICAgIHN0YXR1czogNDA0LFxuICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIHByb2plY3RGYWlsdXJlKGUpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgd2Vic29ja2V0OiB7XG4gICAgICAgIG9wZW4od3MpIHtcbiAgICAgICAgICBjb25zdCBkYXRhID0gd3MuZGF0YSBhcyB7IHNpbmNlOiBudW1iZXI7IHByb2plY3RJZD86IHN0cmluZzsgdW5zdWJzY3JpYmU/OiAoKSA9PiB2b2lkIH07XG4gICAgICAgICAgY29uc3QgeyBidXMgfSA9IGxvYWRQcm9qZWN0KGRhdGEucHJvamVjdElkKTtcbiAgICAgICAgICBkYXRhLnVuc3Vic2NyaWJlID0gYnVzLnN1YnNjcmliZShkYXRhLnNpbmNlLCAoZXZlbnQpID0+IHtcbiAgICAgICAgICAgIHdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoZXZlbnQpKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSxcbiAgICAgICAgY2xvc2Uod3MpIHtcbiAgICAgICAgICAod3MuZGF0YSBhcyB7IHVuc3Vic2NyaWJlPzogKCkgPT4gdm9pZCB9KS51bnN1YnNjcmliZT8uKCk7XG4gICAgICAgIH0sXG4gICAgICAgIG1lc3NhZ2UoKSB7XG4gICAgICAgICAgLyogdGhlIGJyb3dzZXIgb25seSBsaXN0ZW5zIG9uIHRoaXMgc29ja2V0IGluIFYxICovXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IGV2ZW50OiBcImJpbmRfZXJyb3JcIiwgaG9zdCwgcG9ydCwgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSB9KX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cblxuICBjb25zdCB1cmwgPSBgaHR0cDovLyR7aG9zdH06JHtzZXJ2ZXIucG9ydH1gO1xuICB0cnkge1xuICAgIG1rZGlyU3luYyhIT01FLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICB3cml0ZUZpbGVTeW5jKFBPUlRfRklMRSwgU3RyaW5nKHNlcnZlci5wb3J0KSk7XG4gICAgd3JpdGVGaWxlU3luYyhQSURfRklMRSwgU3RyaW5nKHByb2Nlc3MucGlkKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBtaW5kLW1hcHBlcjogY291bGQgbm90IHdyaXRlIGRpc2NvdmVyeSBmaWxlczogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICApO1xuICB9XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgdXJsLCBwb3J0OiBzZXJ2ZXIucG9ydCwgbW9kZSB9KX1cXG5gKTtcbiAgaWYgKCFwYXJzZWQudmFsdWVzW1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIodXJsKTtcblxuICAvLyBTdGFuZGluZyB1bnRpbCBraWxsZWQgKFNJR1RFUk0vU0lHSU5UKSDigJQgbm8gaWRsZSB0aW1lb3V0IGluIFYxLlxuICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IHNodXRkb3duID0gKCkgPT4gcmVzb2x2ZSgpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIHNodXRkb3duKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIHNodXRkb3duKTtcbiAgfSk7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoUElEX0ZJTEUpICYmIHJlYWRGaWxlU3luYyhQSURfRklMRSwgXCJ1dGY4XCIpLnRyaW0oKSA9PT0gU3RyaW5nKHByb2Nlc3MucGlkKSkge1xuICAgICAgdW5saW5rU3luYyhQSURfRklMRSk7XG4gICAgICB1bmxpbmtTeW5jKFBPUlRfRklMRSk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvKiBmaW5lICovXG4gIH1cbiAgZm9yIChjb25zdCB7IGRiIH0gb2YgcHJvamVjdHMudmFsdWVzKCkpIGRiLmNsb3NlKCk7XG4gIGF3YWl0IFByb21pc2UucmFjZShbc2VydmVyLnN0b3AodHJ1ZSksIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDIwMCkpXSk7XG4gIHJldHVybiAwO1xufVxuXG4vKipcbiAqIFRoZSBkYWVtb24ncyBvbmUgZW50cnksIGNhbGxlZCBieSB0aGUgbGF1bmNoZXIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBUSEFUIElTIFRIRSBQT0lOVC5cbiAqIGBkaXN0L3NlcnZlci5qc2AgaXMgSU1QT1JURUQgYnkgdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuICogZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGUgYnVuZGxlOiBhIGJsb2NrIGhlcmUgd291bGQgbmV2ZXJcbiAqIHJ1biwgdGhlIGRhZW1vbiB3b3VsZCBib290LCBzZXJ2ZSBub3RoaW5nIGFuZCBleGl0IDAsIGFuZCBldmVyeSB0ZXN0IHdvdWxkXG4gKiBmYWlsIGFzIFwibmV2ZXIgYm91bmQgYSBwb3J0XCIg4oCUIHdoaWNoIHJlYWRzIGxpa2UgZmxha2UgKHBsYXlib29rIEIzKS4gVGhlXG4gKiBzb3VyY2Uga2VlcHMgbm8gc2Vjb25kIGVudHJ5IGVpdGhlcjogYFNLSUxMX1JPT1RgIGlzIHRoZSBza2lsbCByb290IG9ubHkgZnJvbVxuICogYGRpc3QvYCwgc28gcnVuIGZyb20gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL2AgdGhpcyBmaWxlIGNvbXB1dGVzXG4gKiBgc3JjL21pbmQtbWFwcGVyL2AsIGZpbmRzIG5vIGBkaXN0L2luZGV4Lmh0bWxgLCBjaG9vc2VzIERFViwgYW5kIHRoZW4gZmFpbHNcbiAqIHRoZSBkZXYgaW1wb3J0IGZyb20gdGhlIHdyb25nIGFuY2hvci5cbiAqXG4gKiDimqAgVEhFIFRFUk1JTkFMIGBwcm9jZXNzLmV4aXRgIFNUQVlTIEFUIFRIRSBMQVVOQ0hFUiwgbm90IGhlcmU6IGBtYWluYCBhd2FpdHNcbiAqIGEgc2lnbmFsLXJlc29sdmVkIHByb21pc2UgYW5kIHRoZW4gcnVucyBpdHMgb3duIHRlYXJkb3duLCBzbyB0aGUgZXZlbnQgbG9vcCBpc1xuICogZW1wdHkgd2hlbiBpdCByZXR1cm5zIGFuZCBlaXRoZXIgbGF1bmNoZXIgc2hhcGUgd29ya3MuIFRoZSBleGl0IGlzIGZhbWlseVxuICogRS10ZXJtaW5hbCBpbiBgZ3JpbW9pcmUvZXhpdC1zaXRlLWludmVudG9yeS50ZXN0LnRzYCwgcGlubmVkIGF0IHRoZSBsYXVuY2hlcixcbiAqIHdoaWNoIGlzIG5vdyB0aGUgc2l0ZSB3aGVyZSB0aGlzIHByb2Nlc3MgZW5kcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG4vLyDim5QgVEhFIERBRU1PTiBJUyBBIExJQlJBUlkgV0lUSCBBTiBFTlRSWSBQT0lOVCwgQU5EIFRISVMgTElORSBJUyBXSFkgVEhFXG4vLyBQT1JUJ1MgVEVTVCBUUklBR0UgSEFTIFRIUkVFIENBVEVHT1JJRVMgUkFUSEVSIFRIQU4gVFdPLiBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYFxuLy8gaW1wb3J0cyBgc3NlUmVzcG9uc2VgIGFuZCBkcml2ZXMgaXQgSU4tUFJPQ0VTUyDigJQgaXQgc3Bhd25zIG5vdGhpbmcg4oCUIHNvIHRoYXRcbi8vIHJlZmVyZW5jZSBmb2xsb3dzIHRoZSBTT1VSQ0Ugd2hpbGUgYHNlcnZlci50ZXN0LnRzYCwgYGxpZmVjeWNsZS50ZXN0LnRzYCxcbi8vIGBwcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHJlbGVhc2Utc2VydmUudGVzdC50c2Agc3Bhd24gYSBQUk9DRVNTIGFuZCBmb2xsb3cgdGhlXG4vLyBMQVVOQ0hFUi4gUG9pbnRpbmcgYW4gaW1wb3J0ZXIgYXQgdGhlIGxhdW5jaGVyIGdldHMgYSBmaWxlIHRoYXQgZXhwb3J0c1xuLy8gbm90aGluZzsgcG9pbnRpbmcgYSBzcGF3bmVyIGF0IHRoaXMgZmlsZSBib290cyBub3RoaW5nIGF0IGV4aXQgMC4gTmVpdGhlclxuLy8gZmFpbHMgYXMgYSB3cm9uZyBwYXRoIChwbGF5Ym9vayBCNi4xKS5cbmV4cG9ydCB7IG1haW4sIHJlYWREb2MsIHNzZVJlc3BvbnNlIH07XG4iLAogICAgIi8vIFJvdW5kIDQgKEExKSDigJQgcGVyLXRhcmdldCBhY3Rpb24gc2xvdHM6IGFnZW50LWF1dGhvcmVkIGNvbnZlcnNhdGlvbmFsXG4vLyBzaG9ydGN1dHMgcGlubmVkIHRvIGEgbm9kZSBvciBhIFBFTkRJTkcgcHJvcG9zYWwgKHRoZSBzdGlnbWVyZ3kgcGF5b2ZmIOKAlFxuLy8gdGhlIGFnZW50IGxlYXZlcyBhZmZvcmRhbmNlcyBvbiB0aGUgYm9hcmQ7IGEgY2xpY2sgc2VlZHMgdGhlIGNvbXBvc2VyLFxuLy8gbmV2ZXIgYXV0by1zZW5kcykuIEVuZ2luZS1vd25lZCBtZXRhZGF0YSBsaWtlIHRoZSBsZW5zOiBhZ2VudC13cml0YWJsZSxcbi8vIG5vdCBzdGFnZWQsIG5ldmVyIHJhdGlmaWVkIOKAlCBzbyBzaGFwZSBJUyB2YWxpZGF0ZWQgYXQgaW50YWtlICh0aGVcbi8vIG9wYXF1ZS1kcmFmdCBkb2N0cmluZSBjb3ZlcnMgYWdlbnQgZXh0cmFjdGlvbiBkcmFmdHMsIG5vdCB0aGlzKS5cbi8vXG4vLyBTdG9yYWdlOiBub2RlX2FjdGlvbnMgKHRhcmdldF9pZCBQSywgYWN0aW9uc19qc29uKSDigJQgd2hvbGVzYWxlIHVwc2VydCBwZXJcbi8vIHRhcmdldCwgZW1wdHkgYXJyYXkgKG9yIERFTEVURSkgY2xlYXJzLiBMaWZlY3ljbGUgcmlkZXMgdGhlIHRhcmdldCdzXG4vLyBvd25lcnM6IHJhdGlmeSByZS1ob21lcyB0aGUgcm93IG9udG8gdGhlIGZyZXNobHkgbWludGVkIG5vZGUgaWQsIHJlamVjdFxuLy8gZGVsZXRlcyBpdCwgem9uZSBkZWxldGUgY2FzY2FkZXMgaXQgd2l0aCB0aGUgem9uZSdzIHByb3Bvc2FscywgcHJvbW90ZSBpc1xuLy8gYSBuby1vcCAodGhlIHByb3Bvc2FsIGlkIHN1cnZpdmVzIHRoZSBtb3ZlKS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgdHlwZSB7IEV2ZW50QnVzIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5cbmludGVyZmFjZSBBY3Rpb25TbG90IHtcbiAgaWQ6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbiAgc2VlZDogc3RyaW5nO1xufVxuXG4vLyBTb2Z0IGNhcCAoYWR2aXNvcnkgd2FybmluZywgZWRnZURyYWZ0V2FybmluZyBtZWNoYW5pc20g4oCUIGFkZGl0aXZlIHJlc3BvbnNlXG4vLyBmaWVsZCwgbmV2ZXIgc3RvcmVkKSBhbmQgdGhlIGhhcmQgYnl0ZS1jYXAgb24gdGhlIHNlcmlhbGl6ZWQganNvbi5cbmNvbnN0IEFDVElPTlNfU09GVF9DQVAgPSA0O1xuY29uc3QgQUNUSU9OU19CWVRFX0NBUCA9IDE2ICogMTAyNDtcblxuaW50ZXJmYWNlIFNldEFjdGlvbnNSZXN1bHQge1xuICB0YXJnZXRJZDogc3RyaW5nO1xuICBhY3Rpb25zOiBBY3Rpb25TbG90W107XG4gIC8vIEFkdmlzb3J5IG9ubHkg4oCUIHN1cmZhY2VzIHNob3cgNCArIHNjcm9sbCAoY2FwIHRoZSB2aXNpYmxlLCBuZXZlciB0aGVcbiAgLy8gbGlzdCk7IHRoZSBkYWVtb24gc3RvcmVzIHRoZSBmdWxsIGFycmF5LlxuICB3YXJuaW5nPzogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBwYXJzZUFjdGlvbnMocmF3OiB1bmtub3duKTogQWN0aW9uU2xvdFtdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgdGhlIHJlcXVlc3QgYm9keSBJUyB0aGUgYWN0aW9uIGFycmF5IOKAlCBzZW5kIGEgQkFSRSBKU09OIGFycmF5IG9mIHtcImlkXCIsXCJsYWJlbFwiLFwic2VlZFwifSBzdHJpbmcgdHJpcGxlcyAoZW1wdHkgYXJyYXkgY2xlYXJzKSwgTk9UIHtcImFjdGlvbnNcIjpbLi4uXX07IGdvdCAke3R5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgcmF3ICE9PSBudWxsID8gYGFuIG9iamVjdCB3aXRoIGtleXM6ICR7T2JqZWN0LmtleXMocmF3IGFzIG9iamVjdCkuam9pbihcIiwgXCIpfWAgOiB0eXBlb2YgcmF3fWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmF3Lm1hcCgoZW50cnksIGkpID0+IHtcbiAgICBpZiAoZW50cnkgPT09IG51bGwgfHwgdHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGFjdGlvbnNbJHtpfV0gaXMgbm90IGFuIG9iamVjdCDigJQgZXhwZWN0ZWQge1wiaWRcIiwgXCJsYWJlbFwiLCBcInNlZWRcIn1gKTtcbiAgICB9XG4gICAgY29uc3QgeyBpZCwgbGFiZWwsIHNlZWQgfSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGlmICh0eXBlb2YgaWQgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGxhYmVsICE9PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBzZWVkICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYGFjdGlvbnNbJHtpfV0gbmVlZHMgc3RyaW5nIGlkL2xhYmVsL3NlZWRgKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgaWQsIGxhYmVsLCBzZWVkIH07XG4gIH0pO1xufVxuXG4vLyBBIHRhcmdldCBpcyBhIHJlYWwgbm9kZSBvciBhIFBFTkRJTkcgcHJvcG9zYWwg4oCUIGFueXRoaW5nIGVsc2UgaXMgbnVsbCAodGhlXG4vLyBzZXJ2ZXIgNDA0cykuIEEgcmF0aWZpZWQvcmVqZWN0ZWQgcHJvcG9zYWwgaXMgTk9UIGEgdmFsaWQgdGFyZ2V0OiBpdHNcbi8vIGFjdGlvbnMgZWl0aGVyIHJlLWhvbWVkIHRvIHRoZSBub2RlIG9yIGRpZWQgd2l0aCB0aGUgcnVsaW5nLlxuZnVuY3Rpb24gcmVzb2x2ZVRhcmdldChkYjogRGF0YWJhc2UsIHRhcmdldElkOiBzdHJpbmcpOiBcIm5vZGVcIiB8IFwicHJvcG9zYWxcIiB8IG51bGwge1xuICBpZiAoZGIucXVlcnkoXCJTRUxFQ1QgMSBGUk9NIG5vZGVzIFdIRVJFIGlkID0gP1wiKS5nZXQodGFyZ2V0SWQpKSByZXR1cm4gXCJub2RlXCI7XG4gIGNvbnN0IHByb3Bvc2FsID0gZGIucXVlcnkoXCJTRUxFQ1Qgc3RhdHVzIEZST00gcHJvcG9zYWxzIFdIRVJFIGlkID0gP1wiKS5nZXQodGFyZ2V0SWQpIGFzIHtcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgfSB8IG51bGw7XG4gIGlmIChwcm9wb3NhbD8uc3RhdHVzID09PSBcInBlbmRpbmdcIikgcmV0dXJuIFwicHJvcG9zYWxcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHNldEFjdGlvbnMoXG4gIGRiOiBEYXRhYmFzZSxcbiAgYnVzOiBFdmVudEJ1cyxcbiAgdGFyZ2V0SWQ6IHN0cmluZyxcbiAgcmF3QWN0aW9uczogdW5rbm93bixcbik6IFNldEFjdGlvbnNSZXN1bHQgfCBudWxsIHtcbiAgaWYgKHJlc29sdmVUYXJnZXQoZGIsIHRhcmdldElkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGFjdGlvbnMgPSBwYXJzZUFjdGlvbnMocmF3QWN0aW9ucyk7XG5cbiAgaWYgKGFjdGlvbnMubGVuZ3RoID09PSAwKSB7XG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gbm9kZV9hY3Rpb25zIFdIRVJFIHRhcmdldF9pZCA9ID9cIiwgW3RhcmdldElkXSk7XG4gICAgYnVzLmVtaXQoXCJhY3Rpb25zLnNldFwiLCB7IHRhcmdldElkLCBhY3Rpb25zOiBbXSB9KTtcbiAgICByZXR1cm4geyB0YXJnZXRJZCwgYWN0aW9uczogW10gfTtcbiAgfVxuXG4gIGNvbnN0IGpzb24gPSBKU09OLnN0cmluZ2lmeShhY3Rpb25zKTtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUoanNvbikubGVuZ3RoO1xuICBpZiAoYnl0ZXMgPiBBQ1RJT05TX0JZVEVfQ0FQKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGFjdGlvbnMgcGF5bG9hZCBpcyAke2J5dGVzfSBieXRlcyDigJQgb3ZlciB0aGUgJHtBQ1RJT05TX0JZVEVfQ0FQfS1ieXRlIGNhcDsgdHJpbSB0aGUgc2VlZHNgLFxuICAgICk7XG4gIH1cbiAgZGIucnVuKFxuICAgIFwiSU5TRVJUIElOVE8gbm9kZV9hY3Rpb25zICh0YXJnZXRfaWQsIGFjdGlvbnNfanNvbikgVkFMVUVTICg/LCA/KSBPTiBDT05GTElDVCh0YXJnZXRfaWQpIERPIFVQREFURSBTRVQgYWN0aW9uc19qc29uID0gZXhjbHVkZWQuYWN0aW9uc19qc29uXCIsXG4gICAgW3RhcmdldElkLCBqc29uXSxcbiAgKTtcbiAgYnVzLmVtaXQoXCJhY3Rpb25zLnNldFwiLCB7IHRhcmdldElkLCBhY3Rpb25zOiBhY3Rpb25zIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5bXSB9KTtcbiAgY29uc3QgcmVzdWx0OiBTZXRBY3Rpb25zUmVzdWx0ID0geyB0YXJnZXRJZCwgYWN0aW9ucyB9O1xuICBpZiAoYWN0aW9ucy5sZW5ndGggPiBBQ1RJT05TX1NPRlRfQ0FQKSB7XG4gICAgcmVzdWx0Lndhcm5pbmcgPSBgJHthY3Rpb25zLmxlbmd0aH0gYWN0aW9ucyBvbiBvbmUgdGFyZ2V0IOKAlCBzdXJmYWNlcyByZW5kZXIgJHtBQ1RJT05TX1NPRlRfQ0FQfSBwbHVzIHNjcm9sbDsgY29uc2lkZXIgZmV3ZXIsIHNoYXJwZXIgc2xvdHNgO1xuICB9XG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIGNsZWFyQWN0aW9ucyhkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIHRhcmdldElkOiBzdHJpbmcpOiBTZXRBY3Rpb25zUmVzdWx0IHwgbnVsbCB7XG4gIHJldHVybiBzZXRBY3Rpb25zKGRiLCBidXMsIHRhcmdldElkLCBbXSk7XG59XG5cbi8vIFRoZSAvc3RhdGUgbWVyZ2UgaW5wdXQ6IGV2ZXJ5IHN0b3JlZCBzbG90IGxpc3Qga2V5ZWQgYnkgdGFyZ2V0IGlkIChzdGF0ZS50c1xuLy8gYXR0YWNoZXMgdGhlbSBvbnRvIG5vZGVzW10gQU5EIHByb3Bvc2Fsc1tdOyBhYnNlbnQgPSBub25lKS5cbmZ1bmN0aW9uIHJlYWRBY3Rpb25zKGRiOiBEYXRhYmFzZSk6IE1hcDxzdHJpbmcsIEFjdGlvblNsb3RbXT4ge1xuICBjb25zdCByb3dzID0gZGIucXVlcnkoXCJTRUxFQ1QgdGFyZ2V0X2lkLCBhY3Rpb25zX2pzb24gRlJPTSBub2RlX2FjdGlvbnNcIikuYWxsKCkgYXMgQXJyYXk8e1xuICAgIHRhcmdldF9pZDogc3RyaW5nO1xuICAgIGFjdGlvbnNfanNvbjogc3RyaW5nO1xuICB9PjtcbiAgY29uc3Qgb3V0ID0gbmV3IE1hcDxzdHJpbmcsIEFjdGlvblNsb3RbXT4oKTtcbiAgZm9yIChjb25zdCByb3cgb2Ygcm93cykge1xuICAgIHRyeSB7XG4gICAgICBvdXQuc2V0KHJvdy50YXJnZXRfaWQsIEpTT04ucGFyc2Uocm93LmFjdGlvbnNfanNvbikgYXMgQWN0aW9uU2xvdFtdKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIEEgY29ycnVwdCByb3cgbmV2ZXIgY3Jhc2hlcyBhIHNuYXBzaG90IOKAlCBpdCBqdXN0IGRvZXNuJ3QgcmVuZGVyLlxuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgdHlwZSB7IEFjdGlvblNsb3QsIFNldEFjdGlvbnNSZXN1bHQgfTtcbmV4cG9ydCB7IEFDVElPTlNfQllURV9DQVAsIEFDVElPTlNfU09GVF9DQVAsIGNsZWFyQWN0aW9ucywgcmVhZEFjdGlvbnMsIHNldEFjdGlvbnMgfTtcbiIsCiAgICAiLy8gUm91bmQgNSAoU0cxKSDigJQgbm9kZS1hbmNob3JlZCBzdWJtYXBzLiBBIG5vZGUncyBgYW5jaG9yX25vZGVfaWRgIGlzIGl0c1xuLy8gcGFyZW50IGluIGEgc3RyaWN0IGNvbnRhaW5tZW50IHRyZWUgKG51bGwgPSB0b3AtbGV2ZWwpLiBBbmNob3IgaXNcbi8vIFJFQUwtTk9ERVMtT05MWTogcHJvcG9zYWxzIHN0YXkgdG9wLWxldmVsIHVudGlsIHJhdGlmaWVkLCBgcmF0aWZ5KClgIGlzXG4vLyBVTkNIQU5HRUQsIGFuZCBhbmNob3JpbmcgaXMgYSBzZXBhcmF0ZSBwb3N0LXJhdGlmeSBhY3QgKHRoZSBgbm9kZSBhbmNob3JgXG4vLyB2ZXJiKS4gT3J0aG9nb25hbCB0byB6b25lX2lkLiBUaGUgZGFlbW9uIHN0YXlzIGR1bWIgKENvbnRyYWN0IDgpOiB0aGlzIGlzIGFcbi8vIHN0b3JhZ2UgbW92ZSBndWFyZGVkIGFnYWluc3QgY3ljbGVzLCBub3RoaW5nIG1vcmUuXG4vL1xuLy8gVGhlIGd1YXJkIGlzIGFuIGFuY2VzdG9yLXdhbGsgZnJvbSB0aGUgUFJPUE9TRUQgcGFyZW50OiBpZiB3YWxraW5nIHBhcmVudFxuLy8gbGlua3MgZXZlciByZWFjaGVzIGBub2RlSWRgLCB0aGUgYW5jaG9yIHdvdWxkIG1ha2Ugbm9kZUlkIGl0cyBvd24gYW5jZXN0b3Jcbi8vIChhIGN5Y2xlKS4gQSBkZWZlbnNpdmUgYHNlZW5gIHNldCBicmVha3Mgb3V0IG9mIGFueSBwcmUtZXhpc3RpbmcgY3ljbGUgc28gYVxuLy8gY29ycnVwdCBzdG9yZSBjYW4ndCBzcGluIHRoZSB3YWxrIGZvcmV2ZXIuIFJlamVjdHM6IHNlbGYtYW5jaG9yLCBkaXJlY3Rcbi8vIGN5Y2xlLCBkZWVwIGN5Y2xlLCB1bmtub3duIHBhcmVudCwgdW5rbm93biBub2RlLiBgcGFyZW50SWQgPT09IG51bGxgIChjbGVhcilcbi8vIGlzIGFsd2F5cyBzYWZlLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcblxuLy8gQSB0eXBlZCBlcnJvciBzbyB0aGUgc2VydmVyIGNhbiBtYXAgYW5jaG9yIGZhaWx1cmVzIHRvIDQwMCB3aXRob3V0XG4vLyBzdHJpbmctbWF0Y2hpbmcgKHRoZSBDaXRlZEVycm9yL1pvbmVkRXJyb3IgZmFtaWx5KS5cbmNsYXNzIEFuY2hvckVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkFuY2hvckVycm9yXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gYW5jaG9yR3VhcmQoZGI6IERhdGFiYXNlLCBub2RlSWQ6IHN0cmluZywgcGFyZW50SWQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldChub2RlSWQpKSB7XG4gICAgdGhyb3cgbmV3IEFuY2hvckVycm9yKGB1bmtub3duIG5vZGU6ICR7bm9kZUlkfWApO1xuICB9XG4gIGlmIChwYXJlbnRJZCA9PT0gbnVsbCkgcmV0dXJuOyAvLyBjbGVhciBpcyBhbHdheXMgc2FmZVxuICBpZiAocGFyZW50SWQgPT09IG5vZGVJZCkgdGhyb3cgbmV3IEFuY2hvckVycm9yKFwiYSBub2RlIGNhbm5vdCBhbmNob3IgdG8gaXRzZWxmXCIpO1xuICBpZiAoIWRiLnF1ZXJ5KFwiU0VMRUNUIDEgRlJPTSBub2RlcyBXSEVSRSBpZCA9ID9cIikuZ2V0KHBhcmVudElkKSkge1xuICAgIHRocm93IG5ldyBBbmNob3JFcnJvcihgdW5rbm93biBhbmNob3IgdGFyZ2V0OiAke3BhcmVudElkfWApO1xuICB9XG4gIC8vIFdhbGsgYW5jZXN0b3JzIG9mIHRoZSBwcm9wb3NlZCBwYXJlbnQ7IGhpdHRpbmcgbm9kZUlkIG1lYW5zIHRoaXMgYW5jaG9yXG4gIC8vIHdvdWxkIGNsb3NlIGEgY3ljbGUuXG4gIGxldCBjdXI6IHN0cmluZyB8IG51bGwgPSBwYXJlbnRJZDtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICB3aGlsZSAoY3VyICE9PSBudWxsKSB7XG4gICAgaWYgKGN1ciA9PT0gbm9kZUlkKSB7XG4gICAgICB0aHJvdyBuZXcgQW5jaG9yRXJyb3IoYGN5Y2xlOiAke25vZGVJZH0gaXMgYWxyZWFkeSBhbiBhbmNlc3RvciBvZiAke3BhcmVudElkfWApO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXMoY3VyKSkgYnJlYWs7IC8vIGRlZmVuc2l2ZTogYSBwcmUtZXhpc3RpbmcgY3ljbGUgY2FuJ3QgbG9vcCB1c1xuICAgIHNlZW4uYWRkKGN1cik7XG4gICAgY29uc3Qgcm93ID0gZGIucXVlcnkoXCJTRUxFQ1QgYW5jaG9yX25vZGVfaWQgRlJPTSBub2RlcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGN1cikgYXMge1xuICAgICAgYW5jaG9yX25vZGVfaWQ6IHN0cmluZyB8IG51bGw7XG4gICAgfSB8IG51bGw7XG4gICAgY3VyID0gcm93Py5hbmNob3Jfbm9kZV9pZCA/PyBudWxsO1xuICB9XG59XG5cbi8vIFJldHVybnMgdGhlIHtub2RlSWQsIGFuY2hvck5vZGVJZH0gaXQgd3JvdGUgKHRoZSBldmVudCBwYXlsb2FkIHNoYXBlKS4gVGhyb3dzXG4vLyBBbmNob3JFcnJvciBvbiBhbnkgZ3VhcmQgZmFpbHVyZS4gRW1pdHMgYG5vZGUuYW5jaG9yZWRgICh0aGluIOKAlCBjb25zdW1lcnNcbi8vIGZsaXAgdGhlIG5vZGUncyBhbmNob3JOb2RlSWQgbG9jYWxseSwgdGhlbiBtYXkgcmVmZXRjaCBkZXJpdmVkIGNvdW50cykuXG5mdW5jdGlvbiBhbmNob3JOb2RlKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIG5vZGVJZDogc3RyaW5nLFxuICBwYXJlbnRJZDogc3RyaW5nIHwgbnVsbCxcbik6IHsgbm9kZUlkOiBzdHJpbmc7IGFuY2hvck5vZGVJZDogc3RyaW5nIHwgbnVsbCB9IHtcbiAgYW5jaG9yR3VhcmQoZGIsIG5vZGVJZCwgcGFyZW50SWQpO1xuICBkYi5ydW4oXCJVUERBVEUgbm9kZXMgU0VUIGFuY2hvcl9ub2RlX2lkID0gPyBXSEVSRSBpZCA9ID9cIiwgW3BhcmVudElkLCBub2RlSWRdKTtcbiAgYnVzLmVtaXQoXCJub2RlLmFuY2hvcmVkXCIsIHsgbm9kZUlkLCBhbmNob3JOb2RlSWQ6IHBhcmVudElkIH0pO1xuICByZXR1cm4geyBub2RlSWQsIGFuY2hvck5vZGVJZDogcGFyZW50SWQgfTtcbn1cblxuZXhwb3J0IHsgQW5jaG9yRXJyb3IsIGFuY2hvckd1YXJkLCBhbmNob3JOb2RlIH07XG4iLAogICAgIi8vIFJvdW5kIDkgKEpvYiBRdWV1ZSkg4oCUIGEgZmlyc3QtY2xhc3MsIHBlcnNpc3RlZCB1bml0IG9mIEFHRU5UIFdPUks6IHN0YXR1cyArXG4vLyBzdWItdGFza3MgKyBhIGRlbGl2ZXJhYmxlICsgYW4gT1dORVIgKGEgbGVhc2UpLiBVbmxpa2UgdGhlIFI2IGluZ2VzdGlvbiB0cmF5XG4vLyAoYSBwdXJlIGNsaWVudCB2aWV3IG92ZXIgcGVuZGluZyBhdXRob3I6XCJ1c2VyXCIgcHJvcG9zYWxzLCB6ZXJvIGVuZ2luZVxuLy8gc3RhdGUpLCBhIGpvYiBpcyByZWFsIGVuZ2luZSBzdGF0ZSDigJQgaXRzIG93biB0YWJsZSwgaXRzIG93biBldmVudHMuXG4vL1xuLy8gRGVzaWduIGRlY2lzaW9ucyAocGxhbi1yb3VuZDksIGxlYWQtcmVzb2x2ZWQpOlxuLy8gICBEMSDigJQgam9icyBhcmUgdGhlaXIgT1dOIGVudGl0eSwgbm90IHByb3Bvc2Fscy5jbGFpbWVkX2J5ICh0aGUgdmlzaW9uIOKAlFxuLy8gICAgICAgIHN1Yi10YXNrcywgZGVsaXZlcmFibGVzLCBzdGFuZGFsb25lIHRyYWNraW5nIOKAlCBleGNlZWRzIGEgcHJvcG9zYWxcbi8vICAgICAgICBsZWFzZSkuIFRoZSBSNiBjbGFpbWVkX2J5IHNlYW0gaXMgc3Vic3VtZWQgKFwicmVmaW5lIHRoaXMgcHJvcG9zYWxcIiBpc1xuLy8gICAgICAgIGp1c3QgYSBqb2Igd2hvc2UgZGVsaXZlcmFibGUgcG9pbnRzIGF0IGl0KS5cbi8vICAgRDIg4oCUIExJVkVORVNTIGlzIERFUklWRUQgY2xpZW50LXNpZGUgKHN1cmZhY2Ugam9pbnMgam9icyDDlyB0aGUgZXhpc3Rpbmdcbi8vICAgICAgICBhZ2VudC5hY3Rpdml0eSBsYWRkZXIgb24gY2xhaW1lZF9ieSkuIE5PIGVuZ2luZSBsaXZlbmVzcy9oZWFydGJlYXRcbi8vICAgICAgICBmaWVsZCBoZXJlIOKAlCB0aGUgZW5naW5lIHN0b3JlcyBvbmx5IGNsYWltZWRfYnkgKyB0aGUgY29hcnNlIHN0YXR1cy5cbi8vICAgRDMg4oCUIGpvYi4qIGV2ZW50cyBjYXJyeSB0aGUgRlVMTCBqb2IgZW50aXR5ICh3aG9sZXNhbGUgcmVwbGFjZS1ieS1pZCwgdGhlXG4vLyAgICAgICAgdGFncy5zZXQgaWRpb20pOyBvbmx5IGpvYi5kZWxldGVkIGlzIHRoaW4ge2lkfS5cbi8vICAgRDQg4oCUIHN1Yi10YXNrcyBhcmUgYSBKU09OIGNvbHVtbiAoW3tpZCxsYWJlbCxkb25lfV0pIG93bmVkIHdob2xseSBieSB0aGVcbi8vICAgICAgICBqb2IgKHRoZSBub2RlX3RhZ3MgKl9qc29uIHByZWNlZGVudCksIG5vdCBhIGNoaWxkIHRhYmxlLlxuLy8gICBENSDigJQgZGVsaXZlcmFibGUgaXMgb25lIG51bGxhYmxlIGZyZWVmb3JtIHJlZiAoZG9jOmlkIC8gbm9kZTppZCAvIHRleHQpO1xuLy8gICAgICAgIG1hbnkgam9icyBzaGFyaW5nIGEgcmVmID0gbWFueS1qb2JzLW9uZS1kZWxpdmVyYWJsZS5cbi8vICAgRDYg4oCUIFYxIGxlYXNlIGlzIGNsYWltL3JlbGVhc2Ugb25seSAoYXRvbWljIGNvbXBhcmUtYW5kLXNldCk7IGV4cGlyeSAvXG4vLyAgICAgICAgc3RlYWxpbmcgLyBUVEwgaXMgZGVmZXJyZWQgdG8gYSBtdWx0aS1hZ2VudCBoYXJkZW5pbmcgcm91bmQuXG4vL1xuLy8gRGlzY2lwbGluZSAodGhlIGJ1aWxkUHJvcG9zYWwvYnVpbGRSYXRpZnkgbGVzc29uKTogYnVpbGRKb2IgVkFMSURBVEVTICtcbi8vIGNvbXB1dGVzIHRoZSByb3cgYW5kIHRoZSB3aXJlIG9iamVjdCBidXQgZG9lcyBOT1QgaW5zZXJ0IG9yIGVtaXQ7IGV2ZXJ5XG4vLyBtdXRhdG9yIHdyaXRlcyB0aGVuIFJFLVJFQURTIHRoZSBmdWxsIGpvYiB0aHJvdWdoIE9ORSByZWFkZXIgKHJlYWRKb2IpIGJlZm9yZVxuLy8gZW1pdHRpbmcsIHNvIHRoZSBldmVudCBwYXlsb2FkIGFsd2F5cyBlcXVhbHMgdGhlIC9zdGF0ZSBzbmFwc2hvdCBzaGFwZSAodGhlXG4vLyByZS1lbWl0LXRocm91Z2gtdGhlLXNpbmdsZS1zb3VyY2UtcmVhZGVyIHJ1bGUg4oCUIG5ldmVyIGhhbmQtYXNzZW1ibGUgYVxuLy8gcGF5bG9hZCBhIHdob2xlc2FsZS1yZXBsYWNlIGNvbnN1bWVyIGhvbGRzKS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgdHlwZSB7IEV2ZW50QnVzIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5cbi8vIFRoZSBqb2IgbGlmZWN5Y2xlIHZvY2FidWxhcnkuIHN0YXR1cyBpcyBFTkdJTkUtT1dORUQgbWV0YWRhdGEgKGxpa2UgdGhlXG4vLyBhY3Rpb24tc2xvdCBzaGFwZSwgTk9UIGFuIG9wYXF1ZSBkcmFmdCkg4oCUIHZhbGlkYXRlZCBsb3VkIGF0IGludGFrZSwgbmV2ZXJcbi8vIHNpbGVudGx5IHN0b3JlZC4gcXVldWVkIGlzIHRoZSBkZWZhdWx0OyB0aGUgcmVzdCBhcmUgYWdlbnQvaHVtYW4tZHJpdmVuLlxuY29uc3QgSk9CX1NUQVRVU0VTID0gW1wicXVldWVkXCIsIFwicnVubmluZ1wiLCBcImJsb2NrZWRcIiwgXCJkb25lXCIsIFwiZmFpbGVkXCIsIFwiY2FuY2VsZWRcIl0gYXMgY29uc3Q7XG50eXBlIEpvYlN0YXR1cyA9ICh0eXBlb2YgSk9CX1NUQVRVU0VTKVtudW1iZXJdO1xuXG5pbnRlcmZhY2UgU3VidGFzayB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGRvbmU6IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBKb2Ige1xuICBpZDogc3RyaW5nO1xuICAvLyBzY29wZSDigJQgbWF0Y2hlcyB0aGUgcGVyLXByb2plY3Qgc3RvcmUgKHRoZSBtZXNzYWdlcy5wcm9qZWN0X2lkIHByZWNlZGVudCkuXG4gIC8vIFBvcHVsYXRlZCBhdCBjcmVhdGUsIGNhcnJpZWQgb24gdGhlIHdpcmUgc28gYSBqb2IgaXMgc2VsZi1kZXNjcmliaW5nOyByZWFkc1xuICAvLyBhcmUgVU5GSUxURVJFRCAoZWFjaCBwcm9qZWN0IG93bnMgaXRzIG93biBzdG9yZS5zcWxpdGUsIHNvIGV2ZXJ5IHJvdyBoZXJlXG4gIC8vIGJlbG9uZ3MgdG8gdGhpcyBwcm9qZWN0IOKAlCB0aGUgbm9kZXMvcHJvcG9zYWxzIHByZWNlZGVudCwgbm90IG1lc3NhZ2VzJykuXG4gIHByb2plY3Q6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3RhdHVzOiBKb2JTdGF0dXM7XG4gIC8vIHRoZSBsZWFzZSAoRDYpOiB0aGUgb3duaW5nIGFnZW50L3Nlc3Npb24sIG9yIG51bGwgKHVuY2xhaW1lZCkuXG4gIGNsYWltZWRCeTogc3RyaW5nIHwgbnVsbDtcbiAgLy8gRDU6IG9uZSBmcmVlZm9ybSByZWYgKGRvYzppZCAvIG5vZGU6aWQgLyBmcmVlIHRleHQpLCBvciBudWxsLlxuICBkZWxpdmVyYWJsZTogc3RyaW5nIHwgbnVsbDtcbiAgLy8gRDQ6IHRoZSBjaGVja2xpc3QsIG93bmVkIHdob2xseSBieSB0aGlzIGpvYi5cbiAgc3VidGFza3M6IFN1YnRhc2tbXTtcbiAgZGV0YWlsOiBzdHJpbmcgfCBudWxsO1xuICAvLyBlcG9jaCBNSUxMSVNFQ09ORFMgKERhdGUubm93KCkpLiBOT1RFIOKAlCBhIGRlbGliZXJhdGUgZGl2ZXJnZW5jZSBmcm9tIHRoZVxuICAvLyBob3VzZSB1bml4ZXBvY2goKS1zZWNvbmRzIGRlZmF1bHQ6IHVwZGF0ZWRBdCBtdXN0IGJ1bXAgb24gZXZlcnkgbXV0YXRpb25cbiAgLy8gYW5kIG5lZWRzIHN1Yi1zZWNvbmQgb3JkZXJpbmcsIHNvIGJvdGggc3RhbXBzIGFyZSBhcHAtd3JpdHRlbiBtcywgbm90IGFcbiAgLy8gU1FMIERFRkFVTFQuIFRoZSB3aXJlIGNhcnJpZXMgbnVtYmVycyAobGlrZSBtZXNzYWdlIHRzKSwgbmV2ZXIgSVNPIHRleHQuXG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn1cblxuLy8gQSBndWFyZGVkIHJlZnVzYWwgKHRoZSBab25lTm90RW1wdHlFcnJvci9DaXRlZEVycm9yIGZhbWlseSk6IGNsYWltaW5nIGEgam9iXG4vLyBhbHJlYWR5IGxlYXNlZCBieSBhIERJRkZFUkVOVCBvd25lciBpcyBhIDQwOSwgYW5kIHRoZSBlcnJvciBjYXJyaWVzIHRoZVxuLy8gY3VycmVudCBvd25lciBzbyB0aGUgc3VyZmFjZSBjYW4gcmVuZGVyIFwiYWxyZWFkeSBjbGFpbWVkIGJ5IFhcIi4gUmUtY2xhaW0gYnlcbi8vIHRoZSBTQU1FIG93bmVyIGlzIGlkZW1wb3RlbnQgc3VjY2VzcywgbmV2ZXIgdGhpcy5cbmNsYXNzIENsYWltQ29uZmxpY3RFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY2xhaW1lZEJ5OiBzdHJpbmc7XG4gIGNvbnN0cnVjdG9yKGNsYWltZWRCeTogc3RyaW5nKSB7XG4gICAgc3VwZXIoYGpvYiBhbHJlYWR5IGNsYWltZWQgYnkgJHtjbGFpbWVkQnl9YCk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGFpbUNvbmZsaWN0RXJyb3JcIjtcbiAgICB0aGlzLmNsYWltZWRCeSA9IGNsYWltZWRCeTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhc3NlcnRTdGF0dXMoc3RhdHVzOiB1bmtub3duKTogSm9iU3RhdHVzIHtcbiAgaWYgKHR5cGVvZiBzdGF0dXMgIT09IFwic3RyaW5nXCIgfHwgIShKT0JfU1RBVFVTRVMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKHN0YXR1cykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHN0YXR1cyBtdXN0IGJlIG9uZSBvZiAke0pPQl9TVEFUVVNFUy5qb2luKFwifFwiKX1gKTtcbiAgfVxuICByZXR1cm4gc3RhdHVzIGFzIEpvYlN0YXR1cztcbn1cblxuZnVuY3Rpb24gcGFyc2VTdWJ0YXNrcyhyYXc6IHN0cmluZyk6IFN1YnRhc2tbXSB7XG4gIHRyeSB7XG4gICAgY29uc3QgYXJyID0gSlNPTi5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHJldHVybiBbXTtcbiAgICByZXR1cm4gYXJyXG4gICAgICAuZmlsdGVyKChzKTogcyBpcyBTdWJ0YXNrID0+IHMgIT09IG51bGwgJiYgdHlwZW9mIHMgPT09IFwib2JqZWN0XCIpXG4gICAgICAubWFwKChzKSA9PiAoe1xuICAgICAgICBpZDogU3RyaW5nKChzIGFzIFN1YnRhc2spLmlkKSxcbiAgICAgICAgbGFiZWw6IFN0cmluZygocyBhcyBTdWJ0YXNrKS5sYWJlbCksXG4gICAgICAgIGRvbmU6IEJvb2xlYW4oKHMgYXMgU3VidGFzaykuZG9uZSksXG4gICAgICB9KSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5pbnRlcmZhY2UgSm9iUm93IHtcbiAgaWQ6IHN0cmluZztcbiAgcHJvamVjdDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgY2xhaW1lZF9ieTogc3RyaW5nIHwgbnVsbDtcbiAgZGVsaXZlcmFibGU6IHN0cmluZyB8IG51bGw7XG4gIHN1YnRhc2tzX2pzb246IHN0cmluZztcbiAgZGV0YWlsOiBzdHJpbmcgfCBudWxsO1xuICBjcmVhdGVkX2F0OiBudW1iZXI7XG4gIHVwZGF0ZWRfYXQ6IG51bWJlcjtcbn1cblxuY29uc3QgSk9CX0NPTFVNTlMgPVxuICBcImlkLCBwcm9qZWN0LCB0aXRsZSwgc3RhdHVzLCBjbGFpbWVkX2J5LCBkZWxpdmVyYWJsZSwgc3VidGFza3NfanNvbiwgZGV0YWlsLCBjcmVhdGVkX2F0LCB1cGRhdGVkX2F0XCI7XG5cbmZ1bmN0aW9uIHJvd1RvSm9iKHJvdzogSm9iUm93KTogSm9iIHtcbiAgcmV0dXJuIHtcbiAgICBpZDogcm93LmlkLFxuICAgIHByb2plY3Q6IHJvdy5wcm9qZWN0LFxuICAgIHRpdGxlOiByb3cudGl0bGUsXG4gICAgc3RhdHVzOiBhc3NlcnRTdGF0dXNMZW5pZW50KHJvdy5zdGF0dXMpLFxuICAgIGNsYWltZWRCeTogcm93LmNsYWltZWRfYnksXG4gICAgZGVsaXZlcmFibGU6IHJvdy5kZWxpdmVyYWJsZSxcbiAgICBzdWJ0YXNrczogcGFyc2VTdWJ0YXNrcyhyb3cuc3VidGFza3NfanNvbiksXG4gICAgZGV0YWlsOiByb3cuZGV0YWlsLFxuICAgIGNyZWF0ZWRBdDogcm93LmNyZWF0ZWRfYXQsXG4gICAgdXBkYXRlZEF0OiByb3cudXBkYXRlZF9hdCxcbiAgfTtcbn1cblxuLy8gUmVhZHMgdG9sZXJhdGUgYW4gdW5rbm93biBzdG9yZWQgc3RhdHVzIChuZXZlciBjcmFzaCBhIHNuYXBzaG90KSDigJQgd3JpdGVzXG4vLyBhcmUgc3RyaWN0IChhc3NlcnRTdGF0dXMpLCByZWFkcyBwYXNzIGEgc3RyYXkgdmFsdWUgdGhyb3VnaCBhcy1pcy5cbmZ1bmN0aW9uIGFzc2VydFN0YXR1c0xlbmllbnQoc3RhdHVzOiBzdHJpbmcpOiBKb2JTdGF0dXMge1xuICByZXR1cm4gc3RhdHVzIGFzIEpvYlN0YXR1cztcbn1cblxuaW50ZXJmYWNlIENyZWF0ZUpvYklucHV0IHtcbiAgcHJvamVjdDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGRlbGl2ZXJhYmxlPzogc3RyaW5nIHwgbnVsbDtcbiAgZGV0YWlsPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuLy8gYnVpbGRKb2Ig4oCUIHRoZSBwdXJlIGJ1aWxkZXI6IHZhbGlkYXRlICsgY29tcHV0ZSB0aGUgcm93IGFuZCB0aGUgd2lyZSBvYmplY3QsXG4vLyByZXR1cm4gYW4gYGluc2VydGAgY2xvc3VyZTsgTk8gZW1pdCAodGhlIGJ1aWxkUHJvcG9zYWwvYnVpbGRSYXRpZnlcbi8vIGRpc2NpcGxpbmUg4oCUIGEgcm9sbGJhY2sgbXVzdCBuZXZlciBsZWFrIGEgam9iLmFkZGVkKS4gQSBmdXR1cmUgYmF0Y2ggcGF0aFxuLy8gcmV1c2VzIHRoaXMgdW5jaGFuZ2VkLlxuZnVuY3Rpb24gYnVpbGRKb2IoaW5wdXQ6IENyZWF0ZUpvYklucHV0KTogeyBqb2I6IEpvYjsgaW5zZXJ0OiAoZGI6IERhdGFiYXNlKSA9PiB2b2lkIH0ge1xuICBpZiAodHlwZW9mIGlucHV0LnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IGlucHV0LnRpdGxlLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImpvYiByZXF1aXJlcyBhIG5vbi1lbXB0eSB0aXRsZVwiKTtcbiAgfVxuICBpZiAodHlwZW9mIGlucHV0LnByb2plY3QgIT09IFwic3RyaW5nXCIgfHwgaW5wdXQucHJvamVjdCA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImpvYiByZXF1aXJlcyBhIHByb2plY3Qgc2NvcGVcIik7XG4gIH1cbiAgY29uc3Qgc3RhdHVzID0gaW5wdXQuc3RhdHVzID09PSB1bmRlZmluZWQgPyBcInF1ZXVlZFwiIDogYXNzZXJ0U3RhdHVzKGlucHV0LnN0YXR1cyk7XG4gIGNvbnN0IGlkID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3Qgam9iOiBKb2IgPSB7XG4gICAgaWQsXG4gICAgcHJvamVjdDogaW5wdXQucHJvamVjdCxcbiAgICB0aXRsZTogaW5wdXQudGl0bGUsXG4gICAgc3RhdHVzLFxuICAgIGNsYWltZWRCeTogbnVsbCxcbiAgICBkZWxpdmVyYWJsZTogaW5wdXQuZGVsaXZlcmFibGUgPz8gbnVsbCxcbiAgICBzdWJ0YXNrczogW10sXG4gICAgZGV0YWlsOiBpbnB1dC5kZXRhaWwgPz8gbnVsbCxcbiAgICBjcmVhdGVkQXQ6IG5vdyxcbiAgICB1cGRhdGVkQXQ6IG5vdyxcbiAgfTtcbiAgY29uc3QgaW5zZXJ0ID0gKGRiOiBEYXRhYmFzZSkgPT4ge1xuICAgIGRiLnJ1bihgSU5TRVJUIElOVE8gam9icyAoJHtKT0JfQ09MVU1OU30pIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgPywgPywgPylgLCBbXG4gICAgICBpZCxcbiAgICAgIGpvYi5wcm9qZWN0LFxuICAgICAgam9iLnRpdGxlLFxuICAgICAgc3RhdHVzLFxuICAgICAgbnVsbCxcbiAgICAgIGpvYi5kZWxpdmVyYWJsZSxcbiAgICAgIFwiW11cIixcbiAgICAgIGpvYi5kZXRhaWwsXG4gICAgICBub3csXG4gICAgICBub3csXG4gICAgXSk7XG4gIH07XG4gIHJldHVybiB7IGpvYiwgaW5zZXJ0IH07XG59XG5cbmZ1bmN0aW9uIHJlYWRKb2IoZGI6IERhdGFiYXNlLCBpZDogc3RyaW5nKTogSm9iIHwgbnVsbCB7XG4gIGNvbnN0IHJvdyA9IGRiLnF1ZXJ5KGBTRUxFQ1QgJHtKT0JfQ09MVU1OU30gRlJPTSBqb2JzIFdIRVJFIGlkID0gP2ApLmdldChpZCkgYXMgSm9iUm93IHwgbnVsbDtcbiAgcmV0dXJuIHJvdyA/IHJvd1RvSm9iKHJvdykgOiBudWxsO1xufVxuXG4vLyBUaGUgL3N0YXRlIG1lcmdlIGlucHV0OiBldmVyeSBqb2IgaW4gdGhpcyBwcm9qZWN0J3Mgc3RvcmUsIG5ld2VzdC11cGRhdGVkXG4vLyBsYXN0IChjcmVhdGVkX2F0IG9yZGVyIGtlZXBzIHRoZSBzaWRlYmFyIHN0YWJsZTsgdGhlIHN1cmZhY2UgZ3JvdXBzIGJ5XG4vLyBzdGF0dXMpLiBVbmZpbHRlcmVkIOKAlCB0aGUgc3RvcmUgaXMgYWxyZWFkeSBwcm9qZWN0LXNjb3BlZC5cbmZ1bmN0aW9uIHJlYWRKb2JzKGRiOiBEYXRhYmFzZSk6IEpvYltdIHtcbiAgY29uc3Qgcm93cyA9IGRiLnF1ZXJ5KGBTRUxFQ1QgJHtKT0JfQ09MVU1OU30gRlJPTSBqb2JzIE9SREVSIEJZIGNyZWF0ZWRfYXRgKS5hbGwoKSBhcyBKb2JSb3dbXTtcbiAgcmV0dXJuIHJvd3MubWFwKHJvd1RvSm9iKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSm9iKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaW5wdXQ6IENyZWF0ZUpvYklucHV0KTogSm9iIHtcbiAgY29uc3QgeyBqb2IsIGluc2VydCB9ID0gYnVpbGRKb2IoaW5wdXQpO1xuICBpbnNlcnQoZGIpO1xuICAvLyBFbWl0IHRoZSBGVUxMIGVudGl0eSByZS1yZWFkIHRocm91Z2ggdGhlIHNpbmdsZSByZWFkZXIgKEQzKSDigJQgbmV2ZXIgdGhlXG4gIC8vIGhhbmQtYnVpbHQgYGpvYmAgb2JqZWN0LCBzbyB0aGUgcGF5bG9hZCBpcyBieXRlLWlkZW50aWNhbCB0byAvc3RhdGUuXG4gIGNvbnN0IGZyZXNoID0gcmVhZEpvYihkYiwgam9iLmlkKTtcbiAgaWYgKGZyZXNoKSBidXMuZW1pdChcImpvYi5hZGRlZFwiLCBmcmVzaCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIGpvYjtcbn1cblxuaW50ZXJmYWNlIFVwZGF0ZUpvYlBhdGNoIHtcbiAgdGl0bGU/OiBzdHJpbmc7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgZGVsaXZlcmFibGU/OiBzdHJpbmcgfCBudWxsO1xuICBkZXRhaWw/OiBzdHJpbmcgfCBudWxsO1xufVxuXG4vLyB1cGRhdGUg4oCUIHRoZSBzY2FsYXItZmllbGQgbXV0YXRvciAodGl0bGUvc3RhdHVzL2RlbGl2ZXJhYmxlL2RldGFpbCkuIE9ubHlcbi8vIHRoZSBmaWVsZHMgUFJFU0VOVCBpbiB0aGUgcGF0Y2ggYXJlIHdyaXR0ZW47IHN0YXR1cyBpcyB2YWxpZGF0ZWQuIFVua25vd24gaWRcbi8vIOKGkiBudWxsICh0aGUgc2VydmVyIDQwNHMpLiBFbWl0cyBqb2IudXBkYXRlZCAoZnVsbCBlbnRpdHkpLlxuZnVuY3Rpb24gdXBkYXRlSm9iKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaWQ6IHN0cmluZywgcGF0Y2g6IFVwZGF0ZUpvYlBhdGNoKTogSm9iIHwgbnVsbCB7XG4gIGlmIChyZWFkSm9iKGRiLCBpZCkgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBjb25zdCBzZXRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBhcmdzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKHBhdGNoLnRpdGxlICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAodHlwZW9mIHBhdGNoLnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IHBhdGNoLnRpdGxlLnRyaW0oKSA9PT0gXCJcIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwidGl0bGUgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmdcIik7XG4gICAgfVxuICAgIHNldHMucHVzaChcInRpdGxlID0gP1wiKTtcbiAgICBhcmdzLnB1c2gocGF0Y2gudGl0bGUpO1xuICB9XG4gIGlmIChwYXRjaC5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgIHNldHMucHVzaChcInN0YXR1cyA9ID9cIik7XG4gICAgYXJncy5wdXNoKGFzc2VydFN0YXR1cyhwYXRjaC5zdGF0dXMpKTtcbiAgfVxuICBpZiAocGF0Y2guZGVsaXZlcmFibGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHNldHMucHVzaChcImRlbGl2ZXJhYmxlID0gP1wiKTtcbiAgICBhcmdzLnB1c2gocGF0Y2guZGVsaXZlcmFibGUpO1xuICB9XG4gIGlmIChwYXRjaC5kZXRhaWwgIT09IHVuZGVmaW5lZCkge1xuICAgIHNldHMucHVzaChcImRldGFpbCA9ID9cIik7XG4gICAgYXJncy5wdXNoKHBhdGNoLmRldGFpbCk7XG4gIH1cbiAgaWYgKHNldHMubGVuZ3RoID09PSAwKVxuICAgIHRocm93IG5ldyBFcnJvcihcInVwZGF0ZSBuZWVkcyBhdCBsZWFzdCBvbmUgb2YgdGl0bGV8c3RhdHVzfGRlbGl2ZXJhYmxlfGRldGFpbFwiKTtcbiAgc2V0cy5wdXNoKFwidXBkYXRlZF9hdCA9ID9cIik7XG4gIGFyZ3MucHVzaChEYXRlLm5vdygpKTtcbiAgYXJncy5wdXNoKGlkKTtcbiAgZGIucnVuKGBVUERBVEUgam9icyBTRVQgJHtzZXRzLmpvaW4oXCIsIFwiKX0gV0hFUkUgaWQgPSA/YCwgYXJncyBhcyBuZXZlcltdKTtcbiAgY29uc3QgZnJlc2ggPSByZWFkSm9iKGRiLCBpZCk7XG4gIGlmIChmcmVzaCkgYnVzLmVtaXQoXCJqb2IudXBkYXRlZFwiLCBmcmVzaCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIGZyZXNoO1xufVxuXG4vLyBjbGFpbSDigJQgdGhlIEFUT01JQyBsZWFzZSBhY3F1aXNpdGlvbiAoU0VBTSBDKS4gT25lIGNvbmRpdGlvbmFsIFVQREFURSBpcyB0aGVcbi8vIHdob2xlIGd1YXJkOiBzZXQgY2xhaW1lZF9ieSArIHN0YXR1cz1ydW5uaW5nIElGRiB1bmNsYWltZWQgT1IgYWxyZWFkeSBtaW5lLlxuLy8gQSBzaW5nbGUgU1FMIHN0YXRlbWVudCBpcyBhdG9taWMgdW5kZXIgYnVuOnNxbGl0ZSwgc28gbm8gZXhwbGljaXQgdHhuIGlzXG4vLyBuZWVkZWQgZm9yIHRoZSBjb21wYXJlLWFuZC1zZXQuIFJlLWNsYWltIGJ5IHRoZSBzYW1lIG93bmVyIG1hdGNoZXMgdGhlIFdIRVJFXG4vLyAoaWRlbXBvdGVudCBzdWNjZXNzKTsgYSBkaWZmZXJlbnQgb3duZXIgbWF0Y2hlcyBub3RoaW5nICjihpIgQ2xhaW1Db25mbGljdCkuXG4vLyBVbmtub3duIGlkIOKGkiBudWxsLiBFbWl0cyBqb2IuY2xhaW1lZCAoZnVsbCBlbnRpdHkpIOKAlCBrZXB0IERJU1RJTkNUIGZyb21cbi8vIGpvYi51cGRhdGVkIGJlY2F1c2UgYSBjbGFpbSBpcyBhIGNvbXBhcmUtYW5kLXNldCB0aGF0IGNhbiBGQUlMIG9uIGNvbnRlbnRpb25cbi8vIGFuZCBpcyB0aGUgbXVsdGktYWdlbnQgb24tcmFtcCdzIGhlYWRsaW5lIHNpZ25hbCAoYSBjb25zdW1lciBtYXkgc3RpbGwgcm91dGVcbi8vIGl0IHRocm91Z2ggdGhlIHNhbWUgd2hvbGVzYWxlLXJlcGxhY2UtYnktaWQgcmVkdWNlciBjYXNlKS5cbmZ1bmN0aW9uIGNsYWltSm9iKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaWQ6IHN0cmluZywgb3duZXI6IHN0cmluZyk6IEpvYiB8IG51bGwge1xuICBpZiAodHlwZW9mIG93bmVyICE9PSBcInN0cmluZ1wiIHx8IG93bmVyLnRyaW0oKSA9PT0gXCJcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihcImNsYWltIHJlcXVpcmVzIGEgbm9uLWVtcHR5IG93bmVyXCIpO1xuICB9XG4gIGNvbnN0IHJlc3VsdCA9IGRiXG4gICAgLnF1ZXJ5KFxuICAgICAgXCJVUERBVEUgam9icyBTRVQgY2xhaW1lZF9ieSA9ID8sIHN0YXR1cyA9ICdydW5uaW5nJywgdXBkYXRlZF9hdCA9ID8gV0hFUkUgaWQgPSA/IEFORCAoY2xhaW1lZF9ieSBJUyBOVUxMIE9SIGNsYWltZWRfYnkgPSA/KVwiLFxuICAgIClcbiAgICAucnVuKG93bmVyLCBEYXRlLm5vdygpLCBpZCwgb3duZXIpO1xuICBpZiAocmVzdWx0LmNoYW5nZXMgPT09IDApIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGRiLnF1ZXJ5KFwiU0VMRUNUIGNsYWltZWRfYnkgRlJPTSBqb2JzIFdIRVJFIGlkID0gP1wiKS5nZXQoaWQpIGFzIHtcbiAgICAgIGNsYWltZWRfYnk6IHN0cmluZyB8IG51bGw7XG4gICAgfSB8IG51bGw7XG4gICAgaWYgKGV4aXN0aW5nID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgICAvLyBjaGFuZ2VzPT09MCB3aXRoIHRoZSByb3cgcHJlc2VudCBtZWFucyBzb21lb25lIGVsc2Ugb3ducyBpdCAoYSBudWxsIG9yXG4gICAgLy8gc2VsZiBvd25lciB3b3VsZCBoYXZlIG1hdGNoZWQgdGhlIFdIRVJFKS5cbiAgICB0aHJvdyBuZXcgQ2xhaW1Db25mbGljdEVycm9yKFN0cmluZyhleGlzdGluZy5jbGFpbWVkX2J5KSk7XG4gIH1cbiAgY29uc3QgZnJlc2ggPSByZWFkSm9iKGRiLCBpZCk7XG4gIGlmIChmcmVzaCkgYnVzLmVtaXQoXCJqb2IuY2xhaW1lZFwiLCBmcmVzaCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIGZyZXNoO1xufVxuXG4vLyByZWxlYXNlIOKAlCBjbGVhcnMgdGhlIGxlYXNlIChENikuIFN0YXR1cyBpcyBsZWZ0IGFzLWlzIChyZWxlYXNpbmcgYSBydW5uaW5nXG4vLyBqb2IgZG9lc24ndCB1bi1ydW4gaXQ7IHRoZSBodW1hbi9hZ2VudCBzZXRzIHN0YXR1cyBleHBsaWNpdGx5KS4gVW5rbm93biBpZCDihpJcbi8vIG51bGwuIEEgcmVsZWFzZSBpcyBhIHBsYWluIGZpZWxkIGNoYW5nZSwgc28gaXQgZW1pdHMgam9iLnVwZGF0ZWQgKGpvYi5jbGFpbWVkXG4vLyBpcyBhY3F1aXNpdGlvbi1vbmx5KS5cbmZ1bmN0aW9uIHJlbGVhc2VKb2IoZGI6IERhdGFiYXNlLCBidXM6IEV2ZW50QnVzLCBpZDogc3RyaW5nKTogSm9iIHwgbnVsbCB7XG4gIGlmIChyZWFkSm9iKGRiLCBpZCkgPT09IG51bGwpIHJldHVybiBudWxsO1xuICBkYi5ydW4oXCJVUERBVEUgam9icyBTRVQgY2xhaW1lZF9ieSA9IE5VTEwsIHVwZGF0ZWRfYXQgPSA/IFdIRVJFIGlkID0gP1wiLCBbRGF0ZS5ub3coKSwgaWRdKTtcbiAgY29uc3QgZnJlc2ggPSByZWFkSm9iKGRiLCBpZCk7XG4gIGlmIChmcmVzaCkgYnVzLmVtaXQoXCJqb2IudXBkYXRlZFwiLCBmcmVzaCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIGZyZXNoO1xufVxuXG4vLyBzdWJ0YXNrcyAoRDQpIOKAlCB0aGUgY2hlY2tsaXN0IG11dGF0b3JzLiBhZGQgYXBwZW5kcyB7aWQ6IHV1aWQsIGxhYmVsLCBkb25lOlxuLy8gZmFsc2V9OyBjaGVjay91bmNoZWNrIGZsaXAgYW4gZXhpc3Rpbmcgc3VidGFzaydzIGRvbmUgYnkgaWQgKGFuIHVua25vd25cbi8vIHN1YnRhc2sgaWQgaXMgYSBsb3VkIGVycm9yLCBOT1QgYSBzaWxlbnQgbm8tb3ApLiBBbGwgZW1pdCBqb2IudXBkYXRlZC5cbmZ1bmN0aW9uIG11dGF0ZVN1YnRhc2tzKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGlkOiBzdHJpbmcsXG4gIG11dGF0ZTogKHN1YnRhc2tzOiBTdWJ0YXNrW10pID0+IHZvaWQsXG4pOiBKb2IgfCBudWxsIHtcbiAgY29uc3Qgam9iID0gcmVhZEpvYihkYiwgaWQpO1xuICBpZiAoam9iID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3VidGFza3MgPSBqb2Iuc3VidGFza3M7XG4gIG11dGF0ZShzdWJ0YXNrcyk7XG4gIGRiLnJ1bihcIlVQREFURSBqb2JzIFNFVCBzdWJ0YXNrc19qc29uID0gPywgdXBkYXRlZF9hdCA9ID8gV0hFUkUgaWQgPSA/XCIsIFtcbiAgICBKU09OLnN0cmluZ2lmeShzdWJ0YXNrcyksXG4gICAgRGF0ZS5ub3coKSxcbiAgICBpZCxcbiAgXSk7XG4gIGNvbnN0IGZyZXNoID0gcmVhZEpvYihkYiwgaWQpO1xuICBpZiAoZnJlc2gpIGJ1cy5lbWl0KFwiam9iLnVwZGF0ZWRcIiwgZnJlc2ggYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIHJldHVybiBmcmVzaDtcbn1cblxuZnVuY3Rpb24gYWRkU3VidGFzayhkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIGlkOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcpOiBKb2IgfCBudWxsIHtcbiAgaWYgKHR5cGVvZiBsYWJlbCAhPT0gXCJzdHJpbmdcIiB8fCBsYWJlbC50cmltKCkgPT09IFwiXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJzdWJ0YXNrIGFkZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBsYWJlbFwiKTtcbiAgfVxuICByZXR1cm4gbXV0YXRlU3VidGFza3MoZGIsIGJ1cywgaWQsIChzdWJ0YXNrcykgPT4ge1xuICAgIHN1YnRhc2tzLnB1c2goeyBpZDogY3J5cHRvLnJhbmRvbVVVSUQoKSwgbGFiZWwsIGRvbmU6IGZhbHNlIH0pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gc2V0U3VidGFza0RvbmUoXG4gIGRiOiBEYXRhYmFzZSxcbiAgYnVzOiBFdmVudEJ1cyxcbiAgaWQ6IHN0cmluZyxcbiAgc3VidGFza0lkOiBzdHJpbmcsXG4gIGRvbmU6IGJvb2xlYW4sXG4pOiBKb2IgfCBudWxsIHtcbiAgLy8gUmVzb2x2ZSBleGlzdGVuY2UgRklSU1Qgc28gYW4gdW5rbm93biBKT0IgaXMgbnVsbCAoNDA0KSBhbmQgYW4gdW5rbm93blxuICAvLyBTVUJUQVNLIG9uIGEga25vd24gam9iIGlzIGEgbG91ZCA0MDAg4oCUIGRpc3RpbmN0IGZhaWx1cmVzLCBkaXN0aW5jdCBjb2Rlcy5cbiAgaWYgKHJlYWRKb2IoZGIsIGlkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBtdXRhdGVTdWJ0YXNrcyhkYiwgYnVzLCBpZCwgKHN1YnRhc2tzKSA9PiB7XG4gICAgY29uc3Qgc3VidGFzayA9IHN1YnRhc2tzLmZpbmQoKHMpID0+IHMuaWQgPT09IHN1YnRhc2tJZCk7XG4gICAgaWYgKHN1YnRhc2sgPT09IHVuZGVmaW5lZCkgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIHN1YnRhc2s6ICR7c3VidGFza0lkfWApO1xuICAgIHN1YnRhc2suZG9uZSA9IGRvbmU7XG4gIH0pO1xufVxuXG4vLyBkZWxldGUg4oCUIHRoaW4gKEQzKTogZHJvcCB0aGUgcm93LCBlbWl0IGpvYi5kZWxldGVkIHtpZH0uIFVua25vd24gaWQg4oaSIG51bGwuXG5mdW5jdGlvbiBkZWxldGVKb2IoZGI6IERhdGFiYXNlLCBidXM6IEV2ZW50QnVzLCBpZDogc3RyaW5nKTogeyBpZDogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKHJlYWRKb2IoZGIsIGlkKSA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIGRiLnJ1bihcIkRFTEVURSBGUk9NIGpvYnMgV0hFUkUgaWQgPSA/XCIsIFtpZF0pO1xuICBidXMuZW1pdChcImpvYi5kZWxldGVkXCIsIHsgaWQgfSk7XG4gIHJldHVybiB7IGlkIH07XG59XG5cbmV4cG9ydCB0eXBlIHsgQ3JlYXRlSm9iSW5wdXQsIEpvYiwgSm9iU3RhdHVzLCBTdWJ0YXNrLCBVcGRhdGVKb2JQYXRjaCB9O1xuZXhwb3J0IHtcbiAgYWRkU3VidGFzayxcbiAgYnVpbGRKb2IsXG4gIENsYWltQ29uZmxpY3RFcnJvcixcbiAgY2xhaW1Kb2IsXG4gIGNyZWF0ZUpvYixcbiAgZGVsZXRlSm9iLFxuICBKT0JfU1RBVFVTRVMsXG4gIHJlYWRKb2IsXG4gIHJlYWRKb2JzLFxuICByZWxlYXNlSm9iLFxuICBzZXRTdWJ0YXNrRG9uZSxcbiAgdXBkYXRlSm9iLFxufTtcbiIsCiAgICAiLy8gVjEueCBDbGFpbSBCIOKAlCBgbWFyayA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl1gIGJhY2tpbmc6IGFuXG4vLyBhcHBlbmQtb25seSBzdGlnbWVyZ2ljIHRyYWlsIG9uIGRvY3M7IHRoZSBsYXRlc3Qgcm93IHBlciBkb2MgaXMgdGhlIGxpdmVcbi8vIG1hcmsuIFN0YXR1cyB2b2NhYnVsYXJ5IGlzIGRlbGliZXJhdGVseSBmcmVlZm9ybSAoYW5hbHl6ZWQvcmVhZC9za2ltbWVkL+KApilcbi8vIGFuZCBgbm90ZWAgY2FycmllcyB0aGUganVkZ21lbnQgSU5DTFVESU5HIG51bGwgcmVzdWx0cyAoXCJub3RoaW5nIHdvcnRoXG4vLyBleHRyYWN0aW5nXCIgaXMgYSBmaW5kaW5nKS4gZG9jX210aW1lIHNuYXBzaG90cyB0aGUgZG9jIGZpbGUncyBtdGltZSBhdFxuLy8gbWFyayB0aW1lIHNvIHN0YWxlbmVzcyBpcyByZWFkLXRpbWUtY29tcHV0ZWQgKGN1cnJlbnQgbXRpbWUgPiBtYXJrZWRcbi8vIG10aW1lOyBtaXNzaW5nIGZpbGUg4oaSIHN0YWxlKSDigJQgdGhlIE9wZXJhdG9yIGluZGV4ZWRBdCBwYXJ0aWFsLWluZGV4LXRydXN0XG4vLyBwcmluY2lwbGUuIGBzdGFsZWAgbGl2ZXMgaW4gL3N0YXRlIG9ubHksIG5ldmVyIGluIHRoZSBkb2MubWFya2VkIGV2ZW50LlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB7IHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IEV2ZW50QnVzIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5pbXBvcnQgeyBTTFVHX1JFIH0gZnJvbSBcIi4vcHJvamVjdC50c1wiO1xuXG4vLyBUaGUgZXZlbnQgcGF5bG9hZCBzaGFwZSAoZnVsbCBtYXJrIGlubGluZSDigJQgbWFya3MgYXJlIHNtYWxsIGFuZFxuLy8gYXBwZW5kLW9ubHk7IHRoaW4tcmVmZXRjaCBpcyBmb3IgbXV0YWJsZSBlbnRpdGllcykuIE5vIGBzdGFsZWAgaGVyZS5cbmludGVyZmFjZSBEb2NNYXJrIHtcbiAgYXV0aG9yOiBzdHJpbmc7XG4gIG5vdGU6IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogc3RyaW5nO1xuICB0czogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTWFya0lucHV0IHtcbiAgZG9jSWQ6IHN0cmluZztcbiAgYXV0aG9yOiBzdHJpbmc7XG4gIHN0YXR1czogc3RyaW5nO1xuICBub3RlPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgTWFya1JvdyB7XG4gIGRvY19pZDogc3RyaW5nO1xuICBhdXRob3I6IHN0cmluZztcbiAgbm90ZTogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIGRvY19tdGltZTogbnVtYmVyIHwgbnVsbDtcbiAgdHM6IG51bWJlcjtcbn1cblxuZnVuY3Rpb24gZG9jRmlsZU10aW1lKHByb2plY3REaXI6IHN0cmluZywgcmVsUGF0aDogc3RyaW5nKTogbnVtYmVyIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIE1hdGguZmxvb3Ioc3RhdFN5bmMoam9pbihwcm9qZWN0RGlyLCByZWxQYXRoKSkubXRpbWVNcyk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFB1cmUgc3RhbGVuZXNzIHJ1bGUsIHN0YXRlZCBvbmNlOiB1bmtub3duIG10aW1lcyByZWFkIGFzIHN0YWxlIChhIG1hcmsgb25cbi8vIGEgZmlsZSB3ZSBjYW4ndCBzZWUgYW55bW9yZSB2b3VjaGVzIGZvciBub3RoaW5nKS5cbmZ1bmN0aW9uIGlzU3RhbGUobWFya2VkTXRpbWU6IG51bWJlciB8IG51bGwsIGN1cnJlbnRNdGltZTogbnVtYmVyIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAobWFya2VkTXRpbWUgPT09IG51bGwgfHwgY3VycmVudE10aW1lID09PSBudWxsKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGN1cnJlbnRNdGltZSA+IG1hcmtlZE10aW1lO1xufVxuXG4vLyBQdXJlIGxhdGVzdC1wZXItZG9jIHJlZHVjdGlvbiBvdmVyIGFuIGFwcGVuZC1vbmx5IHRyYWlsLiBSb3dzIG11c3QgYXJyaXZlXG4vLyBpbiBpbnNlcnRpb24gb3JkZXIgKHJvd2lkKSDigJQgdHMgYWxvbmUgaXMgc2Vjb25kLWdyYW51bGFyIGFuZCBjYW4gdGllLlxuZnVuY3Rpb24gbGF0ZXN0UGVyRG9jKHJvd3M6IE1hcmtSb3dbXSk6IE1hcDxzdHJpbmcsIE1hcmtSb3c+IHtcbiAgY29uc3QgbGF0ZXN0ID0gbmV3IE1hcDxzdHJpbmcsIE1hcmtSb3c+KCk7XG4gIGZvciAoY29uc3Qgcm93IG9mIHJvd3MpIGxhdGVzdC5zZXQocm93LmRvY19pZCwgcm93KTtcbiAgcmV0dXJuIGxhdGVzdDtcbn1cblxuZnVuY3Rpb24gbWFya0RvYyhkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIHByb2plY3REaXI6IHN0cmluZywgaW5wdXQ6IE1hcmtJbnB1dCk6IERvY01hcmsge1xuICBpZiAoIVNMVUdfUkUudGVzdChpbnB1dC5kb2NJZCkpIHRocm93IG5ldyBFcnJvcihgaW52YWxpZCBkb2MgaWQ6ICR7aW5wdXQuZG9jSWR9YCk7XG4gIGNvbnN0IGRvYyA9IGRiLnF1ZXJ5KFwiU0VMRUNUIHBhdGggRlJPTSBkb2NzIFdIRVJFIGlkID0gP1wiKS5nZXQoaW5wdXQuZG9jSWQpIGFzIHtcbiAgICBwYXRoOiBzdHJpbmc7XG4gIH0gfCBudWxsO1xuICBpZiAoIWRvYykgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIGRvYzogJHtpbnB1dC5kb2NJZH1gKTtcbiAgaWYgKHR5cGVvZiBpbnB1dC5zdGF0dXMgIT09IFwic3RyaW5nXCIgfHwgaW5wdXQuc3RhdHVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIm1hcmsgcmVxdWlyZXMgYSBub24tZW1wdHkgc3RhdHVzXCIpO1xuICB9XG4gIGNvbnN0IGRvY010aW1lID0gZG9jRmlsZU10aW1lKHByb2plY3REaXIsIGRvYy5wYXRoKTtcbiAgY29uc3QgdHMgPSBNYXRoLmZsb29yKERhdGUubm93KCkgLyAxMDAwKTtcbiAgZGIucnVuKFxuICAgIFwiSU5TRVJUIElOVE8gZG9jX21hcmtzIChpZCwgZG9jX2lkLCBhdXRob3IsIG5vdGUsIHN0YXR1cywgZG9jX210aW1lLCB0cykgVkFMVUVTICg/LCA/LCA/LCA/LCA/LCA/LCA/KVwiLFxuICAgIFtcbiAgICAgIGNyeXB0by5yYW5kb21VVUlEKCksXG4gICAgICBpbnB1dC5kb2NJZCxcbiAgICAgIGlucHV0LmF1dGhvcixcbiAgICAgIGlucHV0Lm5vdGUgPz8gbnVsbCxcbiAgICAgIGlucHV0LnN0YXR1cyxcbiAgICAgIGRvY010aW1lLFxuICAgICAgdHMsXG4gICAgXSxcbiAgKTtcbiAgY29uc3QgbWFyazogRG9jTWFyayA9IHtcbiAgICBhdXRob3I6IGlucHV0LmF1dGhvcixcbiAgICBub3RlOiBpbnB1dC5ub3RlID8/IG51bGwsXG4gICAgc3RhdHVzOiBpbnB1dC5zdGF0dXMsXG4gICAgdHMsXG4gIH07XG4gIGJ1cy5lbWl0KFwiZG9jLm1hcmtlZFwiLCB7IGRvY0lkOiBpbnB1dC5kb2NJZCwgbWFyazogbWFyayBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IH0pO1xuICByZXR1cm4gbWFyaztcbn1cblxuLy8gVGhlIC9zdGF0ZSBtZXJnZTogbGF0ZXN0IG1hcmsgcGVyIGRvYyB3aXRoIHJlYWQtdGltZSBzdGFsZS4gYG10aW1lT2ZgXG4vLyByZXNvbHZlcyBhIGRvYydzIENVUlJFTlQgZmlsZSBtdGltZSDigJQgbnVsbCB3aGVuIHRoZSBwcm9qZWN0IHJvb3QgaXNcbi8vIHVua25vd24gb3IgdGhlIGZpbGUgaXMgZ29uZSAoYm90aCByZWFkIGFzIHN0YWxlLCBob25lc3RseSkuXG5mdW5jdGlvbiByZWFkRG9jTWFya3MoXG4gIGRiOiBEYXRhYmFzZSxcbiAgbXRpbWVPZjogKGRvY0lkOiBzdHJpbmcpID0+IG51bWJlciB8IG51bGwsXG4pOiBNYXA8c3RyaW5nLCBEb2NNYXJrICYgeyBzdGFsZTogYm9vbGVhbiB9PiB7XG4gIGNvbnN0IHJvd3MgPSBkYlxuICAgIC5xdWVyeShcIlNFTEVDVCBkb2NfaWQsIGF1dGhvciwgbm90ZSwgc3RhdHVzLCBkb2NfbXRpbWUsIHRzIEZST00gZG9jX21hcmtzIE9SREVSIEJZIHJvd2lkXCIpXG4gICAgLmFsbCgpIGFzIE1hcmtSb3dbXTtcbiAgY29uc3Qgb3V0ID0gbmV3IE1hcDxzdHJpbmcsIERvY01hcmsgJiB7IHN0YWxlOiBib29sZWFuIH0+KCk7XG4gIGZvciAoY29uc3QgW2RvY0lkLCByb3ddIG9mIGxhdGVzdFBlckRvYyhyb3dzKSkge1xuICAgIG91dC5zZXQoZG9jSWQsIHtcbiAgICAgIGF1dGhvcjogcm93LmF1dGhvcixcbiAgICAgIG5vdGU6IHJvdy5ub3RlLFxuICAgICAgc3RhdHVzOiByb3cuc3RhdHVzLFxuICAgICAgc3RhbGU6IGlzU3RhbGUocm93LmRvY19tdGltZSwgbXRpbWVPZihkb2NJZCkpLFxuICAgICAgdHM6IHJvdy50cyxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgdHlwZSB7IERvY01hcmssIE1hcmtJbnB1dCwgTWFya1JvdyB9O1xuZXhwb3J0IHsgZG9jRmlsZU10aW1lLCBpc1N0YWxlLCBsYXRlc3RQZXJEb2MsIG1hcmtEb2MsIHJlYWREb2NNYXJrcyB9O1xuIiwKICAgICIvLyBQMSDigJQgcHJvamVjdCBsaWZlY3ljbGUuIEEgcHJvamVjdCBpcyBhIGRpcmVjdG9yeSBuYW1lICsgYSBzdG9yZS5zcWxpdGUgKyBhXG4vLyBkb2NzLyBzdWJmb2xkZXIgKyBhIHByb2plY3QuanNvbiAoe3RpdGxlfSkg4oCUIG5vdGhpbmcgZmFuY2llciAoQ2xhaW0gQS9COlxuLy8gdGhlIGRhZW1vbiBpcyBhIGR1bWIgc3RhdGUgYXV0aG9yaXR5OyBrZWVwIHRoZSBkdW1iZXN0IHNoYXBlIHRoYXQgd29ya3MpLlxuXG5pbXBvcnQgeyBleGlzdHNTeW5jLCBta2RpclN5bmMsIHJlYWRkaXJTeW5jLCByZWFkRmlsZVN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IG9wZW5TdG9yZSB9IGZyb20gXCIuL2RiLnRzXCI7XG5cbmNvbnN0IERFRkFVTFRfUFJPSkVDVF9JRCA9IFwiZGVmYXVsdFwiO1xuLy8gU2hhcmVkIHNsdWcgZ3VhcmQg4oCUIHByb2plY3QgaWRzIEFORCBkb2MgaWRzIGFyZSBhZ3JlZWQgc2x1Z3M7IGFueXRoaW5nIGVsc2Vcbi8vIChwYXRoIHRyYXZlcnNhbCwgc2VwYXJhdG9ycykgbXVzdCBiZSByZWplY3RlZCBiZWZvcmUgaXQgcmVhY2hlcyBhXG4vLyBmaWxlc3lzdGVtIHBhdGguIFNpbmdsZSBzb3VyY2U6IGV2ZXJ5IHJlYWQgQU5EIHdyaXRlIHBhdGggaW1wb3J0cyB0aGlzLlxuZXhwb3J0IGNvbnN0IFNMVUdfUkUgPSAvXlthLXowLTldW2EtejAtOS1dKiQvO1xuY29uc3QgSURfUkUgPSBTTFVHX1JFO1xuXG5pbnRlcmZhY2UgUHJvamVjdE1ldGEge1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBwcm9qZWN0RGlyKGhvbWU6IHN0cmluZywgaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKGhvbWUsIFwicHJvamVjdHNcIiwgaWQpO1xufVxuXG5mdW5jdGlvbiByZWFkTWV0YShkaXI6IHN0cmluZywgaWQ6IHN0cmluZyk6IFByb2plY3RNZXRhIHtcbiAgY29uc3QgbWV0YUZpbGUgPSBqb2luKGRpciwgXCJwcm9qZWN0Lmpzb25cIik7XG4gIGlmIChleGlzdHNTeW5jKG1ldGFGaWxlKSkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhtZXRhRmlsZSwgXCJ1dGY4XCIpKSBhcyB7IHRpdGxlPzogdW5rbm93biB9O1xuICAgICAgaWYgKHR5cGVvZiBwYXJzZWQudGl0bGUgPT09IFwic3RyaW5nXCIpIHJldHVybiB7IGlkLCB0aXRsZTogcGFyc2VkLnRpdGxlIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBmYWxsIHRocm91Z2ggdG8gaWQtYXMtdGl0bGUgKi9cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgaWQsIHRpdGxlOiBpZCB9O1xufVxuXG5mdW5jdGlvbiBlbnN1cmVQcm9qZWN0RGlycyhkaXI6IHN0cmluZyk6IHZvaWQge1xuICBta2RpclN5bmMoam9pbihkaXIsIFwiZG9jc1wiKSwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZVByb2plY3QoaG9tZTogc3RyaW5nLCBpZDogc3RyaW5nLCB0aXRsZTogc3RyaW5nKTogUHJvamVjdE1ldGEge1xuICBpZiAoIUlEX1JFLnRlc3QoaWQpKSB0aHJvdyBuZXcgRXJyb3IoYGludmFsaWQgcHJvamVjdCBpZDogJHtpZH1gKTtcbiAgY29uc3QgZGlyID0gcHJvamVjdERpcihob21lLCBpZCk7XG4gIGlmIChleGlzdHNTeW5jKGRpcikpIHRocm93IG5ldyBFcnJvcihgcHJvamVjdCBhbHJlYWR5IGV4aXN0czogJHtpZH1gKTtcbiAgZW5zdXJlUHJvamVjdERpcnMoZGlyKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRpciwgXCJwcm9qZWN0Lmpzb25cIiksIEpTT04uc3RyaW5naWZ5KHsgdGl0bGUgfSwgbnVsbCwgMikpO1xuICBvcGVuU3RvcmUoam9pbihkaXIsIFwic3RvcmUuc3FsaXRlXCIpKS5jbG9zZSgpO1xuICByZXR1cm4geyBpZCwgdGl0bGUgfTtcbn1cblxuLy8gUm91bmQgMyAoQ2xhaW0gUDEsIGFzIGNvcnJlY3RlZCk6IGEgcHJvamVjdGxlc3Mgc3RvcmUgYm9vdHMgRU1QVFkg4oCUIHRoZVxuLy8gZGVmYXVsdCBwcm9qZWN0IGlzIG5ldmVyIGF1dG8tbWludGVkIChhbmQgdGhlIGRlbW8tc2VlZCBwYXRoIGlzIGdvbmUgd2l0aFxuLy8gaXQsIGxlYWQgcnVsaW5nKS4gQW4gdW5zY29wZWQgcmVxdWVzdCByZXNvbHZlcyB0byBcImRlZmF1bHRcIiBpZmYgaXRzIGRpclxuLy8gYWxyZWFkeSBleGlzdHMgKGxlZ2FjeSBzdG9yZXMga2VlcCB3b3JraW5nIHVuc2NvcGVkLCBubyBtaWdyYXRpb24pOyBlbHNlXG4vLyB0aGlzIHR5cGVkIGVycm9yIHN1cmZhY2VzIGFzIDQwOSB7ZXJyb3I6XCJuZWVkcy1wcm9qZWN0XCIsIHByb2plY3RzOlsuLi5dfVxuLy8gZnJvbSBldmVyeSBzY29wZWQgZW5kcG9pbnQsIGFuZCB0aGUgc3VyZmFjZSByZW5kZXJzIHBpY2stb3ItY3JlYXRlLlxuY2xhc3MgTmVlZHNQcm9qZWN0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHN1cGVyKFwibm8gcHJvamVjdCBzY29wZSBhbmQgbm8gZGVmYXVsdCBwcm9qZWN0IOKAlCBjcmVhdGUgb3IgcGljayBvbmVcIik7XG4gICAgdGhpcy5uYW1lID0gXCJOZWVkc1Byb2plY3RFcnJvclwiO1xuICB9XG59XG5cbi8vIFVua25vd24tYnV0LW5hbWVkIHNjb3BlIHN0YXlzIGl0cyBvd24gZmFpbHVyZSAoYSA0MDQsIHBlciBDb250cmFjdCA5KSDigJRcbi8vIGRpc3RpbmN0IGZyb20gdGhlIHByb2plY3RsZXNzIDQwOTogdGhlIGNhbGxlciBuYW1lZCBzb21ldGhpbmcgdGhhdCBpc24ndFxuLy8gdGhlcmUsIG5vdCBub3RoaW5nIGF0IGFsbC5cbmNsYXNzIFVua25vd25Qcm9qZWN0RXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKGlkOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgdW5rbm93biBwcm9qZWN0OiAke2lkfWApO1xuICAgIHRoaXMubmFtZSA9IFwiVW5rbm93blByb2plY3RFcnJvclwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVQcm9qZWN0KGhvbWU6IHN0cmluZywgaWQ/OiBzdHJpbmcpOiBQcm9qZWN0TWV0YSB7XG4gIGlmIChpZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgZGlyID0gcHJvamVjdERpcihob21lLCBERUZBVUxUX1BST0pFQ1RfSUQpO1xuICAgIGlmICghZXhpc3RzU3luYyhkaXIpKSB0aHJvdyBuZXcgTmVlZHNQcm9qZWN0RXJyb3IoKTtcbiAgICByZXR1cm4gcmVhZE1ldGEoZGlyLCBERUZBVUxUX1BST0pFQ1RfSUQpO1xuICB9XG4gIGNvbnN0IGRpciA9IHByb2plY3REaXIoaG9tZSwgaWQpO1xuICBpZiAoIWV4aXN0c1N5bmMoZGlyKSkgdGhyb3cgbmV3IFVua25vd25Qcm9qZWN0RXJyb3IoaWQpO1xuICByZXR1cm4gcmVhZE1ldGEoZGlyLCBpZCk7XG59XG5cbmZ1bmN0aW9uIGxpc3RQcm9qZWN0cyhob21lOiBzdHJpbmcpOiBQcm9qZWN0TWV0YVtdIHtcbiAgY29uc3Qgcm9vdCA9IGpvaW4oaG9tZSwgXCJwcm9qZWN0c1wiKTtcbiAgaWYgKCFleGlzdHNTeW5jKHJvb3QpKSByZXR1cm4gW107XG4gIHJldHVybiByZWFkZGlyU3luYyhyb290LCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkuaXNEaXJlY3RvcnkoKSlcbiAgICAubWFwKChlbnRyeSkgPT4gcmVhZE1ldGEoam9pbihyb290LCBlbnRyeS5uYW1lKSwgZW50cnkubmFtZSkpO1xufVxuXG5leHBvcnQgdHlwZSB7IFByb2plY3RNZXRhIH07XG5leHBvcnQge1xuICBjcmVhdGVQcm9qZWN0LFxuICBsaXN0UHJvamVjdHMsXG4gIE5lZWRzUHJvamVjdEVycm9yLFxuICBwcm9qZWN0RGlyLFxuICByZXNvbHZlUHJvamVjdCxcbiAgVW5rbm93blByb2plY3RFcnJvcixcbn07XG4iLAogICAgIi8vIFAxIOKAlCB0aGUgc3FsaXRlIHNjaGVtYSAoQ2xhaW0gQjogZG9jcyBvd24gcHJvc2UsIHNxbGl0ZSBvd25zIGdyYXBoIGluZGV4LFxuLy8gc3RhZ2luZywgY29udmVyc2F0aW9uIGxvZywgRlRTNSkuIE9uZSBmaWxlLCBvbmUgdmVyc2lvbiwgaWRlbXBvdGVudFxuLy8gQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMg4oCUIG5vIHNlcGFyYXRlIG1pZ3JhdGlvbiBydW5uZXIgaW4gVjEgKHJhdGlmaWVkLFxuLy8gdmluZSBtc2cgNikuIFJlLW9wZW5pbmcgYW4gZXhpc3Rpbmcgc3RvcmUgbXVzdCBuZXZlciBlcnJvciBvciBkdXBsaWNhdGUuXG4vL1xuLy8gQW1lbmRtZW50IChwcm9zcGVybydzIFAxIGdhdGUgZmluZGluZywgdmluZSBtc2cgMjApOiBDUkVBVEUgVEFCTEUgSUYgTk9UXG4vLyBFWElTVFMgZG9lcyBub3RoaW5nIGZvciBhIHRhYmxlIHRoYXQgYWxyZWFkeSBleGlzdHMgdW5kZXIgYW4gT0xERVIgc2hhcGUg4oCUXG4vLyBhbiBleGlzdGluZyBzdG9yZSBvcGVuZWQgYnkgbmV3ZXIgY29kZSBuZWVkcyBpdHMgY29sdW1ucyBkaWZmZWQgYW5kXG4vLyBiYWNrZmlsbGVkLiBTdGlsbCBub3QgYSBtaWdyYXRpb24gcnVubmVyOiBhZGRpdGl2ZS1vbmx5IChudWxsYWJsZSBBRERcbi8vIENPTFVNTiksIGFwcGxpZWQgb24gZXZlcnkgb3Blbiwgbm8gdmVyc2lvbmluZy9vcmRlcmluZyB0byBtYW5hZ2UuIEFueXRoaW5nXG4vLyB0aGF0IGNhbid0IGJlIGV4cHJlc3NlZCBhcyBhbiBhZGRpdGl2ZSBBREQgQ09MVU1OIChhIHR5cGUgY2hhbmdlLCBhIG5ld1xuLy8gUFJJTUFSWSBLRVkpIHRocm93cyBuYW1pbmcgdGhlIHN0b3JlIHBhdGgg4oCUIGZhaWwgbG91ZCwgZG9uJ3QgY29ycnVwdC5cblxuaW1wb3J0IHsgRGF0YWJhc2UgfSBmcm9tIFwiYnVuOnNxbGl0ZVwiO1xuXG4vLyBDb2x1bW5zIGFkZGVkIHRvIGEgdGFibGUgYWZ0ZXIgaXRzIG9yaWdpbmFsIHNoYXBlIHNoaXBwZWQuIERlY2xhcmVkXG4vLyBudWxsYWJsZSAobm8gTk9UIE5VTEwvREVGQVVMVCBiZXlvbmQgd2hhdCBBREQgQ09MVU1OIGFsbG93cykgc28gdGhleSdyZVxuLy8gYWx3YXlzIGFkZGFibGUgdG8gYSBwb3B1bGF0ZWQgdGFibGUuXG5jb25zdCBBRERJVElWRV9DT0xVTU5TOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmdbXT4gPSB7XG4gIG1lc3NhZ2VzOiBbXCJpZFwiLCBcImtpbmRcIiwgXCJncm91bmRfanNvblwiXSxcbiAgLy8gUm91bmQgNCAoSzEpOiB3aG8gYXNzZXJ0ZWQgYSBkb2MncyBraW5kIChcInVzZXJcInxcImFnZW50XCIpLiBOdWxsYWJsZSDigJRcbiAgLy8gbGVnYWN5IHJvd3MgYXJlIGhvbmVzdGx5IHVuYXR0cmlidXRlZCAoa2luZEF1dGhvciBudWxsIG9uIHRoZSB3aXJlKS5cbiAgZG9jczogW1wia2luZF9hdXRob3JcIl0sXG4gIC8vIFJvdW5kIDUgKFNHMSk6IGEgbm9kZSdzIHBhcmVudCBpbiB0aGUgc3VibWFwIHRyZWUgKG51bGwgPSB0b3AtbGV2ZWwpLlxuICAvLyBOdWxsYWJsZSDigJQgbGVnYWN5IHJvd3MgYXJlIHRvcC1sZXZlbCBieSBjb25zdHJ1Y3Rpb24uIFJlYWwtbm9kZXMtb25seTpcbiAgLy8gcHJvcG9zYWxzIGFyZSBuZXZlciBhbmNob3JlZCAodGhleSByYXRpZnkgaW50byBhIG5vZGUsIFRIRU4gY2FuIGJlXG4gIC8vIGFuY2hvcmVkKS4ga2luZF9hdXRob3IgcHJlY2VkZW50IChhZGRpdGl2ZSBhZnRlciB0aGUgc2hhcGUgc2hpcHBlZCkuXG4gIG5vZGVzOiBbXCJhbmNob3Jfbm9kZV9pZFwiXSxcbiAgLy8gUm91bmQgMTIgKFNFQU0gMSk6IHRoZSBzdGFnaW5nIEFDVCBhIHByb3Bvc2FsIGNhbWUgZnJvbS4gTnVsbGFibGUg4oCUIGV2ZXJ5XG4gIC8vIHByZS1SMTIgcm93IChhbmQgZXZlcnkgdW5iYXRjaGVkIHNpbmdsZSBwcm9wb3NlKSBpcyBob25lc3RseSB1bmJhdGNoZWQuXG4gIHByb3Bvc2FsczogW1wicmVzdWx0X25vZGVfaWRcIiwgXCJhdXRob3JcIiwgXCJldmlkZW5jZV9tZXNzYWdlX2lkXCIsIFwiem9uZV9pZFwiLCBcImJhdGNoX2lkXCJdLFxuICAvLyBSb3VuZCAzIChDbGFpbSBWMik6IGRvYy1sZW5zIOKAlCBsZW5zIHJvd3Mgd3JpdHRlbiBiZWZvcmUgdGhlIGRvYyBtb2RlXG4gIC8vIHNoaXBwZWQgc2ltcGx5IGNhcnJ5IGEgbnVsbCBkb2NfaWQgKGEgbm9kZSBsZW5zLCB1bmNoYW5nZWQpLlxuICBsZW5zOiBbXCJkb2NfaWRcIl0sXG59O1xuXG5mdW5jdGlvbiBiYWNrZmlsbENvbHVtbnMoZGI6IERhdGFiYXNlLCBwYXRoOiBzdHJpbmcpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbdGFibGUsIGNvbHVtbnNdIG9mIE9iamVjdC5lbnRyaWVzKEFERElUSVZFX0NPTFVNTlMpKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBuZXcgU2V0KFxuICAgICAgKGRiLnF1ZXJ5KGBQUkFHTUEgdGFibGVfaW5mbygke3RhYmxlfSlgKS5hbGwoKSBhcyBBcnJheTx7IG5hbWU6IHN0cmluZyB9PikubWFwKChjKSA9PiBjLm5hbWUpLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBjb2x1bW4gb2YgY29sdW1ucykge1xuICAgICAgaWYgKGV4aXN0aW5nLmhhcyhjb2x1bW4pKSBjb250aW51ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGRiLmV4ZWMoYEFMVEVSIFRBQkxFICR7dGFibGV9IEFERCBDT0xVTU4gJHtjb2x1bW59IFRFWFRgKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBtaW5kLW1hcHBlcjogbm9uLWFkZGl0aXZlIHNjaGVtYSBjaGFuZ2UgbmVlZGVkIGZvciAke3RhYmxlfS4ke2NvbHVtbn0gaW4gJHtwYXRofTogJHtcbiAgICAgICAgICAgIGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKVxuICAgICAgICAgIH1gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuXG5jb25zdCBTQ0hFTUEgPSBgXG4tLSBraW5kIChSb3VuZCA0LCBLMSk6IFNRTGl0ZSBjYW5ub3QgcmVsYXggTk9UIE5VTEwgYWRkaXRpdmVseSAobWVhc3VyZWQsXG4tLSByYXRpZnkgc2NyYXRjaCAyMDI2LTA3LTE5KSwgc28gXCJ1bnR5cGVkXCIgaXMgdGhlICcnIHNlbnRpbmVsIGF0IHJlc3QsXG4tLSBudWxsLW5vcm1hbGl6ZWQgYXQgcmVhZCBldmVyeXdoZXJlIGl0IHJpZGVzIHRoZSB3aXJlLiBUaGUgaW5nZXN0IGRlZmF1bHRzXG4tLSAoXCJyYW1ibGVcIi9cInN0b3J5XCIpIGRpZWQgd2l0aCB0aGlzIOKAlCBhIGZyZXNoIGRvYyBpcyAnJyB1bnRpbCBzb21lb25lXG4tLSBhc3NlcnRzIGEga2luZC4ga2luZF9hdXRob3IgaXMgbnVsbGFibGUtVEVYVC1vbmx5IGJlY2F1c2UgaXQgYXJyaXZlZCB2aWFcbi0tIEFERElUSVZFX0NPTFVNTlMgYWZ0ZXIgdGhlIG9yaWdpbmFsIHNoYXBlIHNoaXBwZWQgKGZyZXNoLWVxdWFscy1taWdyYXRlZCkuXG5DUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBkb2NzIChcbiAgaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgdGl0bGUgVEVYVCBOT1QgTlVMTCxcbiAga2luZCBURVhUIE5PVCBOVUxMLFxuICBwYXRoIFRFWFQgTk9UIE5VTEwsXG4gIGNyZWF0ZWRfYXQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUICh1bml4ZXBvY2goKSksXG4gIGtpbmRfYXV0aG9yIFRFWFRcbik7XG5cbi0tIGFuY2hvcl9ub2RlX2lkIChSb3VuZCA1LCBTRzEpOiBhIG5vZGUncyBwYXJlbnQgaW4gdGhlIHN1Ym1hcCB0cmVlIOKAlFxuLS0gbnVsbGFibGUtVEVYVC1vbmx5IGJlY2F1c2UgaXQgYXJyaXZlZCB2aWEgQURESVRJVkVfQ09MVU1OUyBhZnRlciB0aGVcbi0tIG9yaWdpbmFsIHNoYXBlIHNoaXBwZWQgKGZyZXNoLWVxdWFscy1taWdyYXRlZCkuIG51bGwgPSB0b3AtbGV2ZWw7IGEgc3RyaWN0XG4tLSB0cmVlIChvbmUgYW5jaG9yIHBlciBub2RlKSwgb3J0aG9nb25hbCB0byB6b25lX2lkLiBDeWNsZS1mcmVlZG9tIGlzXG4tLSBlbmZvcmNlZCBhdCB0aGUgd3JpdGUgcGF0aCAoYW5jaG9yLnRzIGFuY2VzdG9yLXdhbGspLCBuZXZlciBieSB0aGUgc2NoZW1hLlxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbm9kZXMgKFxuICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICBraW5kIFRFWFQgTk9UIE5VTEwsXG4gIHRpZXIgVEVYVCBOT1QgTlVMTCxcbiAgdGl0bGUgVEVYVCBOT1QgTlVMTCxcbiAgc3lub3BzaXMgVEVYVCBOT1QgTlVMTCxcbiAgY3JlYXRlZF9hdCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgKHVuaXhlcG9jaCgpKSxcbiAgYW5jaG9yX25vZGVfaWQgVEVYVFxuKTtcblxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgZWRnZXMgKFxuICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICBzb3VyY2UgVEVYVCBOT1QgTlVMTCxcbiAgdGFyZ2V0IFRFWFQgTk9UIE5VTEwsXG4gIGxhYmVsIFRFWFQgTk9UIE5VTEwsXG4gIHByb3ZlbmFuY2UgVEVYVCBOT1QgTlVMTCxcbiAgZGlyZWN0aW9uIFRFWFQsXG4gIGNyZWF0ZWRfYXQgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUICh1bml4ZXBvY2goKSlcbik7XG5cbkNSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIHNvdXJjZXMgKFxuICBub2RlX2lkIFRFWFQgTk9UIE5VTEwsXG4gIGRvY19pZCBURVhUIE5PVCBOVUxMLFxuICBzcGFuIFRFWFRcbik7XG5cbi0tIHJlc3VsdF9ub2RlX2lkOiBzZXQgd2hlbiBhIE5PREUgcHJvcG9zYWwgaXMgcmF0aWZpZWQsIHRvIHRoZSBpZCBvZiB0aGVcbi0tIG5vZGUgaXQgcHJvZHVjZWQg4oCUIGxldHMgYW4gZWRnZSBwcm9wb3NhbCByZWZlcmVuY2UgYW4gdW5yYXRpZmllZCBub2RlJ3Ncbi0tIHByb3Bvc2FsIGlkIGFzIGl0cyBzb3VyY2UvdGFyZ2V0IGFuZCBoYXZlIHJhdGlmeSByZXNvbHZlIGl0IG9uY2UgdGhhdFxuLS0gbm9kZSBwcm9wb3NhbCBpdHNlbGYgcmF0aWZpZXMgKFAzIGZpbmRpbmcgZnJvbSBjYXNzYW5kcmEncyBjb2xkLWFnZW50XG4tLSBkcml2ZTogdGhpcyBlbmRwb2ludC1yZXNvbHV0aW9uIG1lY2hhbmlzbSB3YXMgcHJldmlvdXNseSB1bnZhbGlkYXRlZCkuXG4tLVxuLS0gYXV0aG9yL2V2aWRlbmNlX21lc3NhZ2VfaWQgKFYxLnggQ2xhaW1zIEQvRSk6IG51bGxhYmxlLVRFWFQtb25seSBiZWNhdXNlXG4tLSB0aGV5IGFycml2ZWQgdmlhIEFERElUSVZFX0NPTFVNTlMgYWZ0ZXIgdGhlIG9yaWdpbmFsIHNoYXBlIHNoaXBwZWQg4oCUIHRoZVxuLS0gZnJlc2gtaW5zdGFsbCBzaGFwZSBtdXN0IGVxdWFsIHRoZSBtaWdyYXRlZCBzaGFwZS4gXCJhdXRob3IgZGVmYXVsdHMgdG9cbi0tIGFnZW50XCIgaXMgZXhwcmVzc2VkIGFzIG51bGwtbm9ybWFsaXplZC1hdC1yZWFkIChzdGF0ZS50cyksIG5ldmVyIGFzIGFcbi0tIE5PVCBOVUxMIERFRkFVTFQgaGVyZS4gZXZpZGVuY2VfbWVzc2FnZV9pZCBpcyBtdXR1YWxseSBleGNsdXNpdmUgd2l0aFxuLS0gZXZpZGVuY2VfZG9jX2lkIChlbmZvcmNlZCBhdCBwcm9wb3NlIGludGFrZSwgbm90IGJ5IHRoZSBzY2hlbWEpLlxuLS0gem9uZV9pZCAoUm91bmQgMywgQ2xhaW0gWjEpOiBudWxsYWJsZSDigJQgdGhlIG1haW4gZ3JhcGggaXMgem9uZV9pZCBJUyBOVUxMLFxuLS0gc28gZXZlcnkgcHJlLXpvbmVzIHJvdyBpcyBhIG1haW4tcXVldWUgcHJvcG9zYWwgYnkgY29uc3RydWN0aW9uLiBab25lXG4tLSBjb250ZW50cyBhcmUgUFJPUE9TQUxTIE9OTFkgKG5vZGVzL2VkZ2VzIG5ldmVyIGNhcnJ5IHpvbmVfaWQpOiBhIHpvbmUgaXNcbi0tIHN0YWdpbmcsIGFuZCBwcm9tb3Rpb24gKHpvbmVfaWQgLT4gTlVMTCkgaXMgdGhlIG9ubHkgZXhpdC5cbi0tIGJhdGNoX2lkIChSb3VuZCAxMiwgU0VBTSAxKTogdGhlIHN0YWdpbmcgQUNUIHRoaXMgcHJvcG9zYWwgY2FtZSBmcm9tIOKAlCBtaW50ZWRcbi0tIHBlciBQT1NUIC9wcm9wb3NhbHMvYmF0Y2ggY2FsbCAob3Igc3VwcGxpZWQgYnkgdGhlIGNhbGxlciB0byBKT0lOIGFuXG4tLSBleGlzdGluZyBhY3QpLiBOdWxsYWJsZS1URVhULW9ubHkgYmVjYXVzZSBpdCBhcnJpdmVkIHZpYSBBRERJVElWRV9DT0xVTU5TXG4tLSBhZnRlciB0aGUgc2hhcGUgc2hpcHBlZDsgbnVsbCA9IHVuYmF0Y2hlZCwgdGhlIGhvbmVzdCByZWFkaW5nIG9mIGEgc2luZ2xlXG4tLSBwcm9wb3NlIGFuZCBvZiBldmVyeSBwcmUtUjEyIHJvdy4gSXQgc3Vydml2ZXMgcmF0aWZpY2F0aW9uIGJlY2F1c2UgdGhlXG4tLSBQUk9QT1NBTCBST1cgc3Vydml2ZXMgcmF0aWZpY2F0aW9uIOKAlCB0aGF0IElTIHRoZSBwb2ludDogYWZ0ZXIgYSBQQVJUSUFMXG4tLSByYXRpZmljYXRpb24gdGhlIGFnZW50IGNhbiBhc2sgXCJ3aGF0IGVsc2UgY2FtZSBmcm9tIHRoYXQgY2FsbFwiLlxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgcHJvcG9zYWxzIChcbiAgaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAga2luZCBURVhUIE5PVCBOVUxMLFxuICBkcmFmdF9qc29uIFRFWFQgTk9UIE5VTEwsXG4gIGV2aWRlbmNlX2RvY19pZCBURVhULFxuICBldmlkZW5jZV9zcGFuIFRFWFQsXG4gIHN1Z2dlc3RlZF90aWVyIFRFWFQsXG4gIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3BlbmRpbmcnLFxuICBjcmVhdGVkX2F0IElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAodW5peGVwb2NoKCkpLFxuICByZXN1bHRfbm9kZV9pZCBURVhULFxuICBhdXRob3IgVEVYVCxcbiAgZXZpZGVuY2VfbWVzc2FnZV9pZCBURVhULFxuICB6b25lX2lkIFRFWFQsXG4gIGJhdGNoX2lkIFRFWFRcbik7XG5cbi0tIFJvdW5kIDMgKENsYWltIFoxKTogYSB6b25lIGlzIGEgbmFtZWQgc3RhZ2luZyBwZW4gZm9yIHByb3Bvc2FscyDigJQgbm90aGluZ1xuLS0gZWxzZS4gSWRzIGFyZSBTTFVHUyBkZXJpdmVkIGZyb20gdGhlIG5hbWUgKGNvbnZlcnNhdGlvbmFsXG4tLSByZWZlcmVuY2VhYmlsaXR5LCBydWxlZCk7IG5vIHJlbmFtZSBpbiB0aGlzIHJvdW5kLiBQZXItcHJvamVjdCBieVxuLS0gY29uc3RydWN0aW9uIChlYWNoIHByb2plY3Qgb3ducyBpdHMgb3duIHN0b3JlLnNxbGl0ZSkuXG5DUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyB6b25lcyAoXG4gIGlkIFRFWFQgUFJJTUFSWSBLRVksXG4gIG5hbWUgVEVYVCBOT1QgTlVMTCxcbiAgdHMgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUICh1bml4ZXBvY2goKSlcbik7XG5cbi0tIFYxLnggQ2xhaW0gQjogYXBwZW5kLW9ubHkgbWFyayB0cmFpbDsgbGF0ZXN0LXBlci1kb2MgaXMgdGhlIGxpdmUgbWFyay5cbi0tIGRvY19tdGltZSBzbmFwc2hvdHMgdGhlIGRvYyBmaWxlJ3MgbXRpbWUgKG1zKSBhdCBtYXJrIHRpbWUg4oCUIHN0YWxlbmVzcyBpc1xuLS0gY29tcHV0ZWQgYXQgcmVhZCB0aW1lIChjdXJyZW50IG10aW1lID4gZG9jX210aW1lKSwgbmV2ZXIgc3RvcmVkIG9yXG4tLSBlbWl0dGVkLiBOZXcgdGFibGUsIGFkZGl0aXZlIGJ5IGNvbnN0cnVjdGlvbiDigJQgbm8gbWlncmF0aW9uIG1hY2hpbmVyeS5cbkNSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGRvY19tYXJrcyAoXG4gIGlkIFRFWFQgUFJJTUFSWSBLRVksXG4gIGRvY19pZCBURVhUIE5PVCBOVUxMLFxuICBhdXRob3IgVEVYVCBOT1QgTlVMTCxcbiAgbm90ZSBURVhULFxuICBzdGF0dXMgVEVYVCBOT1QgTlVMTCxcbiAgZG9jX210aW1lIElOVEVHRVIsXG4gIHRzIElOVEVHRVIgTk9UIE5VTEwgREVGQVVMVCAodW5peGVwb2NoKCkpXG4pO1xuXG4tLSBWMS54IENsYWltIEU6IGNvbnZlcnNhdGlvbiBldmlkZW5jZS4gc291cmNlcy5kb2NfaWQgaXMgTk9UIE5VTEwgYW5kIFNRTGl0ZVxuLS0gY2FuJ3QgcmVsYXggdGhhdCBhZGRpdGl2ZWx5LCBzbyBtZXNzYWdlLWdyb3VuZGVkIHByb3ZlbmFuY2UgZ2V0cyBhIHNpYmxpbmdcbi0tIHRhYmxlIGluc3RlYWQgb2YgYSBudWxsYWJsZSBjb2x1bW4g4oCUIHJlYWRTdGF0ZSBtZXJnZXMgYm90aCBpbnRvXG4tLSBub2RlLnNvdXJjZXNbXSBhcyB0aGUgdW5pb24ge2RvY0lkLCBzcGFufSB8IHttZXNzYWdlSWQsIHNwYW59LlxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbWVzc2FnZV9zb3VyY2VzIChcbiAgbm9kZV9pZCBURVhUIE5PVCBOVUxMLFxuICBtZXNzYWdlX2lkIFRFWFQgTk9UIE5VTEwsXG4gIHNwYW4gVEVYVFxuKTtcblxuLS0gaWQva2luZC9ncm91bmRfanNvbiBhcmUgbnVsbGFibGUgaGVyZSBldmVuIHRob3VnaCBhcHBsaWNhdGlvbiBjb2RlIGFsd2F5c1xuLS0gc3VwcGxpZXMgdGhlbSBmb3IgbmV3IHJvd3Mg4oCUIHRoZXkgd2VyZSBhZGRlZCBhZnRlciBtZXNzYWdlcycgb3JpZ2luYWxcbi0tIHNoYXBlIHNoaXBwZWQsIGFuZCBhbiBBREQgQ09MVU1OIGJhY2tmaWxsIChiZWxvdykgY2FuIG9ubHkgYWRkIG51bGxhYmxlXG4tLSBjb2x1bW5zIHRvIGEgcG9wdWxhdGVkIHRhYmxlLCBzbyB0aGUgZnJlc2gtaW5zdGFsbCBzaGFwZSBtYXRjaGVzIHdoYXQgYVxuLS0gbWlncmF0ZWQgc3RvcmUgZW5kcyB1cCB3aXRoIChubyBkcmlmdCBiZXR3ZWVuIHRoZSB0d28gcGF0aHMpLlxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbWVzc2FnZXMgKFxuICBwcm9qZWN0X2lkIFRFWFQgTk9UIE5VTEwsXG4gIHNlcSBJTlRFR0VSIE5PVCBOVUxMLFxuICByb2xlIFRFWFQgTk9UIE5VTEwsXG4gIHRleHQgVEVYVCBOT1QgTlVMTCxcbiAgdHMgSU5URUdFUiBOT1QgTlVMTCBERUZBVUxUICh1bml4ZXBvY2goKSksXG4gIGlkIFRFWFQsXG4gIGtpbmQgVEVYVCxcbiAgZ3JvdW5kX2pzb24gVEVYVFxuKTtcblxuLS0gZG9jX2lkIChSb3VuZCAzLCBDbGFpbSBWMik6IHRoZSBkb2MtbGVucyB2YXJpYW50LiBub2RlX2lkIFhPUiBkb2NfaWQgaXNcbi0tIGVuZm9yY2VkIGF0IHRoZSB3cml0ZSBwYXRoIChzZXRMZW5zIHdyaXRlcyBldmVyeSBjb2x1bW4gb24gdXBzZXJ0LCB0aGVcbi0tIC9sZW5zIHJvdXRlIHZhbGlkYXRlcyB0aGUgWE9SKSDigJQgdGhlIHNjaGVtYSBzdGF5cyBwZXJtaXNzaXZlIHNvIHRoZVxuLS0gQUREIENPTFVNTiBiYWNrZmlsbCBjYW4gbGFuZCBvbiBwb3B1bGF0ZWQgc3RvcmVzLlxuQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgbGVucyAoXG4gIHByb2plY3RfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgb3duZXIgVEVYVCBOT1QgTlVMTCxcbiAgbm9kZV9pZCBURVhULFxuICBkZXB0aCBJTlRFR0VSLFxuICBkb2NfaWQgVEVYVFxuKTtcblxuLS0gUm91bmQgNCAoQTEpOiBhZ2VudC1hdXRob3JlZCBhY3Rpb24gc2xvdHMsIHRhcmdldC1rZXllZCDigJQgdGFyZ2V0X2lkIGlzIGFcbi0tIG5vZGUgaWQgT1IgYSBQRU5ESU5HIHByb3Bvc2FsJ3MgaWQgKGRpc2pvaW50IFVVSUQgc3BhY2VzLCBtZWFzdXJlZDsgdGhlXG4tLSBsZW5zIHByZWNlZGVudDogYWdlbnQtd3JpdGFibGUgbWV0YWRhdGEsIG5vdCBzdGFnZWQsIG5vdCByYXRpZmllZCkuXG4tLSBMaWZlY3ljbGUgcmlkZXMgdGhlIG93bmVyczogcmF0aWZ5IHJlLWhvbWVzIHRoZSByb3cgb250byB0aGUgbWludGVkIG5vZGVcbi0tIGlkLCByZWplY3QgZGVsZXRlcyBpdCwgem9uZSBkZWxldGUgY2FzY2FkZXMgaXQsIHByb21vdGUgaXMgYSBuby1vcC5cbkNSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIG5vZGVfYWN0aW9ucyAoXG4gIHRhcmdldF9pZCBURVhUIFBSSU1BUlkgS0VZLFxuICBhY3Rpb25zX2pzb24gVEVYVCBOT1QgTlVMTFxuKTtcblxuLS0gUm91bmQgNyAoVEFHUyk6IGZyZWVmb3JtIGFnZW50LWN1cmF0ZWQgdGFncywgdGFyZ2V0LWtleWVkIOKAlCB0aGUgZXhhY3QgdHdpblxuLS0gb2Ygbm9kZV9hY3Rpb25zLiB0YXJnZXRfaWQgaXMgYSBub2RlIGlkIE9SIGEgUEVORElORyBwcm9wb3NhbCdzIGlkICh0aGUgc2FtZVxuLS0gZGlzam9pbnQtVVVJRC1zcGFjZSwgcGVuZGluZy1jYXJyeSwgcmUtaG9tZS1vbi1yYXRpZnkgbGlmZWN5Y2xlKS4gU3RvcmVkIGFzIGFcbi0tIGpzb24gc3RyaW5nW10gKEZSRUVGT1JNIOKAlCB0aGUgZW5naW5lIHN0b3JlcyBzdHJpbmdzOyB2b2NhYi9jdXJhdGlvbiBpcyBhXG4tLSBzdXJmYWNlIGNvbmNlcm4pLiBOZXcgdGFibGUsIGFkZGl0aXZlIGJ5IGNvbnN0cnVjdGlvbiAoQ1JFQVRFIFRBQkxFIElGIE5PVFxuLS0gRVhJU1RTIOKAlCBubyBBRERJVElWRV9DT0xVTU5TIGVudHJ5LCBsaWtlIHpvbmVzL25vZGVfYWN0aW9ucykuXG5DUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBub2RlX3RhZ3MgKFxuICB0YXJnZXRfaWQgVEVYVCBQUklNQVJZIEtFWSxcbiAgdGFnc19qc29uIFRFWFQgTk9UIE5VTExcbik7XG5cbi0tIFJvdW5kIDkgKEpvYiBRdWV1ZSk6IGEgZmlyc3QtY2xhc3MsIHBlcnNpc3RlZCB1bml0IG9mIEFHRU5UIFdPUksg4oCUIHN0YXR1cyArXG4tLSBzdWItdGFza3MgKyBhIGRlbGl2ZXJhYmxlICsgYW4gT1dORVIgKGNsYWltZWRfYnksIHRoZSBsZWFzZSkuIE5ldyB0YWJsZSxcbi0tIGFkZGl0aXZlIGJ5IGNvbnN0cnVjdGlvbiAoQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMg4oCUIE5PIEFERElUSVZFX0NPTFVNTlNcbi0tIGVudHJ5LCB0aGUgem9uZXMvbm9kZV9hY3Rpb25zL25vZGVfdGFncyBwcmVjZWRlbnQpLiBGaXJzdC1jbGFzcy13aXRoLWEtXG4tLSBzdGF0dXMtY29sdW1uIGZvbGxvd3MgdGhlIHByb3Bvc2FscyBzaGFwZS4gY2xhaW1lZF9ieSAvIGRlbGl2ZXJhYmxlIC8gZGV0YWlsXG4tLSBhcmUgbnVsbGFibGUgKHVuY2xhaW1lZCAvIG5vIG91dHB1dCAvIG5vIG5vdGVzKTsgc3VidGFza3NfanNvbiBkZWZhdWx0cyAnW10nXG4tLSAoW3tpZCxsYWJlbCxkb25lfV0sIEQ0IOKAlCB0aGUgY2hlY2tsaXN0IHJpZGVzIGl0cyBqb2IsIG5vIGNoaWxkIHRhYmxlKS5cbi0tIGNyZWF0ZWRfYXQvdXBkYXRlZF9hdCBhcmUgYXBwLXdyaXR0ZW4gZXBvY2ggTVMgKE5PVCBhIHVuaXhlcG9jaCgpIGRlZmF1bHQg4oCUXG4tLSB1cGRhdGVkX2F0IG11c3QgYnVtcCBvbiBldmVyeSBtdXRhdGlvbiB3aXRoIHN1Yi1zZWNvbmQgb3JkZXJpbmcpLiBMaXZlbmVzcyBpc1xuLS0gREVSSVZFRCBjbGllbnQtc2lkZSBmcm9tIGFnZW50LmFjdGl2aXR5IChEMikg4oCUIHRoZXJlIGlzIGRlbGliZXJhdGVseSBOT1xuLS0gbGFzdF9zZWVuL2hlYXJ0YmVhdCBjb2x1bW4gaGVyZS5cbkNSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGpvYnMgKFxuICBpZCBURVhUIFBSSU1BUlkgS0VZLFxuICBwcm9qZWN0IFRFWFQgTk9UIE5VTEwsXG4gIHRpdGxlIFRFWFQgTk9UIE5VTEwsXG4gIHN0YXR1cyBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ3F1ZXVlZCcsXG4gIGNsYWltZWRfYnkgVEVYVCxcbiAgZGVsaXZlcmFibGUgVEVYVCxcbiAgc3VidGFza3NfanNvbiBURVhUIE5PVCBOVUxMIERFRkFVTFQgJ1tdJyxcbiAgZGV0YWlsIFRFWFQsXG4gIGNyZWF0ZWRfYXQgSU5URUdFUiBOT1QgTlVMTCxcbiAgdXBkYXRlZF9hdCBJTlRFR0VSIE5PVCBOVUxMXG4pO1xuXG5DUkVBVEUgVklSVFVBTCBUQUJMRSBJRiBOT1QgRVhJU1RTIGRvY3NfZnRzIFVTSU5HIGZ0czUoZG9jX2lkIFVOSU5ERVhFRCwgY29udGVudCk7XG5cbi0tIEV4cGxpY2l0IGR1YWwtd3JpdGUgZnJvbSBzZW5kLnRzIGF0IGluc2VydCB0aW1lIChub3QgYSB0cmlnZ2VyKSDigJQgc2ltcGxlcixcbi0tIGFuZCBzZWFyY2ggc2hvdWxkIGZpbmQgdGhpbmdzIHNhaWQgaW4gY29udmVyc2F0aW9uLCBub3QganVzdCB3cml0dGVuIHRvXG4tLSBkb2NzIChwcm9wb3NhbC5tZCdzIGh5YnJpZC1zZWFyY2ggc3RhbmNlKS5cbkNSRUFURSBWSVJUVUFMIFRBQkxFIElGIE5PVCBFWElTVFMgbWVzc2FnZXNfZnRzIFVTSU5HIGZ0czUobWVzc2FnZV9pZCBVTklOREVYRUQsIGNvbnRlbnQpO1xuYDtcblxuZnVuY3Rpb24gb3BlblN0b3JlKHBhdGg6IHN0cmluZyk6IERhdGFiYXNlIHtcbiAgY29uc3QgZGIgPSBuZXcgRGF0YWJhc2UocGF0aCwgeyBjcmVhdGU6IHRydWUgfSk7XG4gIGRiLmV4ZWMoU0NIRU1BKTtcbiAgYmFja2ZpbGxDb2x1bW5zKGRiLCBwYXRoKTtcbiAgcmV0dXJuIGRiO1xufVxuXG5leHBvcnQgeyBvcGVuU3RvcmUgfTtcbiIsCiAgICAiLy8gUm91bmQgNyAoVEFHUykg4oCUIHBlci10YXJnZXQgZnJlZWZvcm0gdGFnczogYW4gYWdlbnQtY3VyYXRlZCBmb2xrc29ub215IHBpbm5lZFxuLy8gdG8gYSBub2RlIG9yIGEgUEVORElORyBwcm9wb3NhbC4gVGhlIGV4YWN0IHR3aW4gb2Ygbm9kZV9hY3Rpb25zIChSb3VuZCA0LFxuLy8gQTEpOiB0YXJnZXQta2V5ZWQgd2hvbGVzYWxlLXVwc2VydCBtZXRhZGF0YSwgZW5naW5lLW93bmVkICh0aGUgc2hhcGUgSVNcbi8vIHZhbGlkYXRlZCBhdCBpbnRha2Ug4oCUIHRoZSBvcGFxdWUtZHJhZnQgZG9jdHJpbmUgY292ZXJzIGFnZW50IGV4dHJhY3Rpb25cbi8vIGRyYWZ0cywgbm90IHRoaXMpLiBGUkVFRk9STSBieSBydWxpbmc6IHRoZSBlbmdpbmUgc3RvcmVzIHN0cmluZ3M7IGN1cmF0aW9uXG4vLyAocmV1c2Utc3VnZ2VzdGlvbiA9IGF1dG9jb21wbGV0ZSBvdmVyIGV4aXN0aW5nIHRhZ3MpIGlzIGEgU1VSRkFDRSBjb25jZXJuLlxuLy9cbi8vIFN0b3JhZ2U6IG5vZGVfdGFncyAodGFyZ2V0X2lkIFBLLCB0YWdzX2pzb24pIOKAlCB3aG9sZXNhbGUgdXBzZXJ0IHBlciB0YXJnZXQsXG4vLyBlbXB0eSBhcnJheSAob3IgREVMRVRFKSBjbGVhcnMuIExpZmVjeWNsZSByaWRlcyB0aGUgdGFyZ2V0J3Mgb3duZXJzIGV4YWN0bHlcbi8vIGFzIG5vZGVfYWN0aW9uczogcmF0aWZ5IHJlLWhvbWVzIHRoZSByb3cgb250byB0aGUgZnJlc2hseSBtaW50ZWQgbm9kZSBpZCxcbi8vIHJlamVjdCBkZWxldGVzIGl0LCBlZGdlIGFjY2VwdCBkZWxldGVzIGl0LCB6b25lIGRlbGV0ZSBjYXNjYWRlcyBpdCwgcHJvbW90ZVxuLy8gaXMgYSBuby1vcCAodGhlIHByb3Bvc2FsIGlkIHN1cnZpdmVzIHRoZSBtb3ZlKS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgdHlwZSB7IEV2ZW50QnVzIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5cbi8vIEhhcmQgYnl0ZS1jYXAgb24gdGhlIHNlcmlhbGl6ZWQganNvbiDigJQgYSBmb2xrc29ub215IHN0YXlzIG5hdHVyYWxseSBzbWFsbCxcbi8vIHNvICh1bmxpa2UgYWN0aW9ucykgdGhlcmUncyBubyBhZHZpc29yeSBzb2Z0LWNhcDsgdGhlIGJ5dGUgY2FwIG9ubHkgc3RvcHNcbi8vIGFidXNlIGZyb20gYmFsbG9vbmluZyBhIHNuYXBzaG90LlxuY29uc3QgVEFHU19CWVRFX0NBUCA9IDE2ICogMTAyNDtcblxuaW50ZXJmYWNlIFNldFRhZ3NSZXN1bHQge1xuICB0YXJnZXRJZDogc3RyaW5nO1xuICB0YWdzOiBzdHJpbmdbXTtcbn1cblxuLy8gRnJlZWZvcm0sIGJ1dCBub3Qgc2hhcGVsZXNzIOKAlCBhIG5vbi1hcnJheSBvciBhIG5vbi1zdHJpbmcgZW50cnkgaXMgYSBsb3VkXG4vLyBpbnRha2UgZXJyb3IgKHRoZSBwYXJzZUFjdGlvbnMgcGFyc2UtZ3VhcmQsIG1pbnVzIHRoZSBvYmplY3QgdHJpcGxlKS4gVGFnc1xuLy8gcmlkZSB2ZXJiYXRpbTogbm8gdHJpbS9kZWR1cC9sb3dlcmNhc2UgaGVyZSAodGhhdCdzIHN1cmZhY2UgY3VyYXRpb24pLlxuZnVuY3Rpb24gcGFyc2VUYWdzKHJhdzogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHJhdykpIHtcbiAgICAvLyBTRUFNIDcgKGRyaXZlICMxMCBuYW1lZCB0aGlzIGV4YWN0IDQwMCBhcyB0aGUgY291bnRlcmV4YW1wbGUgdG8gdGhlXG4gICAgLy8gaG91c2Ugc3RhbmRhcmQpOiB0aGUgYm9keSBJUyB0aGUgYXJyYXkg4oCUIG5hbWUgdGhlIHdyb25nIHNoYXBlIHRoZSBjYWxsZXJcbiAgICAvLyBtb3N0IGxpa2VseSBzZW50LCBub3QganVzdCB0aGUgcmlnaHQgb25lLlxuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGB0aGUgcmVxdWVzdCBib2R5IElTIHRoZSB0YWcgYXJyYXkg4oCUIHNlbmQgYSBCQVJFIEpTT04gYXJyYXkgb2Ygc3RyaW5ncyBsaWtlIFtcImFtYmllbnRcIixcImZvdXJ0aCB3b3JsZFwiXSAoZW1wdHkgYXJyYXkgY2xlYXJzKSwgTk9UIHtcInRhZ3NcIjpbLi4uXX07IGdvdCAke0FycmF5LmlzQXJyYXkocmF3KSA/IFwiYW4gYXJyYXlcIiA6IHR5cGVvZiByYXcgPT09IFwib2JqZWN0XCIgJiYgcmF3ICE9PSBudWxsID8gYGFuIG9iamVjdCB3aXRoIGtleXM6ICR7T2JqZWN0LmtleXMocmF3IGFzIG9iamVjdCkuam9pbihcIiwgXCIpfWAgOiB0eXBlb2YgcmF3fWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmF3Lm1hcCgoZW50cnksIGkpID0+IHtcbiAgICBpZiAodHlwZW9mIGVudHJ5ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHRhZ3NbJHtpfV0gaXMgbm90IGEgc3RyaW5nIOKAlCB0YWdzIGFyZSBmcmVlZm9ybSBzdHJpbmdzYCk7XG4gICAgfVxuICAgIHJldHVybiBlbnRyeTtcbiAgfSk7XG59XG5cbi8vIEEgdGFyZ2V0IGlzIGEgcmVhbCBub2RlIG9yIGEgUEVORElORyBwcm9wb3NhbCDigJQgYW55dGhpbmcgZWxzZSBpcyBudWxsICh0aGVcbi8vIHNlcnZlciA0MDRzKS4gQSByYXRpZmllZC9yZWplY3RlZCBwcm9wb3NhbCBpcyBOT1QgYSB2YWxpZCB0YXJnZXQ6IGl0cyB0YWdzXG4vLyBlaXRoZXIgcmUtaG9tZWQgdG8gdGhlIG5vZGUgb3IgZGllZCB3aXRoIHRoZSBydWxpbmcuIEJ5dGUtaWRlbnRpY2FsIHRvXG4vLyBhY3Rpb25zLnRzJ3MgcmVzb2x2ZVRhcmdldCAodGhlIGRpc2pvaW50LVVVSUQtc3BhY2UgKyBwZW5kaW5nIGxpZmVjeWNsZSkuXG5mdW5jdGlvbiByZXNvbHZlVGFyZ2V0KGRiOiBEYXRhYmFzZSwgdGFyZ2V0SWQ6IHN0cmluZyk6IFwibm9kZVwiIHwgXCJwcm9wb3NhbFwiIHwgbnVsbCB7XG4gIGlmIChkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldCh0YXJnZXRJZCkpIHJldHVybiBcIm5vZGVcIjtcbiAgY29uc3QgcHJvcG9zYWwgPSBkYi5xdWVyeShcIlNFTEVDVCBzdGF0dXMgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIpLmdldCh0YXJnZXRJZCkgYXMge1xuICAgIHN0YXR1czogc3RyaW5nO1xuICB9IHwgbnVsbDtcbiAgaWYgKHByb3Bvc2FsPy5zdGF0dXMgPT09IFwicGVuZGluZ1wiKSByZXR1cm4gXCJwcm9wb3NhbFwiO1xuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2V0VGFncyhcbiAgZGI6IERhdGFiYXNlLFxuICBidXM6IEV2ZW50QnVzLFxuICB0YXJnZXRJZDogc3RyaW5nLFxuICByYXdUYWdzOiB1bmtub3duLFxuKTogU2V0VGFnc1Jlc3VsdCB8IG51bGwge1xuICBpZiAocmVzb2x2ZVRhcmdldChkYiwgdGFyZ2V0SWQpID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgdGFncyA9IHBhcnNlVGFncyhyYXdUYWdzKTtcblxuICBpZiAodGFncy5sZW5ndGggPT09IDApIHtcbiAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBub2RlX3RhZ3MgV0hFUkUgdGFyZ2V0X2lkID0gP1wiLCBbdGFyZ2V0SWRdKTtcbiAgICBidXMuZW1pdChcInRhZ3Muc2V0XCIsIHsgdGFyZ2V0SWQsIHRhZ3M6IFtdIH0pO1xuICAgIHJldHVybiB7IHRhcmdldElkLCB0YWdzOiBbXSB9O1xuICB9XG5cbiAgY29uc3QganNvbiA9IEpTT04uc3RyaW5naWZ5KHRhZ3MpO1xuICBjb25zdCBieXRlcyA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZShqc29uKS5sZW5ndGg7XG4gIGlmIChieXRlcyA+IFRBR1NfQllURV9DQVApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgdGFncyBwYXlsb2FkIGlzICR7Ynl0ZXN9IGJ5dGVzIOKAlCBvdmVyIHRoZSAke1RBR1NfQllURV9DQVB9LWJ5dGUgY2FwOyB0cmltIHRoZSBsaXN0YCxcbiAgICApO1xuICB9XG4gIGRiLnJ1bihcbiAgICBcIklOU0VSVCBJTlRPIG5vZGVfdGFncyAodGFyZ2V0X2lkLCB0YWdzX2pzb24pIFZBTFVFUyAoPywgPykgT04gQ09ORkxJQ1QodGFyZ2V0X2lkKSBETyBVUERBVEUgU0VUIHRhZ3NfanNvbiA9IGV4Y2x1ZGVkLnRhZ3NfanNvblwiLFxuICAgIFt0YXJnZXRJZCwganNvbl0sXG4gICk7XG4gIGJ1cy5lbWl0KFwidGFncy5zZXRcIiwgeyB0YXJnZXRJZCwgdGFncyB9KTtcbiAgcmV0dXJuIHsgdGFyZ2V0SWQsIHRhZ3MgfTtcbn1cblxuZnVuY3Rpb24gY2xlYXJUYWdzKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgdGFyZ2V0SWQ6IHN0cmluZyk6IFNldFRhZ3NSZXN1bHQgfCBudWxsIHtcbiAgcmV0dXJuIHNldFRhZ3MoZGIsIGJ1cywgdGFyZ2V0SWQsIFtdKTtcbn1cblxuLy8gVGhlIC9zdGF0ZSBtZXJnZSBpbnB1dDogZXZlcnkgc3RvcmVkIHRhZyBsaXN0IGtleWVkIGJ5IHRhcmdldCBpZCAoc3RhdGUudHNcbi8vIGF0dGFjaGVzIHRoZW0gb250byBub2Rlc1tdIEFORCBwcm9wb3NhbHNbXSBBTkQgcmVhZFByb3Bvc2FsQnlJZDsgYWJzZW50ID1cbi8vIG5vbmUpLiBXcml0dGVuIG9uIHRoZSBwcm9wb3NlIHBhdGggdG9vIChidWlsZFByb3Bvc2FsJ3MgaW5zZXJ0IGNsb3N1cmUpLCBzb1xuLy8gdGhpcyByZWFkcyBib3RoIGFnZW50LXNldCBhbmQgcHJvcG9zZS10aW1lIHRhZ3MgdW5pZm9ybWx5LlxuZnVuY3Rpb24gcmVhZFRhZ3MoZGI6IERhdGFiYXNlKTogTWFwPHN0cmluZywgc3RyaW5nW10+IHtcbiAgY29uc3Qgcm93cyA9IGRiLnF1ZXJ5KFwiU0VMRUNUIHRhcmdldF9pZCwgdGFnc19qc29uIEZST00gbm9kZV90YWdzXCIpLmFsbCgpIGFzIEFycmF5PHtcbiAgICB0YXJnZXRfaWQ6IHN0cmluZztcbiAgICB0YWdzX2pzb246IHN0cmluZztcbiAgfT47XG4gIGNvbnN0IG91dCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCByb3cgb2Ygcm93cykge1xuICAgIHRyeSB7XG4gICAgICBvdXQuc2V0KHJvdy50YXJnZXRfaWQsIEpTT04ucGFyc2Uocm93LnRhZ3NfanNvbikgYXMgc3RyaW5nW10pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQSBjb3JydXB0IHJvdyBuZXZlciBjcmFzaGVzIGEgc25hcHNob3Qg4oCUIGl0IGp1c3QgZG9lc24ndCByZW5kZXIuXG4gICAgfVxuICB9XG4gIHJldHVybiBvdXQ7XG59XG5cbmV4cG9ydCB0eXBlIHsgU2V0VGFnc1Jlc3VsdCB9O1xuZXhwb3J0IHsgY2xlYXJUYWdzLCBwYXJzZVRhZ3MsIHJlYWRUYWdzLCBzZXRUYWdzLCBUQUdTX0JZVEVfQ0FQIH07XG4iLAogICAgIi8vIFAxIOKAlCBhc3NlbWJsZXMgdGhlIHJhdGlmaWVkIFByb2plY3RTdGF0ZSBzbmFwc2hvdCBmcm9tIHRoZSBzcWxpdGUgdGFibGVzIGluXG4vLyBvbmUgcmVhZC4gRG9jcyBzdGF5IGNvbnRlbnQtZnJlZSAoc2FtZSBlbnZlbG9wZSBhcyB0aGUgc3Bpa2UncyAvZG9jLzppZCDigJRcbi8vIHplcm8gY2hhbmdlIHRvIHRoYXQgZW5kcG9pbnQncyBzaGFwZSkuIGBjdXJzb3JgIGlzIG5vdCBkdXJhYmxlIChub1xuLy8gZXZlbnQtbG9nIHRhYmxlIGluIFYxIOKAlCBldmVudHMgYXJlIGRlcml2ZWQtZnJvbS1zdGF0ZSwgcmVwbGF5YWJsZSB2aWFcbi8vIHNuYXBzaG90KTsgdGhlIGRhZW1vbiBwYXNzZXMgaW4gaXRzIGxpdmUgaW4tbWVtb3J5IGN1cnNvciwgZGVmYXVsdGluZyB0byAwXG4vLyBvbiBhIGZyZXNoIHByb2Nlc3MgKGhvbmVzdDogbm90aGluZyByYXRpZmllZCBpcyBsb3N0IG9uIHJlc3RhcnQsIG9ubHkgdGhlXG4vLyByZXN1bWUtcG9pbnQgZm9yIGV2ZW50cyBhbHJlYWR5IGVwaGVtZXJhbCBieSBkZXNpZ24pLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB7IHR5cGUgQWN0aW9uU2xvdCwgcmVhZEFjdGlvbnMgfSBmcm9tIFwiLi9hY3Rpb25zLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEpvYiwgcmVhZEpvYnMgfSBmcm9tIFwiLi9qb2JzLnRzXCI7XG5pbXBvcnQgeyB0eXBlIERvY01hcmssIGRvY0ZpbGVNdGltZSwgcmVhZERvY01hcmtzIH0gZnJvbSBcIi4vbWFya3MudHNcIjtcbmltcG9ydCB0eXBlIHsgUHJvamVjdE1ldGEgfSBmcm9tIFwiLi9wcm9qZWN0LnRzXCI7XG5pbXBvcnQgeyByZWFkVGFncyB9IGZyb20gXCIuL3RhZ3MudHNcIjtcblxuaW50ZXJmYWNlIERvYyB7XG4gIGlkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIC8vIFJvdW5kIDQgKEsxKTogbnVsbCA9IHVudHlwZWQgKCcnIHNlbnRpbmVsIGF0IHJlc3QsIG5vcm1hbGl6ZWQgaGVyZSDigJRcbiAgLy8gYWJzZW5jZSBpcyBob25lc3Q7IHRoZSBpbmdlc3QgZGVmYXVsdHMgZGllZCkuIGtpbmRBdXRob3IgaXMgd2hvIGFzc2VydGVkXG4gIC8vIHRoZSBraW5kIChcInVzZXJcInxcImFnZW50XCIpOyBudWxsID0gdW5hdHRyaWJ1dGVkIChsZWdhY3kgb3IgdW50eXBlZCkuXG4gIGtpbmQ6IHN0cmluZyB8IG51bGw7XG4gIGtpbmRBdXRob3I6IFwidXNlclwiIHwgXCJhZ2VudFwiIHwgbnVsbDtcbiAgLy8gQ2xhaW0gQjogbGF0ZXN0IG1hcmssIHdpdGggYHN0YWxlYCBjb21wdXRlZCBzZXJ2ZXItc2lkZSBhdCByZWFkIHRpbWVcbiAgLy8gKGN1cnJlbnQgZmlsZSBtdGltZSB2cyB0aGUgbWFyaydzIHNuYXBzaG90OyBtaXNzaW5nIGZpbGUg4oaSIHN0YWxlKS5cbiAgLy8gQWJzZW50IHdoZW4gdGhlIGRvYyBoYXMgbmV2ZXIgYmVlbiBtYXJrZWQuXG4gIG1hcms/OiBEb2NNYXJrICYgeyBzdGFsZTogYm9vbGVhbiB9O1xufVxuXG4vLyBDbGFpbSBFOiBub2RlLnNvdXJjZXNbXSBpcyB0aGUgdW5pb24gb2YgZG9jLWdyb3VuZGVkIGFuZCBtZXNzYWdlLWdyb3VuZGVkXG4vLyBwcm92ZW5hbmNlLiBEb2MgZW50cmllcyBzdGF5IGJ5dGUtaWRlbnRpY2FsIHRvIHRoZSBwcmUtdW5pb24gc2hhcGVcbi8vICh7ZG9jSWQsIHNwYW59KSDigJQgYWRkaXRpdmUgZm9yIGV2ZXJ5IGV4aXN0aW5nIGNvbnN1bWVyLlxudHlwZSBOb2RlU291cmNlID1cbiAgfCB7IGRvY0lkOiBzdHJpbmc7IHNwYW46IHN0cmluZyB8IG51bGwgfVxuICB8IHsgbWVzc2FnZUlkOiBzdHJpbmc7IHNwYW46IHN0cmluZyB8IG51bGwgfTtcblxuaW50ZXJmYWNlIE5vZGUge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBzdHJpbmc7XG4gIHRpZXI6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgc3lub3BzaXM6IHN0cmluZztcbiAgc291cmNlczogTm9kZVNvdXJjZVtdO1xuICAvLyBSb3VuZCA1IChTRzEpOiB0aGUgbm9kZSdzIHBhcmVudCBpbiB0aGUgc3VibWFwIHRyZWUgKG51bGwgPSB0b3AtbGV2ZWwpLlxuICAvLyBBTFdBWVMgY2FycmllZCDigJQgYC9zdGF0ZS5ub2Rlc1tdYCBpcyBJTkNMVVNJVkUgKGV2ZXJ5IG5vZGUgdGFnZ2VkLCBsaWtlXG4gIC8vIHByb3Bvc2Fsc1tdIGNhcnJ5IHpvbmVJZCk7IHRoZSBzdXJmYWNlIGRlcml2ZXMgdGhlIHN1Ym1hcCB2aWV3IGNsaWVudC1zaWRlXG4gIC8vIGJ5IGZpbHRlcmluZyBvbiB0aGlzLCBhbmQgdGhlIGJyZWFkY3J1bWIgYnkgd2Fsa2luZyBpdC4gYD9hbmNob3I9PGlkPmAgaXNcbiAgLy8gYSBzZXJ2ZXItc2lkZSBDTEkvYWdlbnQgbmFycm93LCBOT1QgdGhlIHN1cmZhY2UgcGF0aC5cbiAgYW5jaG9yTm9kZUlkOiBzdHJpbmcgfCBudWxsO1xuICAvLyBTZXJ2ZXItZGVyaXZlZCBjb3VudCBvZiBub2RlcyBhbmNob3JlZCB1bmRlciB0aGlzIG9uZSAoR1JPVVAtQlkgb3ZlciB0aGVcbiAgLy8gRlVMTCB0YWJsZSwgb24gRVZFUlkgbm9kZSBpbiBFVkVSWSByZXNwb25zZSBpbmNsLiBzY29wZWQpIOKAlCBhIFwiaGFzIHN1Ym1hcFwiXG4gIC8vIGJhZGdlIHdpdGhvdXQgYSBzZWNvbmQgcXVlcnkuIDAgPSBsZWFmLlxuICBzdWJtYXBDaGlsZENvdW50OiBudW1iZXI7XG4gIC8vIFJvdW5kIDQgKEExKTogYWdlbnQtYXV0aG9yZWQgYWN0aW9uIHNsb3RzIOKAlCBhYnNlbnQgPSBub25lIChhZGRpdGl2ZSBmb3JcbiAgLy8gZXZlcnkgZXhpc3RpbmcgY29uc3VtZXI7IHRoZSBzdXJmYWNlIHJlbmRlcnMgNCArIHNjcm9sbCkuXG4gIGFjdGlvbnM/OiBBY3Rpb25TbG90W107XG4gIC8vIFJvdW5kIDcgKFRBR1MpOiBmcmVlZm9ybSBhZ2VudC1jdXJhdGVkIHRhZ3Mg4oCUIGFic2VudCA9IG5vbmUgKGFkZGl0aXZlO1xuICAvLyB0aGUgdGFyZ2V0LWtleWVkIHR3aW4gb2YgYWN0aW9ucywgc28gbm9kZXMgY2FycnkgdGhlbSB0aGUgc2FtZSB3YXkpLlxuICB0YWdzPzogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBFZGdlIHtcbiAgaWQ6IHN0cmluZztcbiAgc291cmNlOiBzdHJpbmc7XG4gIHRhcmdldDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xuICBwcm92ZW5hbmNlOiBzdHJpbmc7XG4gIGRpcmVjdGlvbjogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFByb3Bvc2FsIHtcbiAgaWQ6IHN0cmluZztcbiAga2luZDogc3RyaW5nO1xuICBkcmFmdDogdW5rbm93bjtcbiAgZXZpZGVuY2U6IHsgZG9jSWQ6IHN0cmluZyB8IG51bGw7IG1lc3NhZ2VJZDogc3RyaW5nIHwgbnVsbDsgc3Bhbjogc3RyaW5nIHwgbnVsbCB9O1xuICBzdWdnZXN0ZWRUaWVyOiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IHN0cmluZztcbiAgcmVzdWx0Tm9kZUlkOiBzdHJpbmcgfCBudWxsO1xuICAvLyBDbGFpbSBEOiB0aGUgd2lyZSBBTFdBWVMgY2FycmllcyBcInVzZXJcInxcImFnZW50XCIsIG5ldmVyIG51bGwg4oCUIGEgbnVsbFxuICAvLyBjb2x1bW4gdmFsdWUgKHByZS1hdXRob3Igcm93KSBub3JtYWxpemVzIHRvIFwiYWdlbnRcIiBhdCByZWFkIHRpbWUuXG4gIGF1dGhvcjogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG4gIC8vIFJvdW5kIDMgKENsYWltIFoxLCBhcyBydWxlZCk6IHRoZSB3aXJlIEFMV0FZUyBjYXJyaWVzIHpvbmVJZCDigJQgbnVsbFxuICAvLyBtZWFucyBtYWluIHF1ZXVlLiAvc3RhdGUucHJvcG9zYWxzW10gSU5DTFVERVMgem9uZWQgcm93cyAodGFnZ2VkLCBub1xuICAvLyBkZWZhdWx0IGV4Y2x1c2lvbikgc28gc25hcHNob3QgbWVyZ2UgYW5kIGV2ZW50IGluZ2VzdGlvbiBvYmV5IE9ORSBydWxlO1xuICAvLyB0aGUgbWFpbiB2aWV3IGlzIGB6b25lSWQgPT0gbnVsbGAgYXQgcmVuZGVyLCBhbmQgP3pvbmU9PGlkPiBuYXJyb3dzLlxuICB6b25lSWQ6IHN0cmluZyB8IG51bGw7XG4gIC8vIFJvdW5kIDEyIChTRUFNIDEpOiB0aGUgc3RhZ2luZyBBQ1QgdGhpcyBwcm9wb3NhbCBjYW1lIGZyb20g4oCUIEFMV0FZUyBjYXJyaWVkXG4gIC8vIChudWxsID0gdW5iYXRjaGVkLCB0aGUgem9uZUlkIHByZWNlZGVudCkuIEl0IFNVUlZJVkVTIHJhdGlmaWNhdGlvbiBiZWNhdXNlXG4gIC8vIHRoZSBwcm9wb3NhbCByb3cgZG9lczogdGhhdCBpcyB3aGF0IHR1cm5zIFwid2hhdCBlbHNlIGNhbWUgZnJvbSB0aGF0IGNhbGw/XCJcbiAgLy8gaW50byBhIHF1ZXJ5IGluc3RlYWQgb2YgYWdlbnQgbWVtb3J5IChGNS4xLCB0aGUgZHJpdmUtMTAgcm9vdCBlbmFibGVyKS5cbiAgYmF0Y2hJZDogc3RyaW5nIHwgbnVsbDtcbiAgLy8gUm91bmQgNCAoQTEpOiBhY3Rpb25zIGF0dGFjaCB0byBQRU5ESU5HIHByb3Bvc2FscyB0b28gKENvbGUncyBjb25zdHJhaW50LFxuICAvLyBtZXQgdmlhIHRoZSB0YXJnZXQta2V5ZWQgdGFibGUpIOKAlCBhYnNlbnQgPSBub25lLlxuICBhY3Rpb25zPzogQWN0aW9uU2xvdFtdO1xuICAvLyBSb3VuZCA3IChUQUdTKTogdGFncyBhdHRhY2ggdG8gUEVORElORyBwcm9wb3NhbHMgdG9vIChzYW1lIHRhcmdldC1rZXllZFxuICAvLyB0YWJsZSkg4oCUIGEgcHJvcG9zYWwgY2FycmllcyB0YWdzIHByZS1yYXRpZnkgYW5kIHJlLWhvbWVzIHRoZW0gb24gcmF0aWZ5LlxuICB0YWdzPzogc3RyaW5nW107XG59XG5cbmludGVyZmFjZSBNZXNzYWdlIHtcbiAgaWQ6IHN0cmluZztcbiAgc2VxOiBudW1iZXI7XG4gIHJvbGU6IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgZ3JvdW5kOiBzdHJpbmdbXSB8IG51bGw7XG4gIHRzOiBudW1iZXI7XG59XG5cbi8vIFJvdW5kIDMgKENsYWltIFYyKTogb25lIGxlbnMgcm93LCB0d28gbW9kZXMg4oCUIG5vZGUgWE9SIGRvYywgZW5mb3JjZWQgYnlcbi8vIGNvbnN0cnVjdGlvbiAoc2V0TGVucyB3cml0ZXMgZXZlcnkgY29sdW1uIG9uIHVwc2VydDsgdGhlIC9sZW5zIHJvdXRlXG4vLyB2YWxpZGF0ZXMgdGhlIFhPUikuIFRoZSB3aXJlIEFMV0FZUyBjYXJyaWVzIGRvY0lkIChudWxsIG9uIGEgbm9kZSBsZW5zIC9cbi8vIGNsZWFyKSDigJQgYWRkaXRpdmUtb3B0aW9uYWwgZm9yIHByZS1kb2MtbGVucyBjb25zdW1lcnMuXG5pbnRlcmZhY2UgTGVucyB7XG4gIG93bmVyOiBzdHJpbmc7XG4gIG5vZGVJZDogc3RyaW5nIHwgbnVsbDtcbiAgZGVwdGg6IG51bWJlciB8IG51bGw7XG4gIGRvY0lkOiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgWm9uZSB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFByb2plY3RTdGF0ZSB7XG4gIHByb2plY3Q6IFByb2plY3RNZXRhO1xuICBkb2NzOiBEb2NbXTtcbiAgbm9kZXM6IE5vZGVbXTtcbiAgZWRnZXM6IEVkZ2VbXTtcbiAgem9uZXM6IFpvbmVbXTtcbiAgcHJvcG9zYWxzOiBQcm9wb3NhbFtdO1xuICBjb252ZXJzYXRpb246IE1lc3NhZ2VbXTtcbiAgLy8gUm91bmQgOSAoSm9iIFF1ZXVlKTogdGhlIHBlcnNpc3RlZCBhZ2VudC13b3JrIHVuaXRzIHNlZWQgdGhlIHNpZGViYXIgKEQzIOKAlFxuICAvLyBldmVudHMga2VlcCBpdCBsaXZlIHRoZXJlYWZ0ZXIpLiBVbmZpbHRlcmVkIHBlci1wcm9qZWN0IHJlYWQuXG4gIGpvYnM6IEpvYltdO1xuICBsZW5zOiBMZW5zIHwgbnVsbDtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIGVwb2NoOiBzdHJpbmc7XG59XG5cbi8vIGBwcm9qZWN0Um9vdGAgKHRoZSBkaXJlY3RvcnkgaG9sZGluZyBkb2NzLykgaXMgbmVlZGVkIG9ubHkgZm9yIG1hcmtcbi8vIHN0YWxlbmVzcyDigJQgd2l0aG91dCBpdCwgbWFya3Mgc3RpbGwgbWVyZ2UgYnV0IHJlYWQgYXMgc3RhbGUgKGFuXG4vLyB1bnZlcmlmaWFibGUgbWFyayB2b3VjaGVzIGZvciBub3RoaW5nKS4gVGhlIGRhZW1vbiBhbHdheXMgcGFzc2VzIGl0LlxuZnVuY3Rpb24gcmVhZFN0YXRlKFxuICBkYjogRGF0YWJhc2UsXG4gIHByb2plY3Q6IFByb2plY3RNZXRhLFxuICBjdXJzb3IgPSAwLFxuICBlcG9jaCA9IFwiXCIsXG4gIHByb2plY3RSb290Pzogc3RyaW5nLFxuKTogUHJvamVjdFN0YXRlIHtcbiAgY29uc3QgZG9jUm93cyA9IGRiXG4gICAgLnF1ZXJ5KFwiU0VMRUNUIGlkLCB0aXRsZSwga2luZCwgcGF0aCwga2luZF9hdXRob3IgRlJPTSBkb2NzIE9SREVSIEJZIGNyZWF0ZWRfYXRcIilcbiAgICAuYWxsKCkgYXMgQXJyYXk8e1xuICAgIGlkOiBzdHJpbmc7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBraW5kOiBzdHJpbmc7XG4gICAgcGF0aDogc3RyaW5nO1xuICAgIGtpbmRfYXV0aG9yOiBzdHJpbmcgfCBudWxsO1xuICB9PjtcbiAgY29uc3QgcGF0aEJ5RG9jID0gbmV3IE1hcChkb2NSb3dzLm1hcCgocm93KSA9PiBbcm93LmlkLCByb3cucGF0aF0pKTtcbiAgY29uc3QgbWFya3MgPSByZWFkRG9jTWFya3MoZGIsIChkb2NJZCkgPT4ge1xuICAgIGNvbnN0IHJlbFBhdGggPSBwYXRoQnlEb2MuZ2V0KGRvY0lkKTtcbiAgICBpZiAocHJvamVjdFJvb3QgPT09IHVuZGVmaW5lZCB8fCByZWxQYXRoID09PSB1bmRlZmluZWQpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBkb2NGaWxlTXRpbWUocHJvamVjdFJvb3QsIHJlbFBhdGgpO1xuICB9KTtcbiAgY29uc3QgZG9jczogRG9jW10gPSBkb2NSb3dzLm1hcCgocm93KSA9PiB7XG4gICAgY29uc3QgbWFyayA9IG1hcmtzLmdldChyb3cuaWQpO1xuICAgIC8vICcnIOKGkiBudWxsIGF0IHJlYWQgKEsxJ3MgcmVzdC12cy13aXJlIHNwbGl0KTsga2luZF9hdXRob3Igbm9ybWFsaXplcyB0b1xuICAgIC8vIHRoZSB1bmlvbiBvciBudWxsIChhIHN0cmF5IHN0b3JlZCB2YWx1ZSByZWFkcyBhcyB1bmF0dHJpYnV0ZWQpLlxuICAgIGNvbnN0IGtpbmQgPSByb3cua2luZCA9PT0gXCJcIiA/IG51bGwgOiByb3cua2luZDtcbiAgICBjb25zdCBraW5kQXV0aG9yID1cbiAgICAgIHJvdy5raW5kX2F1dGhvciA9PT0gXCJ1c2VyXCIgfHwgcm93LmtpbmRfYXV0aG9yID09PSBcImFnZW50XCIgPyByb3cua2luZF9hdXRob3IgOiBudWxsO1xuICAgIHJldHVybiBtYXJrXG4gICAgICA/IHsgaWQ6IHJvdy5pZCwgdGl0bGU6IHJvdy50aXRsZSwga2luZCwga2luZEF1dGhvciwgbWFyayB9XG4gICAgICA6IHsgaWQ6IHJvdy5pZCwgdGl0bGU6IHJvdy50aXRsZSwga2luZCwga2luZEF1dGhvciB9O1xuICB9KTtcblxuICBjb25zdCBub2RlUm93cyA9IGRiXG4gICAgLnF1ZXJ5KFwiU0VMRUNUIGlkLCBraW5kLCB0aWVyLCB0aXRsZSwgc3lub3BzaXMsIGFuY2hvcl9ub2RlX2lkIEZST00gbm9kZXMgT1JERVIgQlkgY3JlYXRlZF9hdFwiKVxuICAgIC5hbGwoKSBhcyBBcnJheTx7XG4gICAgaWQ6IHN0cmluZztcbiAgICBraW5kOiBzdHJpbmc7XG4gICAgdGllcjogc3RyaW5nO1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgc3lub3BzaXM6IHN0cmluZztcbiAgICBhbmNob3Jfbm9kZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgfT47XG4gIC8vIFNHMTogc3VibWFwQ2hpbGRDb3VudCBpcyBhIEdST1VQLUJZIG92ZXIgdGhlIEZVTEwgbm9kZXMgdGFibGUg4oCUIGNvbXB1dGVkXG4gIC8vIG9uY2UgaGVyZSBhbmQgYXR0YWNoZWQgdG8gZXZlcnkgbm9kZSwgc28gYSBzY29wZWQvbmFycm93ZWQgcmVzcG9uc2Ugc3RpbGxcbiAgLy8gcmVwb3J0cyB0aGUgdHJ1ZSBjaGlsZCBjb3VudCAodGhlIGJhZGdlIG11c3Qgbm90IGxpZSBpbiBhIHN1Ym1hcCB2aWV3KS5cbiAgY29uc3QgY2hpbGRDb3VudFJvd3MgPSBkYlxuICAgIC5xdWVyeShcbiAgICAgIFwiU0VMRUNUIGFuY2hvcl9ub2RlX2lkIEFTIHBhcmVudCwgQ09VTlQoKikgQVMgbiBGUk9NIG5vZGVzIFdIRVJFIGFuY2hvcl9ub2RlX2lkIElTIE5PVCBOVUxMIEdST1VQIEJZIGFuY2hvcl9ub2RlX2lkXCIsXG4gICAgKVxuICAgIC5hbGwoKSBhcyBBcnJheTx7IHBhcmVudDogc3RyaW5nOyBuOiBudW1iZXIgfT47XG4gIGNvbnN0IHN1Ym1hcENoaWxkQ291bnQgPSBuZXcgTWFwKGNoaWxkQ291bnRSb3dzLm1hcCgocikgPT4gW3IucGFyZW50LCByLm5dKSk7XG4gIGNvbnN0IHNvdXJjZVJvd3MgPSBkYi5xdWVyeShcIlNFTEVDVCBub2RlX2lkLCBkb2NfaWQsIHNwYW4gRlJPTSBzb3VyY2VzXCIpLmFsbCgpIGFzIEFycmF5PHtcbiAgICBub2RlX2lkOiBzdHJpbmc7XG4gICAgZG9jX2lkOiBzdHJpbmc7XG4gICAgc3Bhbjogc3RyaW5nIHwgbnVsbDtcbiAgfT47XG4gIGNvbnN0IG1lc3NhZ2VTb3VyY2VSb3dzID0gZGJcbiAgICAucXVlcnkoXCJTRUxFQ1Qgbm9kZV9pZCwgbWVzc2FnZV9pZCwgc3BhbiBGUk9NIG1lc3NhZ2Vfc291cmNlc1wiKVxuICAgIC5hbGwoKSBhcyBBcnJheTx7XG4gICAgbm9kZV9pZDogc3RyaW5nO1xuICAgIG1lc3NhZ2VfaWQ6IHN0cmluZztcbiAgICBzcGFuOiBzdHJpbmcgfCBudWxsO1xuICB9PjtcbiAgY29uc3Qgc291cmNlc0J5Tm9kZSA9IG5ldyBNYXA8c3RyaW5nLCBOb2RlU291cmNlW10+KCk7XG4gIGZvciAoY29uc3Qgcm93IG9mIHNvdXJjZVJvd3MpIHtcbiAgICBjb25zdCBsaXN0ID0gc291cmNlc0J5Tm9kZS5nZXQocm93Lm5vZGVfaWQpID8/IFtdO1xuICAgIGxpc3QucHVzaCh7IGRvY0lkOiByb3cuZG9jX2lkLCBzcGFuOiByb3cuc3BhbiB9KTtcbiAgICBzb3VyY2VzQnlOb2RlLnNldChyb3cubm9kZV9pZCwgbGlzdCk7XG4gIH1cbiAgZm9yIChjb25zdCByb3cgb2YgbWVzc2FnZVNvdXJjZVJvd3MpIHtcbiAgICBjb25zdCBsaXN0ID0gc291cmNlc0J5Tm9kZS5nZXQocm93Lm5vZGVfaWQpID8/IFtdO1xuICAgIGxpc3QucHVzaCh7IG1lc3NhZ2VJZDogcm93Lm1lc3NhZ2VfaWQsIHNwYW46IHJvdy5zcGFuIH0pO1xuICAgIHNvdXJjZXNCeU5vZGUuc2V0KHJvdy5ub2RlX2lkLCBsaXN0KTtcbiAgfVxuICAvLyBBMS9UQUdTOiBvbmUgcmVhZCBlYWNoIHNlcnZlcyBib3RoIG1lcmdlcyDigJQgYWN0aW9ucyBBTkQgdGFncyBhdHRhY2ggdG9cbiAgLy8gbm9kZXMgQU5EIHBlbmRpbmcgcHJvcG9zYWxzIGJ5IHRhcmdldCBpZCAoYWJzZW50ID0gbm9uZSwgYWRkaXRpdmUtb3B0aW9uYWwpLlxuICBjb25zdCBhY3Rpb25zQnlUYXJnZXQgPSByZWFkQWN0aW9ucyhkYik7XG4gIGNvbnN0IHRhZ3NCeVRhcmdldCA9IHJlYWRUYWdzKGRiKTtcbiAgY29uc3Qgbm9kZXM6IE5vZGVbXSA9IG5vZGVSb3dzLm1hcCgocm93KSA9PiB7XG4gICAgY29uc3QgYWN0aW9ucyA9IGFjdGlvbnNCeVRhcmdldC5nZXQocm93LmlkKTtcbiAgICBjb25zdCB0YWdzID0gdGFnc0J5VGFyZ2V0LmdldChyb3cuaWQpO1xuICAgIHJldHVybiB7XG4gICAgICBpZDogcm93LmlkLFxuICAgICAga2luZDogcm93LmtpbmQsXG4gICAgICB0aWVyOiByb3cudGllcixcbiAgICAgIHRpdGxlOiByb3cudGl0bGUsXG4gICAgICBzeW5vcHNpczogcm93LnN5bm9wc2lzLFxuICAgICAgYW5jaG9yTm9kZUlkOiByb3cuYW5jaG9yX25vZGVfaWQsXG4gICAgICBzdWJtYXBDaGlsZENvdW50OiBzdWJtYXBDaGlsZENvdW50LmdldChyb3cuaWQpID8/IDAsXG4gICAgICBzb3VyY2VzOiBzb3VyY2VzQnlOb2RlLmdldChyb3cuaWQpID8/IFtdLFxuICAgICAgLi4uKGFjdGlvbnMgPyB7IGFjdGlvbnMgfSA6IHt9KSxcbiAgICAgIC4uLih0YWdzID8geyB0YWdzIH0gOiB7fSksXG4gICAgfTtcbiAgfSk7XG5cbiAgY29uc3QgZWRnZXMgPSBkYlxuICAgIC5xdWVyeShcIlNFTEVDVCBpZCwgc291cmNlLCB0YXJnZXQsIGxhYmVsLCBwcm92ZW5hbmNlLCBkaXJlY3Rpb24gRlJPTSBlZGdlcyBPUkRFUiBCWSBjcmVhdGVkX2F0XCIpXG4gICAgLmFsbCgpIGFzIEVkZ2VbXTtcblxuICBjb25zdCB6b25lcyA9IGRiLnF1ZXJ5KFwiU0VMRUNUIGlkLCBuYW1lIEZST00gem9uZXMgT1JERVIgQlkgdHMsIGlkXCIpLmFsbCgpIGFzIFpvbmVbXTtcblxuICBjb25zdCBwcm9wb3NhbFJvd3MgPSBkYlxuICAgIC5xdWVyeShcbiAgICAgIFwiU0VMRUNUIGlkLCBraW5kLCBkcmFmdF9qc29uLCBldmlkZW5jZV9kb2NfaWQsIGV2aWRlbmNlX21lc3NhZ2VfaWQsIGV2aWRlbmNlX3NwYW4sIHN1Z2dlc3RlZF90aWVyLCBzdGF0dXMsIHJlc3VsdF9ub2RlX2lkLCBhdXRob3IsIHpvbmVfaWQsIGJhdGNoX2lkIEZST00gcHJvcG9zYWxzIE9SREVSIEJZIGNyZWF0ZWRfYXRcIixcbiAgICApXG4gICAgLmFsbCgpIGFzIEFycmF5PHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGtpbmQ6IHN0cmluZztcbiAgICBkcmFmdF9qc29uOiBzdHJpbmc7XG4gICAgZXZpZGVuY2VfZG9jX2lkOiBzdHJpbmcgfCBudWxsO1xuICAgIGV2aWRlbmNlX21lc3NhZ2VfaWQ6IHN0cmluZyB8IG51bGw7XG4gICAgZXZpZGVuY2Vfc3Bhbjogc3RyaW5nIHwgbnVsbDtcbiAgICBzdWdnZXN0ZWRfdGllcjogc3RyaW5nIHwgbnVsbDtcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgICByZXN1bHRfbm9kZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgICBhdXRob3I6IHN0cmluZyB8IG51bGw7XG4gICAgem9uZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgICBiYXRjaF9pZDogc3RyaW5nIHwgbnVsbDtcbiAgfT47XG4gIGNvbnN0IHByb3Bvc2FsczogUHJvcG9zYWxbXSA9IHByb3Bvc2FsUm93cy5tYXAoKHJvdykgPT4ge1xuICAgIGNvbnN0IGFjdGlvbnMgPSBhY3Rpb25zQnlUYXJnZXQuZ2V0KHJvdy5pZCk7XG4gICAgY29uc3QgdGFncyA9IHRhZ3NCeVRhcmdldC5nZXQocm93LmlkKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQ6IHJvdy5pZCxcbiAgICAgIGtpbmQ6IHJvdy5raW5kLFxuICAgICAgZHJhZnQ6IEpTT04ucGFyc2Uocm93LmRyYWZ0X2pzb24pLFxuICAgICAgZXZpZGVuY2U6IHtcbiAgICAgICAgZG9jSWQ6IHJvdy5ldmlkZW5jZV9kb2NfaWQsXG4gICAgICAgIG1lc3NhZ2VJZDogcm93LmV2aWRlbmNlX21lc3NhZ2VfaWQsXG4gICAgICAgIHNwYW46IHJvdy5ldmlkZW5jZV9zcGFuLFxuICAgICAgfSxcbiAgICAgIHN1Z2dlc3RlZFRpZXI6IHJvdy5zdWdnZXN0ZWRfdGllcixcbiAgICAgIHN0YXR1czogcm93LnN0YXR1cyxcbiAgICAgIHJlc3VsdE5vZGVJZDogcm93LnJlc3VsdF9ub2RlX2lkLFxuICAgICAgYXV0aG9yOiByb3cuYXV0aG9yID09PSBcInVzZXJcIiA/IFwidXNlclwiIDogXCJhZ2VudFwiLFxuICAgICAgem9uZUlkOiByb3cuem9uZV9pZCxcbiAgICAgIGJhdGNoSWQ6IHJvdy5iYXRjaF9pZCxcbiAgICAgIC4uLihhY3Rpb25zID8geyBhY3Rpb25zIH0gOiB7fSksXG4gICAgICAuLi4odGFncyA/IHsgdGFncyB9IDoge30pLFxuICAgIH07XG4gIH0pO1xuXG4gIGNvbnN0IG1lc3NhZ2VSb3dzID0gZGJcbiAgICAucXVlcnkoXG4gICAgICBcIlNFTEVDVCBpZCwgc2VxLCByb2xlLCBraW5kLCB0ZXh0LCBncm91bmRfanNvbiwgdHMgRlJPTSBtZXNzYWdlcyBXSEVSRSBwcm9qZWN0X2lkID0gPyBPUkRFUiBCWSBzZXFcIixcbiAgICApXG4gICAgLmFsbChwcm9qZWN0LmlkKSBhcyBBcnJheTx7XG4gICAgaWQ6IHN0cmluZztcbiAgICBzZXE6IG51bWJlcjtcbiAgICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAgICBraW5kOiBzdHJpbmc7XG4gICAgdGV4dDogc3RyaW5nO1xuICAgIGdyb3VuZF9qc29uOiBzdHJpbmcgfCBudWxsO1xuICAgIHRzOiBudW1iZXI7XG4gIH0+O1xuICBjb25zdCBjb252ZXJzYXRpb246IE1lc3NhZ2VbXSA9IG1lc3NhZ2VSb3dzLm1hcCgocm93KSA9PiAoe1xuICAgIGlkOiByb3cuaWQsXG4gICAgc2VxOiByb3cuc2VxLFxuICAgIHJvbGU6IHJvdy5yb2xlLFxuICAgIGtpbmQ6IHJvdy5raW5kLFxuICAgIHRleHQ6IHJvdy50ZXh0LFxuICAgIGdyb3VuZDogcm93Lmdyb3VuZF9qc29uID8gKEpTT04ucGFyc2Uocm93Lmdyb3VuZF9qc29uKSBhcyBzdHJpbmdbXSkgOiBudWxsLFxuICAgIHRzOiByb3cudHMsXG4gIH0pKTtcblxuICBjb25zdCBsZW5zUm93ID0gZGJcbiAgICAucXVlcnkoXCJTRUxFQ1Qgb3duZXIsIG5vZGVfaWQsIGRlcHRoLCBkb2NfaWQgRlJPTSBsZW5zIFdIRVJFIHByb2plY3RfaWQgPSA/XCIpXG4gICAgLmdldChwcm9qZWN0LmlkKSBhcyB7XG4gICAgb3duZXI6IHN0cmluZztcbiAgICBub2RlX2lkOiBzdHJpbmcgfCBudWxsO1xuICAgIGRlcHRoOiBudW1iZXIgfCBudWxsO1xuICAgIGRvY19pZDogc3RyaW5nIHwgbnVsbDtcbiAgfSB8IG51bGw7XG4gIGNvbnN0IGxlbnM6IExlbnMgfCBudWxsID0gbGVuc1Jvd1xuICAgID8geyBvd25lcjogbGVuc1Jvdy5vd25lciwgbm9kZUlkOiBsZW5zUm93Lm5vZGVfaWQsIGRlcHRoOiBsZW5zUm93LmRlcHRoLCBkb2NJZDogbGVuc1Jvdy5kb2NfaWQgfVxuICAgIDogbnVsbDtcblxuICBjb25zdCBqb2JzID0gcmVhZEpvYnMoZGIpO1xuXG4gIHJldHVybiB7XG4gICAgcHJvamVjdCxcbiAgICBkb2NzLFxuICAgIG5vZGVzLFxuICAgIGVkZ2VzLFxuICAgIHpvbmVzLFxuICAgIHByb3Bvc2FscyxcbiAgICBjb252ZXJzYXRpb24sXG4gICAgam9icyxcbiAgICBsZW5zLFxuICAgIGN1cnNvcixcbiAgICBlcG9jaCxcbiAgfTtcbn1cblxuLy8gUm91bmQgMTIgKFNFQU0gNCk6IHJlYWQgT05FIG5vZGUgaW4gdGhlIGV4YWN0IHdpcmUgc2hhcGUgcmVhZFN0YXRlIHByb2R1Y2VzXG4vLyAoc291cmNlcyB1bmlvbiwgYW5jaG9yTm9kZUlkLCBzdWJtYXBDaGlsZENvdW50LCBhY3Rpb25zLCB0YWdzKS4gYG5vZGUuZWRpdGVkYFxuLy8gY2FycmllcyB0aGUgRlVMTCBub2RlLCBhbmQgdGhlIHJlLWVtaXQtdGhyb3VnaC10aGUtc2luZ2xlLXNvdXJjZS1yZWFkZXIgcnVsZVxuLy8gc2F5cyBhIHBheWxvYWQgYSByZXBsYWNlLWJ5LWlkIGNvbnN1bWVyIGhvbGRzIG11c3QgTkVWRVIgYmUgaGFuZC1hc3NlbWJsZWQg4oCUXG4vLyB0aGUgcmVhZFByb3Bvc2FsQnlJZCB0d2luLCBmb3IgdGhlIHNhbWUgcmVhc29uLiBSZXR1cm5zIG51bGwgZm9yIGFuIHVua25vd24gaWQuXG5mdW5jdGlvbiByZWFkTm9kZUJ5SWQoZGI6IERhdGFiYXNlLCBpZDogc3RyaW5nKTogTm9kZSB8IG51bGwge1xuICBjb25zdCByb3cgPSBkYlxuICAgIC5xdWVyeShcIlNFTEVDVCBpZCwga2luZCwgdGllciwgdGl0bGUsIHN5bm9wc2lzLCBhbmNob3Jfbm9kZV9pZCBGUk9NIG5vZGVzIFdIRVJFIGlkID0gP1wiKVxuICAgIC5nZXQoaWQpIGFzIHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGtpbmQ6IHN0cmluZztcbiAgICB0aWVyOiBzdHJpbmc7XG4gICAgdGl0bGU6IHN0cmluZztcbiAgICBzeW5vcHNpczogc3RyaW5nO1xuICAgIGFuY2hvcl9ub2RlX2lkOiBzdHJpbmcgfCBudWxsO1xuICB9IHwgbnVsbDtcbiAgaWYgKCFyb3cpIHJldHVybiBudWxsO1xuICBjb25zdCBzb3VyY2VzOiBOb2RlU291cmNlW10gPSBbXG4gICAgLi4uKFxuICAgICAgZGIucXVlcnkoXCJTRUxFQ1QgZG9jX2lkLCBzcGFuIEZST00gc291cmNlcyBXSEVSRSBub2RlX2lkID0gP1wiKS5hbGwoaWQpIGFzIEFycmF5PHtcbiAgICAgICAgZG9jX2lkOiBzdHJpbmc7XG4gICAgICAgIHNwYW46IHN0cmluZyB8IG51bGw7XG4gICAgICB9PlxuICAgICkubWFwKChzKSA9PiAoeyBkb2NJZDogcy5kb2NfaWQsIHNwYW46IHMuc3BhbiB9KSksXG4gICAgLi4uKFxuICAgICAgZGIucXVlcnkoXCJTRUxFQ1QgbWVzc2FnZV9pZCwgc3BhbiBGUk9NIG1lc3NhZ2Vfc291cmNlcyBXSEVSRSBub2RlX2lkID0gP1wiKS5hbGwoaWQpIGFzIEFycmF5PHtcbiAgICAgICAgbWVzc2FnZV9pZDogc3RyaW5nO1xuICAgICAgICBzcGFuOiBzdHJpbmcgfCBudWxsO1xuICAgICAgfT5cbiAgICApLm1hcCgocykgPT4gKHsgbWVzc2FnZUlkOiBzLm1lc3NhZ2VfaWQsIHNwYW46IHMuc3BhbiB9KSksXG4gIF07XG4gIGNvbnN0IGNoaWxkQ291bnQgPSAoXG4gICAgZGIucXVlcnkoXCJTRUxFQ1QgQ09VTlQoKikgQVMgbiBGUk9NIG5vZGVzIFdIRVJFIGFuY2hvcl9ub2RlX2lkID0gP1wiKS5nZXQoaWQpIGFzIHsgbjogbnVtYmVyIH1cbiAgKS5uO1xuICBjb25zdCBhY3Rpb25zID0gcmVhZEFjdGlvbnMoZGIpLmdldChpZCk7XG4gIGNvbnN0IHRhZ3MgPSByZWFkVGFncyhkYikuZ2V0KGlkKTtcbiAgcmV0dXJuIHtcbiAgICBpZDogcm93LmlkLFxuICAgIGtpbmQ6IHJvdy5raW5kLFxuICAgIHRpZXI6IHJvdy50aWVyLFxuICAgIHRpdGxlOiByb3cudGl0bGUsXG4gICAgc3lub3BzaXM6IHJvdy5zeW5vcHNpcyxcbiAgICBhbmNob3JOb2RlSWQ6IHJvdy5hbmNob3Jfbm9kZV9pZCxcbiAgICBzdWJtYXBDaGlsZENvdW50OiBjaGlsZENvdW50LFxuICAgIHNvdXJjZXMsXG4gICAgLi4uKGFjdGlvbnMgPyB7IGFjdGlvbnMgfSA6IHt9KSxcbiAgICAuLi4odGFncyA/IHsgdGFncyB9IDoge30pLFxuICB9O1xufVxuXG4vLyBSb3VuZCA1IChJQy1jKTogcmVhZCBPTkUgcHJvcG9zYWwgaW4gdGhlIGV4YWN0IHdpcmUgc2hhcGUgcmVhZFN0YXRlXG4vLyBwcm9kdWNlcyAoZXZpZGVuY2UgdW5pb24sIGF1dGhvciBub3JtYWxpemVkLCB6b25lSWQsIGFjdGlvbnMgYXR0YWNoZWQpLiBUaGVcbi8vIHpvbmUtbW92ZSBlbmRwb2ludCByZS1lbWl0cyBgcHJvcG9zYWwuYWRkZWRgIHdpdGggdGhpcyBzbyBhbiBpbmNsdXNpdmVcbi8vIGNvbnN1bWVyIHJlLXRhZ3MgdGhlIHJvdyB3aXRob3V0IGNsb2JiZXJpbmcgaXRzIGFjdGlvbnMg4oCUIHRoZSBzYW1lIHNoYXBlIGFcbi8vIGZyZXNoIC9zdGF0ZSB3b3VsZCByZXBvcnQuIFJldHVybnMgbnVsbCBmb3IgYW4gdW5rbm93biBpZC5cbmZ1bmN0aW9uIHJlYWRQcm9wb3NhbEJ5SWQoZGI6IERhdGFiYXNlLCBpZDogc3RyaW5nKTogUHJvcG9zYWwgfCBudWxsIHtcbiAgY29uc3Qgcm93ID0gZGJcbiAgICAucXVlcnkoXG4gICAgICBcIlNFTEVDVCBpZCwga2luZCwgZHJhZnRfanNvbiwgZXZpZGVuY2VfZG9jX2lkLCBldmlkZW5jZV9tZXNzYWdlX2lkLCBldmlkZW5jZV9zcGFuLCBzdWdnZXN0ZWRfdGllciwgc3RhdHVzLCByZXN1bHRfbm9kZV9pZCwgYXV0aG9yLCB6b25lX2lkLCBiYXRjaF9pZCBGUk9NIHByb3Bvc2FscyBXSEVSRSBpZCA9ID9cIixcbiAgICApXG4gICAgLmdldChpZCkgYXMge1xuICAgIGlkOiBzdHJpbmc7XG4gICAga2luZDogc3RyaW5nO1xuICAgIGRyYWZ0X2pzb246IHN0cmluZztcbiAgICBldmlkZW5jZV9kb2NfaWQ6IHN0cmluZyB8IG51bGw7XG4gICAgZXZpZGVuY2VfbWVzc2FnZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgICBldmlkZW5jZV9zcGFuOiBzdHJpbmcgfCBudWxsO1xuICAgIHN1Z2dlc3RlZF90aWVyOiBzdHJpbmcgfCBudWxsO1xuICAgIHN0YXR1czogc3RyaW5nO1xuICAgIHJlc3VsdF9ub2RlX2lkOiBzdHJpbmcgfCBudWxsO1xuICAgIGF1dGhvcjogc3RyaW5nIHwgbnVsbDtcbiAgICB6b25lX2lkOiBzdHJpbmcgfCBudWxsO1xuICAgIGJhdGNoX2lkOiBzdHJpbmcgfCBudWxsO1xuICB9IHwgbnVsbDtcbiAgaWYgKCFyb3cpIHJldHVybiBudWxsO1xuICBjb25zdCBhY3Rpb25zID0gcmVhZEFjdGlvbnMoZGIpLmdldChyb3cuaWQpO1xuICAvLyBUQUdTOiB0aGUgY2xvYmJlciBjYXRjaCDigJQgdGhlIHpvbmUtbW92ZSByZS1lbWl0IHJ1bnMgdGhyb3VnaCBoZXJlLCBzbyB0YWdzXG4gIC8vIG11c3QgcmlkZSB0aGUgZnVsbCBzaGFwZSBiZXNpZGUgYWN0aW9ucywgb3IgYSBtb3ZlLWludG8tem9uZSByZS1lbWl0IGRyb3BzXG4gIC8vIHRoZSBwcm9wb3NhbCdzIHRhZ3Mgb24gYW4gaW5jbHVzaXZlIGNvbnN1bWVyICh0aGUgZnVsbC1zaGFwZS1vbi1yZS1lbWl0XG4gIC8vIGxlc3NvbiDigJQgdGhlIHNhbWUgcmVhc29uIGFjdGlvbnMgd2VyZSBhZGRlZCBoZXJlKS5cbiAgY29uc3QgdGFncyA9IHJlYWRUYWdzKGRiKS5nZXQocm93LmlkKTtcbiAgcmV0dXJuIHtcbiAgICBpZDogcm93LmlkLFxuICAgIGtpbmQ6IHJvdy5raW5kLFxuICAgIGRyYWZ0OiBKU09OLnBhcnNlKHJvdy5kcmFmdF9qc29uKSxcbiAgICBldmlkZW5jZToge1xuICAgICAgZG9jSWQ6IHJvdy5ldmlkZW5jZV9kb2NfaWQsXG4gICAgICBtZXNzYWdlSWQ6IHJvdy5ldmlkZW5jZV9tZXNzYWdlX2lkLFxuICAgICAgc3Bhbjogcm93LmV2aWRlbmNlX3NwYW4sXG4gICAgfSxcbiAgICBzdWdnZXN0ZWRUaWVyOiByb3cuc3VnZ2VzdGVkX3RpZXIsXG4gICAgc3RhdHVzOiByb3cuc3RhdHVzLFxuICAgIHJlc3VsdE5vZGVJZDogcm93LnJlc3VsdF9ub2RlX2lkLFxuICAgIGF1dGhvcjogcm93LmF1dGhvciA9PT0gXCJ1c2VyXCIgPyBcInVzZXJcIiA6IFwiYWdlbnRcIixcbiAgICB6b25lSWQ6IHJvdy56b25lX2lkLFxuICAgIC8vIFNFQU0gMSByaWRlcyB0aGUgcmUtZW1pdCByZWFkZXIgdG9vIOKAlCB0aGUgc3RhbmRpbmcgY2hlY2tsaXN0IGl0ZW06IGFueVxuICAgIC8vIE5FVyBmaWVsZCBvbiB0aGUgUHJvcG9zYWwgd2lyZSBtdXN0IGxhbmQgSEVSRSBhcyB3ZWxsIGFzIGluIHJlYWRTdGF0ZSwgb3JcbiAgICAvLyBhIHpvbmUtbW92ZSByZS1lbWl0IHNpbGVudGx5IGRyb3BzIGl0IG9uIGEgcmVwbGFjZS1ieS1pZCBjb25zdW1lci5cbiAgICBiYXRjaElkOiByb3cuYmF0Y2hfaWQsXG4gICAgLi4uKGFjdGlvbnMgPyB7IGFjdGlvbnMgfSA6IHt9KSxcbiAgICAuLi4odGFncyA/IHsgdGFncyB9IDoge30pLFxuICB9O1xufVxuXG5leHBvcnQgdHlwZSB7IERvYywgRWRnZSwgTGVucywgTWVzc2FnZSwgTm9kZSwgTm9kZVNvdXJjZSwgUHJvamVjdFN0YXRlLCBQcm9wb3NhbCwgWm9uZSB9O1xuZXhwb3J0IHsgcmVhZE5vZGVCeUlkLCByZWFkUHJvcG9zYWxCeUlkLCByZWFkU3RhdGUgfTtcbiIsCiAgICAiLy8gUm91bmQgMTIgKFNFQU0gMykg4oCUIFwid2hhdCBjaGFuZ2VkXCIsIHJ1bGVkIGFuZCBCT1VOREVELlxuLy9cbi8vIOKUgOKUgCBGQUxTSUZJQ0FUSU9OIG9mIHRoZSBwbGFuJ3Mgc3RhdGVkIGJsb2NrZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIChiKSBpcyBGQUxTRS4gVGhlIHBsYW4gc2F5cyBcImBub2Rlc2AsIGBlZGdlc2AgYW5kIGBwcm9wb3NhbHNgIGNhcnJ5IG5vIGB0c2Bcbi8vIGNvbHVtbiBhdCBhbGwgKG9ubHkgYHpvbmVzYCwgYGRvY19tYXJrc2AsIGBtZXNzYWdlc2AgZG8pXCIuIFRoZXkgYWxsIGNhcnJ5XG4vLyBgY3JlYXRlZF9hdCBJTlRFR0VSIE5PVCBOVUxMIERFRkFVTFQgKHVuaXhlcG9jaCgpKWAsIGFuZCBhbHdheXMgaGF2ZSAoZGIudHNcbi8vIOKAlCBkb2NzIHRvbykuIFNvIGFuIGFkZGl0aW9ucyBkZWx0YSBuZWVkcyBaRVJPIG1pZ3JhdGlvbjsgdGhlIGNob2ljZSB3YXMgbmV2ZXJcbi8vIFwiYWRkIHRzIG9yIGdpdmUgdXBcIiwgaXQgd2FzIFwiaG93IG11Y2ggY2FuIGJlIERFUklWRUQgaG9uZXN0bHlcIi5cbi8vXG4vLyAoYSkgaXMgVFJVRSBhbmQgaXQgYmluZHMuIENvbnRyYWN0IDggcmF0aWZpZXMgbm8gZHVyYWJsZSBldmVudCBsb2csIGFuZCB0aGVcbi8vIHBsYW4gYXNrZWQgd2hldGhlciBhbiBhcHBlbmQtb25seSBgY2hhbmdlc2AgdGFibGUgKG9wdGlvbiBCKSB2aW9sYXRlcyB0aGF0XG4vLyBjbGF1c2Ugb3IgaXMgb3J0aG9nb25hbCB0byBpdC4gUlVMSU5HOiBpdCBpcyB0aGUgY2xhdXNlLCBub3Qgb3J0aG9nb25hbCB0b1xuLy8gaXQuIFRoZSBjbGF1c2UncyByYXRpb25hbGUgaXMgdGhhdCBldmVudHMgYXJlIERFUklWRUQgRlJPTSBTVEFURSBhbmQgYVxuLy8gc25hcHNob3QgaXMgdGhlIHNvbGUgZ2FwIHJlY292ZXJ5IOKAlCBhIHRhYmxlIHdob3NlIHdob2xlIHB1cnBvc2UgaXMgdG8gbGV0IGFuXG4vLyBhZ2VudCByZXN1bWUgYC0tc2luY2VgIElTIGEgZHVyYWJsZSBldmVudCBsb2csIHdoYXRldmVyIGl0IGlzIG5hbWVkLiBUd29cbi8vIGVuZ2luZWVyaW5nIHJlYXNvbnMgYWdyZWUgd2l0aCB0aGUgY29udHJhY3Q6ICgxKSBpdCB3b3VsZCBuZWVkIGEgd3JpdGUgYXRcbi8vIGV2ZXJ5IG9uZSBvZiB+MjUgbXV0YXRpb24gc2l0ZXMgdGhhdCBubyB0ZXN0IGZvcmNlcyB0byBzdGF5IGluIHN5bmMg4oCUIHRoZVxuLy8gbWlycm9yLWRyaWZ0IHRyYXAgdGhhdCBoYXMgYWxyZWFkeSBiaXR0ZW4gdGhpcyByZXBvIHR3aWNlICh0aGUgYm91bnR5IHN1cmZhY2Vcbi8vIG1pcnJvcjsgYHByb3Bvc2Utbm9kZSAtLXN0ZGluYCBzaWxlbnRseSBkcm9wcGluZyB0YWdzKSwgYW5kIGEgZGVsdGEgdGhhdFxuLy8gc2lsZW50bHkgbWlzc2VzIGEgbXV0YXRpb24gc2l0ZSBpcyBXT1JTRSB0aGFuIG5vIGRlbHRhLCB3aGljaCBpcyB0aGlzIHNlYW0nc1xuLy8gb3duIHN0YXRlZCBzdGFuZGFyZDsgKDIpIHJldGVudGlvbi92YWN1dW0gd291bGQgYmUgdW5vd25lZC5cbi8vXG4vLyDilIDilIAgV2hhdCBpcyBidWlsdCBpbnN0ZWFkOiBhZGRpdGlvbnMtb25seSwgREVSSVZFRCwgYW5kIHNlbGYtZGVjbGFyaW5nIOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIEV2ZXJ5dGhpbmcgaGVyZSBpcyBhIHB1cmUgcmVhZCBvdmVyIGNvbHVtbnMgdGhhdCBhbHJlYWR5IGV4aXN0LiBJdCBjYW5ub3Rcbi8vIGRyaWZ0IGZyb20gdGhlIG11dGF0aW9uIHNpdGVzIGJlY2F1c2UgaXQgZG9lcyBub3QgdG91Y2ggdGhlbS4gSXQgaXNcbi8vIGRlbGliZXJhdGVseSBOT1QgdGhlIHdob2xlIGFuc3dlciwgYW5kIHRoZSB3aG9sZSBwb2ludCBvZiB0aGUgc2hhcGUgaXMgdGhhdFxuLy8gaXQgU0FZUyBTTzogYG5vdENvdmVyZWRgIGlzIHRoZSByZXNwb25zZSdzIGxhcmdlc3QgZmllbGQsIG1vZGVsbGVkIG9uIHRoZVxuLy8gYC0taW5ib3VuZGAgZ3JvdW5kaW5nIGxpbmUncyBgbm90V2F0Y2hpbmdgLCB3aGljaCBkcml2ZSAjMTAgc2luZ2xlZCBvdXQgYXNcbi8vIHRoZSBiZXN0IGFnZW50LWZhY2luZyBkZXNpZ24gaW4gdGhlIHN5c3RlbSAoXCJpbnRlcmZhY2VzIHRoYXQgc3RhdGUgd2hhdCB0aGV5XG4vLyBET04nVCBjb3ZlciBhcmUgd29ydGggbW9yZSB0aGFuIG1vcmUgY2FwYWJpbGl0eVwiKS4gQW4gYWdlbnQgdGhhdCB0cnVzdHMgYVxuLy8gZGVsdGEgd2hpY2ggc2lsZW50bHkgb21pdHMgZGVsZXRpb25zIGlzIHdvcnNlIG9mZiB0aGFuIG9uZSB0aGF0IHJlZmV0Y2hlcyDigJRcbi8vIHNvIHRoaXMgb25lIG5ldmVyIG9taXRzIHNpbGVudGx5LlxuLy9cbi8vIEJvbnVzIHByb3BlcnR5IHdvcnRoIG5hbWluZzogYGNyZWF0ZWRfYXRgIGlzIERVUkFCTEUsIHNvIGAvY2hhbmdlc2Agc3Vydml2ZXNcbi8vIGEgZGFlbW9uIHJlc3RhcnQuIEl0IGlzIHRoZSBvbmx5IHJlc3VtYWJsZS1hY3Jvc3MtcmVzdGFydCByZWFkIGluIHRoZSBzeXN0ZW1cbi8vICh0aGUgZXZlbnQgYnVzIHJlc2V0cyBpdHMgY3Vyc29yIGFuZCBtaW50cyBhIG5ldyBlcG9jaCBvbiBldmVyeSBib290KS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgdHlwZSB7IFByb2plY3RNZXRhIH0gZnJvbSBcIi4vcHJvamVjdC50c1wiO1xuaW1wb3J0IHsgdHlwZSBQcm9qZWN0U3RhdGUsIHJlYWRTdGF0ZSB9IGZyb20gXCIuL3N0YXRlLnRzXCI7XG5cbmludGVyZmFjZSBDaGFuZ2VzUmVzdWx0IHtcbiAgc2luY2U6IG51bWJlcjtcbiAgbm93OiBudW1iZXI7XG4gIGdyYW51bGFyaXR5OiBcInNlY29uZHNcIjtcbiAgaW5jbHVzaXZlOiB0cnVlO1xuICBhZGRpdGlvbnM6IHtcbiAgICBub2RlczogUHJvamVjdFN0YXRlW1wibm9kZXNcIl07XG4gICAgZWRnZXM6IFByb2plY3RTdGF0ZVtcImVkZ2VzXCJdO1xuICAgIHByb3Bvc2FsczogUHJvamVjdFN0YXRlW1wicHJvcG9zYWxzXCJdO1xuICAgIGRvY3M6IFByb2plY3RTdGF0ZVtcImRvY3NcIl07XG4gICAgem9uZXM6IFByb2plY3RTdGF0ZVtcInpvbmVzXCJdO1xuICAgIG1lc3NhZ2VzOiBQcm9qZWN0U3RhdGVbXCJjb252ZXJzYXRpb25cIl07XG4gIH07XG4gIGNvdW50czogUmVjb3JkPHN0cmluZywgbnVtYmVyPjtcbiAgbm90Q292ZXJlZDogc3RyaW5nW107XG4gIG5vdGU6IHN0cmluZztcbn1cblxuLy8gVGhlIGJsaW5kIHNwb3RzLCBzdGF0ZWQgb25jZSBhbmQgcmV0dXJuZWQgb24gRVZFUlkgcmVzcG9uc2UuIEFkZGluZyBhIHZlcmJcbi8vIHRoYXQgbXV0YXRlcyB3aXRob3V0IGNyZWF0aW5nIGEgcm93IG1lYW5zIGFkZGluZyBhIGxpbmUgaGVyZS5cbmNvbnN0IE5PVF9DT1ZFUkVEID0gW1xuICBcIkRFTEVUSU9OUyBvZiBhbnl0aGluZyAobm9kZSwgZWRnZSwgcHJvcG9zYWwsIGRvYywgem9uZSkg4oCUIGEgZGVsZXRlIGRyb3BzIHRoZSByb3csIHNvIGEgZGVsZXRlZCBlbnRpdHkgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBvbmUgdGhhdCBuZXZlciBleGlzdGVkXCIsXG4gIFwicHJvcG9zYWwgUkVKRUNUSU9OUyBhbmQgYW55IG90aGVyIHN0YXR1cyBmbGlwIHRoYXQgbWludHMgbm8gcm93IChhIHJhdGlmeSBET0VTIGFwcGVhciBoZXJlLCBhcyB0aGUgbm9kZS9lZGdlIGl0IGNyZWF0ZWQ7IGEgcmVqZWN0IGRvZXMgbm90KVwiLFxuICBcIkVESVRTIGluIHBsYWNlOiBub2RlLmVkaXRlZCAodGl0bGUvc3lub3BzaXMpLCBkb2Mga2luZCwgZG9jIG1hcmtzLCB0YWdzLCBhY3Rpb25zLCBhbmNob3JzIChub2RlLmFuY2hvcmVkKSwgem9uZSBtb3ZlcyAocHJvcG9zYWwucHJvbW90ZWQpLCBsZW5zXCIsXG4gIFwiam9icyDigJQgdGhlIGpvYnMgdGFibGUgdGltZXN0YW1wcyBpbiBlcG9jaCBNSUxMSVNFQ09ORFMsIGEgZGlmZmVyZW50IHVuaXQgZnJvbSB0aGlzIHF1ZXJ5J3Mgc2Vjb25kczsgbWl4aW5nIHRoZW0gaW4gb25lIHdhdGVybWFyayB3b3VsZCBiZSBhIHNpbGVudCBvZmYtYnktMTAwMFwiLFxuICBcIldITyBhY3RlZDogbm90aGluZyBoZXJlIGlzIGF0dHJpYnV0YWJsZSB0byB0aGUgaHVtYW4gdnMgdGhlIGFnZW50IChDb250cmFjdCAxMCdzIGFjdG9yLXRhZ2dpbmcgZGVmZXJyYWwgaXMgdW5jaGFuZ2VkKVwiLFxuXTtcblxuY29uc3QgTk9URSA9XG4gIFwiQURESVRJT05TIE9OTFksIGRlcml2ZWQgZnJvbSBjcmVhdGVkX2F0IOKAlCB0aGlzIGlzIGEgcmVjb25jaWxpYXRpb24gQUlELCBub3QgYSByZXBsYWNlbWVudCBmb3IgYSBmdWxsIC9zdGF0ZSByZWZldGNoLCBhbmQgTk9UIGEgcmVwbGFjZW1lbnQgZm9yIGFjdG9yIHRhZ2dpbmcuIFJlYWQgbm90Q292ZXJlZCBiZWZvcmUgdHJ1c3RpbmcgYW4gZW1wdHkgcmVzcG9uc2U6ICdub3RoaW5nIGFkZGVkJyBpcyBub3QgJ25vdGhpbmcgY2hhbmdlZCcuIFBhc3MgYG5vd2AgYXMgeW91ciBuZXh0IGBzaW5jZWAuIGBzaW5jZWAgaXMgSU5DTFVTSVZFIGFuZCB0aGUgZ3JhbnVsYXJpdHkgaXMgd2hvbGUgc2Vjb25kcywgc28gZW50aXRpZXMgY3JlYXRlZCBpbiB0aGUgYm91bmRhcnkgc2Vjb25kIG1heSByZXBlYXQgKG92ZXItcmVwb3J0aW5nIGlzIHRoZSBzYWZlIGRpcmVjdGlvbikuIFVubGlrZSB0aGUgZXZlbnQgYnVzIHRoaXMgc3Vydml2ZXMgYSBkYWVtb24gcmVzdGFydCDigJQgY3JlYXRlZF9hdCBpcyBkdXJhYmxlLCBjdXJzb3JzIGFuZCBlcG9jaHMgYXJlIG5vdC5cIjtcblxuZnVuY3Rpb24gcmVhZENoYW5nZXMoXG4gIGRiOiBEYXRhYmFzZSxcbiAgcHJvamVjdDogUHJvamVjdE1ldGEsXG4gIHNpbmNlOiBudW1iZXIsXG4gIHByb2plY3RSb290Pzogc3RyaW5nLFxuKTogQ2hhbmdlc1Jlc3VsdCB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHNpbmNlKSB8fCAhTnVtYmVyLmlzSW50ZWdlcihzaW5jZSkgfHwgc2luY2UgPCAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHNpbmNlIG11c3QgYmUgYSBub24tbmVnYXRpdmUgaW50ZWdlciBpbiBlcG9jaCBTRUNPTkRTICh1c2UgMCBmb3IgZXZlcnl0aGluZywgdGhlbiBwYXNzIGJhY2sgdGhlIFxcYG5vd1xcYCBmcm9tIGEgcHJldmlvdXMgcmVzcG9uc2UpLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkoc2luY2UpfWAsXG4gICAgKTtcbiAgfVxuICAvLyBSZWFkIHRoZSB3b3JsZCB0aHJvdWdoIHRoZSBPTkUgcmVhZGVyLCB0aGVuIG5hcnJvdyBieSBpZCDigJQgc28gZXZlcnkgZW50aXR5XG4gIC8vIGluIGEgZGVsdGEgaXMgYnl0ZS1pZGVudGljYWwgdG8gaXRzIC9zdGF0ZSBlbnRyeSAodGhlIHNpbmdsZS1zb3VyY2UtcmVhZGVyXG4gIC8vIHJ1bGU6IG5ldmVyIGhhbmQtYXNzZW1ibGUgYW4gZW50aXR5IGEgY29uc3VtZXIgd2lsbCBtZXJnZSkuXG4gIGNvbnN0IHN0YXRlID0gcmVhZFN0YXRlKGRiLCBwcm9qZWN0LCAwLCBcIlwiLCBwcm9qZWN0Um9vdCk7XG4gIGNvbnN0IGlkc1NpbmNlID0gKHRhYmxlOiBzdHJpbmcsIGNvbHVtbiA9IFwiY3JlYXRlZF9hdFwiKTogU2V0PHN0cmluZz4gPT5cbiAgICBuZXcgU2V0KFxuICAgICAgKFxuICAgICAgICBkYi5xdWVyeShgU0VMRUNUIGlkIEZST00gJHt0YWJsZX0gV0hFUkUgJHtjb2x1bW59ID49ID9gKS5hbGwoc2luY2UpIGFzIEFycmF5PHtcbiAgICAgICAgICBpZDogc3RyaW5nO1xuICAgICAgICB9PlxuICAgICAgKS5tYXAoKHIpID0+IHIuaWQpLFxuICAgICk7XG4gIGNvbnN0IG5vZGVJZHMgPSBpZHNTaW5jZShcIm5vZGVzXCIpO1xuICBjb25zdCBlZGdlSWRzID0gaWRzU2luY2UoXCJlZGdlc1wiKTtcbiAgY29uc3QgcHJvcG9zYWxJZHMgPSBpZHNTaW5jZShcInByb3Bvc2Fsc1wiKTtcbiAgY29uc3QgZG9jSWRzID0gaWRzU2luY2UoXCJkb2NzXCIpO1xuICBjb25zdCB6b25lSWRzID0gaWRzU2luY2UoXCJ6b25lc1wiLCBcInRzXCIpO1xuXG4gIGNvbnN0IGFkZGl0aW9ucyA9IHtcbiAgICBub2Rlczogc3RhdGUubm9kZXMuZmlsdGVyKChuKSA9PiBub2RlSWRzLmhhcyhuLmlkKSksXG4gICAgZWRnZXM6IHN0YXRlLmVkZ2VzLmZpbHRlcigoZSkgPT4gZWRnZUlkcy5oYXMoZS5pZCkpLFxuICAgIHByb3Bvc2Fsczogc3RhdGUucHJvcG9zYWxzLmZpbHRlcigocCkgPT4gcHJvcG9zYWxJZHMuaGFzKHAuaWQpKSxcbiAgICBkb2NzOiBzdGF0ZS5kb2NzLmZpbHRlcigoZCkgPT4gZG9jSWRzLmhhcyhkLmlkKSksXG4gICAgem9uZXM6IHN0YXRlLnpvbmVzLmZpbHRlcigoeikgPT4gem9uZUlkcy5oYXMoei5pZCkpLFxuICAgIC8vIG1lc3NhZ2VzIGNhcnJ5IHRoZWlyIG93biB0cyBvbiB0aGUgd2lyZSBhbHJlYWR5LlxuICAgIG1lc3NhZ2VzOiBzdGF0ZS5jb252ZXJzYXRpb24uZmlsdGVyKChtKSA9PiBtLnRzID49IHNpbmNlKSxcbiAgfTtcblxuICByZXR1cm4ge1xuICAgIHNpbmNlLFxuICAgIG5vdzogTWF0aC5mbG9vcihEYXRlLm5vdygpIC8gMTAwMCksXG4gICAgZ3JhbnVsYXJpdHk6IFwic2Vjb25kc1wiLFxuICAgIGluY2x1c2l2ZTogdHJ1ZSxcbiAgICBhZGRpdGlvbnMsXG4gICAgY291bnRzOiBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgICBPYmplY3QuZW50cmllcyhhZGRpdGlvbnMpLm1hcCgoW2tleSwgbGlzdF0pID0+IFtrZXksIGxpc3QubGVuZ3RoXSksXG4gICAgKSBhcyBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+LFxuICAgIG5vdENvdmVyZWQ6IFsuLi5OT1RfQ09WRVJFRF0sXG4gICAgbm90ZTogTk9URSxcbiAgfTtcbn1cblxuZXhwb3J0IHR5cGUgeyBDaGFuZ2VzUmVzdWx0IH07XG5leHBvcnQgeyBOT1RfQ09WRVJFRCwgcmVhZENoYW5nZXMgfTtcbiIsCiAgICAiLy8gUm91bmQgNiAoREVMKSDigJQgdGhlIG1pc3NpbmcgcmV0cmFjdDogaGFyZCBkZWxldGUgZm9yIG5vZGVzIGFuZCBwcm9wb3NhbHMsXG4vLyBlcXVhbC1jYXBhYmlsaXR5IGZvciBodW1hbiBhbmQgYWdlbnQuIE1pcnJvcnMgdGhlIGRvYy1kZWxldGUgQ2l0ZWRFcnJvclxuLy8gcHJlY2VkZW50IChkb2NzLnRzKTogYW4gdW5mb3JjZWQgZGVsZXRlIG9mIGEgQ0lURUQgbm9kZSBpcyBhIDQwOSBjYXJyeWluZ1xuLy8gdGhlIGNpdGluZyBjb3VudHMgdGhlIHN1cmZhY2UncyBjb25maXJtIGRpYWxvZyByZW5kZXJzOyAtLWZvcmNlIGNhc2NhZGVzLlxuLy9cbi8vIFJ1bGluZyAocGxhbi1yb3VuZDYpOiBhIG5vZGUncyBjaXRpbmcgc2V0ID0gZWRnZXMgdG91Y2hpbmcgaXQgKyBjaGlsZHJlblxuLy8gYW5jaG9yZWQgdW5kZXIgaXQuIEZvcmNlIGNhc2NhZGUgREVMRVRFUyB0aGUgZWRnZXMgYnV0IFJFLVBBUkVOVFMgdGhlXG4vLyBjaGlsZHJlbiB0byB0b3AtbGV2ZWwgKGNsZWFycyBhbmNob3Jfbm9kZV9pZCDigJQgdGhlIGNoaWxkcmVuIGFyZSByZWFsXG4vLyByYXRpZmllZCBrbm93bGVkZ2UsIG5vdCBkZXRyaXR1czsgZG8gTk9UIHJlY3Vyc2l2ZWx5IGRlbGV0ZSB0aGUgc3VibWFwKSxcbi8vIGRlbGV0ZXMgdGhlIG5vZGUncyBPV05FRCBkZXRyaXR1cyAoc291cmNlcyAvIG1lc3NhZ2Vfc291cmNlcyAvIG5vZGVfYWN0aW9ucyksXG4vLyBjbGVhcnMgYSBsZW5zIHBvaW50aW5nIGF0IGl0LCBhbmQgTEVBVkVTIHRoZSByYXRpZmllZCBwcm9wb3NhbCdzXG4vLyByZXN1bHRfbm9kZV9pZCBpbnRhY3QgKGhpc3RvcnksIHRoZSBkb2MtZGVsZXRlIHByZWNlZGVudCkuIFByb3Bvc2FsIGRlbGV0ZVxuLy8gaXMgVEhJTiDigJQgbm8gZ3VhcmQ6IGEgZGVwZW5kZW50IHBlbmRpbmcgZWRnZSBsaXZlcyBvbmx5IGluIG9wYXF1ZSBkcmFmdF9qc29uXG4vLyBhbmQgYWxyZWFkeSBmYWlscyBzYWZlIGF0IGl0cyBvd24gcmF0aWZ5LlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcblxuLy8gVGhlIG5vZGUgdHdpbiBvZiBkb2NzLnRzJ3MgQ2l0ZWRFcnJvciDigJQgYSA0MDkgY2FycnlpbmcgdGhlIGNpdGluZyBjb3VudHMuXG5jbGFzcyBOb2RlQ2l0ZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY2l0ZWRCeTogeyBlZGdlczogbnVtYmVyOyBjaGlsZHJlbjogbnVtYmVyIH07XG4gIGNvbnN0cnVjdG9yKGNpdGVkQnk6IHsgZWRnZXM6IG51bWJlcjsgY2hpbGRyZW46IG51bWJlciB9KSB7XG4gICAgc3VwZXIoXG4gICAgICBgbm9kZSBpcyBjaXRlZCBieSAke2NpdGVkQnkuZWRnZXN9IGVkZ2UocykgYW5kIGFuY2hvcnMgJHtjaXRlZEJ5LmNoaWxkcmVufSBjaGlsZCBub2RlKHMpYCxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiTm9kZUNpdGVkRXJyb3JcIjtcbiAgICB0aGlzLmNpdGVkQnkgPSBjaXRlZEJ5O1xuICB9XG59XG5cbi8vIFJldHVybnMgbnVsbCBmb3IgYW4gdW5rbm93biBpZCDigJQgdGhlIHNlcnZlciA0MDRzIGZpcnN0LCBiZWZvcmUgYW55XG4vLyBjaXRlZC9mb3JjZSByZWFzb25pbmcuIFRocm93cyBOb2RlQ2l0ZWRFcnJvciB3aGVuIHVuZm9yY2VkICsgY2l0ZWQuXG5mdW5jdGlvbiBkZWxldGVOb2RlKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGlkOiBzdHJpbmcsXG4gIGZvcmNlOiBib29sZWFuLFxuKTogeyBpZDogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldChpZCkpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGVkZ2VzID0gKFxuICAgIGRiLnF1ZXJ5KFwiU0VMRUNUIENPVU5UKCopIEFTIG4gRlJPTSBlZGdlcyBXSEVSRSBzb3VyY2UgPSA/IE9SIHRhcmdldCA9ID9cIikuZ2V0KGlkLCBpZCkgYXMge1xuICAgICAgbjogbnVtYmVyO1xuICAgIH1cbiAgKS5uO1xuICBjb25zdCBjaGlsZHJlbiA9IChcbiAgICBkYi5xdWVyeShcIlNFTEVDVCBDT1VOVCgqKSBBUyBuIEZST00gbm9kZXMgV0hFUkUgYW5jaG9yX25vZGVfaWQgPSA/XCIpLmdldChpZCkgYXMgeyBuOiBudW1iZXIgfVxuICApLm47XG4gIGlmICghZm9yY2UgJiYgKGVkZ2VzID4gMCB8fCBjaGlsZHJlbiA+IDApKSB0aHJvdyBuZXcgTm9kZUNpdGVkRXJyb3IoeyBlZGdlcywgY2hpbGRyZW4gfSk7XG5cbiAgZGIudHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIC8vIEJvdGgtZGlyZWN0aW9uIGVkZ2VzIHZhbmlzaCAoYW4gZWRnZSB0byBhIGRlbGV0ZWQgbm9kZSBkYW5nbGVzKS5cbiAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBlZGdlcyBXSEVSRSBzb3VyY2UgPSA/IE9SIHRhcmdldCA9ID9cIiwgW2lkLCBpZF0pO1xuICAgIC8vIENoaWxkcmVuIHJlLXBhcmVudCB0byB0b3AtbGV2ZWwg4oCUIHRoZXkgYXJlIHJlYWwgcmF0aWZpZWQga25vd2xlZGdlOyBkb1xuICAgIC8vIE5PVCByZWN1cnNpdmVseSBkZWxldGUgdGhlIHN1Ym1hcC5cbiAgICBkYi5ydW4oXCJVUERBVEUgbm9kZXMgU0VUIGFuY2hvcl9ub2RlX2lkID0gTlVMTCBXSEVSRSBhbmNob3Jfbm9kZV9pZCA9ID9cIiwgW2lkXSk7XG4gICAgLy8gT3duZWQgZGV0cml0dXMuXG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gc291cmNlcyBXSEVSRSBub2RlX2lkID0gP1wiLCBbaWRdKTtcbiAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBtZXNzYWdlX3NvdXJjZXMgV0hFUkUgbm9kZV9pZCA9ID9cIiwgW2lkXSk7XG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gbm9kZV9hY3Rpb25zIFdIRVJFIHRhcmdldF9pZCA9ID9cIiwgW2lkXSk7XG4gICAgLy8gVEFHUzogdGhlIG5vZGUncyB0YWdzIGFyZSBvd25lZCBkZXRyaXR1cyB0b28gKHR3aW4gb2Ygbm9kZV9hY3Rpb25zKS5cbiAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBub2RlX3RhZ3MgV0hFUkUgdGFyZ2V0X2lkID0gP1wiLCBbaWRdKTtcbiAgICAvLyBBIGxlbnMgcG9pbnRpbmcgYXQgdGhpcyBub2RlIGxvc2VzIGl0cyBzdWJqZWN0IChwZXItcHJvamVjdCBzaW5nbGUgcm93KS5cbiAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBsZW5zIFdIRVJFIG5vZGVfaWQgPSA/XCIsIFtpZF0pO1xuICAgIC8vIFRoZSByYXRpZmllZCBwcm9wb3NhbCdzIHJlc3VsdF9ub2RlX2lkIGlzIExFRlQgaW50YWN0IChoaXN0b3J5IOKAlCB0aGVcbiAgICAvLyBkb2MtZGVsZXRlIHByZWNlZGVudDogYSBzb3VyY2UgY2FuIHZhbmlzaCB3aXRob3V0IHVuLXJlY29yZGluZyBpdCkuXG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIsIFtpZF0pO1xuICB9KSgpO1xuXG4gIGJ1cy5lbWl0KFwibm9kZS5kZWxldGVkXCIsIHsgaWQgfSk7XG4gIHJldHVybiB7IGlkIH07XG59XG5cbi8vIFRoaW4sIE5PIGd1YXJkIChydWxlZCk6IGRyb3AgdGhlIHJvdyArIGNhc2NhZGUgaXRzIGFjdGlvbiBzbG90cy4gQSBwZW5kaW5nXG4vLyBlZGdlIHByb3Bvc2FsIHRoYXQgbmFtZXMgdGhpcyBwcm9wb3NhbCBhcyBhbiBlbmRwb2ludCBsaXZlcyBvbmx5IGluIG9wYXF1ZVxuLy8gZHJhZnRfanNvbiAoQ29udHJhY3QgOCkgYW5kIGZhaWxzIHNhZmUgYXQgaXRzIE9XTiByYXRpZnkuIEFueSBzdGF0dXNcbi8vIGRlbGV0YWJsZSAocGVuZGluZyAvIHJlamVjdGVkIC8gcmF0aWZpZWQpIOKAlCB0aGlzIGlzIHRoZSBsaXR0ZXItY2xlYXJpbmdcbi8vIHBhdGggKGNsZWFyIGEgcmF3IGluc3RydWN0aW9uLW5vZGUgdGhyb3VnaCBERUxFVEUsIG5vdCByZWplY3QpLlxuZnVuY3Rpb24gZGVsZXRlUHJvcG9zYWwoZGI6IERhdGFiYXNlLCBidXM6IEV2ZW50QnVzLCBpZDogc3RyaW5nKTogeyBpZDogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gcHJvcG9zYWxzIFdIRVJFIGlkID0gP1wiKS5nZXQoaWQpKSByZXR1cm4gbnVsbDtcbiAgZGIudHJhbnNhY3Rpb24oKCkgPT4ge1xuICAgIGRiLnJ1bihcIkRFTEVURSBGUk9NIG5vZGVfYWN0aW9ucyBXSEVSRSB0YXJnZXRfaWQgPSA/XCIsIFtpZF0pO1xuICAgIC8vIFRBR1M6IGNhc2NhZGUgdGhlIHByb3Bvc2FsJ3MgdGFncyB3aXRoIGl0ICh0d2luIG9mIG5vZGVfYWN0aW9ucykuXG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gbm9kZV90YWdzIFdIRVJFIHRhcmdldF9pZCA9ID9cIiwgW2lkXSk7XG4gICAgZGIucnVuKFwiREVMRVRFIEZST00gcHJvcG9zYWxzIFdIRVJFIGlkID0gP1wiLCBbaWRdKTtcbiAgfSkoKTtcbiAgYnVzLmVtaXQoXCJwcm9wb3NhbC5kZWxldGVkXCIsIHsgaWQgfSk7XG4gIHJldHVybiB7IGlkIH07XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDUpIOKAlCB0aGUgaW52ZXJzZSBvZiByYXRpZnktYmF0Y2guIENsZWFyaW5nIDQ0IHN0YWxlIHByb3Bvc2Fsc1xuLy8gaW4gZHJpdmUgIzEwIHdhcyA0NCBpbmRpdmlkdWFsIEhUVFAgZGVsZXRlcyBpbiBhIGxvb3AuXG4vL1xuLy8gREVMRVRFLCBub3QgcmVqZWN0IChydWxlZCk6IHJlamVjdCBpcyBhIFJVTElORyBhbmQgbGVhdmVzIGEgdG9tYnN0b25lLCBhbmQgUjZcbi8vIGFscmVhZHkgcnVsZWQgdGhhdCBhIHJlamVjdCBpcyBub3QgYSBiYXRjaCBhY3QgKFwiYSByZWplY3QgZXhjbHVkZXMgYSBwcm9wb3NhbFxuLy8gZnJvbSB0aGUgYmF0Y2gg4oCUIHJlamVjdCBpdCBzaW5nbHlcIik7IHRoYXQgcnVsaW5nIHN0YW5kcywgc28gYSByZWplY3QtYmF0Y2hcbi8vIHdvdWxkIGNvbnRyYWRpY3QgaXQuIERlbGV0ZSBpcyBsaXR0ZXItY2xlYXJpbmcsIHdoaWNoIGlzIGV4YWN0bHkgd2hhdCBhIGJhdGNoXG4vLyBpcyBmb3IuXG4vL1xuLy8gVFJBTlNBQ1RJT05BTCBhbGwtb3Itbm90aGluZywgbWlycm9yaW5nIHJhdGlmeUJhdGNoOiB2YWxpZGF0ZSBldmVyeXRoaW5nXG4vLyBmaXJzdCwgb25lIHR4biwgZW1pdHMgQUZURVIgY29tbWl0LiBCZXN0LWVmZm9ydC13aXRoLWEtcmVwb3J0IHdhcyBjb25zaWRlcmVkXG4vLyBhbmQgcmVqZWN0ZWQg4oCUIHRoZSBhZ2VudCdzIG1vZGVsIGFmdGVyIHRoZSBjYWxsIHNob3VsZCBiZSBiaW5hcnkgKGFsbCBnb25lIC9cbi8vIG5vdGhpbmcgZ29uZSksIGJlY2F1c2UgXCJJIGFzc3VtZWQgdGhlIHN3ZWVwIHdvcmtlZFwiIGlzIHRoZSBmYWlsdXJlIG1vZGUgdGhpc1xuLy8gd2hvbGUgcm91bmQgZXhpc3RzIHRvIHByZXZlbnQuIEFuIHVua25vd24gaWQgbmFtZXMgRVZFUlkgdW5rbm93biBpZCwgbm90IGp1c3Rcbi8vIHRoZSBmaXJzdDogYSA0NC1pZCBjbGVhbnVwIG11c3QgbmV2ZXIgYmVjb21lIGEgNDQtcm91bmQtdHJpcCBiaXNlY3QuXG4vL1xuLy8gTk9UIEJVSUxULCBkZWxpYmVyYXRlbHk6IGEgYHtiYXRjaDogXCI8YmF0Y2hJZD5cIn1gIHNob3J0aGFuZC4gRHJpdmUgIzEwJ3MgYnVnXG4vLyBXQVMgYW4gb3Zlci1icm9hZCBjbGVhbnVwIOKAlCB0aGUgYWdlbnQgY2xlYXJlZCBpdHMgcGVuZGluZyBwcm9wb3NhbHMgYW5kIHRvb2tcbi8vIHRoZSBlZGdlcyBob2xkaW5nIGl0cyByYXRpZmllZCBub2RlcyB0b2dldGhlciB3aXRoIHRoZW0uIFRoZSBiYXRjaCBpZCBleGlzdHNcbi8vIHNvIHRoZSBhZ2VudCBMT09LUyBiZWZvcmUgaXQgc3dlZXBzIChgc3RhdGUgLS1iYXRjaCA8aWQ+YCBzaG93cyB3aGF0IHJhdGlmaWVkXG4vLyBhbmQgd2hhdCBpcyBzdGlsbCBwZW5kaW5nKTsgbWFraW5nIHRoZSBzd2VlcCBvbmUga2V5c3Ryb2tlIHdvdWxkIGFybSB0aGVcbi8vIGV4YWN0IGJ1ZyB0aGlzIHJvdW5kIGlzIGZpeGluZy4gRXhwbGljaXQgaWRzIG9ubHkuIChUaGUgYWR2aXNvcnkgYmVsb3cgaXMgdGhlXG4vLyBSMTItZ2F0ZSBmb2xsb3ctdXAgdG8gdGhhdCBydWxpbmc6IHJlZnVzZSBub3RoaW5nLCBidXQgbmV2ZXIgc3dlZXAgc2lsZW50bHkuKVxuXG4vLyBSMTIgR0FURSBGSU5ESU5HIDEg4oCUIHRoZSBhZHZpc29yeSB0aGF0IG1ha2VzIGEgc3dlZXAgc2VsZi1jb3JyZWN0aW5nLlxuLy9cbi8vIGNhc3NhbmRyYSdzIGNvbGQgZ2F0ZSByZXByb2R1Y2VkIGRyaXZlICMxMCBleGFjdGx5IGFuZCBmb3VuZCB0aGF0XG4vLyBkZWxldGUtYmF0Y2ggaGFwcGlseSBkZWxldGVkIHRocmVlIHBlbmRpbmcgZWRnZSBwcm9wb3NhbHMgdGhhdCB3ZXJlIHRoZSBMQVNUXG4vLyBjb25uZWN0aW9uIGludGVudCBmb3IgYWxyZWFkeS1yYXRpZmllZCBjYW5vbiBub2RlcywgZXhpdCAwLCBzaWxlbnRseS4gVGhhdCBpc1xuLy8gcHJlY2lzZWx5IHRoZSBhY3QgdGhhdCBicm9rZSB0aGUgaHVtYW4ncyBtYXAuXG4vL1xuLy8gVGhpcyBkb2VzIE5PVCByZWZ1c2Ug4oCUIENvbnRyYWN0IDgncyBkdW1iLWRhZW1vbiBjbGF1c2UgaG9sZHMsIGFuZCBhIGJsb2NrXG4vLyB3b3VsZCBiZSB0aGUgXCJwcmV2ZW50XCIgcmVmbGV4IHRoaXMgcm91bmQgZGVsaWJlcmF0ZWx5IGF2b2lkZWQuIEl0IGZvbGxvd3MgdGhlXG4vLyBSMyBpbnRha2UtYHdhcm5pbmdgIGlkaW9tIGluc3RlYWQ6IGFkZGl0aXZlIG9uIHRoZSAyMDAsIG1pcnJvcmVkIHRvIHN0ZGVyciBieVxuLy8gdGhlIENMSSwgZXhpdCB1bmNoYW5nZWQuIEl0IGNvbnZlcnRzIFwiaW1tZWRpYXRlbHkgdmlzaWJsZSB0byB0aGUgSFVNQU5cIiAodGhlXG4vLyBvcnBoYW4gbWFya2VyKSBpbnRvIFwiaW1tZWRpYXRlbHkgdmlzaWJsZSB0byB0aGUgQUdFTlQgVEhBVCBDQVVTRUQgSVRcIi5cbi8vXG4vLyBUaGUgcHJlZGljYXRlIGRlbGliZXJhdGVseSBNSVJST1JTIGNpcmNlJ3Mgc3VyZmFjZSBvcnBoYW4gcnVsZSAoUjEyIHN1cmZhY2Vcbi8vIGNvbnZlbnRpb24pLCBzbyB0aGUgZW5naW5lJ3Mgd2FybmluZyBhbmQgdGhlIGJvYXJkJ3MgbWFya2VyIGNhbiBuZXZlciBkaXNhZ3JlZTpcbi8vIGEgcmF0aWZpZWQgbm9kZSBpcyBvcnBoYW5lZCB3aGVuIGl0IGhhcyBubyByZWFsIGVkZ2UgQU5EIG5vIHJlbWFpbmluZyBwZW5kaW5nXG4vLyBlZGdlIHByb3Bvc2FsIG5hbWVzIGl0LiBIZXJlIHdlIGFzayB0aGF0IHF1ZXN0aW9uIGFib3V0IHRoZSBzdGF0ZSBBRlRFUiB0aGVcbi8vIHByb3Bvc2VkIGRlbGV0aW9uLCB3aGljaCBpcyB0aGUgb25seSBtb21lbnQgdGhlIGFnZW50IGNhbiBzdGlsbCBhY3Qgb24gaXQuXG5mdW5jdGlvbiBvcnBoYW5lZEJ5RGVsZXRpb24oZGI6IERhdGFiYXNlLCBpZHM6IHN0cmluZ1tdKTogeyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nIH1bXSB7XG4gIGNvbnN0IGRvb21lZCA9IG5ldyBTZXQoaWRzKTtcbiAgLy8gRW5kcG9pbnRzIG9mIGEgcGVuZGluZyBlZGdlIHByb3Bvc2FsIG1heSBiZSBhIHJlYWwgbm9kZSBpZCBPUiBhIG5vZGVcbiAgLy8gcHJvcG9zYWwncyBpZCAocmF0aWZ5IHJlc29sdmVzIHRoZSBsYXR0ZXIgdmlhIHJlc3VsdF9ub2RlX2lkKSDigJQgcmVzb2x2ZVxuICAvLyBib3RoIHRvIHRoZSBub2RlIHRoZXkgbWVhbiwgZXhhY3RseSBhcyB0aGUgc3VyZmFjZSBkb2VzLlxuICBjb25zdCBhc05vZGVJZCA9IChlbmRwb2ludDogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCByb3cgPSBkYi5xdWVyeShcIlNFTEVDVCByZXN1bHRfbm9kZV9pZCBGUk9NIHByb3Bvc2FscyBXSEVSRSBpZCA9ID9cIikuZ2V0KGVuZHBvaW50KSBhcyB7XG4gICAgICByZXN1bHRfbm9kZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgICB9IHwgbnVsbDtcbiAgICByZXR1cm4gcm93Py5yZXN1bHRfbm9kZV9pZCA/PyBlbmRwb2ludDtcbiAgfTtcbiAgY29uc3QgZW5kcG9pbnRzT2YgPSAoZHJhZnRKc29uOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGQgPSBKU09OLnBhcnNlKGRyYWZ0SnNvbikgYXMgeyBzb3VyY2U/OiB1bmtub3duOyB0YXJnZXQ/OiB1bmtub3duIH07XG4gICAgICByZXR1cm4gW2Quc291cmNlLCBkLnRhcmdldF0uZmlsdGVyKChlKTogZSBpcyBzdHJpbmcgPT4gdHlwZW9mIGUgPT09IFwic3RyaW5nXCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgcGVuZGluZ0VkZ2VzID0gZGJcbiAgICAucXVlcnkoXCJTRUxFQ1QgaWQsIGRyYWZ0X2pzb24gRlJPTSBwcm9wb3NhbHMgV0hFUkUga2luZCA9ICdlZGdlJyBBTkQgc3RhdHVzID0gJ3BlbmRpbmcnXCIpXG4gICAgLmFsbCgpIGFzIHsgaWQ6IHN0cmluZzsgZHJhZnRfanNvbjogc3RyaW5nIH1bXTtcblxuICAvLyBOb2RlcyB0aGUgZG9vbWVkIGVkZ2VzIHdlcmUgc3BlYWtpbmcgZm9yLlxuICBjb25zdCB0b3VjaGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgZSBvZiBwZW5kaW5nRWRnZXMpIHtcbiAgICBpZiAoIWRvb21lZC5oYXMoZS5pZCkpIGNvbnRpbnVlO1xuICAgIGZvciAoY29uc3QgZXAgb2YgZW5kcG9pbnRzT2YoZS5kcmFmdF9qc29uKSkgdG91Y2hlZC5hZGQoYXNOb2RlSWQoZXApKTtcbiAgfVxuICAvLyBJbnRlbnQgdGhhdCBTVVJWSVZFUyB0aGUgZGVsZXRpb24uXG4gIGNvbnN0IHN1cnZpdmluZyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGUgb2YgcGVuZGluZ0VkZ2VzKSB7XG4gICAgaWYgKGRvb21lZC5oYXMoZS5pZCkpIGNvbnRpbnVlO1xuICAgIGZvciAoY29uc3QgZXAgb2YgZW5kcG9pbnRzT2YoZS5kcmFmdF9qc29uKSkgc3Vydml2aW5nLmFkZChhc05vZGVJZChlcCkpO1xuICB9XG5cbiAgY29uc3Qgb3V0OiB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmcgfVtdID0gW107XG4gIGZvciAoY29uc3Qgbm9kZUlkIG9mIHRvdWNoZWQpIHtcbiAgICBpZiAoc3Vydml2aW5nLmhhcyhub2RlSWQpKSBjb250aW51ZTtcbiAgICBjb25zdCBub2RlID0gZGIucXVlcnkoXCJTRUxFQ1QgaWQsIHRpdGxlIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldChub2RlSWQpIGFzIHtcbiAgICAgIGlkOiBzdHJpbmc7XG4gICAgICB0aXRsZTogc3RyaW5nO1xuICAgIH0gfCBudWxsO1xuICAgIGlmICghbm9kZSkgY29udGludWU7IC8vIG5vdCBhIHJhdGlmaWVkIG5vZGUg4oCUIG5vdGhpbmcgdG8gc3RyYW5kXG4gICAgY29uc3QgcmVhbEVkZ2VzID0gZGJcbiAgICAgIC5xdWVyeShcIlNFTEVDVCAxIEZST00gZWRnZXMgV0hFUkUgc291cmNlID0gPyBPUiB0YXJnZXQgPSA/IExJTUlUIDFcIilcbiAgICAgIC5nZXQobm9kZUlkLCBub2RlSWQpO1xuICAgIGlmIChyZWFsRWRnZXMpIGNvbnRpbnVlOyAvLyBzdGlsbCBnZW51aW5lbHkgY29ubmVjdGVkXG4gICAgb3V0LnB1c2gobm9kZSk7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gZGVsZXRlUHJvcG9zYWxCYXRjaChcbiAgZGI6IERhdGFiYXNlLFxuICBidXM6IEV2ZW50QnVzLFxuICBpZHM6IHN0cmluZ1tdLFxuKTogeyBkZWxldGVkOiBzdHJpbmdbXTsgd2FybmluZz86IHN0cmluZyB9IHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGlkcykgfHwgaWRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcignZGVsZXRlLWJhdGNoIHJlcXVpcmVzIGEgbm9uLWVtcHR5IGlkcyBhcnJheSDigJQge1wiaWRzXCI6IFtcIjxwcm9wb3NhbElkPlwiLCAuLi5dfScpO1xuICB9XG4gIGNvbnN0IGJhZCA9IGlkcy5maWx0ZXIoKGlkKSA9PiB0eXBlb2YgaWQgIT09IFwic3RyaW5nXCIgfHwgaWQgPT09IFwiXCIpO1xuICBpZiAoYmFkLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRlbGV0ZS1iYXRjaCBpZHMgbXVzdCBiZSBub24tZW1wdHkgc3RyaW5ncyDigJQgZ290ICR7SlNPTi5zdHJpbmdpZnkoYmFkKX1gKTtcbiAgfVxuICAvLyBWYWxpZGF0ZSBBTEwgYmVmb3JlIHRoZSB0eG4gKHB1cmUgcmVhZHMgKyB0aHJvdyksIHNvIG5vdGhpbmcgaXMgZGVsZXRlZFxuICAvLyB3aGVuIGFueSBpZCBpcyB3cm9uZyDigJQgYW5kIG5hbWUgZXZlcnkgb2ZmZW5kZXIgYXQgb25jZS5cbiAgY29uc3QgdW5rbm93biA9IGlkcy5maWx0ZXIoKGlkKSA9PiAhZGIucXVlcnkoXCJTRUxFQ1QgMSBGUk9NIHByb3Bvc2FscyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlkKSk7XG4gIGlmICh1bmtub3duLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgZGVsZXRlLWJhdGNoIGlzIGFsbC1vci1ub3RoaW5nIGFuZCAke3Vua25vd24ubGVuZ3RofSBpZChzKSBkbyBub3QgZXhpc3Qg4oCUIG5vdGhpbmcgd2FzIGRlbGV0ZWQ6ICR7dW5rbm93bi5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IHVuaXF1ZSA9IFsuLi5uZXcgU2V0KGlkcyldO1xuICAvLyBDb21wdXRlZCBCRUZPUkUgdGhlIHR4biAoaXQgcmVhZHMgdGhlIHJvd3Mgd2UncmUgYWJvdXQgdG8gZHJvcCksIHJlcG9ydGVkXG4gIC8vIGFmdGVyLiBBZHZpc29yeSBvbmx5IOKAlCBuZXZlciBhIHJlZnVzYWwuXG4gIGNvbnN0IHN0cmFuZGVkID0gb3JwaGFuZWRCeURlbGV0aW9uKGRiLCB1bmlxdWUpO1xuICBkYi50cmFuc2FjdGlvbigoKSA9PiB7XG4gICAgZm9yIChjb25zdCBpZCBvZiB1bmlxdWUpIHtcbiAgICAgIGRiLnJ1bihcIkRFTEVURSBGUk9NIG5vZGVfYWN0aW9ucyBXSEVSRSB0YXJnZXRfaWQgPSA/XCIsIFtpZF0pO1xuICAgICAgZGIucnVuKFwiREVMRVRFIEZST00gbm9kZV90YWdzIFdIRVJFIHRhcmdldF9pZCA9ID9cIiwgW2lkXSk7XG4gICAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIsIFtpZF0pO1xuICAgIH1cbiAgfSkoKTtcbiAgLy8gQUZURVIgY29tbWl0IG9ubHkg4oCUIGEgcm9sbGJhY2sgbXVzdCBuZXZlciBsZWFrIGEgcHJvcG9zYWwuZGVsZXRlZC5cbiAgZm9yIChjb25zdCBpZCBvZiB1bmlxdWUpIGJ1cy5lbWl0KFwicHJvcG9zYWwuZGVsZXRlZFwiLCB7IGlkIH0pO1xuICBpZiAoc3RyYW5kZWQubGVuZ3RoID09PSAwKSByZXR1cm4geyBkZWxldGVkOiB1bmlxdWUgfTtcbiAgcmV0dXJuIHtcbiAgICBkZWxldGVkOiB1bmlxdWUsXG4gICAgd2FybmluZzpcbiAgICAgIGB0aGlzIGRlbGV0ZWQgdGhlIGxhc3QgY29ubmVjdGlvbiBpbnRlbnQgZm9yICR7c3RyYW5kZWQubGVuZ3RofSByYXRpZmllZCBub2RlKHMpLCBgICtcbiAgICAgIGBub3cgdW5jb25uZWN0ZWQ6ICR7c3RyYW5kZWQubWFwKChuKSA9PiBgJHtuLnRpdGxlfSAoJHtuLmlkfSlgKS5qb2luKFwiLCBcIil9IOKAlCBgICtcbiAgICAgIGByZS1wcm9wb3NlIHRoZWlyIGVkZ2VzIChhbiBlZGdlIGVuZHBvaW50IG1heSBiZSB0aXRsZTo8ZXhhY3QgdGl0bGU+KSwgb3IgYCArXG4gICAgICBgXFxgc3RhdGUgLS1iYXRjaCA8aWQ+XFxgIHRvIHNlZSB3aGF0IHRoZSBhY3Qgc3RpbGwgaG9sZHNgLFxuICB9O1xufVxuXG5leHBvcnQgeyBkZWxldGVOb2RlLCBkZWxldGVQcm9wb3NhbCwgZGVsZXRlUHJvcG9zYWxCYXRjaCwgTm9kZUNpdGVkRXJyb3IgfTtcbiIsCiAgICAiLy8gVjEueCBDbGFpbSBBIOKAlCBgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXWAgYmFja2luZy4gTm9kZXMgU1VSVklWRSBhIGRvY1xuLy8gZGVsZXRlIChtYXAtYXMtdmlldzogZGVsZXRpbmcgYSBzb3VyY2UgZG9lc24ndCB1bi1yYXRpZnkgdGhlIGNsYWltKTsgd2hhdFxuLy8gZGllcyBpcyB0aGUgZG9jIGZpbGUsIGl0cyBkb2NzL2RvY3NfZnRzIHJvd3MsIGl0cyBzb3VyY2VzIHJvd3MsIGFuZCDigJQgd2l0aFxuLy8gZm9yY2Ug4oCUIHRoZSBldmlkZW5jZSBjb2x1bW5zIG9uIFBFTkRJTkcgcHJvcG9zYWxzIGNpdGluZyBpdCAodGhleSBiZWNvbWVcbi8vIGV2aWRlbmNlLWxlc3MgcHJvcG9zYWxzLCBzdGlsbCBydWxhYmxlOyByYXRpZnkncyBcIm5vIGV2aWRlbmNlIGRvYyB0byBlZGl0XCJcbi8vIGd1YXJkIHRoZW4gaG9sZHMsIGNsb3NpbmcgdGhlIHpvbWJpZS13cml0ZSBob2xlIHdoZXJlIHJhdGlmeWluZyBhIGNpdGluZ1xuLy8gcHJvcG9zYWwgd291bGQgcmVjcmVhdGUgdGhlIGRlbGV0ZWQgZmlsZSkuIFJhdGlmaWVkIHByb3Bvc2FscyBrZWVwIHRoZWlyXG4vLyBldmlkZW5jZV9kb2NfaWQgYXMgaGlzdG9yaWNhbCByZWNvcmQg4oCUIGNvbnN1bWVycyB0b2xlcmF0ZSBhIGRvY0lkIGFic2VudFxuLy8gZnJvbSBkb2NzW10uXG5cbmltcG9ydCB0eXBlIHsgRGF0YWJhc2UgfSBmcm9tIFwiYnVuOnNxbGl0ZVwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgdW5saW5rU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBFdmVudEJ1cyB9IGZyb20gXCIuL2V2ZW50cy50c1wiO1xuaW1wb3J0IHsgU0xVR19SRSB9IGZyb20gXCIuL3Byb2plY3QudHNcIjtcblxuLy8gVGhlIGZpcnN0IG5vbi11bmlmb3JtIGVycm9yIGluIHNlcnZlci50cywgZGVsaWJlcmF0ZTogYW4gdW5mb3JjZWQgZGVsZXRlXG4vLyBvZiBhIGNpdGVkIGRvYyBpcyBhIDQwOSBjYXJyeWluZyB0aGUgcHJvdmVuYW5jZSBjb3VudHMgdGhlIHN1cmZhY2Unc1xuLy8gY29uZmlybSBkaWFsb2cgcmVuZGVycyDigJQgbm90IGEgNDAwIHN0cmluZy5cbmNsYXNzIENpdGVkRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNpdGVkQnk6IHsgbm9kZXM6IG51bWJlcjsgcHJvcG9zYWxzOiBudW1iZXIgfTtcbiAgY29uc3RydWN0b3IoY2l0ZWRCeTogeyBub2RlczogbnVtYmVyOyBwcm9wb3NhbHM6IG51bWJlciB9KSB7XG4gICAgc3VwZXIoYGRvYyBpcyBjaXRlZCBieSAke2NpdGVkQnkubm9kZXN9IG5vZGUocykgYW5kICR7Y2l0ZWRCeS5wcm9wb3NhbHN9IHBlbmRpbmcgcHJvcG9zYWwocylgKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNpdGVkRXJyb3JcIjtcbiAgICB0aGlzLmNpdGVkQnkgPSBjaXRlZEJ5O1xuICB9XG59XG5cbi8vIFJldHVybnMgbnVsbCBmb3IgYW4gdW5rbm93biAob3Igbm9uLXNsdWcpIGlkIOKAlCB0aGUgc2VydmVyIDQwNHMgZmlyc3QsXG4vLyBiZWZvcmUgYW55IGNpdGVkL2ZvcmNlIHJlYXNvbmluZy5cbmZ1bmN0aW9uIGRlbGV0ZURvYyhcbiAgZGI6IERhdGFiYXNlLFxuICBidXM6IEV2ZW50QnVzLFxuICBwcm9qZWN0RGlyOiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4gIGZvcmNlOiBib29sZWFuLFxuKTogeyBpZDogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKCFTTFVHX1JFLnRlc3QoaWQpKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgcm93ID0gZGIucXVlcnkoXCJTRUxFQ1QgcGF0aCBGUk9NIGRvY3MgV0hFUkUgaWQgPSA/XCIpLmdldChpZCkgYXMgeyBwYXRoOiBzdHJpbmcgfSB8IG51bGw7XG4gIGlmICghcm93KSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBub2RlcyA9IChcbiAgICBkYi5xdWVyeShcIlNFTEVDVCBDT1VOVChESVNUSU5DVCBub2RlX2lkKSBhcyBuIEZST00gc291cmNlcyBXSEVSRSBkb2NfaWQgPSA/XCIpLmdldChpZCkgYXMge1xuICAgICAgbjogbnVtYmVyO1xuICAgIH1cbiAgKS5uO1xuICBjb25zdCBwcm9wb3NhbHMgPSAoXG4gICAgZGJcbiAgICAgIC5xdWVyeShcIlNFTEVDVCBDT1VOVCgqKSBhcyBuIEZST00gcHJvcG9zYWxzIFdIRVJFIGV2aWRlbmNlX2RvY19pZCA9ID8gQU5EIHN0YXR1cyA9ICdwZW5kaW5nJ1wiKVxuICAgICAgLmdldChpZCkgYXMgeyBuOiBudW1iZXIgfVxuICApLm47XG4gIGlmICghZm9yY2UgJiYgKG5vZGVzID4gMCB8fCBwcm9wb3NhbHMgPiAwKSkgdGhyb3cgbmV3IENpdGVkRXJyb3IoeyBub2RlcywgcHJvcG9zYWxzIH0pO1xuXG4gIGNvbnN0IGZpbGUgPSBqb2luKHByb2plY3REaXIsIHJvdy5wYXRoKTtcbiAgaWYgKGV4aXN0c1N5bmMoZmlsZSkpIHVubGlua1N5bmMoZmlsZSk7XG4gIGRiLnJ1bihcIkRFTEVURSBGUk9NIGRvY3MgV0hFUkUgaWQgPSA/XCIsIFtpZF0pO1xuICBkYi5ydW4oXCJERUxFVEUgRlJPTSBkb2NzX2Z0cyBXSEVSRSBkb2NfaWQgPSA/XCIsIFtpZF0pO1xuICBkYi5ydW4oXCJERUxFVEUgRlJPTSBzb3VyY2VzIFdIRVJFIGRvY19pZCA9ID9cIiwgW2lkXSk7XG4gIC8vIFBlbmRpbmcgcHJvcG9zYWxzIGxvc2UgdGhlaXIgZXZpZGVuY2UgKHNwYW4gaW5jbHVkZWQg4oCUIGEgc3BhbiB3aXRob3V0XG4gIC8vIGl0cyBkb2MgYW5jaG9ycyBub3RoaW5nKTsgcmF0aWZpZWQgb25lcyBrZWVwIGl0IGFzIGhpc3RvcnkuXG4gIGRiLnJ1bihcbiAgICBcIlVQREFURSBwcm9wb3NhbHMgU0VUIGV2aWRlbmNlX2RvY19pZCA9IE5VTEwsIGV2aWRlbmNlX3NwYW4gPSBOVUxMIFdIRVJFIGV2aWRlbmNlX2RvY19pZCA9ID8gQU5EIHN0YXR1cyA9ICdwZW5kaW5nJ1wiLFxuICAgIFtpZF0sXG4gICk7XG5cbiAgYnVzLmVtaXQoXCJkb2MuZGVsZXRlZFwiLCB7IGlkIH0pO1xuICByZXR1cm4geyBpZCB9O1xufVxuXG4vLyBSb3VuZCA0IChLMSkg4oCUIGBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1jbGVhcl1gIGJhY2tpbmcgKG1hcmsgcm91dGVcbi8vIGZhbWlseTogc2x1ZyArIGV4aXN0cyBndWFyZHMgZmFpbCBsb3VkLCA0MDQtZmlyc3QgYXQgdGhlIHNlcnZlcikuIGtpbmRcbi8vIG51bGwgPSBjbGVhcjogd3JpdGVzIHRoZSAnJyBzZW50aW5lbCBhdCByZXN0IEFORCBudWxscyBraW5kX2F1dGhvciAoYW5cbi8vIHVudHlwZWQgZG9jIGhhcyBubyBhc3NlcnRvcikuIEEgc3RyaW5nIGtpbmQgcmVxdWlyZXMgYW4gYXV0aG9yIOKAlCB0aGUgYmFkZ2Vcbi8vIHN0eWxlcyBhc3NlcnRlZC1ieS11c2VyIHZzIGFnZW50LXNldCwgc28gYW4gdW5hdHRyaWJ1dGVkIHNldCB3b3VsZCBsaWUuXG4vLyBFbWl0cyBkb2Mua2luZCB7ZG9jSWQsIGtpbmQsIGF1dGhvcn0gd2l0aCB0aGUgV0lSRSBzaGFwZSAobnVsbCwgbmV2ZXIgJycpLlxuZnVuY3Rpb24gc2V0RG9jS2luZChcbiAgZGI6IERhdGFiYXNlLFxuICBidXM6IEV2ZW50QnVzLFxuICBpbnB1dDogeyBkb2NJZDogc3RyaW5nOyBraW5kOiBzdHJpbmcgfCBudWxsOyBhdXRob3I/OiBzdHJpbmcgfSxcbik6IHsgZG9jSWQ6IHN0cmluZzsga2luZDogc3RyaW5nIHwgbnVsbDsga2luZEF1dGhvcjogXCJ1c2VyXCIgfCBcImFnZW50XCIgfCBudWxsIH0gfCBudWxsIHtcbiAgaWYgKCFTTFVHX1JFLnRlc3QoaW5wdXQuZG9jSWQpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gZG9jcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlucHV0LmRvY0lkKSkgcmV0dXJuIG51bGw7XG4gIGlmIChpbnB1dC5raW5kICE9PSBudWxsICYmICh0eXBlb2YgaW5wdXQua2luZCAhPT0gXCJzdHJpbmdcIiB8fCBpbnB1dC5raW5kID09PSBcIlwiKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImtpbmQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmcsIG9yIG51bGwgdG8gY2xlYXJcIik7XG4gIH1cbiAgbGV0IGtpbmRBdXRob3I6IFwidXNlclwiIHwgXCJhZ2VudFwiIHwgbnVsbCA9IG51bGw7XG4gIGlmIChpbnB1dC5raW5kICE9PSBudWxsKSB7XG4gICAgaWYgKGlucHV0LmF1dGhvciAhPT0gXCJ1c2VyXCIgJiYgaW5wdXQuYXV0aG9yICE9PSBcImFnZW50XCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcInNldHRpbmcgYSBraW5kIHJlcXVpcmVzIGF1dGhvciB1c2VyfGFnZW50XCIpO1xuICAgIH1cbiAgICBraW5kQXV0aG9yID0gaW5wdXQuYXV0aG9yO1xuICB9XG4gIGRiLnJ1bihcIlVQREFURSBkb2NzIFNFVCBraW5kID0gPywga2luZF9hdXRob3IgPSA/IFdIRVJFIGlkID0gP1wiLCBbXG4gICAgaW5wdXQua2luZCA/PyBcIlwiLFxuICAgIGtpbmRBdXRob3IsXG4gICAgaW5wdXQuZG9jSWQsXG4gIF0pO1xuICBidXMuZW1pdChcImRvYy5raW5kXCIsIHsgZG9jSWQ6IGlucHV0LmRvY0lkLCBraW5kOiBpbnB1dC5raW5kLCBhdXRob3I6IGtpbmRBdXRob3IgfSk7XG4gIHJldHVybiB7IGRvY0lkOiBpbnB1dC5kb2NJZCwga2luZDogaW5wdXQua2luZCwga2luZEF1dGhvciB9O1xufVxuXG5leHBvcnQgeyBDaXRlZEVycm9yLCBkZWxldGVEb2MsIHNldERvY0tpbmQgfTtcbiIsCiAgICAiLy8gUm91bmQgMTIgKFNFQU0gNCkg4oCUIGBub2RlIGVkaXRgOiB0aGUgbWlzc2luZyBcInRoZSBhZ2VudCBpcyBhbGxvd2VkIHRvIGxlYXJuXG4vLyBtb3JlIGFib3V0IHRoaXMgbGF0ZXJcIi4gQmVmb3JlIHRoaXMsIGBub2RlYCBzdXBwb3J0ZWQgb25seSBhbmNob3IgYW5kIGRlbGV0ZSxcbi8vIHNvIGEgbm9kZSByYXRpZmllZCBmcm9tIGEgdGhpbiBkcmFmdCBjb3VsZCBORVZFUiBnYWluIGEgc3lub3BzaXMg4oCUIHRoZSBvbmx5XG4vLyByZWNvdmVyeSB3YXMgZGVsZXRlICsgcmUtcHJvcG9zZSArIHJlLXJhdGlmeSwgd2hpY2ggZGVzdHJveXMgdGhlIGh1bWFuJ3Ncbi8vIHJhdGlmaWNhdGlvbiBhY3QuIE9ic2VydmVkIGxpdmU6IGZpdmUgY2Fub24gbm9kZXMgcGVybWFuZW50bHkgYmFyZSAoRjIpLlxuLy9cbi8vIFdIQVQgSVMgRURJVEFCTEUg4oCUIHRpdGxlIGFuZCBzeW5vcHNpcyBPTkxZLiBUaGUgbGluZSBpczogYW4gZWRpdCBjaGFuZ2VzIHdoYXRcbi8vIGEgbm9kZSBTQVlTLCBuZXZlciB3aGF0IGl0IElTIG9yIGhvdyBpdCB3YXMgUlVMRUQuXG4vLyAgIMK3IGB0aWVyYCBpcyB0aGUgaHVtYW4ncyBydWxpbmcgKGNhbm9uIC8gdGhyZWFkIC8gc3RvcnktbG9jYWwpIOKAlCBhbiBhZ2VudFxuLy8gICAgIFwiZWRpdFwiIHRoYXQgcmUtdGllcnMgYSBub2RlIHdvdWxkIG92ZXJ3cml0ZSBhIHJhdGlmaWNhdGlvbiBhY3Qgd2l0aCBhXG4vLyAgICAgd3JpdGUsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIHRoaW5nIEYyIHdhcyB0cnlpbmcgbm90IHRvIGRlc3Ryb3kuXG4vLyAgIMK3IGBraW5kYCBpcyB0aGUgc2FtZSBjbGFzc2lmaWNhdGlvbiBheGlzIChkcmFmdGVkLCB0aGVuIGZyb3plbiBieSB0aGVcbi8vICAgICBydWxpbmcpIGFuZCBubyBuZWVkIGZvciBpdCBpcyBpbiBldmlkZW5jZSDigJQgZGVsaWJlcmF0ZWx5IG91dCwgbm90XG4vLyAgICAgZm9yZ290dGVuLiBSZS1jbGFzc2lmeWluZyBzdGF5cyBhIHByb3Bvc2UtYW5kLXJ1bGUgYWN0LlxuLy8gICDCtyBgYW5jaG9yTm9kZUlkYCBoYXMgaXRzIG93biB2ZXJiIChgbm9kZSBhbmNob3JgKSwgYHRhZ3NgIGhhdmUgYC90YWdzLzppZGAsXG4vLyAgICAgYHNvdXJjZXNgIGFyZSBwcm92ZW5hbmNlIGFuZCBhcmUgbmV2ZXIgcmV3cml0dGVuIGluIHBsYWNlLlxuLy9cbi8vIENvbnRyYWN0IDggaG9sZHM6IHRoaXMgd3JpdGVzIEVYQUNUTFkgd2hhdCBpdCBpcyBnaXZlbi4gTm8gdHJpbW1pbmcsIG5vXG4vLyB0aXRsZS1jYXNpbmcsIG5vIHJlLWRlcml2aW5nIGFueXRoaW5nIGZyb20gdGhlIG5ldyB0ZXh0LCBubyBhdXRvLXJlbGF0ZS5cbi8vXG4vLyBTRUFSQ0ggKHRoZSBwbGFuJ3Mgc3ViLXF1ZXN0aW9uIDIsIEZBTFNJRklFRCk6IG5vZGVzIGFyZSBOT1QgaW4gYW55IEZUU1xuLy8gdGFibGUuIHNlYXJjaC50cyBtYXRjaGVzIG5vZGVzIHdpdGggYSBsaXZlIGBMSUtFYCBvdmVyIHRoZSBgbm9kZXNgIHRhYmxlXG4vLyBpdHNlbGYgKGRvY3NfZnRzIC8gbWVzc2FnZXNfZnRzIGluZGV4IGRvY3MgYW5kIG1lc3NhZ2VzIG9ubHkpLCBzbyBhbiBlZGl0IGlzXG4vLyB2aXNpYmxlIHRvIHNlYXJjaCB0aGUgaW5zdGFudCBpdCBjb21taXRzIGFuZCB0aGVyZSBpcyBubyBpbmRleCB0byBrZWVwIGluXG4vLyBzeW5jLiBUaGUgXCJhbiBlZGl0IHRoYXQgZG9lc24ndCByZS1pbmRleCBzaWxlbnRseSBjb3JydXB0cyBzZWFyY2hcIiByaXNrIGRvZXNcbi8vIG5vdCBleGlzdCBoZXJlIOKAlCBidXQgaXQgaXMgcGlubmVkIGJ5IGEgdGVzdCByYXRoZXIgdGhhbiBsZWZ0IGFzIGEgY2xhaW0sXG4vLyBiZWNhdXNlIGl0IHdvdWxkIGJlY29tZSByZWFsIHRoZSBkYXkgbm9kZSBzZWFyY2ggbW92ZXMgdG8gRlRTLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcbmltcG9ydCB7IHR5cGUgTm9kZSwgcmVhZE5vZGVCeUlkIH0gZnJvbSBcIi4vc3RhdGUudHNcIjtcblxuaW50ZXJmYWNlIEVkaXROb2RlSW5wdXQge1xuICB0aXRsZT86IHN0cmluZztcbiAgc3lub3BzaXM/OiBzdHJpbmc7XG59XG5cbmNvbnN0IEVESVRBQkxFID0gJ2V4cGVjdGVkIHtcInRpdGxlXCI/OiBzdHJpbmcsIFwic3lub3BzaXNcIj86IHN0cmluZ30g4oCUIGF0IGxlYXN0IG9uZSc7XG5cbi8vIFJldHVybnMgbnVsbCBmb3IgYW4gdW5rbm93biBub2RlICh0aGUgc2VydmVyIDQwNHMpOyB0aHJvd3MgYSBuYW1lZCBpbnRha2Vcbi8vIGVycm9yIGZvciBhbiBlbXB0eSBvciBpbGwtc2hhcGVkIHBhdGNoICh0aGUgam9icy11cGRhdGUgcHJlY2VkZW50KS5cbmZ1bmN0aW9uIGVkaXROb2RlKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaWQ6IHN0cmluZywgaW5wdXQ6IEVkaXROb2RlSW5wdXQpOiBOb2RlIHwgbnVsbCB7XG4gIGNvbnN0IGhhc1RpdGxlID0gaW5wdXQudGl0bGUgIT09IHVuZGVmaW5lZDtcbiAgY29uc3QgaGFzU3lub3BzaXMgPSBpbnB1dC5zeW5vcHNpcyAhPT0gdW5kZWZpbmVkO1xuICBpZiAoIWhhc1RpdGxlICYmICFoYXNTeW5vcHNpcykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBub2RlIGVkaXQgbmVlZHMgc29tZXRoaW5nIHRvIHdyaXRlIOKAlCAke0VESVRBQkxFfS4gdGllciBpcyB0aGUgaHVtYW4ncyBydWxpbmcgYW5kIGtpbmQgaXMgYSByYXRpZmljYXRpb24tdGltZSBjbGFzc2lmaWNhdGlvbjsgbmVpdGhlciBpcyBlZGl0YWJsZSAocmUtcHJvcG9zZSB0byByZS1jbGFzc2lmeSlgLFxuICAgICk7XG4gIH1cbiAgaWYgKGhhc1RpdGxlICYmICh0eXBlb2YgaW5wdXQudGl0bGUgIT09IFwic3RyaW5nXCIgfHwgaW5wdXQudGl0bGUudHJpbSgpID09PSBcIlwiKSkge1xuICAgIC8vIEEgdGl0bGUgaXMgYSBzZWFyY2gga2V5IEFORCB0aGUgU0VBTSAyIHJlc29sdXRpb24ga2V5IOKAlCBhbiBlbXB0eSBvbmVcbiAgICAvLyB3b3VsZCBtYWtlIHRoZSBub2RlIHVuYWRkcmVzc2FibGUgYnkgZXZlcnkgbmFtZSBpdCBoYXMuXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYG5vZGUgZWRpdCB0aXRsZSBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZyAoaXQgaXMgdGhlIHNlYXJjaCBrZXkgYW5kIHRoZSBcXGB0aXRsZTpcXGAgZW5kcG9pbnQtcmVzb2x1dGlvbiBrZXkpIOKAlCAke0VESVRBQkxFfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzU3lub3BzaXMgJiYgdHlwZW9mIGlucHV0LnN5bm9wc2lzICE9PSBcInN0cmluZ1wiKSB7XG4gICAgLy8gXCJcIiBJUyBhbGxvd2VkIOKAlCBjbGVhcmluZyBhIHN5bm9wc2lzIGlzIGEgbGVnaXRpbWF0ZSBlZGl0LlxuICAgIHRocm93IG5ldyBFcnJvcihgbm9kZSBlZGl0IHN5bm9wc2lzIG11c3QgYmUgYSBzdHJpbmcgKGVtcHR5IHN0cmluZyBjbGVhcnMgaXQpIOKAlCAke0VESVRBQkxFfWApO1xuICB9XG4gIGlmICghZGIucXVlcnkoXCJTRUxFQ1QgMSBGUk9NIG5vZGVzIFdIRVJFIGlkID0gP1wiKS5nZXQoaWQpKSByZXR1cm4gbnVsbDtcblxuICAvLyBPbmx5IHRoZSBwcm92aWRlZCBmaWVsZHMgYXJlIHdyaXR0ZW4g4oCUIGEgcGF0Y2gsIG5ldmVyIGEgd2hvbGVzYWxlIHJlcGxhY2VcbiAgLy8gKGFuIG9taXR0ZWQgc3lub3BzaXMgbXVzdCBub3QgYmxhbmsgYW4gZXhpc3Rpbmcgb25lKS5cbiAgaWYgKGhhc1RpdGxlKSBkYi5ydW4oXCJVUERBVEUgbm9kZXMgU0VUIHRpdGxlID0gPyBXSEVSRSBpZCA9ID9cIiwgW2lucHV0LnRpdGxlIGFzIHN0cmluZywgaWRdKTtcbiAgaWYgKGhhc1N5bm9wc2lzKSB7XG4gICAgZGIucnVuKFwiVVBEQVRFIG5vZGVzIFNFVCBzeW5vcHNpcyA9ID8gV0hFUkUgaWQgPSA/XCIsIFtpbnB1dC5zeW5vcHNpcyBhcyBzdHJpbmcsIGlkXSk7XG4gIH1cblxuICAvLyBSZS1yZWFkIHRocm91Z2ggdGhlIFNJTkdMRSByZWFkZXIgc28gdGhlIHBheWxvYWQgaXMgYnl0ZS1pZGVudGljYWwgdG9cbiAgLy8gL3N0YXRlLm5vZGVzW10g4oCUIG5ldmVyIGhhbmQtYXNzZW1ibGUgYW4gZW50aXR5IGEgcmVwbGFjZS1ieS1pZCBjb25zdW1lclxuICAvLyBob2xkcyAodGhlIHN0YW5kaW5nIHJlLWVtaXQgcnVsZSkuXG4gIGNvbnN0IG5vZGUgPSByZWFkTm9kZUJ5SWQoZGIsIGlkKSBhcyBOb2RlO1xuICBidXMuZW1pdChcIm5vZGUuZWRpdGVkXCIsIG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIHJldHVybiBub2RlO1xufVxuXG5leHBvcnQgdHlwZSB7IEVkaXROb2RlSW5wdXQgfTtcbmV4cG9ydCB7IGVkaXROb2RlIH07XG4iLAogICAgIi8vIFAxIOKAlCBhIHRpbnkgaW4tcHJvY2VzcyBldmVudCBidXMuIEV2ZW50cyBhcmUgZGVyaXZlZC1mcm9tLXN0YXRlIGFuZFxuLy8gcmVwbGF5YWJsZSB2aWEgc25hcHNob3QgKENsYWltIEEvQjogbm8gZXZlbnQtbG9nIHRhYmxlIGluIFYxKSwgc28gdGhlXG4vLyBidWZmZXIgaGVyZSBpcyBhIGJvdW5kZWQgaW4tbWVtb3J5IHJlcGxheSB3aW5kb3cgZm9yIHJlY29ubmVjdHMgd2l0aGluIG9uZVxuLy8gZGFlbW9uIHByb2Nlc3MncyBsaWZldGltZSwgbm90IGEgZHVyYWJsZSBsb2cg4oCUIGEgcmVzdGFydCByZXNldHMgdG8gY3Vyc29yXG4vLyAwLCB3aGljaCBpcyBob25lc3QgKG5vdGhpbmcgcmF0aWZpZWQgaXMgbG9zdDsgb25seSB0aGUgcmVzdW1lLXBvaW50IGZvclxuLy8gZXZlbnRzIGFscmVhZHkgZXBoZW1lcmFsIGJ5IGRlc2lnbikuIE9uZSBlbWl0KCkgZmFucyBvdXQgdG8gYm90aCB0aGVcbi8vIGJyb3dzZXIncyBXUyBhbmQgdGhlIGFnZW50J3MgU1NFLXNoYXBlZCBgdGFpbGAg4oCUIHNhbWUgYnVzLCB0d28gdHJhbnNwb3J0c1xuLy8gKGRhZWRhbHVzJ3MgV1MtdnMtU1NFIHJ1bGluZywgdmluZSBtc2cgNikuXG5cbmNvbnN0IFJFUExBWV9CVUZGRVJfU0laRSA9IDEwMDA7XG5cbi8vIFRoZSBDT01QTEVURSBidXMgdm9jYWJ1bGFyeSDigJQgZXZlcnkgZW1pdCgpIHNpdGUncyBraW5kIG11c3QgYmUgbGlzdGVkIGhlcmVcbi8vICh0aGUgbG9vay5oZXJlIGRyaWZ0IGhpZCBmcm9tIHRoaXMgdW5pb24gZm9yIGEgd2hvbGUgYnVpbGQ7IGtlZXAgaXQgdG90YWwpLlxuLy8gTk9UIGxpc3RlZDogXCJlcG9jaC5jaGFuZ2VkXCIg4oCUIHRoYXQgbGluZSBpcyBDTEktc3ludGhlc2l6ZWQgYnkgdGFpbCBvblxuLy8gcmVjb25uZWN0LCBuZXZlciBhIGJ1cyBldmVudCAodGhlIGJyb3dzZXIgV1MgbmV2ZXIgc2VlcyBpdCkuXG4vL1xuLy8gUm91bmQgMTAgKFNFQU0gMSk6IHRoaXMgaXMgYSBydW50aW1lIGBhcyBjb25zdGAgYXJyYXkgYW5kIEV2ZW50S2luZCBpc1xuLy8gREVSSVZFRCBmcm9tIGl0IChgdHlwZW9mIEFMTF9FVkVOVF9LSU5EU1tudW1iZXJdYCksIHNvIHRoZSB1bmlvbiBhbmQgdGhlXG4vLyBydW50aW1lIGxpc3QgY2Fubm90IGRyaWZ0IOKAlCBhbmQgdGhlIGAtLWluYm91bmRgIHRyaWFnZSBiZWxvdyBjYW4gYmUgcHJvdmVuXG4vLyBUT1RBTCBvdmVyIGl0IChub3Qtd2F0Y2hlZCA9IHRoZSB3aG9sZSB2b2NhYnVsYXJ5IG1pbnVzIHRoZSB0d28gd2F0Y2hlZFxuLy8gY2hhbm5lbHMsIHNvIGEgTkVXTFktYWRkZWQga2luZCBpcyBub3Qtd2F0Y2hlZCBCWSBDT05TVFJVQ1RJT04gYW5kIHNob3dzIHVwXG4vLyBpbiB0aGUgZ3JvdW5kaW5nIGxpbmUgdGhlIG1vbWVudCBpdCBleGlzdHM7IEY1J3MgXCJhIG1pc3NpbmcgY2hhbm5lbCBpc1xuLy8gdmlzaWJsZSwgbm90IHNpbGVudFwiKS5cbmNvbnN0IEFMTF9FVkVOVF9LSU5EUyA9IFtcbiAgXCJhY3Rpb25zLnNldFwiLFxuICBcInRhZ3Muc2V0XCIsXG4gIFwiZG9jLmFkZGVkXCIsXG4gIFwiZG9jLmRlbGV0ZWRcIixcbiAgXCJkb2Mua2luZFwiLFxuICBcImRvYy5tYXJrZWRcIixcbiAgXCJub2RlLnJhdGlmaWVkXCIsXG4gIC8vIFJvdW5kIDEyIChTRUFNIDQpOiBjYXJyaWVzIHRoZSBGVUxMIE5vZGUgZW50aXR5ICh3aG9sZXNhbGUgcmVwbGFjZS1ieS1pZCxcbiAgLy8gdGhlIHRhZ3Muc2V0L2pvYi4qIGlkaW9tLCByZS1yZWFkIHRocm91Z2ggcmVhZE5vZGVCeUlkKS4gS2VwdCBESVNUSU5DVCBmcm9tXG4gIC8vIG5vZGUucmF0aWZpZWQg4oCUIGEgcmF0aWZ5IGlzIGFuIGFycml2YWwgKGFuaW1hdGUgaXQgaW4pLCBhbiBlZGl0IGlzIGEgcGF0Y2hcbiAgLy8gb2YgYSBub2RlIHRoZSBjb25zdW1lciBhbHJlYWR5IGhvbGRzOyBhbmQgcGVyIHRoZSBSOSBydWxlLCBhIGNvbnN1bWVyIGNhblxuICAvLyBhbHdheXMgQ09MTEFQU0UgdHdvIGtpbmRzIGludG8gb25lIHJlZHVjZXIgY2FzZSBidXQgY2FuIG5ldmVyIHJlLWRlcml2ZSBhXG4gIC8vIGtpbmQgdGhhdCB3YXMgZm9sZGVkIGF3YXkuXG4gIFwibm9kZS5lZGl0ZWRcIixcbiAgXCJub2RlLmRlbGV0ZWRcIixcbiAgXCJlZGdlLnJhdGlmaWVkXCIsXG4gIFwibm9kZS5hbmNob3JlZFwiLFxuICBcInByb3Bvc2FsLmFkZGVkXCIsXG4gIFwicHJvcG9zYWwucHJvbW90ZWRcIixcbiAgXCJwcm9wb3NhbC5yZWplY3RlZFwiLFxuICBcInByb3Bvc2FsLmRlbGV0ZWRcIixcbiAgXCJ6b25lLmNyZWF0ZWRcIixcbiAgXCJ6b25lLmRlbGV0ZWRcIixcbiAgLy8gUm91bmQgOSAoSm9iIFF1ZXVlKTogYWRkZWQvdXBkYXRlZC9jbGFpbWVkIGNhcnJ5IHRoZSBGVUxMIEpvYiBlbnRpdHkgKEQzIOKAlFxuICAvLyB3aG9sZXNhbGUgcmVwbGFjZS1ieS1pZCwgdGhlIHRhZ3Muc2V0IGlkaW9tKTsgZGVsZXRlZCBpcyB0aGluIHtpZH0uXG4gIC8vIGpvYi5jbGFpbWVkIGlzIGtlcHQgRElTVElOQ1QgZnJvbSBqb2IudXBkYXRlZCAoYSBjbGFpbSBpcyBhIGNvbXBhcmUtYW5kLXNldFxuICAvLyBsZWFzZSBhY3F1aXNpdGlvbiwgdGhlIG11bHRpLWFnZW50IG9uLXJhbXAncyBoZWFkbGluZSBzaWduYWwpLlxuICBcImpvYi5hZGRlZFwiLFxuICBcImpvYi51cGRhdGVkXCIsXG4gIFwiam9iLmNsYWltZWRcIixcbiAgXCJqb2IuZGVsZXRlZFwiLFxuICBcIm1lc3NhZ2UucG9zdGVkXCIsXG4gIFwibGVucy5zZXRcIixcbiAgXCJsb29rLmhlcmVcIixcbiAgXCJwcmVzZW5jZS5jaGFuZ2VkXCIsXG4gIFwiYWdlbnQuYWN0aXZpdHlcIixcbl0gYXMgY29uc3Q7XG5cbnR5cGUgRXZlbnRLaW5kID0gKHR5cGVvZiBBTExfRVZFTlRfS0lORFMpW251bWJlcl07XG5cbmludGVyZmFjZSBCdXNFdmVudCB7XG4gIHNlcTogbnVtYmVyO1xuICBlcG9jaDogc3RyaW5nO1xuICBraW5kOiBFdmVudEtpbmQ7XG4gIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG50eXBlIExpc3RlbmVyID0gKGV2ZW50OiBCdXNFdmVudCkgPT4gdm9pZDtcblxuaW50ZXJmYWNlIEV2ZW50QnVzIHtcbiAgZW1pdChraW5kOiBFdmVudEtpbmQsIHBheWxvYWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogQnVzRXZlbnQ7XG4gIHN1YnNjcmliZShzaW5jZTogbnVtYmVyLCBsaXN0ZW5lcjogTGlzdGVuZXIpOiAoKSA9PiB2b2lkO1xuICBjdXJzb3IoKTogbnVtYmVyO1xuICBlcG9jaDogc3RyaW5nO1xufVxuXG4vLyBBIGZyZXNoIHJhbmRvbSBlcG9jaCBwZXIgYnVzIGluc3RhbmNlIChpLmUuIHBlciBkYWVtb24gYm9vdCkg4oCUIHNpbmNlIHNlcVxuLy8gcmVzZXRzIHRvIDAgb24gcmVzdGFydCAobm8gZHVyYWJsZSBldmVudCBsb2csIENsYWltIEEvQiksIGEgcmVzdW1pbmdcbi8vIGB0YWlsIC0tc2luY2UgPG4+YCBjbGllbnQgY2FuJ3QgdGVsbCBhIHN0YWxlIHdhdGVybWFyayBmcm9tIGEgZnJlc2ggb25lIGJ5XG4vLyBzZXEgYWxvbmUuIENvbXBhcmluZyBlcG9jaCBtYWtlcyB0aGF0IGRldGVjdGFibGU6IGEgZGlmZmVyZW50IGVwb2NoIG1lYW5zXG4vLyBcInRoaXMgY3Vyc29yIGlzIGZyb20gYSBwcmlvciBwcm9jZXNzLCByZXNuYXBzaG90IGluc3RlYWQgb2YgdHJ1c3RpbmcgaXRcIlxuLy8gKGNhc3NhbmRyYSdzIFAyIGdhdGUgZmluZGluZyDigJQgdGFpbC1yZXN1bWUtYWNyb3NzLXJlc3RhcnQgd2FzIHByZXZpb3VzbHlcbi8vIHNpbGVudCBhYm91dCB0aGlzKS5cbmZ1bmN0aW9uIGNyZWF0ZUV2ZW50QnVzKCk6IEV2ZW50QnVzIHtcbiAgbGV0IHNlcSA9IDA7XG4gIGNvbnN0IGVwb2NoID0gY3J5cHRvLnJhbmRvbVVVSUQoKTtcbiAgY29uc3QgYnVmZmVyOiBCdXNFdmVudFtdID0gW107XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8TGlzdGVuZXI+KCk7XG5cbiAgcmV0dXJuIHtcbiAgICBlcG9jaCxcbiAgICBlbWl0KGtpbmQsIHBheWxvYWQpIHtcbiAgICAgIHNlcSArPSAxO1xuICAgICAgY29uc3QgZXZlbnQ6IEJ1c0V2ZW50ID0geyBzZXEsIGVwb2NoLCBraW5kLCBwYXlsb2FkIH07XG4gICAgICBidWZmZXIucHVzaChldmVudCk7XG4gICAgICBpZiAoYnVmZmVyLmxlbmd0aCA+IFJFUExBWV9CVUZGRVJfU0laRSkgYnVmZmVyLnNoaWZ0KCk7XG4gICAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIGxpc3RlbmVycykgbGlzdGVuZXIoZXZlbnQpO1xuICAgICAgcmV0dXJuIGV2ZW50O1xuICAgIH0sXG4gICAgc3Vic2NyaWJlKHNpbmNlLCBsaXN0ZW5lcikge1xuICAgICAgZm9yIChjb25zdCBldmVudCBvZiBidWZmZXIpIHtcbiAgICAgICAgaWYgKGV2ZW50LnNlcSA+IHNpbmNlKSBsaXN0ZW5lcihldmVudCk7XG4gICAgICB9XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiAoKSA9PiBsaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbiAgICB9LFxuICAgIGN1cnNvcigpIHtcbiAgICAgIHJldHVybiBzZXE7XG4gICAgfSxcbiAgfTtcbn1cblxuLy8g4pSA4pSAIFJvdW5kIDEwIMK3IFNFQU0gMSDigJQgdGhlIGAtLWluYm91bmRgIGh1bWFuLWludGVudCBmaWx0ZXIg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gQSBqb2luaW5nIGFnZW50IHRhaWxzIE9ORSBzZXJ2ZXItZmlsdGVyZWQgc3RyZWFtIG9mIGV2ZW50cyBhIEhVTUFOXG4vLyBvcmlnaW5hdGVkLCBzbyBpdCBjYW5ub3QgdW5kZXItc3Vic2NyaWJlICh0aGUgRjQgYnVnOiBhbiBhZ2VudCB0YWlsaW5nIG9ubHlcbi8vIGNoYXQgd2VudCBERUFGIHRvIHRoZSBib2FyZCB3aGVuIHRoZSBodW1hbiByaWdodC1jbGlja2VkIGEgbm9kZSkuIENvcnJlY3RuZXNzXG4vLyBpcyBvd25lZCBieSB0aGUgc3VyZmFjZSAodGhpcyBwcmVkaWNhdGUpLCBOT1QgdGhlIGFnZW50J3MgZ3JlcC5cbi8vXG4vLyBBdHRyaWJ1dGlvbiB0b2RheSBpcyBQQVlMT0FELUZJRUxELWJhc2VkIOKAlCB0aGUgb25seSBjbGVhbiBodW1hbi9hZ2VudFxuLy8gZGlzY3JpbWluYXRvci4gYG1lc3NhZ2UucG9zdGVkYCBjYXJyaWVzIGByb2xlYCwgYHByb3Bvc2FsLmFkZGVkYCBjYXJyaWVzXG4vLyBgYXV0aG9yYDsgYm90aCBhcmUgd3JpdHRlbiBieSB0aGUgQ0FMTEVSICh0aGUgYnJvd3NlciBwb3N0cyByb2xlL2F1dGhvclxuLy8gXCJ1c2VyXCI7IHRoZSBDTEkgZGVmYXVsdHMgdG8gXCJhZ2VudFwiKS4gRXZlcnkgT1RIRVIgYm9hcmQgbXV0YXRpb25cbi8vIChyYXRpZnkvcHJvbW90ZS96b25lLW1vdmUvZGVsZXRlL3RhZ3MvYWN0aW9ucy9hbmNob3IvZG9jKSBpcyBlbWl0dGVkXG4vLyBJREVOVElDQUxMWSB3aGV0aGVyIGEgaHVtYW4gKGJyb3dzZXIpIG9yIGFuIGFnZW50IChDTEkpIHRyaWdnZXJlZCBpdCwgYmVjYXVzZVxuLy8gYm90aCBjbGllbnRzIFBPU1QgdGhlIFNBTUUgZGFlbW9uIHJvdXRlcyDigJQgdGhlcmUgaXMgTk8gcm91dGUgb3JpZ2luIHRvIHN0YW1wXG4vLyAodGhlIHBsYW4ncyBPcHRpb24gQiBpcyBmYWxzaWZpZWQ6IHRoZSBkYWVtb24gc2VydmVzIG9uZSBIVFRQIHN1cmZhY2UgZm9yIHR3b1xuLy8gY2xpZW50cykuIFNvIGAtLWluYm91bmRgID0gT3B0aW9uIEE6IHRoZSB0d28gYXR0cmlidXRhYmxlIGNoYW5uZWxzIG9ubHkuXG4vLyBIdW1hbiBib2FyZC1hY3QgYXR0cmlidXRpb24gKGUuZy4gdGhlIGh1bWFuIHJhdGlmeWluZyBhIG5vZGUpIGlzIGEgTkFNRURcbi8vIGZvbGxvdy1vbiB0aGF0IG5lZWRzIGFjdG9yIHRhZ2dpbmcgb24gdGhvc2Ugc2hhcmVkIHJvdXRlcyDigJQgc3VyZmFjZWQgaW4gdGhlXG4vLyBncm91bmRpbmcgbGluZSdzIGBub3RXYXRjaGluZ2AsIG5ldmVyIHNpbGVudGx5IGRyb3BwZWQuXG5jb25zdCBJTkJPVU5EX1dBVENIRUQgPSBbXG4gIHsga2luZDogXCJtZXNzYWdlLnBvc3RlZFwiLCBmaWVsZDogXCJyb2xlXCIsIHZhbHVlOiBcInVzZXJcIiB9LFxuICB7IGtpbmQ6IFwicHJvcG9zYWwuYWRkZWRcIiwgZmllbGQ6IFwiYXV0aG9yXCIsIHZhbHVlOiBcInVzZXJcIiB9LFxuXSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVhZG9ubHlBcnJheTx7IGtpbmQ6IEV2ZW50S2luZDsgZmllbGQ6IHN0cmluZzsgdmFsdWU6IHN0cmluZyB9PjtcblxuLy8gbm90LXdhdGNoZWQgPSB0aGUgd2hvbGUgdm9jYWJ1bGFyeSBtaW51cyB0aGUgd2F0Y2hlZCBjaGFubmVscyDigJQgVE9UQUwgYnlcbi8vIGNvbnN0cnVjdGlvbiwgc28gYSBuZXcgRXZlbnRLaW5kIGlzIG5vdC13YXRjaGVkIChhbmQgZ3JvdW5kaW5nLXZpc2libGUpIHVudGlsXG4vLyBzb21lb25lIGRlbGliZXJhdGVseSB0cmlhZ2VzIGl0IGludG8gSU5CT1VORF9XQVRDSEVELlxuY29uc3QgSU5CT1VORF9OT1RfV0FUQ0hFRDogRXZlbnRLaW5kW10gPSBBTExfRVZFTlRfS0lORFMuZmlsdGVyKFxuICAoaykgPT4gIUlOQk9VTkRfV0FUQ0hFRC5zb21lKCh3KSA9PiB3LmtpbmQgPT09IGspLFxuKTtcblxuLy8gVHJ1ZSBpZmYgdGhlIGV2ZW50IHJlcHJlc2VudHMgYSBodW1hbiBhY3Rpbmcgb24gdGhlIHNlc3Npb24gKE9wdGlvbiBBKS5cbmZ1bmN0aW9uIGlzSW5ib3VuZEV2ZW50KGV2ZW50OiBCdXNFdmVudCk6IGJvb2xlYW4ge1xuICBmb3IgKGNvbnN0IHcgb2YgSU5CT1VORF9XQVRDSEVEKSB7XG4gICAgaWYgKGV2ZW50LmtpbmQgPT09IHcua2luZCAmJiBldmVudC5wYXlsb2FkW3cuZmllbGRdID09PSB3LnZhbHVlKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8vIOKUgOKUgCBSb3VuZCAxMSDCtyBTRUFNIDEg4oCUIHRoZSBtZXNzYWdlIENIQU5ORUwgdm9jYWJ1bGFyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBBIG1lc3NhZ2UncyBga2luZGAgSVMgaXRzIGNoYW5uZWwg4oCUIHRoZSBhZmZvcmRhbmNlIGl0IGFycml2ZWQgdGhyb3VnaCwgd2hpY2hcbi8vIGlzIHdoYXQgY2FycmllcyB0aGUgaHVtYW4ncyBwcm92ZW5hbmNlIChcInRoYXQgY2FtZSBmcm9tIHRoZSBjYW52YXMsIG5vdCB0aGVcbi8vIGNoYXQgYmFyXCIpLiBUaGlzIGlzIGEgbmFtaW5nIG9mIGFzLWJ1aWx0LCBub3QgYSBuZXcgYXhpczogdGhlIHN1cmZhY2UgYWxyZWFkeVxuLy8gc2hpcHBlZCBga2luZDpcImFuYWx5emVcImAgZm9yIHRoZSBkb2NzLXJhaWwgQW5hbHl6ZSBhZmZvcmRhbmNlLCBzbyBga2luZGAgd2FzXG4vLyBhbHJlYWR5IHRoZSBhcnJpdmFsIGRpc2NyaW1pbmF0b3IgYmVmb3JlIFIxMSBuYW1lZCBpdC5cbi8vXG4vLyBUaGUgc2V0IGlzIEtOT1dOIGJ1dCBOT1QgQ0xPU0VEIOKAlCBpbnRha2Ugc3RvcmVzIGFuIHVua25vd24gY2hhbm5lbCB2ZXJiYXRpbVxuLy8gYW5kIEFEVklTRVMgKHNlbmQudHMgY2hhbm5lbFdhcm5pbmc7IHRoZSBlZGdlRHJhZnRXYXJuaW5nIHByZWNlZGVudDogXCJvcGFxdWVcIlxuLy8gYm91bmRzIHdoYXQgeW91IFJFSkVDVCwgbm90IHdoYXQgeW91IFNBWSkuIFZhbGlkYXRpbmcgYSBjbG9zZWQgc2V0IHdvdWxkIDQwMFxuLy8gdGhlIGFscmVhZHktc2hpcHBlZCBgYW5hbHl6ZWAsIGFuZCBpdCB3b3VsZCBtYWtlIGV2ZXJ5IGZ1dHVyZSBjaGFubmVsIGFcbi8vIGRhZW1vbiBjaGFuZ2UgYmVmb3JlIGEgc3VyZmFjZSBjb3VsZCB1c2UgaXQuIFZpc2liaWxpdHksIG5vdCByZWplY3Rpb24sIGlzXG4vLyB0aGUgRjUgbGVzc29uIOKAlCBoZW5jZSB0aGlzIGxpc3QgcmlkZXMgdGhlIGluYm91bmQgZ3JvdW5kaW5nIGxpbmUuXG5jb25zdCBNRVNTQUdFX0NIQU5ORUxTID0gW1xuICBcInR1cm5cIiwgLy8gdGhlIGNoYXQgYmFyICh0aGUgZGVmYXVsdClcbiAgXCJhbmFseXplXCIsIC8vIHRoZSBkb2NzLXJhaWwgQW5hbHl6ZSBhZmZvcmRhbmNlIChzaGlwcGVkIHByZS1SMTEpXG4gIFwiY2FudmFzXCIsIC8vIHRoZSByaWdodC1jbGljayBmcmVlZm9ybSByYW1ibGUgKFIxMSDigJQgYSBtZXNzYWdlLCBOT1QgYSBub2RlKVxuXSBhcyBjb25zdDtcblxudHlwZSBNZXNzYWdlQ2hhbm5lbCA9ICh0eXBlb2YgTUVTU0FHRV9DSEFOTkVMUylbbnVtYmVyXTtcblxuaW50ZXJmYWNlIEdyb3VuZGluZ0xpbmUge1xuICBraW5kOiBcImdyb3VuZGluZ1wiO1xuICBpbmJvdW5kOiB0cnVlO1xuICB3YXRjaGluZzogc3RyaW5nW107XG4gIG5vdFdhdGNoaW5nOiBFdmVudEtpbmRbXTtcbiAgbWVzc2FnZUNoYW5uZWxzOiBzdHJpbmdbXTtcbiAgbm90ZTogc3RyaW5nO1xufVxuXG4vLyBUaGUgZmlyc3QtY29ubmVjdCBiZWx0LWFuZC1zdXNwZW5kZXJzIGxpbmUgKEY1KTogbmFtZXMgdGhlIGNoYW5uZWxzIHRoaXNcbi8vIGluYm91bmQgc3RyZWFtIHdhdGNoZXMgQU5EIHRoZSBvbmVzIGl0IGRvZXMgbm90LCBzbyBhIG1pc3NpbmcgY2hhbm5lbCBpc1xuLy8gdmlzaWJsZSBpbnN0ZWFkIG9mIHNpbGVudGx5IGFic2VudC4gREVSSVZFRCBmcm9tIHRoZSBzYW1lIHByZWRpY2F0ZSB0aGF0XG4vLyBmaWx0ZXJzLCBzbyB0aGUgdHdvIGNhbm5vdCBkcmlmdC4gQ2FycmllcyBubyBzZXEvZXBvY2gg4oCUIGl0IGlzIGluZm9ybWF0aW9uYWwsXG4vLyBuZXZlciBhIGJ1cyBldmVudCAodGhlIHNhbWUgc2VwYXJhdGlvbiBhcyBDTEktc3ludGhlc2l6ZWQgZXBvY2guY2hhbmdlZCksIHNvXG4vLyBpdCBuZXZlciBhZHZhbmNlcyB0aGUgdGFpbCdzIGN1cnNvci5cbmZ1bmN0aW9uIGluYm91bmRHcm91bmRpbmcoKTogR3JvdW5kaW5nTGluZSB7XG4gIHJldHVybiB7XG4gICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICBpbmJvdW5kOiB0cnVlLFxuICAgIHdhdGNoaW5nOiBJTkJPVU5EX1dBVENIRUQubWFwKCh3KSA9PiBgJHt3LmtpbmR9WyR7dy5maWVsZH09JHt3LnZhbHVlfV1gKSxcbiAgICBub3RXYXRjaGluZzogSU5CT1VORF9OT1RfV0FUQ0hFRCxcbiAgICBtZXNzYWdlQ2hhbm5lbHM6IFsuLi5NRVNTQUdFX0NIQU5ORUxTXSxcbiAgICBub3RlOiBcIkh1bWFuIGJvYXJkLWFjdHMgb24gc2hhcmVkIHJvdXRlcyAocmF0aWZ5L3Byb21vdGUvem9uZS1tb3ZlL2RlbGV0ZS90YWdzL2FjdGlvbnMvYW5jaG9yL2RvYykgY2Fycnkgbm8gYWN0b3IgYW5kIGFyZSBOT1QgYXR0cmlidXRhYmxlIGluIFYxIOKAlCBhIG5hbWVkIGZvbGxvdy1vbiAoYWN0b3IgdGFnZ2luZyBvbiB0aG9zZSByb3V0ZXMpLiBSZWZldGNoIC9zdGF0ZSB0byByZWNvbmNpbGUgdGhlIGJvYXJkLiBBIGh1bWFuIG1lc3NhZ2UncyBga2luZGAgaXMgaXRzIGNoYW5uZWwgKG1lc3NhZ2VDaGFubmVscyBhYm92ZSk7IHRoZSBzZXQgaXMga25vd24gYnV0IE5PVCBjbG9zZWQg4oCUIGFuIHVua25vd24gY2hhbm5lbCBpcyBzdG9yZWQgYW5kIHN0cmVhbWVkLCBuZXZlciByZWplY3RlZCwgc28gcmVhZCBga2luZGAgdG9sZXJhbnRseS5cIixcbiAgfTtcbn1cblxuZXhwb3J0IHR5cGUgeyBCdXNFdmVudCwgRXZlbnRCdXMsIEV2ZW50S2luZCwgR3JvdW5kaW5nTGluZSwgTWVzc2FnZUNoYW5uZWwgfTtcbmV4cG9ydCB7XG4gIEFMTF9FVkVOVF9LSU5EUyxcbiAgY3JlYXRlRXZlbnRCdXMsXG4gIElOQk9VTkRfTk9UX1dBVENIRUQsXG4gIElOQk9VTkRfV0FUQ0hFRCxcbiAgaW5ib3VuZEdyb3VuZGluZyxcbiAgaXNJbmJvdW5kRXZlbnQsXG4gIE1FU1NBR0VfQ0hBTk5FTFMsXG59O1xuIiwKICAgICIvLyBQMiDigJQgUE9TVCAvaW5nZXN0IGJhY2tpbmc6IG11bHRpcGFydCAoZmlsZSBkcm9wKSBvciBKU09OIChicmFpbi1kdW1wIHRleHQsXG4vLyBcIisgbmV3IGRvY3VtZW50XCIpIGFsbCBjb252ZXJnZSBoZXJlLiBXcml0ZXMgdGhlIHNvdXJjZSBkb2MgZmlsZSArIGEgZG9jc1xuLy8gcm93LCBlbWl0cyBkb2MuYWRkZWQuIERvZXMgbm90aGluZyBlbHNlIOKAlCBubyBleHRyYWN0aW9uLCBubyBjaHVua2luZywgbm9cbi8vIGVtYmVkZGluZyAoQ2xhaW0gQTogdGhhdCdzIHRoZSBjYXN0aW5nIGFnZW50IHJlYWN0aW5nIHRvIHRoZSBldmVudCkuXG5cbmltcG9ydCB0eXBlIHsgRGF0YWJhc2UgfSBmcm9tIFwiYnVuOnNxbGl0ZVwiO1xuaW1wb3J0IHsgZXhpc3RzU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBFdmVudEJ1cyB9IGZyb20gXCIuL2V2ZW50cy50c1wiO1xuaW1wb3J0IHR5cGUgeyBEb2MgfSBmcm9tIFwiLi9zdGF0ZS50c1wiO1xuXG5mdW5jdGlvbiBzbHVnaWZ5KHRpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gdGl0bGVcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXmEtejAtOV0rL2csIFwiLVwiKVxuICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpO1xuICByZXR1cm4gYmFzZSB8fCBcImRvY1wiO1xufVxuXG4vLyBBIGR1cGxpY2F0ZSB0aXRsZSBnZXRzIGEgZGlzYW1iaWd1YXRpbmcgbnVtZXJpYyBzdWZmaXgg4oCUIG5ldmVyIGFuXG4vLyBvdmVyd3JpdGUgKHNpbGVudCBkYXRhIGxvc3MgaXMgdGhlIGZhaWx1cmUgbW9kZSB0byBndWFyZCkuXG5mdW5jdGlvbiB1bmlxdWVJZChkYjogRGF0YWJhc2UsIHRpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gc2x1Z2lmeSh0aXRsZSk7XG4gIGxldCBpZCA9IGJhc2U7XG4gIGxldCBuID0gMjtcbiAgd2hpbGUgKChkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gZG9jcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlkKSBhcyB1bmtub3duKSAhPT0gbnVsbCkge1xuICAgIGlkID0gYCR7YmFzZX0tJHtufWA7XG4gICAgbiArPSAxO1xuICB9XG4gIHJldHVybiBpZDtcbn1cblxuLy8gUm91bmQgNCAoSzEpOiB0aGUgaW5nZXN0IGtpbmQgZGVmYXVsdHMgKFwicmFtYmxlXCIvXCJzdG9yeVwiKSBkaWVkIOKAlCBhIGZyZXNoXG4vLyBkb2MgaXMgaG9uZXN0bHkgdW50eXBlZCAoJycgc2VudGluZWwgYXQgcmVzdCwga2luZCBudWxsIG9uIHRoZSB3aXJlKSB1bnRpbFxuLy8gc29tZW9uZSBhc3NlcnRzIGEga2luZCB2aWEgUE9TVCAvZG9jLzppZC9raW5kLiBJbnRha2UgbmV2ZXIgZ3Vlc3Nlcy5cbmZ1bmN0aW9uIHN0b3JlRG9jKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGRvY3NEaXI6IHN0cmluZyxcbiAgdGl0bGU6IHN0cmluZyxcbiAgY29udGVudDogc3RyaW5nLFxuKTogRG9jIHtcbiAgY29uc3QgaWQgPSB1bmlxdWVJZChkYiwgdGl0bGUpO1xuICBpZiAoIWV4aXN0c1N5bmMoZG9jc0RpcikpIHRocm93IG5ldyBFcnJvcihgZG9jcyBkaXIgZG9lcyBub3QgZXhpc3Q6ICR7ZG9jc0Rpcn1gKTtcbiAgd3JpdGVGaWxlU3luYyhqb2luKGRvY3NEaXIsIGAke2lkfS5tZGApLCBjb250ZW50KTtcbiAgZGIucnVuKFwiSU5TRVJUIElOVE8gZG9jcyAoaWQsIHRpdGxlLCBraW5kLCBwYXRoLCBraW5kX2F1dGhvcikgVkFMVUVTICg/LCA/LCAnJywgPywgTlVMTClcIiwgW1xuICAgIGlkLFxuICAgIHRpdGxlLFxuICAgIGBkb2NzLyR7aWR9Lm1kYCxcbiAgXSk7XG4gIGRiLnJ1bihcIklOU0VSVCBJTlRPIGRvY3NfZnRzIChyb3dpZCwgZG9jX2lkLCBjb250ZW50KSBWQUxVRVMgKGxhc3RfaW5zZXJ0X3Jvd2lkKCksID8sID8pXCIsIFtcbiAgICBpZCxcbiAgICBjb250ZW50LFxuICBdKTtcbiAgY29uc3QgZG9jOiBEb2MgPSB7IGlkLCB0aXRsZSwga2luZDogbnVsbCwga2luZEF1dGhvcjogbnVsbCB9O1xuICBidXMuZW1pdChcImRvYy5hZGRlZFwiLCBkb2MgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIHJldHVybiBkb2M7XG59XG5cbmZ1bmN0aW9uIGluZ2VzdFRleHQoXG4gIGRiOiBEYXRhYmFzZSxcbiAgYnVzOiBFdmVudEJ1cyxcbiAgZG9jc0Rpcjogc3RyaW5nLFxuICB0aXRsZTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4pOiBEb2Mge1xuICByZXR1cm4gc3RvcmVEb2MoZGIsIGJ1cywgZG9jc0RpciwgdGl0bGUsIHRleHQpO1xufVxuXG5mdW5jdGlvbiBpbmdlc3RGaWxlKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGRvY3NEaXI6IHN0cmluZyxcbiAgdGl0bGU6IHN0cmluZyxcbiAgY29udGVudDogc3RyaW5nLFxuKTogRG9jIHtcbiAgcmV0dXJuIHN0b3JlRG9jKGRiLCBidXMsIGRvY3NEaXIsIHRpdGxlLCBjb250ZW50KTtcbn1cblxuZXhwb3J0IHsgaW5nZXN0RmlsZSwgaW5nZXN0VGV4dCB9O1xuIiwKICAgICIvLyBQMyDigJQgYGxlbnMgc2V0IC0tbm9kZSA8aWQ+IFstLWRlcHRoIDxuPl0gfCBsZW5zIGNsZWFyYCBhbmQgYGxvb2staGVyZVxuLy8gPG5vZGVJZD5gIGJhY2tpbmcuIExlbnMgaXMgYWRkcmVzc2FibGUsIHBlcnNpc3RlZCB2aWV3LXN0YXRlICh3cml0YWJsZVxuLy8gZnJvbSBib3RoIHNpZGVzIOKAlCBodW1hbiBjbGlja3MsIGFnZW50IHN0ZWVycyB2aWEgY29udmVyc2F0aW9uKTsgbG9vay1oZXJlXG4vLyBpcyBhIGZpcmUtb25jZSBudWRnZSB3aXRoIG5vIGJhY2tpbmcgdGFibGUsIGRpc3RpbmN0IGZyb20gbGVucyAocGxhbi5tZCdzXG4vLyByYXRpZmllZCBkaXN0aW5jdGlvbikuXG5cbmltcG9ydCB0eXBlIHsgRGF0YWJhc2UgfSBmcm9tIFwiYnVuOnNxbGl0ZVwiO1xuaW1wb3J0IHR5cGUgeyBFdmVudEJ1cyB9IGZyb20gXCIuL2V2ZW50cy50c1wiO1xuaW1wb3J0IHR5cGUgeyBMZW5zIH0gZnJvbSBcIi4vc3RhdGUudHNcIjtcblxuLy8gUm91bmQgMyAoQ2xhaW0gVjIpOiB0aGUgdXBzZXJ0IHdyaXRlcyBFVkVSWSBjb2x1bW4sIHNvIG5vZGUtbGVucyBYT1Jcbi8vIGRvYy1sZW5zIGhvbGRzIGJ5IGNvbnN0cnVjdGlvbiDigJQgc2V0dGluZyBvbmUgbW9kZSBhbHdheXMgbnVsbHMgdGhlIG90aGVyXG4vLyAob25lIGxlbnMgcm93IHBlciBwcm9qZWN0OyBubyBzdGFsZSBkb2NfaWQgY2FuIHN1cnZpdmUgYSBub2RlIHNldCkuXG5mdW5jdGlvbiBzZXRMZW5zKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgcHJvamVjdElkOiBzdHJpbmcsIGxlbnM6IExlbnMpOiBMZW5zIHtcbiAgZGIucnVuKFxuICAgIFwiSU5TRVJUIElOVE8gbGVucyAocHJvamVjdF9pZCwgb3duZXIsIG5vZGVfaWQsIGRlcHRoLCBkb2NfaWQpIFZBTFVFUyAoPywgPywgPywgPywgPykgXCIgK1xuICAgICAgXCJPTiBDT05GTElDVChwcm9qZWN0X2lkKSBETyBVUERBVEUgU0VUIG93bmVyID0gZXhjbHVkZWQub3duZXIsIG5vZGVfaWQgPSBleGNsdWRlZC5ub2RlX2lkLCBkZXB0aCA9IGV4Y2x1ZGVkLmRlcHRoLCBkb2NfaWQgPSBleGNsdWRlZC5kb2NfaWRcIixcbiAgICBbcHJvamVjdElkLCBsZW5zLm93bmVyLCBsZW5zLm5vZGVJZCwgbGVucy5kZXB0aCwgbGVucy5kb2NJZF0sXG4gICk7XG4gIC8vIGxlbnMuc2V0IEFMV0FZUyBjYXJyaWVzIGRvY0lkIChudWxsIG9uIGEgbm9kZSBsZW5zKSDigJQgYWRkaXRpdmUtb3B0aW9uYWwuXG4gIGJ1cy5lbWl0KFwibGVucy5zZXRcIiwgbGVucyBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIGxlbnM7XG59XG5cbmZ1bmN0aW9uIGNsZWFyTGVucyhkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIHByb2plY3RJZDogc3RyaW5nKTogdm9pZCB7XG4gIGRiLnJ1bihcIkRFTEVURSBGUk9NIGxlbnMgV0hFUkUgcHJvamVjdF9pZCA9ID9cIiwgW3Byb2plY3RJZF0pO1xuICBidXMuZW1pdChcImxlbnMuc2V0XCIsIHsgb3duZXI6IG51bGwsIG5vZGVJZDogbnVsbCwgZGVwdGg6IG51bGwsIGRvY0lkOiBudWxsIH0pO1xufVxuXG5mdW5jdGlvbiBsb29rSGVyZShidXM6IEV2ZW50QnVzLCBub2RlSWQ6IHN0cmluZyk6IHZvaWQge1xuICAvLyBEaXN0aW5jdCBldmVudCBraW5kLCBwZXIgdGhlIHJhdGlmaWVkIHZlcmIgZGVzaWduOiBsb29rLWhlcmUgaXMgYVxuICAvLyBmaXJlLW9uY2Ugdmlld3BvcnQgbnVkZ2UsIE5PVCBhIGxlbnMgY2hhbmdlIOKAlCByZXVzaW5nIFwibGVucy5zZXRcIiBoZXJlXG4gIC8vIGNsb2JiZXJlZCB0aGUgc3VyZmFjZSdzIGxlbnMgc3RhdGUgYW5kIG5ldmVyIG1vdmVkIHRoZSB2aWV3cG9ydFxuICAvLyAocGxhbi1hbGlnbm1lbnQgcmV2aWV3IGZpbmRpbmcsIGZpbmFsaXplIGZsb3cpLlxuICBidXMuZW1pdChcImxvb2suaGVyZVwiLCB7IG5vZGVJZCB9KTtcbn1cblxuZXhwb3J0IHsgY2xlYXJMZW5zLCBsb29rSGVyZSwgc2V0TGVucyB9O1xuIiwKICAgICIvLyBQMyDigJQgYG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXWAgYmFja2luZzogZGVwdGgtYm91bmRlZCBCRlMgb3ZlclxuLy8gZWRnZXMgaW4gYm90aCBkaXJlY3Rpb25zIChlZGdlcyBhcmUgZGlyZWN0ZWQgY2xhaW1zOyBcIm5laWdoYm9yc1wiIG1lYW5zXG4vLyBhbnl0aGluZyBjb25uZWN0ZWQsIG5vdCBqdXN0IG91dGdvaW5nIHBlciBwbGFuLm1kKS4gU2tlbGV0b24tc2hhcGVkXG4vLyByZXNwb25zZSAoaWQvdGl0bGUvZWRnZSByZWFzb24pIOKAlCBubyBzeW5vcHNpcywgY29udGV4dC1idWRnZXRpbmcuXG5cbmltcG9ydCB0eXBlIHsgRGF0YWJhc2UgfSBmcm9tIFwiYnVuOnNxbGl0ZVwiO1xuXG5pbnRlcmZhY2UgTmVpZ2hib3JFZGdlUmVmIHtcbiAgZWRnZUlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGRpcmVjdGlvbjogXCJvdXRnb2luZ1wiIHwgXCJpbmNvbWluZ1wiO1xufVxuXG5pbnRlcmZhY2UgTmVpZ2hib3Ige1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXB0aDogbnVtYmVyO1xuICB2aWE6IE5laWdoYm9yRWRnZVJlZjtcbn1cblxuZnVuY3Rpb24gbmVpZ2hib3JzKGRiOiBEYXRhYmFzZSwgbm9kZUlkOiBzdHJpbmcsIGRlcHRoOiBudW1iZXIpOiBOZWlnaGJvcltdIHtcbiAgY29uc3QgYWxsRWRnZXMgPSBkYi5xdWVyeShcIlNFTEVDVCBpZCwgc291cmNlLCB0YXJnZXQsIGxhYmVsIEZST00gZWRnZXNcIikuYWxsKCkgYXMgQXJyYXk8e1xuICAgIGlkOiBzdHJpbmc7XG4gICAgc291cmNlOiBzdHJpbmc7XG4gICAgdGFyZ2V0OiBzdHJpbmc7XG4gICAgbGFiZWw6IHN0cmluZztcbiAgfT47XG4gIGNvbnN0IHRpdGxlQnlJZCA9IG5ldyBNYXAoXG4gICAgKGRiLnF1ZXJ5KFwiU0VMRUNUIGlkLCB0aXRsZSBGUk9NIG5vZGVzXCIpLmFsbCgpIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZyB9PikubWFwKFxuICAgICAgKG4pID0+IFtuLmlkLCBuLnRpdGxlXSxcbiAgICApLFxuICApO1xuXG4gIGNvbnN0IHZpc2l0ZWQgPSBuZXcgTWFwPHN0cmluZywgTmVpZ2hib3I+KCk7XG4gIGxldCBmcm9udGllciA9IFtub2RlSWRdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldChbbm9kZUlkXSk7XG5cbiAgZm9yIChsZXQgZCA9IDE7IGQgPD0gZGVwdGg7IGQrKykge1xuICAgIGNvbnN0IG5leHQ6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBjdXJyZW50IG9mIGZyb250aWVyKSB7XG4gICAgICBmb3IgKGNvbnN0IGVkZ2Ugb2YgYWxsRWRnZXMpIHtcbiAgICAgICAgbGV0IG5laWdoYm9ySWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgICBsZXQgZGlyZWN0aW9uOiBcIm91dGdvaW5nXCIgfCBcImluY29taW5nXCIgfCBudWxsID0gbnVsbDtcbiAgICAgICAgaWYgKGVkZ2Uuc291cmNlID09PSBjdXJyZW50KSB7XG4gICAgICAgICAgbmVpZ2hib3JJZCA9IGVkZ2UudGFyZ2V0O1xuICAgICAgICAgIGRpcmVjdGlvbiA9IFwib3V0Z29pbmdcIjtcbiAgICAgICAgfSBlbHNlIGlmIChlZGdlLnRhcmdldCA9PT0gY3VycmVudCkge1xuICAgICAgICAgIG5laWdoYm9ySWQgPSBlZGdlLnNvdXJjZTtcbiAgICAgICAgICBkaXJlY3Rpb24gPSBcImluY29taW5nXCI7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFuZWlnaGJvcklkIHx8IHNlZW4uaGFzKG5laWdoYm9ySWQpKSBjb250aW51ZTtcbiAgICAgICAgc2Vlbi5hZGQobmVpZ2hib3JJZCk7XG4gICAgICAgIG5leHQucHVzaChuZWlnaGJvcklkKTtcbiAgICAgICAgdmlzaXRlZC5zZXQobmVpZ2hib3JJZCwge1xuICAgICAgICAgIGlkOiBuZWlnaGJvcklkLFxuICAgICAgICAgIHRpdGxlOiB0aXRsZUJ5SWQuZ2V0KG5laWdoYm9ySWQpID8/IG5laWdoYm9ySWQsXG4gICAgICAgICAgZGVwdGg6IGQsXG4gICAgICAgICAgdmlhOiB7XG4gICAgICAgICAgICBlZGdlSWQ6IGVkZ2UuaWQsXG4gICAgICAgICAgICBsYWJlbDogZWRnZS5sYWJlbCxcbiAgICAgICAgICAgIGRpcmVjdGlvbjogZGlyZWN0aW9uIGFzIFwib3V0Z29pbmdcIiB8IFwiaW5jb21pbmdcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgZnJvbnRpZXIgPSBuZXh0O1xuICB9XG5cbiAgcmV0dXJuIFsuLi52aXNpdGVkLnZhbHVlcygpXTtcbn1cblxuZXhwb3J0IHR5cGUgeyBOZWlnaGJvciwgTmVpZ2hib3JFZGdlUmVmIH07XG5leHBvcnQgeyBuZWlnaGJvcnMgfTtcbiIsCiAgICAiLy8gUDIg4oCUIGBwcm9wb3NlLW5vZGVgL2Bwcm9wb3NlLWVkZ2VgIENMSSB2ZXJiIGJhY2tpbmcuIEluc2VydHMgYSBwZW5kaW5nXG4vLyBwcm9wb3NhbHMgcm93LCBlbWl0cyBwcm9wb3NhbC5hZGRlZC4gVGhlIGRyYWZ0IGlzIG9wYXF1ZSBKU09OIHRvIHRoZVxuLy8gZGFlbW9uIOKAlCBpdCBkb2Vzbid0IHZhbGlkYXRlIHRoZSBhZ2VudCdzIGV4dHJhY3Rpb24sIG9ubHkgc3RvcmVzIGl0XG4vLyAoZHVtYiBkYWVtb24sIENsYWltIEEpLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcbmltcG9ydCB7IFNMVUdfUkUgfSBmcm9tIFwiLi9wcm9qZWN0LnRzXCI7XG5pbXBvcnQgdHlwZSB7IFByb3Bvc2FsIH0gZnJvbSBcIi4vc3RhdGUudHNcIjtcbmltcG9ydCB7IHBhcnNlVGFncyB9IGZyb20gXCIuL3RhZ3MudHNcIjtcblxuaW50ZXJmYWNlIFByb3Bvc2VJbnB1dCB7XG4gIGRyYWZ0OiB1bmtub3duO1xuICAvLyBDbGFpbSBFOiBldmlkZW5jZSBncm91bmRzIGluIEVJVEhFUiBhIGRvYyBvciBhIGNvbnZlcnNhdGlvbiBtZXNzYWdlLFxuICAvLyBuZXZlciBib3RoIOKAlCBtdXR1YWwgZXhjbHVzaW9uIGVuZm9yY2VkIGF0IGludGFrZS5cbiAgZXZpZGVuY2U6IHsgZG9jSWQ/OiBzdHJpbmc7IG1lc3NhZ2VJZD86IHN0cmluZzsgc3Bhbj86IHN0cmluZyB9O1xuICBzdWdnZXN0ZWRUaWVyPzogc3RyaW5nO1xuICAvLyBDbGFpbSBEOiB3aG8gc2tldGNoZWQgdGhpcyBwcm9wb3NhbC4gT21pdHRlZCDihpIgXCJhZ2VudFwiICh0aGUgaGlzdG9yaWNhbFxuICAvLyBkZWZhdWx0IOKAlCBldmVyeSBwcmUtYXV0aG9yIHJvdyB3YXMgYW4gYWdlbnQgcHJvcG9zYWwpLlxuICBhdXRob3I/OiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAgLy8gUm91bmQgMyAoQ2xhaW0gWjEpOiBzdGFnZSB0aGlzIHByb3Bvc2FsIGluIGEgem9uZS4gT21pdHRlZCDihpIgbWFpbiBxdWV1ZVxuICAvLyAoem9uZV9pZCBudWxsKS4gTXVzdCBuYW1lIGFuIGV4aXN0aW5nIHpvbmUg4oCUIGEgZGFuZ2xpbmcgem9uZV9pZCB3b3VsZFxuICAvLyBvcnBoYW4gdGhlIHByb3Bvc2FsIG91dCBvZiBldmVyeSB2aWV3LlxuICB6b25lPzogc3RyaW5nO1xuICAvLyBSb3VuZCA3IChUQUdTKTogZnJlZWZvcm0gdGFncyB0byBhdHRhY2ggYXQgcHJvcG9zZSB0aW1lIOKAlCB3cml0dGVuIHRvIHRoZVxuICAvLyB0YXJnZXQta2V5ZWQgbm9kZV90YWdzIHJvdyBrZXllZCBieSB0aGlzIHByb3Bvc2FsJ3MgaWQgKHNvIHRoZXkgY2FycnlcbiAgLy8gcHJlLXJhdGlmeSBhbmQgcmUtaG9tZSBvbiByYXRpZnkpLiBPbWl0dGVkIOKGkiBubyB0YWdzLlxuICB0YWdzPzogc3RyaW5nW107XG4gIC8vIFJvdW5kIDEyIChTRUFNIDEpOiB0aGUgc3RhZ2luZyBBQ1QgdGhpcyBwcm9wb3NhbCBiZWxvbmdzIHRvLiBgL3Byb3Bvc2Fscy9cbiAgLy8gYmF0Y2hgIE1JTlRTIG9uZSBwZXIgY2FsbDsgYSBzaW5nbGUgcHJvcG9zZSB0YWtlcyBvbmUgb25seSB3aGVuIHRoZSBjYWxsZXJcbiAgLy8gc3VwcGxpZXMgaXQgKGpvaW5pbmcgYSBiYXRjaCBpdCBpcyByZXBhaXJpbmcpLiBPbWl0dGVkIOKGkiBudWxsID0gdW5iYXRjaGVkLFxuICAvLyB3aGljaCBpcyB0aGUgaG9uZXN0IGFuc3dlciBmb3IgYSBsb25lIHByb3Bvc2FsLlxuICBiYXRjaElkPzogc3RyaW5nO1xufVxuXG4vLyDilIDilIAgUm91bmQgMTIgwrcgU0VBTSAyIOKAlCBlZGdlIGVuZHBvaW50cyBieSBUSVRMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBGNS4yOiBhbiBlZGdlIHRvIGFuIEFMUkVBRFktUkFUSUZJRUQgbm9kZSBuZWVkcyBpdHMgdXVpZCwgc28gdGhlIGFnZW50XG4vLyBmZXRjaGVkIC9zdGF0ZSwgYnVpbHQgYSB0aXRsZeKGkmlkIG1hcCwgYW5kIGdlbmVyYXRlZCB0aGUgYmF0Y2ggdGhyb3VnaCBhXG4vLyBiZXNwb2tlIHNjcmlwdCDigJQgZm91ciB0aW1lcyBpbiBvbmUgZHJpdmUsIGFuZCB0aGUgc2Vjb25kIHRpbWUgaXMgd2hlcmUgdGhlXG4vLyBlZGdlcyBnb3QgZHJvcHBlZC4gQSBgdGl0bGU6PGV4YWN0IHRpdGxlPmAgZW5kcG9pbnQgZGVsZXRlcyB0aGF0IHdob2xlXG4vLyBjYXRlZ29yeSBvZiBzY3JpcHRpbmcuXG4vL1xuLy8gVGhlIHByZWZpeCBjYW4gTkVWRVIgY29sbGlkZSB3aXRoIGEgcmVhbCBlbmRwb2ludDogbm9kZSBpZHMgYW5kIHByb3Bvc2FsIGlkc1xuLy8gYXJlIFVVSURzLCB3aGljaCBjb250YWluIG5vIFwiOlwiIOKAlCBhbmQgdGhlIHByZWZpeGVkLXJlZiBncmFtbWFyIGlzIGFscmVhZHkgdGhlXG4vLyBob3VzZSBpZGlvbSAobWVzc2FnZS5ncm91bmQncyBgZG9jOjxpZD5gKS5cbi8vXG4vLyBSZXNvbHV0aW9uIGhhcHBlbnMgYXQgSU5UQUtFIChoZXJlLCBpbiB0aGUgc2hhcmVkIGJ1aWxkIHN0ZXAsIHNvIHRoZSBzaW5nbGVcbi8vIGAvcHJvcG9zYWxzYCBlZGdlIHBhdGggYW5kIGAvcHJvcG9zYWxzL2JhdGNoYCBnZXQgaXQgZnJvbSBPTkUgc2l0ZSkgYW5kIHRoZVxuLy8gUkVTT0xWRUQgaWQgaXMgd2hhdCBnZXRzIHN0b3JlZC4gVHdvIHJlYXNvbnM6IChhKSB0aGUgZXJyb3IgbGFuZHMgaW4gdGhlIHNhbWVcbi8vIHR1cm4gYXMgdGhlIG1pc3Rha2UgaW5zdGVhZCBvZiBhdCB0aGUgaHVtYW4ncyBydWxpbmcgYWN0IOKAlCB0aGUgZWRnZURyYWZ0V2FybmluZ1xuLy8gbGVzc29uLCB3aGljaCBuYW1lZCBcInRocmVlIHZlcmJzIGZyb20gdGhlIG1pc3Rha2VcIiBhcyB0aGUgd29yc3Qgb3V0Y29tZTsgYW5kXG4vLyAoYikgdGhlIHN0b3JlZCBkcmFmdCB0aGVuIGhvbGRzIGEgcmVhbCBpZCwgc28gYSBsYXRlciByZXRpdGxlIGNhbid0IHNpbGVudGx5XG4vLyByZS1wb2ludCBhIHBlbmRpbmcgZWRnZS4gUmF0aWZ5IGtlZXBzIGV4YWN0bHkgT05FIHJlc29sdXRpb24gdm9jYWJ1bGFyeVxuLy8gKGlkcy9wcm9wb3NhbCBpZHMpIOKAlCBhIHNlY29uZCBgdGl0bGU6YCBzaXRlIHRoZXJlIHdvdWxkIGJlIHR3byB2b2NhYnVsYXJpZXNcbi8vIGZyZWUgdG8gZHJpZnQuXG5jb25zdCBUSVRMRV9SRUZfUFJFRklYID0gXCJ0aXRsZTpcIjtcblxuZnVuY3Rpb24gaXNUaXRsZVJlZihyZWY6IHVua25vd24pOiByZWYgaXMgc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiByZWYgPT09IFwic3RyaW5nXCIgJiYgcmVmLnN0YXJ0c1dpdGgoVElUTEVfUkVGX1BSRUZJWCk7XG59XG5cbi8vIEVYQUNULCBjYXNlLXNlbnNpdGl2ZSwgUkFUSUZJRUQgTk9ERVMgT05MWS4gQW1iaWd1aXR5IGlzIGFuIGVycm9yIHRoYXQgTkFNRVNcbi8vIHRoZSBjYW5kaWRhdGVzICh0aGUgXCJyYXRpZnkgbm9kZSBwcm9wb3NhbCA8aWQ+IGZpcnN0XCIgbW9kZWwg4oCUIHRoZSBiZXN0IGVycm9yXG4vLyBpbiB0aGUgc3lzdGVtIHBlciBkcml2ZSAjMTApLCBuZXZlciBhIHNpbGVudCBmaXJzdC1tYXRjaC4gRnV6enkgbG9va3VwIGlzXG4vLyBgc2VhcmNoYCdzIGpvYiBhbmQgYWx3YXlzIHdhczsgdGhpcyBpcyBhIHJlZmVyZW5jZSBzeW50YXgsIG5vdCBhIHNlYXJjaC5cbmZ1bmN0aW9uIHJlc29sdmVUaXRsZVJlZihkYjogRGF0YWJhc2UsIHJlZjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdGl0bGUgPSByZWYuc2xpY2UoVElUTEVfUkVGX1BSRUZJWC5sZW5ndGgpO1xuICBpZiAodGl0bGUgPT09IFwiXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAnZW1wdHkgdGl0bGUgcmVmZXJlbmNlIOKAlCBleHBlY3RlZCBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIChleGFjdCwgY2FzZS1zZW5zaXRpdmUsIHJhdGlmaWVkIG5vZGVzIG9ubHkpJyxcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvd3MgPSBkYi5xdWVyeShcIlNFTEVDVCBpZCBGUk9NIG5vZGVzIFdIRVJFIHRpdGxlID0gP1wiKS5hbGwodGl0bGUpIGFzIEFycmF5PHsgaWQ6IHN0cmluZyB9PjtcbiAgaWYgKHJvd3MubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYG5vIHJhdGlmaWVkIG5vZGUgaXMgdGl0bGVkIFwiJHt0aXRsZX1cIiDigJQgdGl0bGUgcmVmcyBtYXRjaCBFWEFDVExZIChjYXNlLXNlbnNpdGl2ZSkgYW5kIHJlc29sdmUgYWdhaW5zdCByYXRpZmllZCBub2RlcyBPTkxZLCBuZXZlciBwZW5kaW5nIHByb3Bvc2FscyAobmFtZSB0aG9zZSBieSBsb2NhbCByZWYgb3IgcHJvcG9zYWwgaWQpOyB1c2UgXFxgc2VhcmNoXFxgIHRvIGZpbmQgdGhlIG5vZGUsIG9yIHBhc3MgaXRzIGlkYCxcbiAgICApO1xuICB9XG4gIGlmIChyb3dzLmxlbmd0aCA+IDEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgdGl0bGUgXCIke3RpdGxlfVwiIG1hdGNoZXMgJHtyb3dzLmxlbmd0aH0gbm9kZXM6ICR7cm93cy5tYXAoKHIpID0+IHIuaWQpLmpvaW4oXCIsIFwiKX0g4oCUIHRpdGxlcyBhcmUgbm90IHVuaXF1ZTsgcGFzcyBvbmUgb2YgdGhvc2UgaWRzIGluc3RlYWRgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIChyb3dzWzBdIGFzIHsgaWQ6IHN0cmluZyB9KS5pZDtcbn1cblxuLy8gUmV3cml0ZSBhbiBlZGdlIGRyYWZ0J3Mgc291cmNlL3RhcmdldCB3aGVuIChhbmQgb25seSB3aGVuKSB0aGV5IGFyZSB0aXRsZVxuLy8gcmVmcy4gUmV0dXJucyB0aGUgZHJhZnQgVU5UT1VDSEVEIG90aGVyd2lzZSwgc28gYSBkcmFmdCB3aXRoIG5vIHRpdGxlIHJlZiBpc1xuLy8gc3RvcmVkIGJ5dGUtaWRlbnRpY2FsbHkgdG8gcHJlLVIxMiAob3BhY2l0eSBpcyB1bmNoYW5nZWQgZm9yIGV2ZXJ5IGtleSB0aGVcbi8vIGRhZW1vbiBkb2Vzbid0IGFscmVhZHkgcmVhZCDigJQgcmF0aWZ5IGhhcyBhbHdheXMgcmVhZCBzb3VyY2UvdGFyZ2V0LCB3aGljaCBpc1xuLy8gZXhhY3RseSB3aGF0IGVkZ2VEcmFmdFdhcm5pbmcgYWR2aXNlcyBhYm91dCkuXG5mdW5jdGlvbiByZXNvbHZlRWRnZVRpdGxlUmVmcyhkYjogRGF0YWJhc2UsIGRyYWZ0OiB1bmtub3duKTogdW5rbm93biB7XG4gIGlmIChkcmFmdCA9PT0gbnVsbCB8fCB0eXBlb2YgZHJhZnQgIT09IFwib2JqZWN0XCIpIHJldHVybiBkcmFmdDtcbiAgY29uc3QgZCA9IGRyYWZ0IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAoIWlzVGl0bGVSZWYoZC5zb3VyY2UpICYmICFpc1RpdGxlUmVmKGQudGFyZ2V0KSkgcmV0dXJuIGRyYWZ0O1xuICByZXR1cm4ge1xuICAgIC4uLmQsXG4gICAgLi4uKGlzVGl0bGVSZWYoZC5zb3VyY2UpID8geyBzb3VyY2U6IHJlc29sdmVUaXRsZVJlZihkYiwgZC5zb3VyY2UpIH0gOiB7fSksXG4gICAgLi4uKGlzVGl0bGVSZWYoZC50YXJnZXQpID8geyB0YXJnZXQ6IHJlc29sdmVUaXRsZVJlZihkYiwgZC50YXJnZXQpIH0gOiB7fSksXG4gIH07XG59XG5cbi8vIFJvdW5kIDUgKENMSTEpOiB2YWxpZGF0ZSArIGNvbXB1dGUgdGhlIHJvdyBhbmQgdGhlIHdpcmUgb2JqZWN0LCBidXQgZG8gTk9UXG4vLyBpbnNlcnQgb3IgZW1pdCDigJQgdGhlIHNpbmdsZS1wcm9wb3NlIHBhdGggaW5zZXJ0cytlbWl0cyBpbW1lZGlhdGVseSwgdGhlXG4vLyBiYXRjaCBwYXRoIGRlZmVycyBib3RoIChhbGwgaW5zZXJ0cyBpbnNpZGUgT05FIGRiLnRyYW5zYWN0aW9uKCksIGFsbCBlbWl0c1xuLy8gQUZURVIgY29tbWl0IHNvIGEgcm9sbGJhY2sgbGVha3Mgbm8gcHJvcG9zYWwuYWRkZWQpLiBTcGxpdHRpbmcgaGVyZSBpcyB3aGF0XG4vLyBsZXRzIGJvdGggcGF0aHMgc2hhcmUgb25lIGludGFrZSBjb250cmFjdCB3aXRob3V0IHRoZSBiYXRjaCBzbXVnZ2xpbmcgYVxuLy8gbWlkLXRyYW5zYWN0aW9uIGVtaXQuXG5mdW5jdGlvbiBidWlsZFByb3Bvc2FsKFxuICBkYjogRGF0YWJhc2UsXG4gIGtpbmQ6IFwibm9kZVwiIHwgXCJlZGdlXCIsXG4gIGlucHV0OiBQcm9wb3NlSW5wdXQsXG4pOiB7IHByb3Bvc2FsOiBQcm9wb3NhbDsgaW5zZXJ0OiAoKSA9PiB2b2lkIH0ge1xuICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gIC8vIFRoZSBkcmFmdCBzdGF5cyBPUEFRVUUgKENsYWltIEEpIGJ1dCBub3QgQUJTRU5UIOKAlCBhIG1pc3NpbmcgZHJhZnQgdXNlZFxuICAvLyB0byBzdXJmYWNlIGFzIGEgcmF3IFwiTk9UIE5VTEwgY29uc3RyYWludCBmYWlsZWQ6IHByb3Bvc2Fscy5kcmFmdF9qc29uXCI7XG4gIC8vIG5hbWUgdGhlIGV4cGVjdGVkIHNoYXBlIGF0IGludGFrZSBpbnN0ZWFkLlxuICBpZiAoaW5wdXQuZHJhZnQgPT09IHVuZGVmaW5lZCB8fCBpbnB1dC5kcmFmdCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICdwcm9wb3NlIHJlcXVpcmVzIGEgZHJhZnQg4oCUIGV4cGVjdGVkIHtcImRyYWZ0XCI6IHt0aXRsZSwgc3lub3BzaXMsIC4uLn0sIFwiZXZpZGVuY2VcIjoge2RvY0lkfG1lc3NhZ2VJZCwgc3Bhbn0sIFwic3VnZ2VzdGVkVGllclwiP30nLFxuICAgICk7XG4gIH1cbiAgLy8gU0VBTSAyOiByZXNvbHZlIGB0aXRsZTo8Li4uPmAgZW5kcG9pbnRzIE5PVyAocHVyZSByZWFkICsgdGhyb3csIGJlZm9yZSBhbnlcbiAgLy8gd3JpdGUpIHNvIHRoZSBzdG9yZWQgZHJhZnQgY2FycmllcyByZWFsIGlkcyBhbmQgdGhlIGNhbGxlciBzZWVzIHRoZW0gaW4gdGhlXG4gIC8vIHJlc3BvbnNlIGl0IGFscmVhZHkgcmVhZHMuXG4gIGNvbnN0IGRyYWZ0ID0ga2luZCA9PT0gXCJlZGdlXCIgPyByZXNvbHZlRWRnZVRpdGxlUmVmcyhkYiwgaW5wdXQuZHJhZnQpIDogaW5wdXQuZHJhZnQ7XG4gIGNvbnN0IGRyYWZ0SnNvbiA9IEpTT04uc3RyaW5naWZ5KGRyYWZ0KTtcbiAgLy8gVGhlIGRyYWZ0IHN0YXlzIG9wYXF1ZSAoQ2xhaW0gQSksIGJ1dCBldmlkZW5jZS5kb2NJZCBiZWNvbWVzIGEgZmlsZXN5c3RlbVxuICAvLyBwYXRoIGNvbXBvbmVudCBhdCByYXRpZnkgdGltZSDigJQgcmVqZWN0IG5vbi1zbHVnIGlkcyBhdCBpbnRha2Ugc28gYSBiYWRcbiAgLy8gb25lIGZhaWxzIGxvdWQgaGVyZSwgbm90IGFzIGEgZmlsZSB3cml0ZSBsYXRlci4gU0xVR19SRSBndWFyZHMgZG9jSWRcbiAgLy8gT05MWTogYSBtZXNzYWdlSWQgaXMgYSBVVUlEIHRoYXQgbmV2ZXIgdG91Y2hlcyB0aGUgZmlsZXN5c3RlbS5cbiAgaWYgKGlucHV0LmV2aWRlbmNlLmRvY0lkICE9PSB1bmRlZmluZWQgJiYgaW5wdXQuZXZpZGVuY2UubWVzc2FnZUlkICE9PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJldmlkZW5jZSBtdXN0IGdyb3VuZCBpbiBhIGRvYyBPUiBhIG1lc3NhZ2UsIG5vdCBib3RoXCIpO1xuICB9XG4gIGlmIChpbnB1dC5ldmlkZW5jZS5kb2NJZCAhPT0gdW5kZWZpbmVkICYmICFTTFVHX1JFLnRlc3QoaW5wdXQuZXZpZGVuY2UuZG9jSWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBldmlkZW5jZS5kb2NJZCBpcyBub3QgYSB2YWxpZCBkb2Mgc2x1ZzogJHtpbnB1dC5ldmlkZW5jZS5kb2NJZH1gKTtcbiAgfVxuICAvLyBBIGRhbmdsaW5nIG1lc3NhZ2UgcmVmZXJlbmNlIHdvdWxkIG1ha2UgdGhlIHByb3Bvc2FsIHVuLW5hdmlnYWJsZSB0aGVcbiAgLy8gbW9tZW50IGl0IHJlbmRlcnMg4oCUIGZhaWwgbG91ZCBhdCBpbnRha2UsIG5vdCBhdCBzdXJmYWNlIGNsaWNrIHRpbWUuXG4gIGlmIChpbnB1dC5ldmlkZW5jZS5tZXNzYWdlSWQgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGV4aXN0cyA9IGRiXG4gICAgICAucXVlcnkoXCJTRUxFQ1QgMSBGUk9NIG1lc3NhZ2VzIFdIRVJFIGlkID0gP1wiKVxuICAgICAgLmdldChpbnB1dC5ldmlkZW5jZS5tZXNzYWdlSWQpIGFzIHVua25vd247XG4gICAgaWYgKGV4aXN0cyA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBldmlkZW5jZS5tZXNzYWdlSWQgZG9lcyBub3QgZXhpc3Q6ICR7aW5wdXQuZXZpZGVuY2UubWVzc2FnZUlkfWApO1xuICAgIH1cbiAgfVxuICBpZiAoaW5wdXQuYXV0aG9yICE9PSB1bmRlZmluZWQgJiYgaW5wdXQuYXV0aG9yICE9PSBcInVzZXJcIiAmJiBpbnB1dC5hdXRob3IgIT09IFwiYWdlbnRcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgYXV0aG9yIG11c3QgYmUgdXNlciBvciBhZ2VudCwgZ290OiAke1N0cmluZyhpbnB1dC5hdXRob3IpfWApO1xuICB9XG4gIC8vIFpvbmUgaW50YWtlIGd1YXJkIChSb3VuZCAzKTogc2FtZSBmYWlsLWxvdWQtYXQtaW50YWtlIHNwaXJpdCBhcyBkb2NJZCDigJRcbiAgLy8gYW4gdW5rbm93biB6b25lIGlzIGEgdXNhZ2UgZXJyb3IgaGVyZSwgbmV2ZXIgYSBkYW5nbGluZyByb3cgbGF0ZXIuXG4gIGlmIChpbnB1dC56b25lICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIVNMVUdfUkUudGVzdChpbnB1dC56b25lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB6b25lIGlzIG5vdCBhIHZhbGlkIHpvbmUgc2x1ZzogJHtpbnB1dC56b25lfWApO1xuICAgIH1cbiAgICBpZiAoIWRiLnF1ZXJ5KFwiU0VMRUNUIDEgRlJPTSB6b25lcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlucHV0LnpvbmUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gem9uZTogJHtpbnB1dC56b25lfWApO1xuICAgIH1cbiAgfVxuICAvLyBUQUdTOiB2YWxpZGF0ZSBoZXJlIChwdXJlIOKAlCB0aGUgcGFyc2UgZ3VhcmQgdGhyb3dzIGJlZm9yZSBhbnkgd3JpdGUpLCBzbyBhXG4gIC8vIGJhZCBzaGFwZSBmYWlscyBpbnRha2UsIG5vdCBtaWQtdHJhbnNhY3Rpb24uIEVtcHR5L2Fic2VudCDihpIgbm8gcm93LlxuICBjb25zdCB0YWdzID0gaW5wdXQudGFncyAhPT0gdW5kZWZpbmVkID8gcGFyc2VUYWdzKGlucHV0LnRhZ3MpIDogW107XG4gIGNvbnN0IHRhZ3NKc29uID0gdGFncy5sZW5ndGggPiAwID8gSlNPTi5zdHJpbmdpZnkodGFncykgOiBudWxsO1xuXG4gIGNvbnN0IGV2aWRlbmNlRG9jSWQgPSBpbnB1dC5ldmlkZW5jZS5kb2NJZCA/PyBudWxsO1xuICBjb25zdCBldmlkZW5jZU1lc3NhZ2VJZCA9IGlucHV0LmV2aWRlbmNlLm1lc3NhZ2VJZCA/PyBudWxsO1xuICBjb25zdCBldmlkZW5jZVNwYW4gPSBpbnB1dC5ldmlkZW5jZS5zcGFuID8/IG51bGw7XG4gIGNvbnN0IHN1Z2dlc3RlZFRpZXIgPSBpbnB1dC5zdWdnZXN0ZWRUaWVyID8/IG51bGw7XG4gIC8vIFdyaXR0ZW4gZXhwbGljaXRseSBvbiBldmVyeSBORVcgcm93IOKAlCB0aGUgY29sdW1uIHN0YXlzIG51bGxhYmxlIG9ubHkgc29cbiAgLy8gdGhlIGZyZXNoLWluc3RhbGwgc2hhcGUgZXF1YWxzIHRoZSBtaWdyYXRlZCBzaGFwZSAoQ2xhaW0gRCk7IHRoZSB3aXJlXG4gIC8vIG5ldmVyIGNhcnJpZXMgbnVsbCAocmVhZFN0YXRlIG5vcm1hbGl6ZXMgcHJlLWNvbHVtbiByb3dzKS5cbiAgY29uc3QgYXV0aG9yID0gaW5wdXQuYXV0aG9yID8/IFwiYWdlbnRcIjtcbiAgY29uc3Qgem9uZUlkID0gaW5wdXQuem9uZSA/PyBudWxsO1xuICAvLyBTRUFNIDE6IHRoZSBkYWVtb24gZG9lcyBOT1QgbWludCBvbmUgaGVyZSDigJQgbWludGluZyBpcyB0aGUgQkFUQ0ggcm91dGUnc1xuICAvLyBhY3QgKGEgYmF0Y2ggaXMgYSBjYWxsLCBhbmQgb25seSB0aGUgY2FsbCBrbm93cyBpdHMgb3duIGV4dGVudCkuIEEgc2luZ2xlXG4gIC8vIHByb3Bvc2UgaXMgdW5iYXRjaGVkIHVubGVzcyB0aGUgY2FsbGVyIG5hbWVzIHRoZSBhY3QgaXQgYmVsb25ncyB0by5cbiAgaWYgKGlucHV0LmJhdGNoSWQgIT09IHVuZGVmaW5lZCAmJiAodHlwZW9mIGlucHV0LmJhdGNoSWQgIT09IFwic3RyaW5nXCIgfHwgaW5wdXQuYmF0Y2hJZCA9PT0gXCJcIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgYmF0Y2hJZCBtdXN0IGJlIGEgbm9uLWVtcHR5IHN0cmluZyAodGhlIGlkIHJldHVybmVkIGJ5IFxcYHByb3Bvc2UtYmF0Y2hcXGApLCBnb3Q6ICR7SlNPTi5zdHJpbmdpZnkoaW5wdXQuYmF0Y2hJZCl9YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGJhdGNoSWQgPSBpbnB1dC5iYXRjaElkID8/IG51bGw7XG5cbiAgLy8gcHJvcG9zZSBlbWl0cyB0aGUgRlVMTCBwcm9wb3NhbCBvYmplY3QsIHNvIHByb3Bvc2FsLmFkZGVkIGNhcnJpZXMgem9uZUlkXG4gIC8vIGZvciBmcmVlIOKAlCBwYXlsb2FkLXRhZ2dpbmcgaXMgdGhlIG1lY2hhbmlzbSAoZXZlbnRzIGFyZSBwcm9qZWN0LXNjb3BlZFxuICAvLyBhbmQgY2FuIG5ldmVyIGJlIHpvbmUtc2NvcGVkOyBjb25zdW1lcnMgZmlsdGVyIGJ5IHRoZSB0YWcpLlxuICBjb25zdCBwcm9wb3NhbDogUHJvcG9zYWwgPSB7XG4gICAgaWQsXG4gICAga2luZCxcbiAgICBkcmFmdCxcbiAgICBldmlkZW5jZTogeyBkb2NJZDogZXZpZGVuY2VEb2NJZCwgbWVzc2FnZUlkOiBldmlkZW5jZU1lc3NhZ2VJZCwgc3BhbjogZXZpZGVuY2VTcGFuIH0sXG4gICAgc3VnZ2VzdGVkVGllcixcbiAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgIHJlc3VsdE5vZGVJZDogbnVsbCxcbiAgICBhdXRob3IsXG4gICAgem9uZUlkLFxuICAgIGJhdGNoSWQsXG4gICAgLi4uKHRhZ3MubGVuZ3RoID4gMCA/IHsgdGFncyB9IDoge30pLFxuICB9O1xuICBjb25zdCBpbnNlcnQgPSAoKSA9PiB7XG4gICAgZGIucnVuKFxuICAgICAgXCJJTlNFUlQgSU5UTyBwcm9wb3NhbHMgKGlkLCBraW5kLCBkcmFmdF9qc29uLCBldmlkZW5jZV9kb2NfaWQsIGV2aWRlbmNlX21lc3NhZ2VfaWQsIGV2aWRlbmNlX3NwYW4sIHN1Z2dlc3RlZF90aWVyLCBzdGF0dXMsIGF1dGhvciwgem9uZV9pZCwgYmF0Y2hfaWQpIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgJ3BlbmRpbmcnLCA/LCA/LCA/KVwiLFxuICAgICAgW1xuICAgICAgICBpZCxcbiAgICAgICAga2luZCxcbiAgICAgICAgZHJhZnRKc29uLFxuICAgICAgICBldmlkZW5jZURvY0lkLFxuICAgICAgICBldmlkZW5jZU1lc3NhZ2VJZCxcbiAgICAgICAgZXZpZGVuY2VTcGFuLFxuICAgICAgICBzdWdnZXN0ZWRUaWVyLFxuICAgICAgICBhdXRob3IsXG4gICAgICAgIHpvbmVJZCxcbiAgICAgICAgYmF0Y2hJZCxcbiAgICAgIF0sXG4gICAgKTtcbiAgICAvLyBUQUdTOiB0aGUgdGFyZ2V0LWtleWVkIHJvdyByaWRlcyB0aGUgU0FNRSBpbnNlcnQgY2xvc3VyZSAoc28gYSBiYXRjaFxuICAgIC8vIHdyaXRlcyBpdCBpbnNpZGUgdGhlIG9uZSBkYi50cmFuc2FjdGlvbigpIOKAlCBhdG9taWMgd2l0aCB0aGUgcHJvcG9zYWwpLlxuICAgIGlmICh0YWdzSnNvbiAhPT0gbnVsbCkge1xuICAgICAgZGIucnVuKFwiSU5TRVJUIElOVE8gbm9kZV90YWdzICh0YXJnZXRfaWQsIHRhZ3NfanNvbikgVkFMVUVTICg/LCA/KVwiLCBbaWQsIHRhZ3NKc29uXSk7XG4gICAgfVxuICB9O1xuICByZXR1cm4geyBwcm9wb3NhbCwgaW5zZXJ0IH07XG59XG5cbmZ1bmN0aW9uIGluc2VydFByb3Bvc2FsKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGtpbmQ6IFwibm9kZVwiIHwgXCJlZGdlXCIsXG4gIGlucHV0OiBQcm9wb3NlSW5wdXQsXG4pOiBQcm9wb3NhbCB7XG4gIGNvbnN0IHsgcHJvcG9zYWwsIGluc2VydCB9ID0gYnVpbGRQcm9wb3NhbChkYiwga2luZCwgaW5wdXQpO1xuICBpbnNlcnQoKTtcbiAgYnVzLmVtaXQoXCJwcm9wb3NhbC5hZGRlZFwiLCBwcm9wb3NhbCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIHByb3Bvc2FsO1xufVxuXG4vLyBSb3VuZCA1IChDTEkxKSDigJQgYmF0Y2ggcHJvcG9zZS4gTWludHMgYSBVVUlEIHBlciBub2RlLCByZWdpc3RlcnMgZWFjaCB1bmRlclxuLy8gaXRzIExPQ0FMIHJlZiAoYW4gb3BhcXVlIGF1dGhvci1jaG9zZW4gc3RyaW5nIGxpa2UgXCJuMVwiLCBuZXZlciBwZXJzaXN0ZWQg4oCUXG4vLyBkaXNqb2ludCBmcm9tIHRoZSBtaW50ZWQgVVVJRHMpLCB0aGVuIHJlc29sdmVzIGVhY2ggZWRnZSBlbmRwb2ludCB2aWFcbi8vIGByZWZUb0lkLmdldCh4KSA/PyB4YDogYSBsb2NhbCByZWYgYmVjb21lcyB0aGUgZnJlc2hseS1taW50ZWQgbm9kZSBpZCwgd2hpbGVcbi8vIGEgcmVhbCBub2RlL3Byb3Bvc2FsIGlkIChvciBhbiB1bnJlc29sdmFibGUgcmVmIOKAlCByYXRpZnkgb3ducyBkYW5nbGluZy1yZWZcbi8vIGVycm9ycykgcGFzc2VzIHRocm91Z2ggdW5jaGFuZ2VkLiBPcGFjaXR5IGhvbGRzOiBhIG1pc3NpbmcgZW5kcG9pbnQga2V5XG4vLyBzdGF5cyBtaXNzaW5nIChzcHJlYWQgaW5qZWN0cyBgdW5kZWZpbmVkYCwgd2hpY2ggSlNPTi5zdHJpbmdpZnkgZHJvcHMpLCBzb1xuLy8gdGhlIHN0b3JlZCBlZGdlIGRyYWZ0IGlzIGJ5dGUtaWRlbnRpY2FsIHRvIGEgc2luZ2xlLXByb3Bvc2Ugb2YgdGhlIHNhbWVcbi8vIGRyYWZ0LiBBbGwgdmFsaWRhdGlvbiBydW5zIEJFRk9SRSB0aGUgdHJhbnNhY3Rpb24gKHB1cmUgcmVhZHMgKyB0aHJvd3MpLCBhbGxcbi8vIGluc2VydHMgcnVuIElOU0lERSBpdCwgYWxsIGVtaXRzIEFGVEVSIGNvbW1pdCDigJQgYSB0aHJvdyBhdCBhbnkgc3RhZ2UgbGVhdmVzXG4vLyB6ZXJvIHJvd3MgYW5kIGxlYWtzIHplcm8gZXZlbnRzLlxuaW50ZXJmYWNlIEJhdGNoTm9kZUlucHV0IHtcbiAgcmVmOiBzdHJpbmc7XG4gIGRyYWZ0OiB1bmtub3duO1xuICBzdWdnZXN0ZWRUaWVyPzogc3RyaW5nO1xuICBldmlkZW5jZT86IHsgZG9jSWQ/OiBzdHJpbmc7IG1lc3NhZ2VJZD86IHN0cmluZzsgc3Bhbj86IHN0cmluZyB9O1xuICBhdXRob3I/OiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAgLy8gUm91bmQgNyAoVEFHUyk6IGEgYmF0Y2hlZCBub2RlIG1heSBjYXJyeSBwcm9wb3NlLXRpbWUgdGFncyAod3JpdHRlbiB0byBpdHNcbiAgLy8gbm9kZV90YWdzIHJvdyBpbnNpZGUgdGhlIGJhdGNoJ3Mgb25lIHRyYW5zYWN0aW9uKS4gRWRnZXMgY2Fycnkgbm8gdGFnc1xuICAvLyAoYW4gZWRnZSBoYXMgbm8gdGFyZ2V0LWtleWVkIG1ldGFkYXRhIHRvIHJlLWhvbWUpLlxuICB0YWdzPzogc3RyaW5nW107XG59XG5pbnRlcmZhY2UgQmF0Y2hFZGdlSW5wdXQge1xuICBkcmFmdDogdW5rbm93bjtcbiAgc3VnZ2VzdGVkVGllcj86IHN0cmluZztcbiAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgYXV0aG9yPzogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG59XG5pbnRlcmZhY2UgQmF0Y2hJbnB1dCB7XG4gIG5vZGVzPzogQmF0Y2hOb2RlSW5wdXRbXTtcbiAgZWRnZXM/OiBCYXRjaEVkZ2VJbnB1dFtdO1xuICAvLyBSb3VuZCAxMiAoU0VBTSAxKTogb21pdCBhbmQgdGhlIGRhZW1vbiBNSU5UUyBvbmUgKHRoZSBub3JtYWwgcGF0aCDigJQgdGhlXG4gIC8vIGFnZW50IGdldHMgYSBxdWVyeWFibGUgYWN0IGZvciBmcmVlLCB3aXRoIHplcm8gYm9va2tlZXBpbmcsIHdoaWNoIGlzIHRoZVxuICAvLyB3aG9sZSBGNS4xIGFzaykuIFN1cHBseSBvbmUgdG8gRVhURU5EIGFuIGV4aXN0aW5nIGFjdCDigJQgdGhlIHJlcGFpciBjYXNlXG4gIC8vIGRyaXZlICMxMCBuZWVkZWQ6IFwiSSBmb3Jnb3QgdGhlIGVkZ2VzOyBhZGQgdGhlbSB0byB0aGF0IGJhdGNoLlwiXG4gIGJhdGNoSWQ/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIGJhdGNoUHJvcG9zZShcbiAgZGI6IERhdGFiYXNlLFxuICBidXM6IEV2ZW50QnVzLFxuICBpbnB1dDogQmF0Y2hJbnB1dCxcbik6IHsgYmF0Y2hJZDogc3RyaW5nOyByZWZUb0lkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+OyBwcm9wb3NhbHM6IFByb3Bvc2FsW10gfSB7XG4gIC8vIE1pbnRlZCBCRUZPUkUgYW55IGJ1aWxkIHNvIGV2ZXJ5IG1lbWJlciBvZiB0aGUgY2FsbCBjYXJyaWVzIHRoZSBzYW1lIGFjdCxcbiAgLy8gaW5jbHVkaW5nIGEgYmF0Y2ggb2Ygb25seSBlZGdlcy4gUmV1c2UgaXMgTk9UIHJlamVjdGVkOiBhIGNhbGxlciB0aGF0IG5hbWVzXG4gIC8vIGFuIGV4aXN0aW5nIGlkIG1lYW5zIFwic2FtZSBhY3RcIiwgYW5kIHRoZSBlbmdpbmUgZG9lcyBub3Qgb3duIHRoZSBhZ2VudCdzXG4gIC8vIGdyb3VwaW5nIHNlbWFudGljcyAodGhlIGR1bWItZGFlbW9uIGNsYXVzZSkuXG4gIGlmIChpbnB1dC5iYXRjaElkICE9PSB1bmRlZmluZWQgJiYgKHR5cGVvZiBpbnB1dC5iYXRjaElkICE9PSBcInN0cmluZ1wiIHx8IGlucHV0LmJhdGNoSWQgPT09IFwiXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYGJhdGNoSWQgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmcgKG9taXQgaXQgdG8gaGF2ZSBvbmUgbWludGVkKSwgZ290OiAke0pTT04uc3RyaW5naWZ5KGlucHV0LmJhdGNoSWQpfWAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBiYXRjaElkID0gaW5wdXQuYmF0Y2hJZCA/PyBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICBjb25zdCByZWZUb0lkID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZz4oKTtcbiAgY29uc3QgYnVpbHQ6IEFycmF5PHsgcHJvcG9zYWw6IFByb3Bvc2FsOyBpbnNlcnQ6ICgpID0+IHZvaWQgfT4gPSBbXTtcblxuICBmb3IgKGNvbnN0IG4gb2YgaW5wdXQubm9kZXMgPz8gW10pIHtcbiAgICBpZiAodHlwZW9mIG4ucmVmICE9PSBcInN0cmluZ1wiIHx8IG4ucmVmID09PSBcIlwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ2VhY2ggYmF0Y2ggbm9kZSBuZWVkcyBhIG5vbi1lbXB0eSBzdHJpbmcgXCJyZWZcIicpO1xuICAgIH1cbiAgICBpZiAocmVmVG9JZC5oYXMobi5yZWYpKSB0aHJvdyBuZXcgRXJyb3IoYGR1cGxpY2F0ZSBiYXRjaCBub2RlIHJlZjogJHtuLnJlZn1gKTtcbiAgICBjb25zdCBiID0gYnVpbGRQcm9wb3NhbChkYiwgXCJub2RlXCIsIHtcbiAgICAgIGRyYWZ0OiBuLmRyYWZ0LFxuICAgICAgZXZpZGVuY2U6IG4uZXZpZGVuY2UgPz8ge30sXG4gICAgICBzdWdnZXN0ZWRUaWVyOiBuLnN1Z2dlc3RlZFRpZXIsXG4gICAgICBhdXRob3I6IG4uYXV0aG9yLFxuICAgICAgdGFnczogbi50YWdzLFxuICAgICAgYmF0Y2hJZCxcbiAgICB9KTtcbiAgICByZWZUb0lkLnNldChuLnJlZiwgYi5wcm9wb3NhbC5pZCk7XG4gICAgYnVpbHQucHVzaChiKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgZSBvZiBpbnB1dC5lZGdlcyA/PyBbXSkge1xuICAgIC8vIFJlc29sdmUgbG9jYWwgcmVmcyBhZ2FpbnN0IHRoZSBqdXN0LW1pbnRlZCBub2RlIGlkczsga2VlcCB0aGUgZHJhZnRcbiAgICAvLyBvdGhlcndpc2Ugb3BhcXVlIChDb250cmFjdCA4KS5cbiAgICBsZXQgZHJhZnQgPSBlLmRyYWZ0O1xuICAgIGlmIChkcmFmdCAhPT0gbnVsbCAmJiB0eXBlb2YgZHJhZnQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgIGNvbnN0IGQgPSBkcmFmdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGRyYWZ0ID0ge1xuICAgICAgICAuLi5kLFxuICAgICAgICBzb3VyY2U6IHJlZlRvSWQuZ2V0KFN0cmluZyhkLnNvdXJjZSkpID8/IGQuc291cmNlLFxuICAgICAgICB0YXJnZXQ6IHJlZlRvSWQuZ2V0KFN0cmluZyhkLnRhcmdldCkpID8/IGQudGFyZ2V0LFxuICAgICAgfTtcbiAgICB9XG4gICAgYnVpbHQucHVzaChcbiAgICAgIGJ1aWxkUHJvcG9zYWwoZGIsIFwiZWRnZVwiLCB7XG4gICAgICAgIGRyYWZ0LFxuICAgICAgICBldmlkZW5jZTogZS5ldmlkZW5jZSA/PyB7fSxcbiAgICAgICAgc3VnZ2VzdGVkVGllcjogZS5zdWdnZXN0ZWRUaWVyLFxuICAgICAgICBhdXRob3I6IGUuYXV0aG9yLFxuICAgICAgICBiYXRjaElkLFxuICAgICAgfSksXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHJ1biA9IGRiLnRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICBmb3IgKGNvbnN0IGIgb2YgYnVpbHQpIGIuaW5zZXJ0KCk7XG4gIH0pO1xuICBydW4oKTtcbiAgLy8gQUZURVIgY29tbWl0IG9ubHkg4oCUIGEgcm9sbGJhY2sgbXVzdCBuZXZlciBsZWFrIGEgcHJvcG9zYWwuYWRkZWQuXG4gIGZvciAoY29uc3QgYiBvZiBidWlsdCkge1xuICAgIGJ1cy5lbWl0KFwicHJvcG9zYWwuYWRkZWRcIiwgYi5wcm9wb3NhbCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgfVxuICByZXR1cm4geyBiYXRjaElkLCByZWZUb0lkOiBPYmplY3QuZnJvbUVudHJpZXMocmVmVG9JZCksIHByb3Bvc2FsczogYnVpbHQubWFwKChiKSA9PiBiLnByb3Bvc2FsKSB9O1xufVxuXG4vLyBSMyBnYXRlIHJld29yayAoY2Fzc2FuZHJhJ3MgY29sZCBkcml2ZSk6IGFuIGVkZ2UgZHJhZnQgd2l0aCB0aGUgV1JPTkdcbi8vIGVuZHBvaW50IGtleXMgKGZyb20vdG8sIHNyYy9kc3TigKYpIHNhaWxzIHRocm91Z2ggb3BhcXVlIGludGFrZSwgYnlwYXNzZXNcbi8vIHByb21vdGUncyBlbmRwb2ludC1vcmRlciBndWFyZCAodW5rbm93biByZWZzIHBhc3MgYnkgZGVzaWduKSwgYW5kIG9ubHlcbi8vIGRpZXMgYXQgcmF0aWZ5IOKAlCB0aGUgd29yc3QgcG9zc2libGUgZGlzdGFuY2UgZnJvbSB0aGUgbWlzdGFrZS4gVGhpcyBpcyBhXG4vLyBXQVJOSU5HLCBuZXZlciBhIHJlamVjdDogZHJhZnQgb3BhY2l0eSBzdGF5cyBzYWNyZWQgKENvbnRyYWN0IDgpLCB0aGVcbi8vIGRhZW1vbiBqdXN0IG5hbWVzIHRoZSBtaXNzaW5nIGtleXMgbmV4dCB0byB0aGUgYWNjZXB0ZWQgcHJvcG9zYWwgc28gdGhlXG4vLyBjb2xkIGFnZW50IGhlYXJzIGFib3V0IGl0IGluIHRoZSBzYW1lIHR1cm4uXG5mdW5jdGlvbiBlZGdlRHJhZnRXYXJuaW5nKGRyYWZ0OiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChkcmFmdCA9PT0gbnVsbCB8fCB0eXBlb2YgZHJhZnQgIT09IFwib2JqZWN0XCIpIHtcbiAgICByZXR1cm4gJ2VkZ2UgZHJhZnQgaXMgbm90IGFuIG9iamVjdCDigJQgZXhwZWN0ZWQge1wic291cmNlXCI6IFwiPG5vZGUtb3ItcHJvcG9zYWwtaWQ+XCIsIFwidGFyZ2V0XCI6IFwiPG5vZGUtb3ItcHJvcG9zYWwtaWQ+XCIsIFwibGFiZWxcIjogXCIuLi5cIn07IHN0b3JlZCBhcy1pcyAob3BhcXVlIGludGFrZSksIGJ1dCByYXRpZnkgd2lsbCBmYWlsIG9uIGl0JztcbiAgfVxuICBjb25zdCBkID0gZHJhZnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGNvbnN0IG1pc3NpbmcgPSBbXCJzb3VyY2VcIiwgXCJ0YXJnZXRcIl0uZmlsdGVyKChrZXkpID0+IHR5cGVvZiBkW2tleV0gIT09IFwic3RyaW5nXCIpO1xuICBpZiAobWlzc2luZy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gYGVkZ2UgZHJhZnQgaGFzIG5vIHN0cmluZyAke21pc3Npbmcuam9pbihcIi9cIil9IGtleShzKSDigJQgZW5kcG9pbnRzIHJpZGUgXCJzb3VyY2VcIi9cInRhcmdldFwiIChub2RlIG9yIHBlbmRpbmcgbm9kZS1wcm9wb3NhbCBpZHMpOyBvdGhlciBrZXlzIGFyZSBOT1QgcmVqZWN0ZWQgKHRoZSBkcmFmdCBpcyBvcGFxdWUgdG8gdGhlIGRhZW1vbiksIGJ1dCByYXRpZnkgd2lsbCBmYWlsIHRvIHJlc29sdmUgdGhlIGVuZHBvaW50c2A7XG59XG5cbmZ1bmN0aW9uIHByb3Bvc2VOb2RlKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaW5wdXQ6IFByb3Bvc2VJbnB1dCk6IFByb3Bvc2FsIHtcbiAgcmV0dXJuIGluc2VydFByb3Bvc2FsKGRiLCBidXMsIFwibm9kZVwiLCBpbnB1dCk7XG59XG5cbmZ1bmN0aW9uIHByb3Bvc2VFZGdlKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaW5wdXQ6IFByb3Bvc2VJbnB1dCk6IFByb3Bvc2FsIHtcbiAgcmV0dXJuIGluc2VydFByb3Bvc2FsKGRiLCBidXMsIFwiZWRnZVwiLCBpbnB1dCk7XG59XG5cbmV4cG9ydCB0eXBlIHsgQmF0Y2hFZGdlSW5wdXQsIEJhdGNoSW5wdXQsIEJhdGNoTm9kZUlucHV0LCBQcm9wb3NlSW5wdXQgfTtcbmV4cG9ydCB7XG4gIGJhdGNoUHJvcG9zZSxcbiAgZWRnZURyYWZ0V2FybmluZyxcbiAgaXNUaXRsZVJlZixcbiAgcHJvcG9zZUVkZ2UsXG4gIHByb3Bvc2VOb2RlLFxuICByZXNvbHZlVGl0bGVSZWYsXG4gIFRJVExFX1JFRl9QUkVGSVgsXG59O1xuIiwKICAgICIvLyBQMyDigJQgYHJhdGlmeSA8cHJvcG9zYWxJZD4gLS1ydWxpbmcgY2Fub258dGhyZWFkfHN0b3J5LWxvY2FsfHJlamVjdFxuLy8gLS1kb2MtZWRpdCA8ZmlsZT5gIGJhY2tpbmcuIE9uIGFjY2VwdDogd3JpdGVzIHRoZSBhZ2VudC1zdXBwbGllZCBkb2MgZWRpdFxuLy8gdmVyYmF0aW0gKHRoZSBkYWVtb24gbmV2ZXIgY29tcG9zZXMgcHJvc2Ug4oCUIGhvdXNlLXN0eWxlJ3MgcmV2aWV3LXF1ZXVlXG4vLyBjb250cmFjdCksIGFwcGVuZHMgYSBvbmUtbGluZSBjaGFuZ2Vsb2cgZW50cnksIGNyZWF0ZXMgdGhlIHJhdGlmaWVkXG4vLyBub2RlL2VkZ2Ugcm93LCBtYXJrcyB0aGUgcHJvcG9zYWwgcmF0aWZpZWQsIGVtaXRzIG5vZGUucmF0aWZpZWQvXG4vLyBlZGdlLnJhdGlmaWVkLiBPbiByZWplY3Q6IG1hcmtzIHJlamVjdGVkLCB0b3VjaGVzIG5vdGhpbmcgZWxzZSwgbm9cbi8vIGp1c3RpZmljYXRpb24gcmVxdWlyZWQgKHJhdGlmaWVkIGNvbnRyYWN0KS5cbi8vXG4vLyBSYXRpZnktdGltZSBldmlkZW5jZSBhdHRhY2ggKFAzIGdhdGUgcnVsaW5nKTogYC0tZG9jIDxkb2NJZD4gLS1kb2MtZWRpdFxuLy8gPGZpbGU+IFstLXNwYW4gPHRleHQ+XWAgbGV0cyB0aGUgcnVsaW5nIGF0dGFjaCBhIGRvYyBob21lIHRvIGFuXG4vLyBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgKHRoZSBodW1hbi1za2V0Y2ggaW52ZXJzaW9uKSDigJQgd3JpdGVzIHRoZVxuLy8gZHJhZnRlZCBkb2MsIHJlLWluZGV4ZXMsIGFuZCBtaW50cyB0aGUgbm9kZSdzIHNvdXJjZXMgcm93LlxuLy9cbi8vIEVkZ2UgZW5kcG9pbnQgcmVzb2x1dGlvbiAoY2Fzc2FuZHJhJ3MgUDIgY29sZC1hZ2VudCBnYXRlIGZpbmRpbmcpOiBhbiBlZGdlXG4vLyBkcmFmdCdzIHNvdXJjZS90YXJnZXQgbWF5IHJlZmVyZW5jZSBlaXRoZXIgYSByZWFsIG5vZGUgaWQgT1IgYSBwZW5kaW5nXG4vLyBOT0RFIHByb3Bvc2FsJ3MgaWQgKHRoZSBub2RlIGRvZXNuJ3QgZXhpc3QgeWV0LCBvbmx5IGl0cyBwcm9wb3NhbCBkb2VzKS5cbi8vIHJhdGlmeSByZXNvbHZlcyB0aGUgbGF0dGVyIHZpYSBwcm9wb3NhbHMucmVzdWx0X25vZGVfaWQg4oCUIHNldCB0aGUgbW9tZW50XG4vLyB0aGF0IG5vZGUgcHJvcG9zYWwgaXRzZWxmIHJhdGlmaWVzIOKAlCBhbmQgdGhyb3dzIGEgY2xlYXIgZXJyb3IgaWYgdGhlXG4vLyByZWZlcmVuY2VkIG5vZGUgcHJvcG9zYWwgaGFzbid0IHJhdGlmaWVkIHlldCwgcmF0aGVyIHRoYW4gc2lsZW50bHlcbi8vIGFjY2VwdGluZyBhIGRhbmdsaW5nIHJlZmVyZW5jZS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgeyBhcHBlbmRGaWxlU3luYywgd3JpdGVGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgYW5jaG9yR3VhcmQgfSBmcm9tIFwiLi9hbmNob3IudHNcIjtcbmltcG9ydCB0eXBlIHsgRXZlbnRCdXMgfSBmcm9tIFwiLi9ldmVudHMudHNcIjtcbmltcG9ydCB7IFNMVUdfUkUgfSBmcm9tIFwiLi9wcm9qZWN0LnRzXCI7XG5cbnR5cGUgUnVsaW5nID0gXCJjYW5vblwiIHwgXCJ0aHJlYWRcIiB8IFwic3RvcnktbG9jYWxcIiB8IFwicmVqZWN0XCI7XG5cbi8vIFJvdW5kIDQgKFIxKSDigJQgdGhlIGluLXpvbmUgcmVmdXNhbCwgdHlwZWQgKHRoZSBDaXRlZEVycm9yL1pvbmVOb3RFbXB0eUVycm9yXG4vLyBmYW1pbHkpOiBjYXJyaWVzIHRoZSB6b25lSWQgc28gYSBtZW51IGNhbiBicmFuY2ggb24ge2Vycm9yOlwiem9uZWRcIiwgem9uZUlkfVxuLy8gKDQwOSBhdCB0aGUgc2VydmVyKSBpbnN0ZWFkIG9mIHN0cmluZy1tYXRjaGluZyBwcm9zZS4gU2VtYW50aWNzIHVuY2hhbmdlZDpcbi8vIHJhdGlmaWNhdGlvbiDigJQgcmVqZWN0IGluY2x1ZGVkIOKAlCBpcyBhIG1haW4tcXVldWUgYWN0OyBwcm9tb3RlIGZpcnN0LlxuY2xhc3MgWm9uZWRFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgem9uZUlkOiBzdHJpbmc7XG4gIGNvbnN0cnVjdG9yKHByb3Bvc2FsSWQ6IHN0cmluZywgem9uZUlkOiBzdHJpbmcpIHtcbiAgICBzdXBlcihcbiAgICAgIGBwcm9wb3NhbCAke3Byb3Bvc2FsSWR9IGlzIGluIHpvbmUgJHt6b25lSWR9IOKAlCBwcm9tb3RlIGZpcnN0IChyYXRpZmljYXRpb24gaXMgYSBtYWluLXF1ZXVlIGFjdClgLFxuICAgICk7XG4gICAgdGhpcy5uYW1lID0gXCJab25lZEVycm9yXCI7XG4gICAgdGhpcy56b25lSWQgPSB6b25lSWQ7XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJhdGlmeUlucHV0IHtcbiAgcHJvcG9zYWxJZDogc3RyaW5nO1xuICBydWxpbmc6IFJ1bGluZztcbiAgZG9jRWRpdD86IHN0cmluZzsgLy8gZnVsbCBuZXcgY29udGVudCBmb3IgdGhlIHByb3Bvc2FsJ3MgZXZpZGVuY2UgZG9jIChvciAtLWRvYyBhdHRhY2ggdGFyZ2V0KVxuICAvLyBSYXRpZnktdGltZSBldmlkZW5jZSBhdHRhY2ggKFAzIGdhdGUgcnVsaW5nKTogYSBkb2MgaG9tZSBtaW50ZWQgYXRcbiAgLy8gcnVsaW5nIHRpbWUgZm9yIGFuIEVWSURFTkNFLUxFU1Mgbm9kZSBwcm9wb3NhbCDigJQgdGhlIGh1bWFuLXNrZXRjaFxuICAvLyBpbnZlcnNpb24sIHdoZXJlIHRoZSBodW1hbiBhbHJlYWR5IGJlbGlldmVzIHRoZSBjbGFpbSBhbmQgdGhlIGFnZW50XG4gIC8vIGRyYWZ0cyBpdHMgZG9jIGhvbWUuIEludmFsaWQgd2hlbmV2ZXIgdGhlIHByb3Bvc2FsIGFscmVhZHkgY2Fycmllc1xuICAvLyBldmlkZW5jZSAoZG9jIG9yIG1lc3NhZ2UpLCBhbmQgbm9kZSBwcm9wb3NhbHMgb25seSAoZWRnZXMgY2Fycnkgbm9cbiAgLy8gc291cmNlcyByb3dzKS4gUmVxdWlyZXMgZG9jRWRpdCDigJQgdGhlIGF0dGFjaCBJUyB0aGUgZHJhZnRlZCBkb2MgaG9tZS5cbiAgZG9jSWQ/OiBzdHJpbmc7XG4gIHNwYW4/OiBzdHJpbmc7IC8vIG9wdGlvbmFsIGV4Y2VycHQgZm9yIHRoZSBtaW50ZWQgc291cmNlcyByb3cgKG51bGxhYmxlKVxufVxuXG5pbnRlcmZhY2UgUmF0aWZ5UmVzdWx0IHtcbiAgaWQ6IHN0cmluZztcbiAgc3RhdHVzOiBcInJhdGlmaWVkXCIgfCBcInJlamVjdGVkXCI7XG4gIG5vZGVJZD86IHN0cmluZztcbiAgZWRnZUlkPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUHJvcG9zYWxSb3cge1xuICBpZDogc3RyaW5nO1xuICBraW5kOiBzdHJpbmc7XG4gIGRyYWZ0X2pzb246IHN0cmluZztcbiAgZXZpZGVuY2VfZG9jX2lkOiBzdHJpbmcgfCBudWxsO1xuICBldmlkZW5jZV9tZXNzYWdlX2lkOiBzdHJpbmcgfCBudWxsO1xuICBldmlkZW5jZV9zcGFuOiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IHN0cmluZztcbiAgem9uZV9pZDogc3RyaW5nIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVzb2x2ZU5vZGVSZWYoZGI6IERhdGFiYXNlLCByZWY6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vZGUgPSBkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldChyZWYpO1xuICBpZiAobm9kZSkgcmV0dXJuIHJlZjtcblxuICBjb25zdCBwcm9wb3NhbCA9IGRiXG4gICAgLnF1ZXJ5KFwiU0VMRUNUIGtpbmQsIHN0YXR1cywgcmVzdWx0X25vZGVfaWQgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIpXG4gICAgLmdldChyZWYpIGFzIHsga2luZDogc3RyaW5nOyBzdGF0dXM6IHN0cmluZzsgcmVzdWx0X25vZGVfaWQ6IHN0cmluZyB8IG51bGwgfSB8IG51bGw7XG4gIGlmICghcHJvcG9zYWwpIHRocm93IG5ldyBFcnJvcihgdW5yZXNvbHZlZCBub2RlIHJlZmVyZW5jZTogJHtyZWZ9YCk7XG4gIGlmIChwcm9wb3NhbC5raW5kICE9PSBcIm5vZGVcIikgdGhyb3cgbmV3IEVycm9yKGByZWZlcmVuY2UgJHtyZWZ9IGlzIG5vdCBhIG5vZGUgcHJvcG9zYWxgKTtcbiAgaWYgKHByb3Bvc2FsLnN0YXR1cyAhPT0gXCJyYXRpZmllZFwiIHx8ICFwcm9wb3NhbC5yZXN1bHRfbm9kZV9pZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgdW5yZXNvbHZlZCBwcm9wb3NhbCByZWZlcmVuY2U6IHJhdGlmeSBub2RlIHByb3Bvc2FsICR7cmVmfSBmaXJzdGApO1xuICB9XG4gIHJldHVybiBwcm9wb3NhbC5yZXN1bHRfbm9kZV9pZDtcbn1cblxuLy8gUm91bmQgNiAoUkIpIOKAlCBmYWN0b3IgdGhlIHJhdGlmeSB3cml0ZS1wYXRoIGV4YWN0bHkgYXMgYnVpbGRQcm9wb3NhbCB3YXNcbi8vIGZhY3RvcmVkIGZyb20gaW5zZXJ0UHJvcG9zYWw6IHZhbGlkYXRlICsgcmVzb2x2ZSAocHVyZSByZWFkcyArIHRocm93cywgbm9cbi8vIHNpZGUgZWZmZWN0cyksIHRoZW4gcmV0dXJuIHRoZSBkZWZlcnJlZCBlZmZlY3RzIOKAlCBhIGB3cml0ZURvY2AgZnMgY2xvc3VyZSwgYVxuLy8gZGItb25seSBgYXBwbHlgLCB0aGUgYGNoYW5nZWxvZ0xpbmVgLCBhbmQgYSBkZWZlcnJlZCBgZW1pdGAuIFRoaXMgaXMgd2hhdFxuLy8gbGV0cyByYXRpZnktYmF0Y2ggbG9vcCBgYXBwbHkoKWAgaW5zaWRlIE9ORSBkYi50cmFuc2FjdGlvbigpIGFuZCBkZWZlciBldmVyeVxuLy8gZnMgd3JpdGUgKyBlbWl0IHRvIEFGVEVSIGNvbW1pdCwgc28gYSB0aHJvdyBhdCBhbnkgc3RhZ2UgbGVha3MgemVybyByb3dzLFxuLy8gemVybyBldmVudHMsIHplcm8gY2hhbmdlbG9nIGxpbmVzICh0aGUgYnVpbGRQcm9wb3NhbCBhdG9taWNpdHkgbGVzc29uKS5cbi8vIFNpbmdsZSBgcmF0aWZ5KClgIGtlZXBzIGNhbGxpbmcgdGhlIHBpZWNlcyBpbmxpbmUg4oaSIGJlaGF2aW9yLWlkZW50aWNhbC5cbi8vXG4vLyBgcmVzb2x2ZVJlZmAgb3ZlcnJpZGVzIGVkZ2UtZW5kcG9pbnQgcmVzb2x1dGlvbjogc2luZ2xlIHJhdGlmeSByZXNvbHZlc1xuLy8gYWdhaW5zdCB0aGUgZGIgKHJlc29sdmVOb2RlUmVmKTsgYmF0Y2ggcmVzb2x2ZXMgYWdhaW5zdCBpdHMgaW4tcHJvZ3Jlc3Ncbi8vIGlkTWFwIChwcm9wb3NhbElkIOKGkiBtaW50ZWQgbm9kZUlkKSBGSVJTVCwgc2luY2UgYSBiYXRjaGVkIG5vZGUgcHJvcG9zYWwnc1xuLy8gcmVzdWx0X25vZGVfaWQgaXNuJ3Qgc2V0IHVudGlsIGl0cyBvd24gYXBwbHkoKSBydW5zIGluc2lkZSB0aGUgdHhuLlxuaW50ZXJmYWNlIEJ1aWx0UmF0aWZ5IHtcbiAgYXBwbHk6ICgpID0+IHZvaWQ7IC8vIGRiLW9ubHkgd3JpdGVzIChmdHMgcmVpbmRleCArIG5vZGUvZWRnZS9zb3VyY2VzL3Byb3Bvc2FsL2FjdGlvbnMpXG4gIHdyaXRlRG9jOiAoKCkgPT4gdm9pZCkgfCBudWxsOyAvLyBkZWZlcnJlZCBmcyBkb2MtZWRpdCB3cml0ZSAoc2luZ2xlIHJhdGlmeSBvbmx5KVxuICBjaGFuZ2Vsb2dMaW5lOiBzdHJpbmcgfCBudWxsO1xuICBlbWl0OiAoKSA9PiB2b2lkOyAvLyBkZWZlcnJlZCBidXMgZW1pdFxuICByZXN1bHQ6IFJhdGlmeVJlc3VsdDtcbn1cblxuZnVuY3Rpb24gYnVpbGRSYXRpZnkoXG4gIGRiOiBEYXRhYmFzZSxcbiAgZG9jc0Rpcjogc3RyaW5nLFxuICBpbnB1dDogUmF0aWZ5SW5wdXQsXG4gIGJ1czogRXZlbnRCdXMsXG4gIHJlc29sdmVSZWY6IChyZWY6IHN0cmluZykgPT4gc3RyaW5nID0gKHJlZikgPT4gcmVzb2x2ZU5vZGVSZWYoZGIsIHJlZiksXG4pOiBCdWlsdFJhdGlmeSB7XG4gIGNvbnN0IHJvdyA9IGRiXG4gICAgLnF1ZXJ5KFxuICAgICAgXCJTRUxFQ1QgaWQsIGtpbmQsIGRyYWZ0X2pzb24sIGV2aWRlbmNlX2RvY19pZCwgZXZpZGVuY2VfbWVzc2FnZV9pZCwgZXZpZGVuY2Vfc3Bhbiwgc3RhdHVzLCB6b25lX2lkIEZST00gcHJvcG9zYWxzIFdIRVJFIGlkID0gP1wiLFxuICAgIClcbiAgICAuZ2V0KGlucHV0LnByb3Bvc2FsSWQpIGFzIFByb3Bvc2FsUm93IHwgbnVsbDtcbiAgaWYgKCFyb3cpIHRocm93IG5ldyBFcnJvcihgdW5rbm93biBwcm9wb3NhbDogJHtpbnB1dC5wcm9wb3NhbElkfWApO1xuICBpZiAocm93LnN0YXR1cyAhPT0gXCJwZW5kaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHByb3Bvc2FsICR7aW5wdXQucHJvcG9zYWxJZH0gYWxyZWFkeSAke3Jvdy5zdGF0dXN9YCk7XG4gIH1cbiAgLy8gUm91bmQgMyAoQ2xhaW0gWjIpOiByYXRpZmljYXRpb24gaXMgYSBNQUlOLUdSQVBIIGFjdCDigJQgYSB6b25lZCBwcm9wb3NhbFxuICAvLyBtdXN0IGJlIHByb21vdGVkIG91dCBvZiBpdHMgc3RhZ2luZyBwZW4gYmVmb3JlIGl0IGNhbiBiZSBydWxlZCBvblxuICAvLyAocmVqZWN0aW9uIGluY2x1ZGVkOiB6b25lIGRlbGV0ZSBpcyB0aGUgb25seSBpbi16b25lIGRpc3Bvc2FsKS5cbiAgaWYgKHJvdy56b25lX2lkICE9PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IFpvbmVkRXJyb3IoaW5wdXQucHJvcG9zYWxJZCwgcm93LnpvbmVfaWQpO1xuICB9XG5cbiAgaWYgKGlucHV0LnJ1bGluZyA9PT0gXCJyZWplY3RcIikge1xuICAgIC8vIFJvdW5kIDYgKGZpbmRpbmcgIzQgcm9vdCBjYXVzZSk6IHJlamVjdCB1c2VkIHRvIGVtaXQgTk9USElORywgc28gYVxuICAgIC8vIHJlamVjdGVkIG5vZGUgbGluZ2VyZWQgb24gZXZlcnkgc3VyZmFjZSB1bnRpbCBhIG1hbnVhbCByZWZldGNoLiBBIHRoaW5cbiAgICAvLyBwcm9wb3NhbC5yZWplY3RlZCB7aWR9IG1ha2VzIHJlamVjdCBMSVZFIOKAlCBjaXJjZSdzIHJlZHVjZXIgZHJvcHMgaXQuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFwcGx5OiAoKSA9PiB7XG4gICAgICAgIGRiLnJ1bihcIlVQREFURSBwcm9wb3NhbHMgU0VUIHN0YXR1cyA9ICdyZWplY3RlZCcgV0hFUkUgaWQgPSA/XCIsIFtpbnB1dC5wcm9wb3NhbElkXSk7XG4gICAgICAgIC8vIEExOiBhIHJlamVjdGVkIHByb3Bvc2FsJ3MgYWN0aW9uIHNsb3RzIGRpZSB3aXRoIGl0IOKAlCBhIHNsb3Qgb24gYVxuICAgICAgICAvLyBkZWFkIHRhcmdldCB3b3VsZCBkYW5nbGUgb3V0IG9mIGV2ZXJ5IHZpZXcuXG4gICAgICAgIGRiLnJ1bihcIkRFTEVURSBGUk9NIG5vZGVfYWN0aW9ucyBXSEVSRSB0YXJnZXRfaWQgPSA/XCIsIFtpbnB1dC5wcm9wb3NhbElkXSk7XG4gICAgICAgIC8vIFRBR1M6IHNhbWUg4oCUIGEgcmVqZWN0ZWQgcHJvcG9zYWwncyB0YWdzIGRpZSB3aXRoIGl0ICh0d2luIG9mIGFjdGlvbnMpLlxuICAgICAgICBkYi5ydW4oXCJERUxFVEUgRlJPTSBub2RlX3RhZ3MgV0hFUkUgdGFyZ2V0X2lkID0gP1wiLCBbaW5wdXQucHJvcG9zYWxJZF0pO1xuICAgICAgfSxcbiAgICAgIHdyaXRlRG9jOiBudWxsLFxuICAgICAgY2hhbmdlbG9nTGluZTogbnVsbCxcbiAgICAgIGVtaXQ6ICgpID0+IGJ1cy5lbWl0KFwicHJvcG9zYWwucmVqZWN0ZWRcIiwgeyBpZDogaW5wdXQucHJvcG9zYWxJZCB9KSxcbiAgICAgIHJlc3VsdDogeyBpZDogaW5wdXQucHJvcG9zYWxJZCwgc3RhdHVzOiBcInJlamVjdGVkXCIgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gUmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoICgtLWRvYyk6IHZhbGlkIE9OTFkgZm9yIGFuIGV2aWRlbmNlLWxlc3NcbiAgLy8gbm9kZSBwcm9wb3NhbCwgYW5kIG9ubHkgYWxvbmdzaWRlIHRoZSBkb2MtZWRpdCB0aGF0IGRyYWZ0cyBpdHMgaG9tZSDigJRcbiAgLy8gYWxsIGNvbnN0cmFpbnRzIGZhaWwgbG91ZCBhdCBpbnRha2UgKHNhbWUgc3Bpcml0IGFzIG1hcmspLCBiZWZvcmUgYW55XG4gIC8vIHdyaXRlIGxhbmRzLlxuICBpZiAoaW5wdXQuZG9jSWQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmIChyb3cuZXZpZGVuY2VfZG9jX2lkIHx8IHJvdy5ldmlkZW5jZV9tZXNzYWdlX2lkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBwcm9wb3NhbCAke2lucHV0LnByb3Bvc2FsSWR9IGFscmVhZHkgY2FycmllcyBldmlkZW5jZTsgLS1kb2MgaXMgZm9yIGV2aWRlbmNlLWxlc3MgcHJvcG9zYWxzYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChpbnB1dC5kb2NFZGl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIi0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQgKHRoZSBhdHRhY2ggaXMgdGhlIGFnZW50IGRyYWZ0aW5nIHRoZSBkb2MgaG9tZSlcIik7XG4gICAgfVxuICAgIGlmIChyb3cua2luZCAhPT0gXCJub2RlXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCItLWRvYyBpcyBpbnZhbGlkIGZvciBlZGdlIHByb3Bvc2FscyDigJQgZWRnZXMgY2Fycnkgbm8gc291cmNlcyByb3dzOyBhdHRhY2ggZXZpZGVuY2UgdG8gdGhlIGVuZHBvaW50IG5vZGVzIGluc3RlYWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmICghU0xVR19SRS50ZXN0KGlucHV0LmRvY0lkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAtLWRvYyBpcyBub3QgYSB2YWxpZCBkb2Mgc2x1ZzogJHtpbnB1dC5kb2NJZH1gKTtcbiAgICB9XG4gICAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gZG9jcyBXSEVSRSBpZCA9ID9cIikuZ2V0KGlucHV0LmRvY0lkKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGB1bmtub3duIGRvYzogJHtpbnB1dC5kb2NJZH1gKTtcbiAgICB9XG4gIH1cbiAgLy8gVGhlIGRvYyBhIC0tZG9jLWVkaXQgbGFuZHMgaW46IHRoZSBwcm9wb3NhbCdzIG93biBldmlkZW5jZSBkb2MsIG9yIHRoZVxuICAvLyByYXRpZnktdGltZSBhdHRhY2ggdGFyZ2V0IGZvciBhbiBldmlkZW5jZS1sZXNzIHByb3Bvc2FsLlxuICBjb25zdCBob21lRG9jSWQgPSByb3cuZXZpZGVuY2VfZG9jX2lkID8/IGlucHV0LmRvY0lkID8/IG51bGw7XG5cbiAgaWYgKGlucHV0LmRvY0VkaXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghaG9tZURvY0lkKSB7XG4gICAgICAvLyBDbGFpbSBFIHNoYXJwZW5pbmc6IG1lc3NhZ2UgZXZpZGVuY2UgdGFrZXMgbm8gLS1kb2MtZWRpdCDigJQgdGhlXG4gICAgICAvLyB0cmFuc2NyaXB0IGlzIHRoZSBzb3VyY2UgYW5kIHRoZSBkYWVtb24gbmV2ZXIgd3JpdGVzIG1lc3NhZ2VzLlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICByb3cuZXZpZGVuY2VfbWVzc2FnZV9pZFxuICAgICAgICAgID8gYHByb3Bvc2FsICR7aW5wdXQucHJvcG9zYWxJZH0gaGFzIG1lc3NhZ2UgZXZpZGVuY2Ug4oCUIC0tZG9jLWVkaXQgaXMgaW52YWxpZCBmb3IgbWVzc2FnZS1ncm91bmRlZCBwcm9wb3NhbHNgXG4gICAgICAgICAgOiBgcHJvcG9zYWwgJHtpbnB1dC5wcm9wb3NhbElkfSBoYXMgbm8gZXZpZGVuY2UgZG9jIHRvIGVkaXQgKGF0dGFjaCBvbmUgd2l0aCAtLWRvYylgLFxuICAgICAgKTtcbiAgICB9XG4gICAgLy8gRGVmZW5zZSBpbiBkZXB0aDogcHJvcG9zZS50cyByZWplY3RzIG5vbi1zbHVnIGV2aWRlbmNlIGlkcyBhdCBpbnRha2UsXG4gICAgLy8gYnV0IHRoaXMgcm93IG1heSBwcmVkYXRlIHRoYXQgZ3VhcmQgKG9yIGNvbWUgZnJvbSBhbm90aGVyIHdyaXRlcikg4oCUXG4gICAgLy8gbmV2ZXIgbGV0IGEgc3RvcmVkIGlkIHJlYWNoIHRoZSBmaWxlc3lzdGVtIHVudmFsaWRhdGVkLlxuICAgIGlmICghU0xVR19SRS50ZXN0KGhvbWVEb2NJZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgcmVmdXNpbmcgZG9jIGVkaXQ6IGV2aWRlbmNlIGRvYyBpZCBpcyBub3QgYSB2YWxpZCBzbHVnOiAke2hvbWVEb2NJZH1gKTtcbiAgICB9XG4gIH1cbiAgLy8gRGVmZXJyZWQgZnMgZG9jIHdyaXRlIChzaW5nbGUgcmF0aWZ5IG9ubHkg4oCUIGJhdGNoIGNhcnJpZXMgbm8gZG9jRWRpdCkuXG4gIGNvbnN0IHdyaXRlRG9jID1cbiAgICBpbnB1dC5kb2NFZGl0ICE9PSB1bmRlZmluZWQgJiYgaG9tZURvY0lkXG4gICAgICA/ICgpID0+IHdyaXRlRmlsZVN5bmMoam9pbihkb2NzRGlyLCBgJHtob21lRG9jSWR9Lm1kYCksIGlucHV0LmRvY0VkaXQgYXMgc3RyaW5nKVxuICAgICAgOiBudWxsO1xuXG4gIC8vIEV2ZXJ5IGFjY2VwdCBsb2dzLCB3aXRoIG9yIHdpdGhvdXQgYSBkb2MgZWRpdCDigJQgdGhlIGNoYW5nZWxvZyBpcyB0aGVcbiAgLy8gYXR0cmlidXRlZCB3aGF0LWNoYW5nZWQgcmVjb3JkLCBub3QgYSBkb2Mtd3JpdGUgc2lkZSBlZmZlY3QuXG4gIGNvbnN0IGNoYW5nZWxvZ0xpbmUgPSBgcmF0aWZpZWQgJHtpbnB1dC5wcm9wb3NhbElkfSAoJHtpbnB1dC5ydWxpbmd9KSR7aG9tZURvY0lkID8gYCAtPiAke2hvbWVEb2NJZH0ubWRgIDogXCJcIn0ke2lucHV0LmRvY0VkaXQgIT09IHVuZGVmaW5lZCA/IFwiIChkb2MgZWRpdGVkKVwiIDogXCJcIn1cXG5gO1xuXG4gIGNvbnN0IGRyYWZ0ID0gSlNPTi5wYXJzZShyb3cuZHJhZnRfanNvbikgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG5cbiAgaWYgKHJvdy5raW5kID09PSBcIm5vZGVcIikge1xuICAgIGNvbnN0IG5vZGVJZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIHdyaXRlRG9jLFxuICAgICAgY2hhbmdlbG9nTGluZSxcbiAgICAgIGFwcGx5OiAoKSA9PiB7XG4gICAgICAgIC8vIGZ0cyByZS1pbmRleCByaWRlcyBoZXJlIChhIGRiIHdyaXRlKSDigJQga2VlcHMgc2VhcmNoIHRydWUgdG8gdGhlXG4gICAgICAgIC8vIHJhdGlmaWVkIGVkaXQ7IHRoZSBmaWxlIHdyaXRlIGl0c2VsZiBpcyB0aGUgZGVmZXJyZWQgd3JpdGVEb2MuXG4gICAgICAgIGlmIChpbnB1dC5kb2NFZGl0ICE9PSB1bmRlZmluZWQgJiYgaG9tZURvY0lkKSB7XG4gICAgICAgICAgZGIucnVuKFwiREVMRVRFIEZST00gZG9jc19mdHMgV0hFUkUgZG9jX2lkID0gP1wiLCBbaG9tZURvY0lkXSk7XG4gICAgICAgICAgZGIucnVuKFwiSU5TRVJUIElOVE8gZG9jc19mdHMgKGRvY19pZCwgY29udGVudCkgVkFMVUVTICg/LCA/KVwiLCBbXG4gICAgICAgICAgICBob21lRG9jSWQsXG4gICAgICAgICAgICBpbnB1dC5kb2NFZGl0LFxuICAgICAgICAgIF0pO1xuICAgICAgICB9XG4gICAgICAgIGRiLnJ1bihcIklOU0VSVCBJTlRPIG5vZGVzIChpZCwga2luZCwgdGllciwgdGl0bGUsIHN5bm9wc2lzKSBWQUxVRVMgKD8sID8sID8sID8sID8pXCIsIFtcbiAgICAgICAgICBub2RlSWQsXG4gICAgICAgICAgdHlwZW9mIGRyYWZ0LmtpbmQgPT09IFwic3RyaW5nXCIgPyBkcmFmdC5raW5kIDogXCJjb25jZXB0XCIsXG4gICAgICAgICAgaW5wdXQucnVsaW5nLFxuICAgICAgICAgIHR5cGVvZiBkcmFmdC50aXRsZSA9PT0gXCJzdHJpbmdcIiA/IGRyYWZ0LnRpdGxlIDogXCJVbnRpdGxlZFwiLFxuICAgICAgICAgIHR5cGVvZiBkcmFmdC5zeW5vcHNpcyA9PT0gXCJzdHJpbmdcIiA/IGRyYWZ0LnN5bm9wc2lzIDogXCJcIixcbiAgICAgICAgXSk7XG4gICAgICAgIGlmIChyb3cuZXZpZGVuY2VfZG9jX2lkKSB7XG4gICAgICAgICAgZGIucnVuKFwiSU5TRVJUIElOVE8gc291cmNlcyAobm9kZV9pZCwgZG9jX2lkLCBzcGFuKSBWQUxVRVMgKD8sID8sID8pXCIsIFtcbiAgICAgICAgICAgIG5vZGVJZCxcbiAgICAgICAgICAgIHJvdy5ldmlkZW5jZV9kb2NfaWQsXG4gICAgICAgICAgICByb3cuZXZpZGVuY2Vfc3BhbixcbiAgICAgICAgICBdKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocm93LmV2aWRlbmNlX21lc3NhZ2VfaWQpIHtcbiAgICAgICAgICBkYi5ydW4oXCJJTlNFUlQgSU5UTyBtZXNzYWdlX3NvdXJjZXMgKG5vZGVfaWQsIG1lc3NhZ2VfaWQsIHNwYW4pIFZBTFVFUyAoPywgPywgPylcIiwgW1xuICAgICAgICAgICAgbm9kZUlkLFxuICAgICAgICAgICAgcm93LmV2aWRlbmNlX21lc3NhZ2VfaWQsXG4gICAgICAgICAgICByb3cuZXZpZGVuY2Vfc3BhbixcbiAgICAgICAgICBdKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBSYXRpZnktdGltZSBhdHRhY2g6IHRoZSBtaW50ZWQgZG9jIGhvbWUgYmVjb21lcyB0aGUgbm9kZSdzIHNvdXJjZVxuICAgICAgICAvLyAob25seSByZWFjaGFibGUgd2hlbiB0aGUgcHJvcG9zYWwgd2FzIGV2aWRlbmNlLWxlc3Mg4oCUIGd1YXJkZWQgYWJvdmUpLlxuICAgICAgICBpZiAoaW5wdXQuZG9jSWQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGRiLnJ1bihcIklOU0VSVCBJTlRPIHNvdXJjZXMgKG5vZGVfaWQsIGRvY19pZCwgc3BhbikgVkFMVUVTICg/LCA/LCA/KVwiLCBbXG4gICAgICAgICAgICBub2RlSWQsXG4gICAgICAgICAgICBpbnB1dC5kb2NJZCxcbiAgICAgICAgICAgIGlucHV0LnNwYW4gPz8gbnVsbCxcbiAgICAgICAgICBdKTtcbiAgICAgICAgfVxuICAgICAgICBkYi5ydW4oXCJVUERBVEUgcHJvcG9zYWxzIFNFVCBzdGF0dXMgPSAncmF0aWZpZWQnLCByZXN1bHRfbm9kZV9pZCA9ID8gV0hFUkUgaWQgPSA/XCIsIFtcbiAgICAgICAgICBub2RlSWQsXG4gICAgICAgICAgaW5wdXQucHJvcG9zYWxJZCxcbiAgICAgICAgXSk7XG4gICAgICAgIC8vIEExOiByZS1ob21lIHRoZSBwcm9wb3NhbCdzIGFjdGlvbiBzbG90cyBvbnRvIHRoZSBtaW50ZWQgbm9kZSBpZCAodGhlXG4gICAgICAgIC8vIHN0aWdtZXJneSBwYXlvZmYg4oCUIHNsb3RzIHN1cnZpdmUgcmF0aWZpY2F0aW9uOyBub2RlSWQgaXMgYSBmcmVzaFxuICAgICAgICAvLyBVVUlELCBzbyB0aGUgUEsgbW92ZSBjYW4gbmV2ZXIgY29sbGlkZSkuXG4gICAgICAgIGRiLnJ1bihcIlVQREFURSBub2RlX2FjdGlvbnMgU0VUIHRhcmdldF9pZCA9ID8gV0hFUkUgdGFyZ2V0X2lkID0gP1wiLCBbXG4gICAgICAgICAgbm9kZUlkLFxuICAgICAgICAgIGlucHV0LnByb3Bvc2FsSWQsXG4gICAgICAgIF0pO1xuICAgICAgICAvLyBUQUdTOiByZS1ob21lIHRoZSBwcm9wb3NhbCdzIHRhZ3Mgb250byB0aGUgbWludGVkIG5vZGUgaWQgdG9vICh0aGVcbiAgICAgICAgLy8gdHdpbiByZS1ob21lIOKAlCBub2RlSWQgaXMgYSBmcmVzaCBVVUlEIHNvIHRoZSBQSyBtb3ZlIGNhbid0IGNvbGxpZGUpLlxuICAgICAgICBkYi5ydW4oXCJVUERBVEUgbm9kZV90YWdzIFNFVCB0YXJnZXRfaWQgPSA/IFdIRVJFIHRhcmdldF9pZCA9ID9cIiwgW1xuICAgICAgICAgIG5vZGVJZCxcbiAgICAgICAgICBpbnB1dC5wcm9wb3NhbElkLFxuICAgICAgICBdKTtcbiAgICAgIH0sXG4gICAgICBlbWl0OiAoKSA9PiBidXMuZW1pdChcIm5vZGUucmF0aWZpZWRcIiwgeyBpZDogbm9kZUlkLCBwcm9wb3NhbElkOiBpbnB1dC5wcm9wb3NhbElkIH0pLFxuICAgICAgcmVzdWx0OiB7IGlkOiBpbnB1dC5wcm9wb3NhbElkLCBzdGF0dXM6IFwicmF0aWZpZWRcIiwgbm9kZUlkIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEVkZ2Ug4oCUIHJlc29sdmUgZW5kcG9pbnRzIE5PVyAocHVyZSByZWFkICsgdGhyb3csIGJlZm9yZSBhbnkgd3JpdGUpOyBiYXRjaFxuICAvLyBwYXNzZXMgYW4gaWRNYXAtYXdhcmUgcmVzb2x2ZXIgc28gYW4gZW5kcG9pbnQgbmFtaW5nIGEgYmF0Y2hlZCBub2RlXG4gIC8vIHByb3Bvc2FsIHJlc29sdmVzIHRvIGl0cyBqdXN0LW1pbnRlZCBpZC5cbiAgY29uc3Qgc291cmNlID0gcmVzb2x2ZVJlZihTdHJpbmcoZHJhZnQuc291cmNlKSk7XG4gIGNvbnN0IHRhcmdldCA9IHJlc29sdmVSZWYoU3RyaW5nKGRyYWZ0LnRhcmdldCkpO1xuICBjb25zdCBlZGdlSWQgPSBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICByZXR1cm4ge1xuICAgIHdyaXRlRG9jLFxuICAgIGNoYW5nZWxvZ0xpbmUsXG4gICAgYXBwbHk6ICgpID0+IHtcbiAgICAgIGRiLnJ1bihcbiAgICAgICAgXCJJTlNFUlQgSU5UTyBlZGdlcyAoaWQsIHNvdXJjZSwgdGFyZ2V0LCBsYWJlbCwgcHJvdmVuYW5jZSwgZGlyZWN0aW9uKSBWQUxVRVMgKD8sID8sID8sID8sICdhc3NlcnRlZCcsID8pXCIsXG4gICAgICAgIFtcbiAgICAgICAgICBlZGdlSWQsXG4gICAgICAgICAgc291cmNlLFxuICAgICAgICAgIHRhcmdldCxcbiAgICAgICAgICB0eXBlb2YgZHJhZnQubGFiZWwgPT09IFwic3RyaW5nXCIgPyBkcmFmdC5sYWJlbCA6IFwiXCIsXG4gICAgICAgICAgdHlwZW9mIGRyYWZ0LmRpcmVjdGlvbiA9PT0gXCJzdHJpbmdcIiA/IGRyYWZ0LmRpcmVjdGlvbiA6IG51bGwsXG4gICAgICAgIF0sXG4gICAgICApO1xuICAgICAgZGIucnVuKFwiVVBEQVRFIHByb3Bvc2FscyBTRVQgc3RhdHVzID0gJ3JhdGlmaWVkJyBXSEVSRSBpZCA9ID9cIiwgW2lucHV0LnByb3Bvc2FsSWRdKTtcbiAgICAgIC8vIEExOiBhY3Rpb25zIGxpdmUgb24gcmF0aWZpZWQgTk9ERVMgYW5kIHBlbmRpbmcgcHJvcG9zYWxzIG9ubHkg4oCUIGFuIGVkZ2VcbiAgICAgIC8vIHByb3Bvc2FsJ3Mgc2xvdHMgaGF2ZSBub3doZXJlIHRvIHJlLWhvbWUsIHNvIHRoZXkgZGllIHdpdGggdGhlIHJ1bGluZy5cbiAgICAgIGRiLnJ1bihcIkRFTEVURSBGUk9NIG5vZGVfYWN0aW9ucyBXSEVSRSB0YXJnZXRfaWQgPSA/XCIsIFtpbnB1dC5wcm9wb3NhbElkXSk7XG4gICAgICAvLyBUQUdTOiBzYW1lIOKAlCBhbiBlZGdlIGFjY2VwdCBoYXMgbm8gbm9kZSB0byByZS1ob21lIHRhZ3Mgb250byAoZWRnZXNcbiAgICAgIC8vIGNhcnJ5IG5vIHRhcmdldC1rZXllZCBtZXRhZGF0YSksIHNvIHRoZXkgZGllIHdpdGggdGhlIHJ1bGluZy5cbiAgICAgIGRiLnJ1bihcIkRFTEVURSBGUk9NIG5vZGVfdGFncyBXSEVSRSB0YXJnZXRfaWQgPSA/XCIsIFtpbnB1dC5wcm9wb3NhbElkXSk7XG4gICAgfSxcbiAgICBlbWl0OiAoKSA9PiBidXMuZW1pdChcImVkZ2UucmF0aWZpZWRcIiwgeyBpZDogZWRnZUlkLCBwcm9wb3NhbElkOiBpbnB1dC5wcm9wb3NhbElkIH0pLFxuICAgIHJlc3VsdDogeyBpZDogaW5wdXQucHJvcG9zYWxJZCwgc3RhdHVzOiBcInJhdGlmaWVkXCIsIGVkZ2VJZCB9LFxuICB9O1xufVxuXG4vLyBTaW5nbGUgcmF0aWZ5IOKAlCBidWlsZCwgdGhlbiBydW4gdGhlIHBpZWNlcyBpbmxpbmUgKHdyaXRlRG9jIOKGkiBhcHBseSDihpJcbi8vIGNoYW5nZWxvZyDihpIgZW1pdCkuIE5vIHRyYW5zYWN0aW9uLCBubyBiYXRjaGluZzogYnl0ZS1mb3ItYnl0ZSB0aGUgcHJlLVI2XG4vLyBiZWhhdmlvciwgbm93IGV4cHJlc3NlZCB0aHJvdWdoIGJ1aWxkUmF0aWZ5LlxuZnVuY3Rpb24gcmF0aWZ5KGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgZG9jc0Rpcjogc3RyaW5nLCBpbnB1dDogUmF0aWZ5SW5wdXQpOiBSYXRpZnlSZXN1bHQge1xuICBjb25zdCBidWlsdCA9IGJ1aWxkUmF0aWZ5KGRiLCBkb2NzRGlyLCBpbnB1dCwgYnVzKTtcbiAgYnVpbHQud3JpdGVEb2M/LigpO1xuICBidWlsdC5hcHBseSgpO1xuICBpZiAoYnVpbHQuY2hhbmdlbG9nTGluZSlcbiAgICBhcHBlbmRGaWxlU3luYyhqb2luKGRvY3NEaXIsIFwiLi5cIiwgXCJjaGFuZ2Vsb2cudHh0XCIpLCBidWlsdC5jaGFuZ2Vsb2dMaW5lKTtcbiAgYnVpbHQuZW1pdCgpO1xuICByZXR1cm4gYnVpbHQucmVzdWx0O1xufVxuXG5pbnRlcmZhY2UgUmF0aWZ5QmF0Y2hJbnB1dCB7XG4gIHJ1bGluZzogUnVsaW5nO1xuICBpZHM6IHN0cmluZ1tdO1xuICAvLyBPcHRpb25hbCBwb3N0LXJhdGlmeSBhbmNob3JzIChzdWJtYXAgbmVzdGluZyk6IGVhY2ggcmVmIG1heSBiZSBhIGJhdGNoZWRcbiAgLy8gcHJvcG9zYWwgaWQgKHJlc29sdmVkIHZpYSBpZE1hcCB0byBpdHMgbWludGVkIG5vZGUpIG9yIGEgcmVhbCBub2RlIGlkLlxuICBhbmNob3JzPzogQXJyYXk8eyBub2RlOiBzdHJpbmc7IHBhcmVudDogc3RyaW5nIH0+O1xufVxuXG5pbnRlcmZhY2UgUmF0aWZ5QmF0Y2hSZXN1bHQge1xuICAvLyBvbGTihpJuZXc6IGJhdGNoZWQgTk9ERSBwcm9wb3NhbCBpZCDihpIgdGhlIG5vZGUgaWQgaXQgbWludGVkLiBUaGUgcG9pbnQgb2ZcbiAgLy8gdGhlIGJhdGNoIOKAlCBhbiBlZGdlIChvciBhIGNhbGxlcikgbmFtZXMgYSBub2RlIGJ5IGl0cyBwcmUtcmF0aWZ5IHByb3Bvc2FsXG4gIC8vIGlkIGFuZCBnZXRzIHRoZSByZWFsIGlkIGJhY2sgaW4gb25lIGNhbGwuXG4gIGlkTWFwOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICByYXRpZmllZDogUmF0aWZ5UmVzdWx0W107XG59XG5cbi8vIFJvdW5kIDYgKFJCKSDigJQgcmF0aWZ5IGEgc2V0IGluIE9ORSBjYWxsICsgb25lIHRyYW5zYWN0aW9uLiBBdXRvLXBhcnRpdGlvbnNcbi8vIG5vZGVzLWJlZm9yZS1lZGdlcyBieSBsb29raW5nIHVwIGVhY2ggaWQncyBraW5kIChubyBjYWxsZXIgb3JkZXJpbmcpOyBOT1xuLy8gYXV0by1pbmNsdWRlIG9mIHVubGlzdGVkIGVkZ2VzIChleHBsaWNpdCBvbmx5IOKAlCBubyBzaWxlbnQgcmF0aWZpY2F0aW9ucykuXG4vLyBPbmUgdG9wLWxldmVsIHJ1bGluZzsgcmVqZWN0IGlzIE5PVCBhIGJhdGNoIGFjdC4gQWxsIHZhbGlkYXRpb24vcmVzb2x1dGlvblxuLy8gcnVucyBCRUZPUkUgdGhlIHR4biAoYnVpbGRSYXRpZnkgaXMgcHVyZSksIGFsbCBhcHBseSgpIElOU0lERSBpdCwgYWxsXG4vLyBjaGFuZ2Vsb2cgYXBwZW5kcyArIGVtaXRzIEFGVEVSIGNvbW1pdCDigJQgYSB0aHJvdyBhdCBhbnkgc3RhZ2UgbGVhdmVzIHplcm9cbi8vIHJvd3MsIHplcm8gZXZlbnRzLCB6ZXJvIGNoYW5nZWxvZyBsaW5lcy5cbmZ1bmN0aW9uIHJhdGlmeUJhdGNoKFxuICBkYjogRGF0YWJhc2UsXG4gIGJ1czogRXZlbnRCdXMsXG4gIGRvY3NEaXI6IHN0cmluZyxcbiAgaW5wdXQ6IFJhdGlmeUJhdGNoSW5wdXQsXG4pOiBSYXRpZnlCYXRjaFJlc3VsdCB7XG4gIGlmIChpbnB1dC5ydWxpbmcgPT09IFwicmVqZWN0XCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInJhdGlmeS1iYXRjaCBkb2VzIG5vdCByZWplY3Qg4oCUIGEgcmVqZWN0IGV4Y2x1ZGVzIGEgcHJvcG9zYWwgZnJvbSB0aGUgYmF0Y2ggKHJlamVjdCBpdCBzaW5nbHkpXCIsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFBhcnRpdGlvbiBieSBraW5kIChsb29rIHVwIGVhY2ggaWQg4oCUIHRoZSBjYWxsZXIgc3VwcGxpZXMgbm8gb3JkZXJpbmcpLlxuICBjb25zdCBub2RlSWRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBlZGdlSWRzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGlkIG9mIGlucHV0Lmlkcykge1xuICAgIGNvbnN0IHJvdyA9IGRiLnF1ZXJ5KFwiU0VMRUNUIGtpbmQgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIpLmdldChpZCkgYXMge1xuICAgICAga2luZDogc3RyaW5nO1xuICAgIH0gfCBudWxsO1xuICAgIGlmICghcm93KSB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gcHJvcG9zYWw6ICR7aWR9YCk7XG4gICAgaWYgKHJvdy5raW5kID09PSBcIm5vZGVcIikgbm9kZUlkcy5wdXNoKGlkKTtcbiAgICBlbHNlIGVkZ2VJZHMucHVzaChpZCk7XG4gIH1cblxuICBjb25zdCBpZE1hcDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBjb25zdCBidWlsdDogQnVpbHRSYXRpZnlbXSA9IFtdO1xuICBjb25zdCByYXRpZmllZDogUmF0aWZ5UmVzdWx0W10gPSBbXTtcblxuICAvLyBOb2RlcyBmaXJzdCDigJQgYnVpbGQgKG1pbnRzIGlkcyArIHZhbGlkYXRlcykgYW5kIHJlZ2lzdGVyIGluIHRoZSBpZE1hcCBzb1xuICAvLyBlZGdlcyArIGFuY2hvcnMgY2FuIHJlc29sdmUgdGhlaXIgcmVmcyBiZWZvcmUgYW55IHdyaXRlIGxhbmRzLlxuICBmb3IgKGNvbnN0IGlkIG9mIG5vZGVJZHMpIHtcbiAgICBjb25zdCBiID0gYnVpbGRSYXRpZnkoZGIsIGRvY3NEaXIsIHsgcHJvcG9zYWxJZDogaWQsIHJ1bGluZzogaW5wdXQucnVsaW5nIH0sIGJ1cyk7XG4gICAgaWRNYXBbaWRdID0gYi5yZXN1bHQubm9kZUlkIGFzIHN0cmluZztcbiAgICBidWlsdC5wdXNoKGIpO1xuICAgIHJhdGlmaWVkLnB1c2goYi5yZXN1bHQpO1xuICB9XG4gIC8vIEVkZ2VzIOKAlCByZXNvbHZlIGVuZHBvaW50cyB2aWEgaWRNYXAgZmlyc3QgKGEgYmF0Y2hlZCBub2RlIHByb3Bvc2FsJ3NcbiAgLy8gcmVzdWx0X25vZGVfaWQgaXNuJ3Qgd3JpdHRlbiB1bnRpbCBpdHMgYXBwbHkgcnVucyBpbiB0aGUgdHhuKSwgdGhlbiByZWFsXG4gIC8vIGlkcyAvIHJlc3VsdF9ub2RlX2lkIHZpYSByZXNvbHZlTm9kZVJlZiAod2hpY2ggdGhyb3dzIGZvciBhbiB1bnJhdGlmaWVkLFxuICAvLyB1bmxpc3RlZCBub2RlIHByb3Bvc2FsIOKAlCB0aGUgTk8tYXV0by1pbmNsdWRlIGd1YXJhbnRlZSkuXG4gIGNvbnN0IHJlc29sdmVyID0gKHJlZjogc3RyaW5nKSA9PiBpZE1hcFtyZWZdID8/IHJlc29sdmVOb2RlUmVmKGRiLCByZWYpO1xuICBmb3IgKGNvbnN0IGlkIG9mIGVkZ2VJZHMpIHtcbiAgICBjb25zdCBiID0gYnVpbGRSYXRpZnkoZGIsIGRvY3NEaXIsIHsgcHJvcG9zYWxJZDogaWQsIHJ1bGluZzogaW5wdXQucnVsaW5nIH0sIGJ1cywgcmVzb2x2ZXIpO1xuICAgIGJ1aWx0LnB1c2goYik7XG4gICAgcmF0aWZpZWQucHVzaChiLnJlc3VsdCk7XG4gIH1cblxuICAvLyBBbmNob3JzIOKAlCByZXNvbHZlIHJlZnMgdmlhIGlkTWFwLXRoZW4tcmVhbCwgc3RydWN0dXJhbCBwcmUtY2hlY2sgKGJvdGhcbiAgLy8gcmVzb2x2ZTsgbm8gc2VsZi1hbmNob3IpLiBUaGUgZnVsbCBhbmNob3JHdWFyZCAoZXhpc3RlbmNlICsgY3ljbGUgd2FsaylcbiAgLy8gcnVucyBJTlNJREUgdGhlIHR4biBhZnRlciBub2RlIGluc2VydHMsIHNpbmNlIGEganVzdC1taW50ZWQgbm9kZSBoYXMgbm9cbiAgLy8gcm93IHlldCDigJQgYXRvbWljYWxseSBlcXVpdmFsZW50IChhIHRocm93IHJvbGxzIHRoZSB0eG4gYmFjaykuXG4gIGNvbnN0IGFuY2hvclBsYW4gPSAoaW5wdXQuYW5jaG9ycyA/PyBbXSkubWFwKChhKSA9PiB7XG4gICAgY29uc3Qgbm9kZSA9IGlkTWFwW2Eubm9kZV0gPz8gYS5ub2RlO1xuICAgIGNvbnN0IHBhcmVudCA9IGlkTWFwW2EucGFyZW50XSA/PyBhLnBhcmVudDtcbiAgICBpZiAobm9kZSA9PT0gcGFyZW50KSB0aHJvdyBuZXcgRXJyb3IoYGFuY2hvcjogYSBub2RlIGNhbm5vdCBhbmNob3IgdG8gaXRzZWxmICgke25vZGV9KWApO1xuICAgIC8vIEEgcmVmIHRoYXQgaXMgbmVpdGhlciBhIGJhdGNoZWQgbm9kZSBub3IgYW4gZXhpc3RpbmcgcmVhbCBub2RlIGNhbiBuZXZlclxuICAgIC8vIHJlc29sdmUg4oCUIGZhaWwgbG91ZCBiZWZvcmUgdGhlIHR4bi5cbiAgICBmb3IgKGNvbnN0IFtsYWJlbCwgcmVmXSBvZiBbXG4gICAgICBbXCJub2RlXCIsIG5vZGVdLFxuICAgICAgW1wicGFyZW50XCIsIHBhcmVudF0sXG4gICAgXSBhcyBjb25zdCkge1xuICAgICAgY29uc3QgaW5CYXRjaCA9IE9iamVjdC52YWx1ZXMoaWRNYXApLmluY2x1ZGVzKHJlZik7XG4gICAgICBjb25zdCBpc1JlYWwgPSBkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gbm9kZXMgV0hFUkUgaWQgPSA/XCIpLmdldChyZWYpICE9PSBudWxsO1xuICAgICAgaWYgKCFpbkJhdGNoICYmICFpc1JlYWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBhbmNob3I6ICR7bGFiZWx9ICR7cmVmfSBpcyBub3QgYSBiYXRjaGVkIG5vZGUgcHJvcG9zYWwgb3IgYSByZWFsIG5vZGVgKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHsgbm9kZSwgcGFyZW50IH07XG4gIH0pO1xuXG4gIGNvbnN0IHJ1biA9IGRiLnRyYW5zYWN0aW9uKCgpID0+IHtcbiAgICBmb3IgKGNvbnN0IGIgb2YgYnVpbHQpIGIuYXBwbHkoKTtcbiAgICBmb3IgKGNvbnN0IHAgb2YgYW5jaG9yUGxhbikge1xuICAgICAgYW5jaG9yR3VhcmQoZGIsIHAubm9kZSwgcC5wYXJlbnQpO1xuICAgICAgZGIucnVuKFwiVVBEQVRFIG5vZGVzIFNFVCBhbmNob3Jfbm9kZV9pZCA9ID8gV0hFUkUgaWQgPSA/XCIsIFtwLnBhcmVudCwgcC5ub2RlXSk7XG4gICAgfVxuICB9KTtcbiAgcnVuKCk7XG5cbiAgLy8gQUZURVIgY29tbWl0IG9ubHkg4oCUIGEgcm9sbGJhY2sgbXVzdCBuZXZlciBsZWFrIGEgY2hhbmdlbG9nIGxpbmUgb3IgZXZlbnQuXG4gIGZvciAoY29uc3QgYiBvZiBidWlsdCkge1xuICAgIGlmIChiLmNoYW5nZWxvZ0xpbmUpIGFwcGVuZEZpbGVTeW5jKGpvaW4oZG9jc0RpciwgXCIuLlwiLCBcImNoYW5nZWxvZy50eHRcIiksIGIuY2hhbmdlbG9nTGluZSk7XG4gICAgYi5lbWl0KCk7XG4gIH1cbiAgZm9yIChjb25zdCBwIG9mIGFuY2hvclBsYW4pIHtcbiAgICBidXMuZW1pdChcIm5vZGUuYW5jaG9yZWRcIiwgeyBub2RlSWQ6IHAubm9kZSwgYW5jaG9yTm9kZUlkOiBwLnBhcmVudCB9KTtcbiAgfVxuXG4gIHJldHVybiB7IGlkTWFwLCByYXRpZmllZCB9O1xufVxuXG5leHBvcnQgdHlwZSB7IFJhdGlmeUJhdGNoSW5wdXQsIFJhdGlmeUJhdGNoUmVzdWx0LCBSYXRpZnlJbnB1dCwgUmF0aWZ5UmVzdWx0LCBSdWxpbmcgfTtcbmV4cG9ydCB7IHJhdGlmeSwgcmF0aWZ5QmF0Y2gsIFpvbmVkRXJyb3IgfTtcbiIsCiAgICAiLy8gUDMg4oCUIGBzZWFyY2ggPHF1ZXJ5PmAgYmFja2luZywgcGVyIHByb3NwZXJvJ3MgcnVsaW5nICh2aW5lIG1zZyAzNik6IE9ORVxuLy8gdHlwZWQtaGl0IHNoYXBlIHNoYXJlZCBieSB0aGUgc2VhcmNoIHBhbGV0dGUgKGtpbmQ6XCJub2RlXCIgb25seSkgYW5kIHRoZVxuLy8gYWdlbnQncyBzZWFyY2ggdmVyYiAodGhlIGZ1bGwgc2V0KSDigJQge2hpdHM6IFt7a2luZCwgaWQsIHRpdGxlLCBzbmlwcGV0Pyxcbi8vIHNjb3JlfV19LiBOb2RlcyBhcmUgc2VhcmNoZWQgYnkgdGl0bGUvc3lub3BzaXMgKExJS0Ug4oCUIG15IGNob2ljZSBwZXIgdGhlXG4vLyBydWxpbmcpOyBkb2NzICsgbWVzc2FnZXMgdmlhIEZUUzUuIE5vZGUgaGl0cyByYW5rIGZpcnN0IGF0IGFuIGVxdWFsIHNjb3JlXG4vLyAodGhlIHJ1bGluZydzIHRpZS1icmVhaykuIFYxIHN0YXlzIGxleGljYWwtb25seSAobm8gZW1iZWRkaW5ncy9zaW1pbGFyLFxuLy8gcHJvcG9zYWwubWQncyBleHBsaWNpdCBhYnNlbmNlKSDigJQgdGhlIHNoYXBlIGxlYXZlcyByb29tIGZvciBhIGZ1dHVyZVxuLy8gYGtpbmQ6IFwidmVjdG9yXCJgIGhpdCB3aXRob3V0IGEgYnJlYWtpbmcgY2hhbmdlLlxuXG5pbXBvcnQgdHlwZSB7IERhdGFiYXNlIH0gZnJvbSBcImJ1bjpzcWxpdGVcIjtcblxuaW50ZXJmYWNlIFNlYXJjaEhpdCB7XG4gIGtpbmQ6IFwibm9kZVwiIHwgXCJkb2NcIiB8IFwibWVzc2FnZVwiIHwgXCJwcm9wb3NhbFwiO1xuICBpZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBzbmlwcGV0Pzogc3RyaW5nO1xuICBzY29yZTogbnVtYmVyO1xuICAvLyBSb3VuZCAzIChDbGFpbSBTMSk6IHByb3Bvc2FsIGhpdHMgY2FycnkgdGhlaXIgem9uZSB0YWcgKG51bGwgPSBtYWluXG4gIC8vIHF1ZXVlKSBzbyB0aGUgcGFsZXR0ZSBjYW4gc3dpdGNoIHRvIHRoZSB6b25lIHZpZXcgYmVmb3JlIGZvY3VzaW5nLlxuICB6b25lSWQ/OiBzdHJpbmcgfCBudWxsO1xufVxuXG4vLyBGVFM1J3MgYmFyZXdvcmQgcXVlcnkgc3ludGF4IHRyZWF0cyBoeXBoZW5zL2NvbG9ucyBhcyBvcGVyYXRvcnMg4oCUIHF1b3Rpbmdcbi8vIHRoZSB3aG9sZSBxdWVyeSBhcyBvbmUgcGhyYXNlIHNpZGVzdGVwcyB0aGF0IChWMSBpcyBwbGFpbiBzdWJzdHJpbmctaXNoXG4vLyBsZXhpY2FsIHNlYXJjaCwgbm90IGEgcXVlcnktRFNMIHN1cmZhY2UgZm9yIHRoZSBodW1hbi9hZ2VudCB0byBsZWFybikuXG5mdW5jdGlvbiBmdHNQaHJhc2UocXVlcnk6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgXCIke3F1ZXJ5LnJlcGxhY2UoL1wiL2csICdcIlwiJyl9XCJgO1xufVxuXG5mdW5jdGlvbiBzZWFyY2goZGI6IERhdGFiYXNlLCBxdWVyeTogc3RyaW5nKTogU2VhcmNoSGl0W10ge1xuICBjb25zdCBsaWtlID0gYCUke3F1ZXJ5LnJlcGxhY2UoL1slX10vZywgKGMpID0+IGBcXFxcJHtjfWApfSVgO1xuICBjb25zdCBub2RlUm93cyA9IGRiXG4gICAgLnF1ZXJ5KFxuICAgICAgYFNFTEVDVCBpZCwgdGl0bGUsIHN5bm9wc2lzLFxuICAgICAgICAgICAgICAoQ0FTRSBXSEVOIHRpdGxlIExJS0UgPyBFU0NBUEUgJ1xcXFwnIFRIRU4gMiBFTFNFIDEgRU5EKSBhcyBzY29yZVxuICAgICAgIEZST00gbm9kZXMgV0hFUkUgdGl0bGUgTElLRSA/IEVTQ0FQRSAnXFxcXCcgT1Igc3lub3BzaXMgTElLRSA/IEVTQ0FQRSAnXFxcXCdgLFxuICAgIClcbiAgICAuYWxsKGxpa2UsIGxpa2UsIGxpa2UpIGFzIEFycmF5PHtcbiAgICBpZDogc3RyaW5nO1xuICAgIHRpdGxlOiBzdHJpbmc7XG4gICAgc3lub3BzaXM6IHN0cmluZztcbiAgICBzY29yZTogbnVtYmVyO1xuICB9PjtcbiAgY29uc3Qgbm9kZUhpdHM6IFNlYXJjaEhpdFtdID0gbm9kZVJvd3MubWFwKChyb3cpID0+ICh7XG4gICAga2luZDogXCJub2RlXCIsXG4gICAgaWQ6IHJvdy5pZCxcbiAgICB0aXRsZTogcm93LnRpdGxlLFxuICAgIHNuaXBwZXQ6IHJvdy5zeW5vcHNpcyB8fCB1bmRlZmluZWQsXG4gICAgc2NvcmU6IHJvdy5zY29yZSAqIDEwLCAvLyBub2RlIGhpdHMgb3V0cmFuayBsZXhpY2FsIEZUUyBzY29yZXMgYXQgYW55IHRpZVxuICB9KSk7XG5cbiAgLy8gUm91bmQgMyAoQ2xhaW0gUzEpOiBwZW5kaW5nIHByb3Bvc2FscywgbWF0Y2hlZCBpbiBKUyBvdmVyIHRoZSBQQVJTRURcbiAgLy8gZHJhZnQgKFNRTCBMSUtFIG92ZXIgcmF3IGRyYWZ0X2pzb24gbWF0Y2hlcyBrZXkgbmFtZXMgYW5kIGVzY2FwZVxuICAvLyBzZXF1ZW5jZXMg4oCUIHJ1bGVkIG91dCBhdCByYXRpZnkpLiBTY29yZSA9IHRoZSBub2RlIGZvcm11bGEgw5c5ICh0aXRsZSAxOCAvXG4gIC8vIHN5bm9wc2lzIDkpOiBtYXRjaCBxdWFsaXR5IGRvbWluYXRlcyB0aWVyLCBhbmQgYW4gZXF1YWwtcXVhbGl0eSBtYXRjaFxuICAvLyByYW5rcyB0aGUgcmF0aWZpZWQgbm9kZSBmaXJzdCAoMjAvMTAgdnMgMTgvOSkuXG4gIGNvbnN0IGxvd2VyUXVlcnkgPSBxdWVyeS50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBwcm9wb3NhbFJvd3MgPSBkYlxuICAgIC5xdWVyeShcIlNFTEVDVCBpZCwgZHJhZnRfanNvbiwgem9uZV9pZCBGUk9NIHByb3Bvc2FscyBXSEVSRSBzdGF0dXMgPSAncGVuZGluZydcIilcbiAgICAuYWxsKCkgYXMgQXJyYXk8eyBpZDogc3RyaW5nOyBkcmFmdF9qc29uOiBzdHJpbmc7IHpvbmVfaWQ6IHN0cmluZyB8IG51bGwgfT47XG4gIGNvbnN0IHByb3Bvc2FsSGl0czogU2VhcmNoSGl0W10gPSBbXTtcbiAgaWYgKGxvd2VyUXVlcnkgIT09IFwiXCIpIHtcbiAgICBmb3IgKGNvbnN0IHJvdyBvZiBwcm9wb3NhbFJvd3MpIHtcbiAgICAgIGxldCBkcmFmdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB0cnkge1xuICAgICAgICBkcmFmdCA9IEpTT04ucGFyc2Uocm93LmRyYWZ0X2pzb24pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlOyAvLyBhbiB1bnBhcnNhYmxlIGRyYWZ0IHNpbXBseSBjYW4ndCBtYXRjaFxuICAgICAgfVxuICAgICAgY29uc3QgdGl0bGUgPSB0eXBlb2YgZHJhZnQudGl0bGUgPT09IFwic3RyaW5nXCIgPyBkcmFmdC50aXRsZSA6IFwiXCI7XG4gICAgICBjb25zdCBzeW5vcHNpcyA9IHR5cGVvZiBkcmFmdC5zeW5vcHNpcyA9PT0gXCJzdHJpbmdcIiA/IGRyYWZ0LnN5bm9wc2lzIDogXCJcIjtcbiAgICAgIGNvbnN0IHRpdGxlTWF0Y2ggPSB0aXRsZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGxvd2VyUXVlcnkpO1xuICAgICAgY29uc3Qgc3lub3BzaXNNYXRjaCA9IHN5bm9wc2lzLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobG93ZXJRdWVyeSk7XG4gICAgICBpZiAoIXRpdGxlTWF0Y2ggJiYgIXN5bm9wc2lzTWF0Y2gpIGNvbnRpbnVlO1xuICAgICAgcHJvcG9zYWxIaXRzLnB1c2goe1xuICAgICAgICBraW5kOiBcInByb3Bvc2FsXCIsXG4gICAgICAgIGlkOiByb3cuaWQsXG4gICAgICAgIHRpdGxlOiB0aXRsZSB8fCBcIlVudGl0bGVkXCIsXG4gICAgICAgIHNuaXBwZXQ6IHN5bm9wc2lzIHx8IHVuZGVmaW5lZCxcbiAgICAgICAgc2NvcmU6ICh0aXRsZU1hdGNoID8gMiA6IDEpICogOSxcbiAgICAgICAgem9uZUlkOiByb3cuem9uZV9pZCxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHBocmFzZSA9IGZ0c1BocmFzZShxdWVyeSk7XG4gIGNvbnN0IGRvY1Jvd3MgPSBkYlxuICAgIC5xdWVyeShcbiAgICAgIGBTRUxFQ1QgZG9jcy5pZCBhcyBpZCwgZG9jcy50aXRsZSBhcyB0aXRsZSwgcmFuayBhcyByYW5rLFxuICAgICAgICAgICAgICBzbmlwcGV0KGRvY3NfZnRzLCAxLCAnJywgJycsICcuLi4nLCA4KSBhcyBzbmlwcGV0XG4gICAgICAgRlJPTSBkb2NzX2Z0cyBKT0lOIGRvY3MgT04gZG9jcy5pZCA9IGRvY3NfZnRzLmRvY19pZFxuICAgICAgIFdIRVJFIGRvY3NfZnRzIE1BVENIID8gT1JERVIgQlkgcmFua2AsXG4gICAgKVxuICAgIC5hbGwocGhyYXNlKSBhcyBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IHJhbms6IG51bWJlcjsgc25pcHBldDogc3RyaW5nIH0+O1xuICBjb25zdCBkb2NIaXRzOiBTZWFyY2hIaXRbXSA9IGRvY1Jvd3MubWFwKChyb3cpID0+ICh7XG4gICAga2luZDogXCJkb2NcIixcbiAgICBpZDogcm93LmlkLFxuICAgIHRpdGxlOiByb3cudGl0bGUsXG4gICAgc25pcHBldDogcm93LnNuaXBwZXQsXG4gICAgc2NvcmU6IC1yb3cucmFuayxcbiAgfSkpO1xuXG4gIGNvbnN0IG1lc3NhZ2VSb3dzID0gZGJcbiAgICAucXVlcnkoXG4gICAgICBgU0VMRUNUIG1lc3NhZ2VzLmlkIGFzIGlkLCBtZXNzYWdlcy50ZXh0IGFzIHRleHQsIHJhbmsgYXMgcmFuayxcbiAgICAgICAgICAgICAgc25pcHBldChtZXNzYWdlc19mdHMsIDEsICcnLCAnJywgJy4uLicsIDgpIGFzIHNuaXBwZXRcbiAgICAgICBGUk9NIG1lc3NhZ2VzX2Z0cyBKT0lOIG1lc3NhZ2VzIE9OIG1lc3NhZ2VzLmlkID0gbWVzc2FnZXNfZnRzLm1lc3NhZ2VfaWRcbiAgICAgICBXSEVSRSBtZXNzYWdlc19mdHMgTUFUQ0ggPyBPUkRFUiBCWSByYW5rYCxcbiAgICApXG4gICAgLmFsbChwaHJhc2UpIGFzIEFycmF5PHsgaWQ6IHN0cmluZzsgdGV4dDogc3RyaW5nOyByYW5rOiBudW1iZXI7IHNuaXBwZXQ6IHN0cmluZyB9PjtcbiAgY29uc3QgbWVzc2FnZUhpdHM6IFNlYXJjaEhpdFtdID0gbWVzc2FnZVJvd3MubWFwKChyb3cpID0+ICh7XG4gICAga2luZDogXCJtZXNzYWdlXCIsXG4gICAgaWQ6IHJvdy5pZCxcbiAgICB0aXRsZTogcm93LnRleHQsXG4gICAgc25pcHBldDogcm93LnNuaXBwZXQsXG4gICAgc2NvcmU6IC1yb3cucmFuayxcbiAgfSkpO1xuXG4gIHJldHVybiBbLi4ubm9kZUhpdHMsIC4uLnByb3Bvc2FsSGl0cywgLi4uZG9jSGl0cywgLi4ubWVzc2FnZUhpdHNdLnNvcnQoKGEsIGIpID0+IHtcbiAgICBpZiAoYi5zY29yZSAhPT0gYS5zY29yZSkgcmV0dXJuIGIuc2NvcmUgLSBhLnNjb3JlO1xuICAgIGlmIChhLmtpbmQgPT09IFwibm9kZVwiICYmIGIua2luZCAhPT0gXCJub2RlXCIpIHJldHVybiAtMTtcbiAgICBpZiAoYi5raW5kID09PSBcIm5vZGVcIiAmJiBhLmtpbmQgIT09IFwibm9kZVwiKSByZXR1cm4gMTtcbiAgICByZXR1cm4gMDtcbiAgfSk7XG59XG5cbmV4cG9ydCB0eXBlIHsgU2VhcmNoSGl0IH07XG5leHBvcnQgeyBzZWFyY2ggfTtcbiIsCiAgICAiLy8gUDIg4oCUIGBzZW5kIDx0ZXh0PmAgQ0xJIHZlcmIgYmFja2luZzogYXBwZW5kcyBhIG1lc3NhZ2VzIHJvdywgZW1pdHNcbi8vIG1lc3NhZ2UucG9zdGVkLiBBZ2VudCBpZGVudGl0eSBpcyB0aGUgYHJvbGVgIGZpZWxkLCBub3QgYSBzZXBhcmF0ZSB0YWJsZVxuLy8gKG1hdGNoZXMgdGhlIHNwaWtlJ3MgZmxhdC1wcm92ZW5hbmNlIHRhc3RlKS4gQ2xhaW0gQTogdGhpcyBzdG9yZXMsIGl0XG4vLyBkb2Vzbid0IGludGVycHJldCDigJQgcmVwbHlpbmcgaXMgdGhlIGNhc3RpbmcgYWdlbnQncyBqb2IgdmlhIGEgbGF0ZXIgc2VuZC5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgeyB0eXBlIEV2ZW50QnVzLCBNRVNTQUdFX0NIQU5ORUxTIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IE1lc3NhZ2UgfSBmcm9tIFwiLi9zdGF0ZS50c1wiO1xuXG5pbnRlcmZhY2UgU2VuZElucHV0IHtcbiAgcm9sZTogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG4gIGtpbmQ6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xuICBncm91bmQ/OiBzdHJpbmdbXTtcbn1cblxuLy8gUm91bmQgMTEgKFNFQU0gMSk6IGEgbWVzc2FnZSdzIGBraW5kYCBpcyBpdHMgQ0hBTk5FTCDigJQgdGhlIGFmZm9yZGFuY2UgaXRcbi8vIGFycml2ZWQgdGhyb3VnaC4gVGhlIHZvY2FidWxhcnkgaXMga25vd24gYnV0IE5PVCBjbG9zZWQ6IGFuIHVua25vd24gY2hhbm5lbFxuLy8gc3RvcmVzIHZlcmJhdGltIGFuZCBkcmF3cyBhbiBBRFZJU09SWSBpbnN0ZWFkIG9mIGEgNDAwIChwcm9wb3NlLnRzJ3Ncbi8vIGVkZ2VEcmFmdFdhcm5pbmcgcHJlY2VkZW50IOKAlCBhIGNvbnN1bWVyIHJlYWRzIHNwZWNpZmljIHZhbHVlcywgc28gaW50YWtlIHNheXNcbi8vIHNvIGluIHRoZSBzYW1lIHR1cm47IFwidG9sZXJhbnRcIiBib3VuZHMgd2hhdCB3ZSByZWplY3QsIG5vdCB3aGF0IHdlIHNheSkuIFRoaXNcbi8vIGlzIHdoYXQgdHVybnMgYSB0eXBvJ2QgY2hhbm5lbCBmcm9tIFwic2lsZW50bHkgcmVuZGVyZWQgYXMgYSBwbGFpbiB0dXJuXCIgaW50b1xuLy8gYW4gaW1tZWRpYXRlLCBzZWxmLWRvY3VtZW50aW5nIHNpZ25hbCBhdCB0aGUgbW9tZW50IG9mIHNlbmRpbmcuXG5mdW5jdGlvbiBjaGFubmVsV2FybmluZyhraW5kOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoKE1FU1NBR0VfQ0hBTk5FTFMgYXMgcmVhZG9ubHkgc3RyaW5nW10pLmluY2x1ZGVzKGtpbmQpKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gYGtpbmQgXCIke2tpbmR9XCIgaXMgbm90IGEga25vd24gbWVzc2FnZSBjaGFubmVsICgke01FU1NBR0VfQ0hBTk5FTFMuam9pbihcIiwgXCIpfSkg4oCUIGl0IHdhcyBzdG9yZWQgdmVyYmF0aW0sIGJ1dCB0aGUgc3VyZmFjZSByZW5kZXJzIHVua25vd24gY2hhbm5lbHMgZ2VuZXJpY2FsbHkuIENoYW5uZWxzIGFyZSBvcGVuIGJ5IGRlc2lnbjsgYWRkIGl0IHRvIE1FU1NBR0VfQ0hBTk5FTFMgaWYgaXQncyByZWFsLmA7XG59XG5cbmZ1bmN0aW9uIG5leHRTZXEoZGI6IERhdGFiYXNlLCBwcm9qZWN0SWQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHJvdyA9IGRiXG4gICAgLnF1ZXJ5KFwiU0VMRUNUIENPQUxFU0NFKE1BWChzZXEpLCAwKSBhcyBtYXhTZXEgRlJPTSBtZXNzYWdlcyBXSEVSRSBwcm9qZWN0X2lkID0gP1wiKVxuICAgIC5nZXQocHJvamVjdElkKSBhcyB7IG1heFNlcTogbnVtYmVyIH07XG4gIHJldHVybiByb3cubWF4U2VxICsgMTtcbn1cblxuZnVuY3Rpb24gc2VuZE1lc3NhZ2UoZGI6IERhdGFiYXNlLCBidXM6IEV2ZW50QnVzLCBwcm9qZWN0SWQ6IHN0cmluZywgaW5wdXQ6IFNlbmRJbnB1dCk6IE1lc3NhZ2Uge1xuICBjb25zdCBpZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gIGNvbnN0IHNlcSA9IG5leHRTZXEoZGIsIHByb2plY3RJZCk7XG4gIGNvbnN0IGdyb3VuZCA9IGlucHV0Lmdyb3VuZCA/PyBudWxsO1xuICBjb25zdCB0cyA9IE1hdGguZmxvb3IoRGF0ZS5ub3coKSAvIDEwMDApO1xuXG4gIGRiLnJ1bihcbiAgICBcIklOU0VSVCBJTlRPIG1lc3NhZ2VzIChpZCwgcHJvamVjdF9pZCwgc2VxLCByb2xlLCBraW5kLCB0ZXh0LCBncm91bmRfanNvbiwgdHMpIFZBTFVFUyAoPywgPywgPywgPywgPywgPywgPywgPylcIixcbiAgICBbXG4gICAgICBpZCxcbiAgICAgIHByb2plY3RJZCxcbiAgICAgIHNlcSxcbiAgICAgIGlucHV0LnJvbGUsXG4gICAgICBpbnB1dC5raW5kLFxuICAgICAgaW5wdXQudGV4dCxcbiAgICAgIGdyb3VuZCA/IEpTT04uc3RyaW5naWZ5KGdyb3VuZCkgOiBudWxsLFxuICAgICAgdHMsXG4gICAgXSxcbiAgKTtcbiAgZGIucnVuKFxuICAgIFwiSU5TRVJUIElOVE8gbWVzc2FnZXNfZnRzIChyb3dpZCwgbWVzc2FnZV9pZCwgY29udGVudCkgVkFMVUVTIChsYXN0X2luc2VydF9yb3dpZCgpLCA/LCA/KVwiLFxuICAgIFtpZCwgaW5wdXQudGV4dF0sXG4gICk7XG5cbiAgY29uc3QgbWVzc2FnZTogTWVzc2FnZSA9IHtcbiAgICBpZCxcbiAgICBzZXEsXG4gICAgcm9sZTogaW5wdXQucm9sZSxcbiAgICBraW5kOiBpbnB1dC5raW5kLFxuICAgIHRleHQ6IGlucHV0LnRleHQsXG4gICAgZ3JvdW5kLFxuICAgIHRzLFxuICB9O1xuICBidXMuZW1pdChcIm1lc3NhZ2UucG9zdGVkXCIsIG1lc3NhZ2UgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5leHBvcnQgdHlwZSB7IFNlbmRJbnB1dCB9O1xuZXhwb3J0IHsgY2hhbm5lbFdhcm5pbmcsIHNlbmRNZXNzYWdlIH07XG4iLAogICAgIi8vIFJvdW5kIDMgKENsYWltcyBaMS9aMikg4oCUIHpvbmVzOiBuYW1lZCBzdGFnaW5nIHBlbnMgZm9yIHByb3Bvc2FscywgYW5kXG4vLyBwcm9tb3Rpb24gb3V0IG9mIHRoZW0uIEEgem9uZSBpcyBhIHBsYWNlIHdoZXJlIGV2ZXJ5dGhpbmcgaXMgc3RhZ2luZyBhbmRcbi8vIG1lc3MgaXMgbGljZW5zZWQ7IHRoZSBtYXAtYXMtdmlldyBsaXRtdXMgYXBwbGllcyBvbmx5IGF0IHRoZSBwcm9tb3Rpb25cbi8vIGJvdW5kYXJ5LiBab25lIGNvbnRlbnRzIGFyZSBQUk9QT1NBTFMgT05MWSDigJQgbm9kZXMvZWRnZXMgbmV2ZXIgY2FycnkgYVxuLy8gem9uZV9pZC4gVGhlIGRhZW1vbiBzdGF5cyBkdW1iIChDb250cmFjdCA4KTogem9uZXMvcHJvbW90aW9uIGFyZSBzdG9yYWdlXG4vLyBtb3Zlcywgbm90aGluZyBlbHNlLlxuLy9cbi8vIFdpcmUgbm90ZXMgKHJhdGlmaWVkKTogem9uZSBpZHMgYXJlIFNMVUdTIGRlcml2ZWQgZnJvbSB0aGUgbmFtZSAoc2FtZVxuLy8gZGVyaXZhdGlvbiBhcyBgcHJvamVjdHMgLS1jcmVhdGVgKSDigJQgY29udmVyc2F0aW9uYWwgcmVmZXJlbmNlYWJpbGl0eTsgbm9cbi8vIHJlbmFtZSB0aGlzIHJvdW5kLiBFdmVudHMgYXJlIHByb2plY3Qtc2NvcGVkIGFuZCBjYW4gbmV2ZXIgYmUgem9uZS1zY29wZWRcbi8vIChvbmUgYnVzIHBlciBwcm9qZWN0KSwgc28gcGF5bG9hZC10YWdnaW5nIGlzIHRoZSBtZWNoYW5pc206IHRoZSBQcm9wb3NhbFxuLy8gd2lyZSB0eXBlIGNhcnJpZXMgYHpvbmVJZGAgYW5kIGNvbnN1bWVycyBmaWx0ZXIg4oCUIHpvbmUuY3JlYXRlZC96b25lLmRlbGV0ZWRcbi8vIGFyZSBUSElOLCBhbmQgb24gem9uZS5kZWxldGVkIGNvbnN1bWVycyBkcm9wIHRoYXQgem9uZSdzIHByb3Bvc2FscyBsb2NhbGx5XG4vLyAoc2NvcGVkIGRyb3AsIG5ldmVyIHdob2xlc2FsZSByZXBsYWNlKS5cblxuaW1wb3J0IHR5cGUgeyBEYXRhYmFzZSB9IGZyb20gXCJidW46c3FsaXRlXCI7XG5pbXBvcnQgdHlwZSB7IEV2ZW50QnVzIH0gZnJvbSBcIi4vZXZlbnRzLnRzXCI7XG5pbXBvcnQgeyBTTFVHX1JFIH0gZnJvbSBcIi4vcHJvamVjdC50c1wiO1xuaW1wb3J0IHsgcmVhZFByb3Bvc2FsQnlJZCB9IGZyb20gXCIuL3N0YXRlLnRzXCI7XG5cbmludGVyZmFjZSBab25lIHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBzbHVnaWZ5KG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBuYW1lXG4gICAgLnRvTG93ZXJDYXNlKClcbiAgICAucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIilcbiAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlWm9uZShkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIG5hbWU6IHN0cmluZyk6IFpvbmUge1xuICBpZiAodHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgbmFtZS50cmltKCkgPT09IFwiXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ6b25lIGNyZWF0ZSByZXF1aXJlcyBhIG5hbWVcIik7XG4gIH1cbiAgY29uc3QgaWQgPSBzbHVnaWZ5KG5hbWUpO1xuICBpZiAoIVNMVUdfUkUudGVzdChpZCkpIHRocm93IG5ldyBFcnJvcihgem9uZSBuYW1lIGRvZXMgbm90IHlpZWxkIGEgdmFsaWQgc2x1ZzogJHtuYW1lfWApO1xuICBpZiAoZGIucXVlcnkoXCJTRUxFQ1QgMSBGUk9NIHpvbmVzIFdIRVJFIGlkID0gP1wiKS5nZXQoaWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB6b25lIGFscmVhZHkgZXhpc3RzOiAke2lkfWApO1xuICB9XG4gIGRiLnJ1bihcIklOU0VSVCBJTlRPIHpvbmVzIChpZCwgbmFtZSkgVkFMVUVTICg/LCA/KVwiLCBbaWQsIG5hbWVdKTtcbiAgY29uc3Qgem9uZTogWm9uZSA9IHsgaWQsIG5hbWUgfTtcbiAgYnVzLmVtaXQoXCJ6b25lLmNyZWF0ZWRcIiwgeyBpZCwgbmFtZSB9KTtcbiAgcmV0dXJuIHpvbmU7XG59XG5cbmZ1bmN0aW9uIGxpc3Rab25lcyhkYjogRGF0YWJhc2UpOiBab25lW10ge1xuICByZXR1cm4gZGIucXVlcnkoXCJTRUxFQ1QgaWQsIG5hbWUgRlJPTSB6b25lcyBPUkRFUiBCWSB0cywgaWRcIikuYWxsKCkgYXMgWm9uZVtdO1xufVxuXG4vLyBBIHpvbmUtbm90LWVtcHR5IGd1YXJkIG1pcnJvcmluZyBkb2MgZGVsZXRlJ3MgY2l0ZWQgZmxvdzogZGVsZXRpbmcgYSB6b25lXG4vLyBkaXNjYXJkcyBpdHMgcHJvcG9zYWxzIHdob2xlc2FsZSAodGhlIGRpc3Bvc2FibGUtc2FuZGJveCBwcm9wZXJ0eSksIHNvIGFcbi8vIHBvcHVsYXRlZCB6b25lIG5lZWRzIGFuIGV4cGxpY2l0IHllcyDigJQgdGhlIGVycm9yIGNhcnJpZXMgdGhlIGNvdW50IHRoZVxuLy8gY29uZmlybSBhZmZvcmRhbmNlIHJlbmRlcnMuXG5jbGFzcyBab25lTm90RW1wdHlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcHJvcG9zYWxzOiBudW1iZXI7XG4gIGNvbnN0cnVjdG9yKHByb3Bvc2FsczogbnVtYmVyKSB7XG4gICAgc3VwZXIoYHpvbmUgaG9sZHMgJHtwcm9wb3NhbHN9IHByb3Bvc2FsKHMpIOKAlCBwYXNzIC0teWVzIHRvIGRlbGV0ZSB0aGVtIHdpdGggaXRgKTtcbiAgICB0aGlzLm5hbWUgPSBcIlpvbmVOb3RFbXB0eUVycm9yXCI7XG4gICAgdGhpcy5wcm9wb3NhbHMgPSBwcm9wb3NhbHM7XG4gIH1cbn1cblxuLy8gUmV0dXJucyBudWxsIGZvciBhbiB1bmtub3duIChvciBub24tc2x1ZykgaWQg4oCUIHRoZSBzZXJ2ZXIgNDA0cyBmaXJzdCxcbi8vIGJlZm9yZSBhbnkgbm90LWVtcHR5L3llcyByZWFzb25pbmcuXG5mdW5jdGlvbiBkZWxldGVab25lKGRiOiBEYXRhYmFzZSwgYnVzOiBFdmVudEJ1cywgaWQ6IHN0cmluZywgeWVzOiBib29sZWFuKTogeyBpZDogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKCFTTFVHX1JFLnRlc3QoaWQpKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFkYi5xdWVyeShcIlNFTEVDVCAxIEZST00gem9uZXMgV0hFUkUgaWQgPSA/XCIpLmdldChpZCkpIHJldHVybiBudWxsO1xuICBjb25zdCBjb3VudCA9IChcbiAgICBkYi5xdWVyeShcIlNFTEVDVCBDT1VOVCgqKSBhcyBuIEZST00gcHJvcG9zYWxzIFdIRVJFIHpvbmVfaWQgPSA/XCIpLmdldChpZCkgYXMgeyBuOiBudW1iZXIgfVxuICApLm47XG4gIGlmICgheWVzICYmIGNvdW50ID4gMCkgdGhyb3cgbmV3IFpvbmVOb3RFbXB0eUVycm9yKGNvdW50KTtcbiAgLy8gQTEvVEFHUzogdGhlIHpvbmUncyBwcm9wb3NhbHMgdGFrZSB0aGVpciBhY3Rpb24gc2xvdHMgQU5EIHRhZ3Mgd2l0aCB0aGVtXG4gIC8vIChkZWxldGUgYm90aCBCRUZPUkUgdGhlIHByb3Bvc2FscyDigJQgdGhlIHRhcmdldCBpZHMgYXJlIGFib3V0IHRvIHZhbmlzaCkuXG4gIGRiLnJ1bihcbiAgICBcIkRFTEVURSBGUk9NIG5vZGVfYWN0aW9ucyBXSEVSRSB0YXJnZXRfaWQgSU4gKFNFTEVDVCBpZCBGUk9NIHByb3Bvc2FscyBXSEVSRSB6b25lX2lkID0gPylcIixcbiAgICBbaWRdLFxuICApO1xuICBkYi5ydW4oXCJERUxFVEUgRlJPTSBub2RlX3RhZ3MgV0hFUkUgdGFyZ2V0X2lkIElOIChTRUxFQ1QgaWQgRlJPTSBwcm9wb3NhbHMgV0hFUkUgem9uZV9pZCA9ID8pXCIsIFtcbiAgICBpZCxcbiAgXSk7XG4gIGRiLnJ1bihcIkRFTEVURSBGUk9NIHByb3Bvc2FscyBXSEVSRSB6b25lX2lkID0gP1wiLCBbaWRdKTtcbiAgZGIucnVuKFwiREVMRVRFIEZST00gem9uZXMgV0hFUkUgaWQgPSA/XCIsIFtpZF0pO1xuICBidXMuZW1pdChcInpvbmUuZGVsZXRlZFwiLCB7IGlkIH0pO1xuICByZXR1cm4geyBpZCB9O1xufVxuXG4vLyBDbGFpbSBaMiDigJQgcHJvbW90aW9uOiBNT1ZFLCBub3QgZHVwbGljYXRlIChydWxlZCkuIENsZWFycyB6b25lX2lkIChVUERBVEVcbi8vIG9ubHkg4oCUIGRyYWZ0L3Byb3ZlbmFuY2UvZXZpZGVuY2Ugcm93cyB1bnRvdWNoZWQpIHNvIHRoZSBwcm9wb3NhbCBhcHBlYXJzIGluXG4vLyB0aGUgbWFpbiByZXZpZXcgcXVldWUgYXMgYSBub3JtYWwgcGVuZGluZyBpdGVtOyB0aGUgem9uZSBrZWVwcyBub1xuLy8gdG9tYnN0b25lLiBSYXRpZmljYXRpb24gc3RheXMgYSBtYWluLWdyYXBoIGFjdDogcmF0aWZ5KCkgcmVmdXNlcyBhXG4vLyBzdGlsbC16b25lZCBwcm9wb3NhbCAoXCJwcm9tb3RlIGZpcnN0XCIpLCBhbmQgdGhpcyBpcyB0aGUgb25seSBleGl0IGEgem9uZWRcbi8vIHByb3Bvc2FsIGhhcyBiZXNpZGVzIGR5aW5nIHdpdGggaXRzIHpvbmUuXG4vL1xuLy8gRWRnZSBlbmRwb2ludC1vcmRlciBtaXJyb3IgKHNhbWUgcmVzb2x2ZS1vcmRlciBydWxlIGFzIHJhdGlmeSk6IGFuIGVkZ2Vcbi8vIHByb3Bvc2FsIHdob3NlIGRyYWZ0IGVuZHBvaW50cyByZWZlcmVuY2UgTk9ERSBQUk9QT1NBTFMgbWF5IG9ubHkgcHJvbW90ZVxuLy8gYWZ0ZXIgKG9yIHdpdGgpIHRob3NlIGVuZHBvaW50cyDigJQgdGhlIGVycm9yIG5hbWVzIHRoZSB1bnByb21vdGVkIGVuZHBvaW50XG4vLyBzbyB0aGUgY2FsbGVyIGtub3dzIGV4YWN0bHkgd2hhdCB0byBwcm9tb3RlIGZpcnN0LiBSZWFsIG5vZGUgaWRzIChhbmQgcmVmc1xuLy8gdGhhdCByZXNvbHZlIHRvIG5vdGhpbmcgeWV0IOKAlCByYXRpZnkgb3ducyBkYW5nbGluZy1yZWYgZXJyb3JzKSBwYXNzLlxuZnVuY3Rpb24gcHJvbW90ZShkYjogRGF0YWJhc2UsIGJ1czogRXZlbnRCdXMsIHByb3Bvc2FsSWQ6IHN0cmluZyk6IHsgaWQ6IHN0cmluZyB9IHtcbiAgY29uc3Qgcm93ID0gZGJcbiAgICAucXVlcnkoXCJTRUxFQ1QgaWQsIGtpbmQsIGRyYWZ0X2pzb24sIHN0YXR1cywgem9uZV9pZCBGUk9NIHByb3Bvc2FscyBXSEVSRSBpZCA9ID9cIilcbiAgICAuZ2V0KHByb3Bvc2FsSWQpIGFzIHtcbiAgICBpZDogc3RyaW5nO1xuICAgIGtpbmQ6IHN0cmluZztcbiAgICBkcmFmdF9qc29uOiBzdHJpbmc7XG4gICAgc3RhdHVzOiBzdHJpbmc7XG4gICAgem9uZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgfSB8IG51bGw7XG4gIGlmICghcm93KSB0aHJvdyBuZXcgRXJyb3IoYHVua25vd24gcHJvcG9zYWw6ICR7cHJvcG9zYWxJZH1gKTtcbiAgaWYgKHJvdy5zdGF0dXMgIT09IFwicGVuZGluZ1wiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYHByb3Bvc2FsICR7cHJvcG9zYWxJZH0gYWxyZWFkeSAke3Jvdy5zdGF0dXN9IOKAlCBwcm9tb3RlIGlzIGZvciBwZW5kaW5nIHByb3Bvc2Fsc2AsXG4gICAgKTtcbiAgfVxuICBpZiAocm93LnpvbmVfaWQgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHByb3Bvc2FsICR7cHJvcG9zYWxJZH0gaXMgbm90IGluIGEgem9uZSDigJQgbm90aGluZyB0byBwcm9tb3RlYCk7XG4gIH1cblxuICBpZiAocm93LmtpbmQgPT09IFwiZWRnZVwiKSB7XG4gICAgY29uc3QgZHJhZnQgPSBKU09OLnBhcnNlKHJvdy5kcmFmdF9qc29uKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBmb3IgKGNvbnN0IGVuZCBvZiBbXCJzb3VyY2VcIiwgXCJ0YXJnZXRcIl0gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IHJlZiA9IFN0cmluZyhkcmFmdFtlbmRdKTtcbiAgICAgIGNvbnN0IGVuZHBvaW50ID0gZGIucXVlcnkoXCJTRUxFQ1QgaWQsIHpvbmVfaWQgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIpLmdldChyZWYpIGFzIHtcbiAgICAgICAgaWQ6IHN0cmluZztcbiAgICAgICAgem9uZV9pZDogc3RyaW5nIHwgbnVsbDtcbiAgICAgIH0gfCBudWxsO1xuICAgICAgaWYgKGVuZHBvaW50ICYmIGVuZHBvaW50LnpvbmVfaWQgIT09IG51bGwpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBlZGdlICR7ZW5kfSByZWZlcmVuY2VzIHByb3Bvc2FsICR7cmVmfSwgc3RpbGwgaW4gem9uZSAke2VuZHBvaW50LnpvbmVfaWR9IOKAlCBwcm9tb3RlIGl0IGZpcnN0YCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBkYi5ydW4oXCJVUERBVEUgcHJvcG9zYWxzIFNFVCB6b25lX2lkID0gTlVMTCBXSEVSRSBpZCA9ID9cIiwgW3Byb3Bvc2FsSWRdKTtcbiAgLy8gVGhpbiAobGlrZSB0aGUgcmF0aWZpZWQgZXZlbnRzKTogY29uc3VtZXJzIHdpdGggdGhlIGluY2x1c2l2ZSBzdG9yZVxuICAvLyBjbGVhciB6b25lSWQgb24gdGhlIHJvdyBsb2NhbGx5OyBubyBkZW5vcm1hbGl6ZWQgcGF5bG9hZC5cbiAgYnVzLmVtaXQoXCJwcm9wb3NhbC5wcm9tb3RlZFwiLCB7IGlkOiBwcm9wb3NhbElkIH0pO1xuICByZXR1cm4geyBpZDogcHJvcG9zYWxJZCB9O1xufVxuXG4vLyBSb3VuZCA1IChJQy1jKSDigJQgdGhlIHpvbmUgSU4tZG9vcjogbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyBhIHpvbmUgKHRoZVxuLy8gaW52ZXJzZSBvZiBwcm9tb3RlLCB3aGljaCBtb3ZlcyBPVVQgdG8gbWFpbikuIENvbXBsZXRlcyB0aGUgZHJpdmUtM1xuLy8gZ3JvdXAtc2VsZWN0ZWQtaW50by1hLXpvbmUgZ2FwICh0aGUgc3VyZmFjZSdzIHpvbmUtY3JlYXRlIGFmZm9yZGFuY2UpLlxuLy8gYHpvbmVJZCA9PT0gbnVsbGAgaXMgdGhlIHRvLW1haW4gbW92ZSDigJQgZGVsZWdhdGVzIHRvIHByb21vdGUoKSBzbyB0aGUgdHdvXG4vLyBzaGFyZSBvbmUgZXhpdCAodGhlIGVkZ2UgZW5kcG9pbnQtb3JkZXIgZ3VhcmQgKyB0aGluIHByb3Bvc2FsLnByb21vdGVkXG4vLyBldmVudCkuIEEgbW92ZSBJTlRPIGEgem9uZSByZS1lbWl0cyB0aGUgRlVMTCBwcm9wb3NhbCAod2l0aCB0aGUgbmV3IHpvbmVJZClcbi8vIHZpYSByZWFkUHJvcG9zYWxCeUlkIHNvIGFuIGluY2x1c2l2ZSBjb25zdW1lciByZS10YWdzIHRoZSByb3cgd2l0aG91dFxuLy8gY2xvYmJlcmluZyBpdHMgYWN0aW9ucyAodGhlIFIzIHBheWxvYWQtdGFnZ2luZyBtZWNoYW5pc20pLlxuLy9cbi8vIEVycm9ycywgZGlzdGluY3Qgc28gdGhlIHNlcnZlciBtYXBzIHRoZW0gdG8gZGlzdGluY3Qgc3RhdHVzZXM6IHVua25vd25cbi8vIHByb3Bvc2FsIOKGkiBudWxsIChzZXJ2ZXIgNDA0cyksIHVua25vd24gem9uZSDihpIgdHlwZWQgVW5rbm93blpvbmVFcnJvciAoNDA0KSxcbi8vIG5vbi1wZW5kaW5nIOKGkiBhIHBsYWluIEVycm9yICg0MDApLlxuY2xhc3MgVW5rbm93blpvbmVFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3Ioem9uZUlkOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgdW5rbm93biB6b25lOiAke3pvbmVJZH1gKTtcbiAgICB0aGlzLm5hbWUgPSBcIlVua25vd25ab25lRXJyb3JcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBtb3ZlUHJvcG9zYWxUb1pvbmUoXG4gIGRiOiBEYXRhYmFzZSxcbiAgYnVzOiBFdmVudEJ1cyxcbiAgcHJvcG9zYWxJZDogc3RyaW5nLFxuICB6b25lSWQ6IHN0cmluZyB8IG51bGwsXG4pOiB7IGlkOiBzdHJpbmc7IHpvbmVJZDogc3RyaW5nIHwgbnVsbCB9IHwgbnVsbCB7XG4gIGNvbnN0IHJvdyA9IGRiXG4gICAgLnF1ZXJ5KFwiU0VMRUNUIGlkLCBzdGF0dXMsIHpvbmVfaWQgRlJPTSBwcm9wb3NhbHMgV0hFUkUgaWQgPSA/XCIpXG4gICAgLmdldChwcm9wb3NhbElkKSBhcyB7XG4gICAgaWQ6IHN0cmluZztcbiAgICBzdGF0dXM6IHN0cmluZztcbiAgICB6b25lX2lkOiBzdHJpbmcgfCBudWxsO1xuICB9IHwgbnVsbDtcbiAgaWYgKCFyb3cpIHJldHVybiBudWxsOyAvLyBzZXJ2ZXIgNDA0c1xuICBpZiAocm93LnN0YXR1cyAhPT0gXCJwZW5kaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcHJvcG9zYWwgJHtwcm9wb3NhbElkfSBhbHJlYWR5ICR7cm93LnN0YXR1c30g4oCUIG9ubHkgcGVuZGluZyBwcm9wb3NhbHMgbW92ZSBiZXR3ZWVuIHpvbmVzYCxcbiAgICApO1xuICB9XG5cbiAgLy8gVG8tbWFpbiBtb3ZlIElTIGEgcHJvbW90ZSDigJQgcmV1c2UgaXQgKGd1YXJkICsgdGhpbiBwcm9wb3NhbC5wcm9tb3RlZCkuXG4gIGlmICh6b25lSWQgPT09IG51bGwpIHtcbiAgICBwcm9tb3RlKGRiLCBidXMsIHByb3Bvc2FsSWQpO1xuICAgIHJldHVybiB7IGlkOiBwcm9wb3NhbElkLCB6b25lSWQ6IG51bGwgfTtcbiAgfVxuXG4gIC8vIE1vdmUgSU5UTyBhIHpvbmUg4oCUIHRoZSB6b25lIG11c3QgZXhpc3QgKHNhbWUgZmFpbC1sb3VkIHNwaXJpdCBhcyBwcm9wb3NlXG4gIC8vIC0tem9uZSksIHRoZW4gcmUtdGFnIGFuZCByZS1lbWl0IHRoZSBmdWxsIHByb3Bvc2FsIHNvIGNvbnN1bWVycyB1cGRhdGVcbiAgLy8gdGhlIHpvbmVJZCBvbiB0aGUgcm93IHRoZXkgYWxyZWFkeSBob2xkLlxuICBpZiAoIWRiLnF1ZXJ5KFwiU0VMRUNUIDEgRlJPTSB6b25lcyBXSEVSRSBpZCA9ID9cIikuZ2V0KHpvbmVJZCkpIHtcbiAgICB0aHJvdyBuZXcgVW5rbm93blpvbmVFcnJvcih6b25lSWQpO1xuICB9XG4gIGRiLnJ1bihcIlVQREFURSBwcm9wb3NhbHMgU0VUIHpvbmVfaWQgPSA/IFdIRVJFIGlkID0gP1wiLCBbem9uZUlkLCBwcm9wb3NhbElkXSk7XG4gIGNvbnN0IHByb3Bvc2FsID0gcmVhZFByb3Bvc2FsQnlJZChkYiwgcHJvcG9zYWxJZCk7XG4gIGlmIChwcm9wb3NhbCkgYnVzLmVtaXQoXCJwcm9wb3NhbC5hZGRlZFwiLCBwcm9wb3NhbCBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgcmV0dXJuIHsgaWQ6IHByb3Bvc2FsSWQsIHpvbmVJZCB9O1xufVxuXG5leHBvcnQgdHlwZSB7IFpvbmUgfTtcbmV4cG9ydCB7XG4gIGNyZWF0ZVpvbmUsXG4gIGRlbGV0ZVpvbmUsXG4gIGxpc3Rab25lcyxcbiAgbW92ZVByb3Bvc2FsVG9ab25lLFxuICBwcm9tb3RlLFxuICBVbmtub3duWm9uZUVycm9yLFxuICBab25lTm90RW1wdHlFcnJvcixcbn07XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7OztBQWFBLHVCQUFTLDBCQUFZLDRCQUFXLDZCQUFjLDhCQUFZO0FBQzFEO0FBQ0EsaUJBQVM7QUFDVDs7O0FDUUEsSUFBTSxtQkFBbUI7QUFDekIsSUFBTSxtQkFBbUIsS0FBSztBQVU5QixT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QjtBQUFBO0FBQUEsUUFFSCxLQUFLLENBQUMsSUFBSTtBQUFBLFVBQ1AsR0FBRyxLQUFzQyxjQUFjO0FBQUE7QUFBQSxRQUUxRCxPQUFPLEdBQUc7QUFBQSxNQUdaO0FBQUEsSUFDRixDQUFDO0FBQUEsSUFDRCxPQUFPLEdBQUc7QUFBQSxJQUNWLFFBQVEsT0FBTyxNQUNiLEdBQUcsS0FBSyxVQUFVLEVBQUUsT0FBTyxjQUFjLE1BQU0sTUFBTSxPQUFPLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLENBQzFHO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUdULE1BQU0sTUFBTSxVQUFVLFFBQVEsT0FBTztBQUFBLEVBQ3JDLElBQUk7QUFBQSxJQUNGLFdBQVUsTUFBTSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsSUFDbkMsZUFBYyxXQUFXLE9BQU8sT0FBTyxJQUFJLENBQUM7QUFBQSxJQUM1QyxlQUFjLFVBQVUsT0FBTyxRQUFRLEdBQUcsQ0FBQztBQUFBLElBQzNDLE9BQU8sR0FBRztBQUFBLElBQ1YsUUFBUSxPQUFPLE1BQ2IsaURBQWlELGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsQ0FDNUY7QUFBQTtBQUFBLEVBRUYsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsRUFBRSxLQUFLLE1BQU0sT0FBTyxNQUFNLEtBQUssQ0FBQztBQUFBLENBQUs7QUFBQSxFQUM1RSxJQUFJLENBQUMsT0FBTyxPQUFPO0FBQUEsSUFBWSxZQUFZLEdBQUc7QUFBQSxFQUc5QyxNQUFNLElBQUksUUFBYyxDQUFDLFlBQVk7QUFBQSxJQUNuQyxNQUFNLFdBQVcsTUFBTSxRQUFRO0FBQUEsSUFDL0IsUUFBUSxHQUFHLFdBQVcsUUFBUTtBQUFBLElBQzlCLFFBQVEsR0FBRyxVQUFVLFFBQVE7QUFBQSxHQUM5QjtBQUFBLEVBQ0QsSUFBSTtBQUFBLElBQ0YsSUFBSSxZQUFXLFFBQVEsS0FBSyxjQUFhLFVBQVUsTUFBTSxFQUFFLEtBQUssTUFBTSxPQUFPLFFBQVEsR0FBRyxHQUFHO0FBQUEsTUFDekYsWUFBVyxRQUFRO0FBQUEsTUFDbkIsWUFBVyxTQUFTO0FBQUEsSUFDdEI7QUFBQSxJQUNBLE1BQU07QUFBQSxFQUdSLGFBQWEsUUFBUSxTQUFTLE9BQU87QUFBQSxJQUFHLEdBQUcsTUFBTTtBQUFBLEVBQ2pELE1BQU0sUUFBUSxLQUFLLENBQUMsT0FBTyxLQUFLLElBQUksR0FBRyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQUEsRUFDOUUsT0FBTztBQUFBO0FBdUJULGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjQzNkU5NDQ4RTlDNTU3NjE2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9

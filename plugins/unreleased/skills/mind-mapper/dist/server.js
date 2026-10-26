#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/mind-mapper/backend/server.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync2, readFileSync as readFileSync4 } from "fs";
import { homedir } from "os";
import { join as join7 } from "path";
import { parseArgs } from "util";

// src/kit/wire/discovery.ts
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "fs";
function writeFileAtomic(target, text) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}
function unlinkIfMatches(path, expected, identify = (raw) => raw.trim()) {
  try {
    if (!existsSync(path))
      return false;
    if (identify(readFileSync(path, "utf8")) !== expected)
      return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// src/kit/wire/housekeeping.ts
var TIMER_MAX_S = Math.floor((2 ** 31 - 1) / 1000);
async function drainAndStop(opts) {
  const graceMs = opts.graceMs ?? 150;
  const stopMs = opts.stopMs ?? 200;
  const listeners = (opts.clients?.size ?? 0) + [...opts.sockets ?? []].length + (opts.server.pendingRequests ?? 0);
  if (listeners > 0)
    await new Promise((r) => setTimeout(r, graceMs));
  if (opts.clients) {
    for (const client of [...opts.clients])
      client.close();
  }
  if (opts.sockets) {
    for (const ws of [...opts.sockets]) {
      try {
        ws.close();
      } catch {}
    }
  }
  let raceTimer;
  try {
    await Promise.race([
      Promise.resolve(opts.server.stop(true)),
      new Promise((r) => {
        raceTimer = setTimeout(r, stopMs);
      })
    ]);
  } finally {
    clearTimeout(raceTimer);
  }
}

// src/kit/wire/origin.ts
function ours(port) {
  if (typeof port !== "number" || !Number.isFinite(port))
    return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}
function sameOrigin(req, port) {
  const origin = req.headers.get("origin");
  if (origin === null)
    return true;
  return ours(port).includes(origin);
}
function refuseForeignOrigin(req, port, boundHost) {
  if (!ownHost(req, port, boundHost))
    return Response.json({ ok: false, error: "foreign host refused" }, { status: 403 });
  if (sameOrigin(req, port))
    return null;
  return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
}
function ownHost(req, port, boundHost) {
  const host = req.headers.get("host");
  if (host === null)
    return true;
  if (typeof port !== "number" || !Number.isFinite(port))
    return false;
  const names = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (boundHost) {
    const bound = boundHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    names.push(bound.includes(":") ? `[${bound}]:${port}` : `${bound}:${port}`);
  }
  return names.includes(host.toLowerCase());
}

// src/kit/wire/serveDist.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join } from "path";
function resolveMode(distDir) {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync2(join(distDir, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function contentTypeFor(nameOrExt) {
  const dot = nameOrExt.lastIndexOf(".");
  const ext = dot === -1 ? "" : nameOrExt.slice(dot);
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
function serveFromDist(distDir, rel) {
  if (!rel || rel.includes("..") || rel.includes("/"))
    return null;
  if (!surfaceWhitelist(distDir).has(rel))
    return null;
  const file = join(distDir, rel);
  if (!existsSync2(file))
    return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}
var ENTRY_REF_RE = /(?:src|href)\s*=\s*"(?:\.\/)?([^"]+)"/g;
var RELATIVE_REF_RE = /["'(]\.\/([^"'()\s]+)["')]/g;
var TRANSITIVE_EXTS = [".js", ".css"];
var whitelistCache = new Map;
function refsIn(text, re) {
  return [...text.matchAll(re)].map(([, ref]) => ref).filter((ref) => !!ref && !ref.includes("/") && !ref.includes("..") && !ref.includes(":") && !ref.startsWith("#") && !ref.startsWith("?"));
}
function surfaceWhitelist(distDir) {
  const cached = whitelistCache.get(distDir);
  if (cached)
    return cached;
  const names = new Set;
  const entry = join(distDir, "index.html");
  if (existsSync2(entry)) {
    names.add("index.html");
    const html = readFileSync2(entry, "utf8");
    const pending = [...refsIn(html, ENTRY_REF_RE), ...refsIn(html, RELATIVE_REF_RE)];
    while (pending.length > 0) {
      const name = pending.pop();
      if (names.has(name))
        continue;
      const file = join(distDir, name);
      if (!existsSync2(file))
        continue;
      names.add(name);
      if (!TRANSITIVE_EXTS.some((ext) => name.endsWith(ext)))
        continue;
      pending.push(...refsIn(readFileSync2(file, "utf8"), RELATIVE_REF_RE));
    }
  }
  whitelistCache.set(distDir, names);
  return names;
}

// src/kit/wire/sse.ts
function sseResponse(opts) {
  const { log, since, heartbeatMs, clients, signal, filter, openFrames, onOpen, onClose } = opts;
  let unsubscribe = null;
  let keepalive = null;
  let closed = false;
  const client = { close: () => {}, send: () => {} };
  const teardown = () => {
    if (closed)
      return;
    closed = true;
    if (keepalive !== null)
      clearInterval(keepalive);
    unsubscribe?.();
    clients?.delete(client);
    onClose?.();
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
      client.close = () => {
        teardown();
        try {
          controller.close();
        } catch {}
      };
      client.send = safeEnqueue;
      safeEnqueue(`: connected

`);
      if (openFrames)
        for (const chunk of openFrames())
          safeEnqueue(chunk);
      unsubscribe = log.subscribe(since, (frame) => {
        if (filter && !filter(frame))
          return;
        safeEnqueue(`data: ${JSON.stringify(frame)}

`);
      });
      keepalive = setInterval(() => safeEnqueue(`: hb

`), heartbeatMs);
      signal?.addEventListener("abort", teardown, { once: true });
      clients?.add(client);
      onOpen?.();
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
import { statSync as statSync2 } from "fs";
import { join as join3 } from "path";

// src/mind-mapper/backend/project.ts
import { existsSync as existsSync3, mkdirSync, readdirSync as readdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "fs";
import { join as join2 } from "path";

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
  return join2(home, "projects", id);
}
function readMeta(dir, id) {
  const metaFile = join2(dir, "project.json");
  if (existsSync3(metaFile)) {
    try {
      const parsed = JSON.parse(readFileSync3(metaFile, "utf8"));
      if (typeof parsed.title === "string")
        return { id, title: parsed.title };
    } catch {}
  }
  return { id, title: id };
}
function ensureProjectDirs(dir) {
  mkdirSync(join2(dir, "docs"), { recursive: true });
}
function createProject(home, id, title) {
  if (!ID_RE.test(id))
    throw new Error(`invalid project id: ${id}`);
  const dir = projectDir(home, id);
  if (existsSync3(dir))
    throw new Error(`project already exists: ${id}`);
  ensureProjectDirs(dir);
  writeFileSync2(join2(dir, "project.json"), JSON.stringify({ title }, null, 2));
  openStore(join2(dir, "store.sqlite")).close();
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
    if (!existsSync3(dir2))
      throw new NeedsProjectError;
    return readMeta(dir2, DEFAULT_PROJECT_ID);
  }
  const dir = projectDir(home, id);
  if (!existsSync3(dir))
    throw new UnknownProjectError(id);
  return readMeta(dir, id);
}
function listProjects(home) {
  const root = join2(home, "projects");
  if (!existsSync3(root))
    return [];
  return readdirSync2(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => readMeta(join2(root, entry.name), entry.name));
}

// src/mind-mapper/backend/marks.ts
function docFileMtime(projectDir2, relPath) {
  try {
    return Math.floor(statSync2(join3(projectDir2, relPath)).mtimeMs);
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
import { existsSync as existsSync4, unlinkSync as unlinkSync2 } from "fs";
import { join as join4 } from "path";
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
  const file = join4(projectDir2, row.path);
  if (existsSync4(file))
    unlinkSync2(file);
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

// src/kit/wire/eventLog.ts
var REPLAY_BUFFER_SIZE = 1000;
function createEventLog(opts = {}) {
  const bufferSize = opts.bufferSize ?? REPLAY_BUFFER_SIZE;
  const epoch = opts.epoch;
  const buffer = [];
  const listeners = new Set;
  let seq = 0;
  return {
    epoch,
    emit(msg) {
      seq += 1;
      const frame = { id: seq, ...msg };
      frame.id = seq;
      if (epoch !== undefined)
        frame.epoch = epoch;
      buffer.push(frame);
      if (buffer.length > bufferSize)
        buffer.shift();
      for (const listener of listeners)
        listener(frame);
      return frame;
    },
    subscribe(since, listener) {
      const from = !Number.isFinite(since) || since > seq ? -1 : since;
      for (const frame of buffer) {
        if (frame.id > from)
          listener(frame);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cursor() {
      return seq;
    }
  };
}

// src/mind-mapper/backend/events.ts
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
  const epoch = crypto.randomUUID();
  const log = createEventLog({ epoch });
  return {
    epoch,
    emit(kind, payload) {
      return log.emit({ kind, payload });
    },
    subscribe(since, listener) {
      return log.subscribe(since, (frame) => listener(frame));
    },
    cursor() {
      return log.cursor();
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

// src/kit/wire/heartbeat.ts
var MAX_IDLE_TIMEOUT_SEC = 255;
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
var MIN_HEARTBEAT_MS = 500;
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  const ceiling = Math.max(MIN_HEARTBEAT_MS, Math.floor(idleSec * 1000 / 2));
  return Math.min(Math.max(intOr(raw, fallback), MIN_HEARTBEAT_MS), ceiling);
}
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/mind-mapper/backend/heartbeat.ts
function intOr2(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.MIND_MAPPER_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.MIND_MAPPER_KEEPALIVE_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = intOr2(process.env.MIND_MAPPER_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS));
var TAIL_RETRY_MS = intOr2(process.env.MIND_MAPPER_TAIL_RETRY_MS, 1000);

// src/mind-mapper/backend/ingest.ts
import { existsSync as existsSync5, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";
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
  if (!existsSync5(docsDir))
    throw new Error(`docs dir does not exist: ${docsDir}`);
  writeFileSync3(join5(docsDir, `${id}.md`), content);
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
import { appendFileSync, writeFileSync as writeFileSync4 } from "fs";
import { join as join6 } from "path";
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
  const writeDoc = input.docEdit !== undefined && homeDocId ? () => writeFileSync4(join6(docsDir, `${homeDocId}.md`), input.docEdit) : null;
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
    appendFileSync(join6(docsDir, "..", "changelog.txt"), built.changelogLine);
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
      appendFileSync(join6(docsDir, "..", "changelog.txt"), b.changelogLine);
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
var SKILL_ROOT = join7(SCRIPT_DIR, "..");
var DIST_DIR = join7(SKILL_ROOT, "dist");
var HOME = process.env.MIND_MAPPER_HOME ?? join7(homedir(), ".mind-mapper");
var PORT_FILE = join7(HOME, "daemon.port");
var PID_FILE = join7(HOME, "daemon.pid");
var projects = new Map;
function loadProject(id) {
  const meta = resolveProject(HOME, id);
  const existing = projects.get(meta.id);
  if (existing)
    return existing;
  const dir = projectDir(HOME, meta.id);
  const db = openStore(join7(dir, "store.sqlite"));
  const entry = {
    db,
    bus: createEventBus(),
    meta,
    agents: 0,
    tails: 0,
    lingerTimer: null,
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
function presenceLingerMs() {
  const v = Number.parseInt(process.env.MIND_MAPPER_PRESENCE_LINGER_MS ?? "", 10);
  return Number.isFinite(v) && v >= 0 ? v : 150000;
}
function setAgents(entry, agents) {
  if (agents === entry.agents)
    return;
  entry.agents = agents;
  entry.bus.emit("presence.changed", { agents });
}
function startLinger(entry) {
  if (entry.lingerTimer !== null)
    clearTimeout(entry.lingerTimer);
  entry.lingerTimer = setTimeout(() => {
    entry.lingerTimer = null;
    if (entry.tails === 0)
      setAgents(entry, 0);
  }, presenceLingerMs());
}
function adjustAgents(entry, delta) {
  entry.tails = Math.max(0, entry.tails + delta);
  if (entry.tails > 0) {
    if (entry.lingerTimer !== null) {
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = null;
    }
    setAgents(entry, entry.tails);
    return;
  }
  if (presenceLingerMs() === 0)
    setAgents(entry, 0);
  else
    startLinger(entry);
}
function notePresenceAct(entry) {
  if (entry.tails === 0 && entry.lingerTimer !== null)
    startLinger(entry);
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
  const file = join7(dir, "..", row.path);
  if (!existsSync6(file))
    return null;
  try {
    return {
      id,
      title: row.title,
      kind: row.kind === "" ? null : row.kind,
      content: readFileSync4(file, "utf8")
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
function sseResponse2(bus, since, hooks = {}, signal, inbound = false, heartbeatMs2 = SSE_HEARTBEAT_MS) {
  return sseResponse({
    log: bus,
    since,
    heartbeatMs: heartbeatMs2,
    signal,
    filter: inbound ? (frame) => isInboundEvent(frame) : undefined,
    openFrames: inbound ? () => [`data: ${JSON.stringify(inboundGrounding())}

`] : undefined,
    onOpen: hooks.onOpen,
    onClose: hooks.onClose
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
  const mode = resolveMode(DIST_DIR);
  const devIndex = mode === "dev" ? (await import("../../../../../src/mind-mapper/surface/index.html")).default : undefined;
  const routes = devIndex ? { "/": devIndex } : {};
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
      idleTimeout: IDLE_TIMEOUT_SEC,
      fetch: (req, srv) => {
        {
          const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
          if (refused)
            return refused;
        }
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
            return sseResponse2(entry.bus, Number.isFinite(since) ? since : 0, {
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
              notePresenceAct(entry);
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
            const docsDir = join7(projectDir(HOME, meta.id), "docs");
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
            const docsDir = join7(projectDir(HOME, meta.id), "docs");
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
                notePresenceAct(entry);
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
            const docsDir = join7(projectDir(HOME, meta.id), "docs");
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
            const doc = readDoc(db, join7(projectDir(HOME, meta.id), "docs"), path.slice("/doc/".length));
            if (doc)
              return Response.json(doc);
            return new Response('{"error":"unknown doc"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          if (mode === "release") {
            const rel = path === "/" ? "index.html" : path.slice(1);
            const asset = serveFromDist(DIST_DIR, rel);
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
    writeFileAtomic(PORT_FILE, String(server.port));
    writeFileAtomic(PID_FILE, String(process.pid));
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
  if (unlinkIfMatches(PID_FILE, String(process.pid))) {
    unlinkIfMatches(PORT_FILE, String(server.port));
  }
  for (const { db } of projects.values())
    db.close();
  await drainAndStop({ server, graceMs: 0, stopMs: 200 });
  return 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  main,
  readDoc,
  run,
  sseResponse2 as sseResponse
};

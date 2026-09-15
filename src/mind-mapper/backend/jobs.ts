// Round 9 (Job Queue) — a first-class, persisted unit of AGENT WORK: status +
// sub-tasks + a deliverable + an OWNER (a lease). Unlike the R6 ingestion tray
// (a pure client view over pending author:"user" proposals, zero engine
// state), a job is real engine state — its own table, its own events.
//
// Design decisions (plan-round9, lead-resolved):
//   D1 — jobs are their OWN entity, not proposals.claimed_by (the vision —
//        sub-tasks, deliverables, standalone tracking — exceeds a proposal
//        lease). The R6 claimed_by seam is subsumed ("refine this proposal" is
//        just a job whose deliverable points at it).
//   D2 — LIVENESS is DERIVED client-side (surface joins jobs × the existing
//        agent.activity ladder on claimed_by). NO engine liveness/heartbeat
//        field here — the engine stores only claimed_by + the coarse status.
//   D3 — job.* events carry the FULL job entity (wholesale replace-by-id, the
//        tags.set idiom); only job.deleted is thin {id}.
//   D4 — sub-tasks are a JSON column ([{id,label,done}]) owned wholly by the
//        job (the node_tags *_json precedent), not a child table.
//   D5 — deliverable is one nullable freeform ref (doc:id / node:id / text);
//        many jobs sharing a ref = many-jobs-one-deliverable.
//   D6 — V1 lease is claim/release only (atomic compare-and-set); expiry /
//        stealing / TTL is deferred to a multi-agent hardening round.
//
// Discipline (the buildProposal/buildRatify lesson): buildJob VALIDATES +
// computes the row and the wire object but does NOT insert or emit; every
// mutator writes then RE-READS the full job through ONE reader (readJob) before
// emitting, so the event payload always equals the /state snapshot shape (the
// re-emit-through-the-single-source-reader rule — never hand-assemble a
// payload a wholesale-replace consumer holds).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

// The job lifecycle vocabulary. status is ENGINE-OWNED metadata (like the
// action-slot shape, NOT an opaque draft) — validated loud at intake, never
// silently stored. queued is the default; the rest are agent/human-driven.
const JOB_STATUSES = ["queued", "running", "blocked", "done", "failed", "canceled"] as const;
type JobStatus = (typeof JOB_STATUSES)[number];

interface Subtask {
  id: string;
  label: string;
  done: boolean;
}

interface Job {
  id: string;
  // scope — matches the per-project store (the messages.project_id precedent).
  // Populated at create, carried on the wire so a job is self-describing; reads
  // are UNFILTERED (each project owns its own store.sqlite, so every row here
  // belongs to this project — the nodes/proposals precedent, not messages').
  project: string;
  title: string;
  status: JobStatus;
  // the lease (D6): the owning agent/session, or null (unclaimed).
  claimedBy: string | null;
  // D5: one freeform ref (doc:id / node:id / free text), or null.
  deliverable: string | null;
  // D4: the checklist, owned wholly by this job.
  subtasks: Subtask[];
  detail: string | null;
  // epoch MILLISECONDS (Date.now()). NOTE — a deliberate divergence from the
  // house unixepoch()-seconds default: updatedAt must bump on every mutation
  // and needs sub-second ordering, so both stamps are app-written ms, not a
  // SQL DEFAULT. The wire carries numbers (like message ts), never ISO text.
  createdAt: number;
  updatedAt: number;
}

// A guarded refusal (the ZoneNotEmptyError/CitedError family): claiming a job
// already leased by a DIFFERENT owner is a 409, and the error carries the
// current owner so the surface can render "already claimed by X". Re-claim by
// the SAME owner is idempotent success, never this.
class ClaimConflictError extends Error {
  claimedBy: string;
  constructor(claimedBy: string) {
    super(`job already claimed by ${claimedBy}`);
    this.name = "ClaimConflictError";
    this.claimedBy = claimedBy;
  }
}

function assertStatus(status: unknown): JobStatus {
  if (typeof status !== "string" || !(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`status must be one of ${JOB_STATUSES.join("|")}`);
  }
  return status as JobStatus;
}

function parseSubtasks(raw: string): Subtask[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s): s is Subtask => s !== null && typeof s === "object")
      .map((s) => ({
        id: String((s as Subtask).id),
        label: String((s as Subtask).label),
        done: Boolean((s as Subtask).done),
      }));
  } catch {
    return [];
  }
}

interface JobRow {
  id: string;
  project: string;
  title: string;
  status: string;
  claimed_by: string | null;
  deliverable: string | null;
  subtasks_json: string;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

const JOB_COLUMNS =
  "id, project, title, status, claimed_by, deliverable, subtasks_json, detail, created_at, updated_at";

function rowToJob(row: JobRow): Job {
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
    updatedAt: row.updated_at,
  };
}

// Reads tolerate an unknown stored status (never crash a snapshot) — writes
// are strict (assertStatus), reads pass a stray value through as-is.
function assertStatusLenient(status: string): JobStatus {
  return status as JobStatus;
}

interface CreateJobInput {
  project: string;
  title: string;
  status?: string;
  deliverable?: string | null;
  detail?: string | null;
}

// buildJob — the pure builder: validate + compute the row and the wire object,
// return an `insert` closure; NO emit (the buildProposal/buildRatify
// discipline — a rollback must never leak a job.added). A future batch path
// reuses this unchanged.
function buildJob(input: CreateJobInput): { job: Job; insert: (db: Database) => void } {
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new Error("job requires a non-empty title");
  }
  if (typeof input.project !== "string" || input.project === "") {
    throw new Error("job requires a project scope");
  }
  const status = input.status === undefined ? "queued" : assertStatus(input.status);
  const id = crypto.randomUUID();
  const now = Date.now();
  const job: Job = {
    id,
    project: input.project,
    title: input.title,
    status,
    claimedBy: null,
    deliverable: input.deliverable ?? null,
    subtasks: [],
    detail: input.detail ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const insert = (db: Database) => {
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
      now,
    ]);
  };
  return { job, insert };
}

function readJob(db: Database, id: string): Job | null {
  const row = db.query(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(id) as JobRow | null;
  return row ? rowToJob(row) : null;
}

// The /state merge input: every job in this project's store, newest-updated
// last (created_at order keeps the sidebar stable; the surface groups by
// status). Unfiltered — the store is already project-scoped.
function readJobs(db: Database): Job[] {
  const rows = db.query(`SELECT ${JOB_COLUMNS} FROM jobs ORDER BY created_at`).all() as JobRow[];
  return rows.map(rowToJob);
}

function createJob(db: Database, bus: EventBus, input: CreateJobInput): Job {
  const { job, insert } = buildJob(input);
  insert(db);
  // Emit the FULL entity re-read through the single reader (D3) — never the
  // hand-built `job` object, so the payload is byte-identical to /state.
  const fresh = readJob(db, job.id);
  if (fresh) bus.emit("job.added", fresh as unknown as Record<string, unknown>);
  return job;
}

interface UpdateJobPatch {
  title?: string;
  status?: string;
  deliverable?: string | null;
  detail?: string | null;
}

// update — the scalar-field mutator (title/status/deliverable/detail). Only
// the fields PRESENT in the patch are written; status is validated. Unknown id
// → null (the server 404s). Emits job.updated (full entity).
function updateJob(db: Database, bus: EventBus, id: string, patch: UpdateJobPatch): Job | null {
  if (readJob(db, id) === null) return null;
  const sets: string[] = [];
  const args: unknown[] = [];
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
  db.run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args as never[]);
  const fresh = readJob(db, id);
  if (fresh) bus.emit("job.updated", fresh as unknown as Record<string, unknown>);
  return fresh;
}

// claim — the ATOMIC lease acquisition (SEAM C). One conditional UPDATE is the
// whole guard: set claimed_by + status=running IFF unclaimed OR already mine.
// A single SQL statement is atomic under bun:sqlite, so no explicit txn is
// needed for the compare-and-set. Re-claim by the same owner matches the WHERE
// (idempotent success); a different owner matches nothing (→ ClaimConflict).
// Unknown id → null. Emits job.claimed (full entity) — kept DISTINCT from
// job.updated because a claim is a compare-and-set that can FAIL on contention
// and is the multi-agent on-ramp's headline signal (a consumer may still route
// it through the same wholesale-replace-by-id reducer case).
function claimJob(db: Database, bus: EventBus, id: string, owner: string): Job | null {
  if (typeof owner !== "string" || owner.trim() === "") {
    throw new Error("claim requires a non-empty owner");
  }
  const result = db
    .query(
      "UPDATE jobs SET claimed_by = ?, status = 'running', updated_at = ? WHERE id = ? AND (claimed_by IS NULL OR claimed_by = ?)",
    )
    .run(owner, Date.now(), id, owner);
  if (result.changes === 0) {
    const existing = db.query("SELECT claimed_by FROM jobs WHERE id = ?").get(id) as {
      claimed_by: string | null;
    } | null;
    if (existing === null) return null;
    // changes===0 with the row present means someone else owns it (a null or
    // self owner would have matched the WHERE).
    throw new ClaimConflictError(String(existing.claimed_by));
  }
  const fresh = readJob(db, id);
  if (fresh) bus.emit("job.claimed", fresh as unknown as Record<string, unknown>);
  return fresh;
}

// release — clears the lease (D6). Status is left as-is (releasing a running
// job doesn't un-run it; the human/agent sets status explicitly). Unknown id →
// null. A release is a plain field change, so it emits job.updated (job.claimed
// is acquisition-only).
function releaseJob(db: Database, bus: EventBus, id: string): Job | null {
  if (readJob(db, id) === null) return null;
  db.run("UPDATE jobs SET claimed_by = NULL, updated_at = ? WHERE id = ?", [Date.now(), id]);
  const fresh = readJob(db, id);
  if (fresh) bus.emit("job.updated", fresh as unknown as Record<string, unknown>);
  return fresh;
}

// subtasks (D4) — the checklist mutators. add appends {id: uuid, label, done:
// false}; check/uncheck flip an existing subtask's done by id (an unknown
// subtask id is a loud error, NOT a silent no-op). All emit job.updated.
function mutateSubtasks(
  db: Database,
  bus: EventBus,
  id: string,
  mutate: (subtasks: Subtask[]) => void,
): Job | null {
  const job = readJob(db, id);
  if (job === null) return null;
  const subtasks = job.subtasks;
  mutate(subtasks);
  db.run("UPDATE jobs SET subtasks_json = ?, updated_at = ? WHERE id = ?", [
    JSON.stringify(subtasks),
    Date.now(),
    id,
  ]);
  const fresh = readJob(db, id);
  if (fresh) bus.emit("job.updated", fresh as unknown as Record<string, unknown>);
  return fresh;
}

function addSubtask(db: Database, bus: EventBus, id: string, label: string): Job | null {
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("subtask add requires a non-empty label");
  }
  return mutateSubtasks(db, bus, id, (subtasks) => {
    subtasks.push({ id: crypto.randomUUID(), label, done: false });
  });
}

function setSubtaskDone(
  db: Database,
  bus: EventBus,
  id: string,
  subtaskId: string,
  done: boolean,
): Job | null {
  // Resolve existence FIRST so an unknown JOB is null (404) and an unknown
  // SUBTASK on a known job is a loud 400 — distinct failures, distinct codes.
  if (readJob(db, id) === null) return null;
  return mutateSubtasks(db, bus, id, (subtasks) => {
    const subtask = subtasks.find((s) => s.id === subtaskId);
    if (subtask === undefined) throw new Error(`unknown subtask: ${subtaskId}`);
    subtask.done = done;
  });
}

// delete — thin (D3): drop the row, emit job.deleted {id}. Unknown id → null.
function deleteJob(db: Database, bus: EventBus, id: string): { id: string } | null {
  if (readJob(db, id) === null) return null;
  db.run("DELETE FROM jobs WHERE id = ?", [id]);
  bus.emit("job.deleted", { id });
  return { id };
}

export type { CreateJobInput, Job, JobStatus, Subtask, UpdateJobPatch };
export {
  addSubtask,
  buildJob,
  ClaimConflictError,
  claimJob,
  createJob,
  deleteJob,
  JOB_STATUSES,
  readJob,
  readJobs,
  releaseJob,
  setSubtaskDone,
  updateJob,
};

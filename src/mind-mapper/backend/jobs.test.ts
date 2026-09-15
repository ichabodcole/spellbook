// Round 9 (Job Queue) — the jobs engine: buildJob purity, readJobs snapshot
// merge, the atomic claim/lease guard (SEAM C), subtask mutation (D4), and the
// full-entity event payloads (D3). A job is standalone engine state (no
// target-keyed re-home lifecycle like tags/actions) — its own table, its own
// events.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import {
  addSubtask,
  buildJob,
  ClaimConflictError,
  claimJob,
  createJob,
  deleteJob,
  readJob,
  readJobs,
  releaseJob,
  setSubtaskDone,
  updateJob,
} from "./jobs.ts";
import { readState } from "./state.ts";

const PROJECT = { id: "default", title: "Default" };

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-jobs-test-"));
  mkdirSync(join(dir, "docs"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("createJob persists a first-class row, defaults status queued, and rides /state.jobs[]", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(0, (e) => received.push(e as unknown as Record<string, unknown>));

    const job = createJob(db, bus, { project: "default", title: "Research the antagonist" });
    expect(job.status).toBe("queued");
    expect(job.claimedBy).toBeNull();
    expect(job.subtasks).toEqual([]);
    expect(job.project).toBe("default");
    expect(typeof job.createdAt).toBe("number");

    // D3: job.added carries the FULL entity (not a thin {id}).
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "job.added" });
    expect((received[0]?.payload as { id: string; title: string }).title).toBe(
      "Research the antagonist",
    );

    // The snapshot seeds the sidebar.
    const state = readState(db, PROJECT);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]?.id).toBe(job.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildJob is pure (no insert, no emit) and validates title/status", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(0, (e) => received.push(e as unknown as Record<string, unknown>));

    const { job, insert } = buildJob({ project: "default", title: "Draft" });
    // Nothing landed and nothing emitted until insert() runs.
    expect(readJobs(db)).toHaveLength(0);
    expect(received).toHaveLength(0);
    insert(db);
    expect(readJob(db, job.id)?.title).toBe("Draft");

    expect(() => buildJob({ project: "default", title: "  " })).toThrow(/title/);
    expect(() => buildJob({ project: "", title: "x" })).toThrow(/project/);
    expect(() => buildJob({ project: "default", title: "x", status: "bogus" })).toThrow(/status/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateJob writes only provided fields, validates status, 404s (null) on unknown id", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const job = createJob(db, bus, { project: "default", title: "First" });

    const updated = updateJob(db, bus, job.id, { status: "blocked", detail: "waiting on Cole" });
    expect(updated?.status).toBe("blocked");
    expect(updated?.detail).toBe("waiting on Cole");
    // title untouched (not in the patch).
    expect(updated?.title).toBe("First");
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(job.createdAt);

    expect(updateJob(db, bus, "no-such-job", { status: "done" })).toBeNull();
    expect(() => updateJob(db, bus, job.id, { status: "bogus" })).toThrow(/status/);
    expect(() => updateJob(db, bus, job.id, {})).toThrow(/at least one/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim is atomic: sets running + owner, re-claim by same owner is idempotent, another owner 409s", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const job = createJob(db, bus, { project: "default", title: "Lease me" });
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as unknown as Record<string, unknown>));

    const claimed = claimJob(db, bus, job.id, "circe");
    expect(claimed?.claimedBy).toBe("circe");
    expect(claimed?.status).toBe("running");
    // D3 + SEAM B: a distinct job.claimed carrying the full entity.
    expect(received[0]).toMatchObject({ kind: "job.claimed" });
    expect((received[0]?.payload as { claimedBy: string }).claimedBy).toBe("circe");

    // Idempotent re-claim by the same owner — no throw, still circe's.
    const again = claimJob(db, bus, job.id, "circe");
    expect(again?.claimedBy).toBe("circe");

    // A different owner is refused with the typed conflict (→ 409 at the route).
    let err: unknown;
    try {
      claimJob(db, bus, job.id, "daedalus");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaimConflictError);
    expect((err as ClaimConflictError).claimedBy).toBe("circe");
    // The refused claim changed nothing.
    expect(readJob(db, job.id)?.claimedBy).toBe("circe");

    // Unknown id → null (the route 404s), never a throw.
    expect(claimJob(db, bus, "no-such-job", "x")).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release clears the lease (status untouched); a released job can be re-claimed by anyone", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const job = createJob(db, bus, { project: "default", title: "Handoff" });
    claimJob(db, bus, job.id, "circe");

    const released = releaseJob(db, bus, job.id);
    expect(released?.claimedBy).toBeNull();
    // Release doesn't un-run — status stays running (the human sets it).
    expect(released?.status).toBe("running");

    // Now a different owner may claim it.
    expect(claimJob(db, bus, job.id, "daedalus")?.claimedBy).toBe("daedalus");
    expect(releaseJob(db, bus, "no-such-job")).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subtasks: add mints an id, check/uncheck flip done, unknown subtask throws, unknown job is null", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const job = createJob(db, bus, { project: "default", title: "Checklist" });

    const one = addSubtask(db, bus, job.id, "outline");
    const two = addSubtask(db, bus, job.id, "draft");
    expect(two?.subtasks).toHaveLength(2);
    const outlineId = one?.subtasks[0]?.id as string;
    expect(one?.subtasks[0]).toMatchObject({ label: "outline", done: false });

    const checked = setSubtaskDone(db, bus, job.id, outlineId, true);
    expect(checked?.subtasks.find((s) => s.id === outlineId)?.done).toBe(true);
    const unchecked = setSubtaskDone(db, bus, job.id, outlineId, false);
    expect(unchecked?.subtasks.find((s) => s.id === outlineId)?.done).toBe(false);

    // Known job, unknown subtask → loud throw (400 at the route).
    expect(() => setSubtaskDone(db, bus, job.id, "no-such-subtask", true)).toThrow(
      /unknown subtask/,
    );
    // Unknown job → null (404), never a throw.
    expect(setSubtaskDone(db, bus, "no-such-job", outlineId, true)).toBeNull();
    expect(addSubtask(db, bus, "no-such-job", "x")).toBeNull();
    expect(() => addSubtask(db, bus, job.id, "  ")).toThrow(/label/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteJob is thin: drops the row, emits job.deleted {id}, unknown id is null", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const job = createJob(db, bus, { project: "default", title: "Ephemeral" });
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as unknown as Record<string, unknown>));

    expect(deleteJob(db, bus, job.id)).toEqual({ id: job.id });
    expect(readJobs(db)).toHaveLength(0);
    expect(received[0]).toMatchObject({ kind: "job.deleted", payload: { id: job.id } });
    // Thin — the deleted payload is JUST {id}, no full entity.
    expect(Object.keys(received[0]?.payload as object)).toEqual(["id"]);

    expect(deleteJob(db, bus, "no-such-job")).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deliverable is a freeform ref; many jobs may share one (many-jobs-one-deliverable, D5)", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = createJob(db, bus, {
      project: "default",
      title: "Research A",
      deliverable: "doc:worldbook",
    });
    const b = createJob(db, bus, {
      project: "default",
      title: "Research B",
      deliverable: "doc:worldbook",
    });
    expect(a.deliverable).toBe("doc:worldbook");
    expect(b.deliverable).toBe("doc:worldbook");
    const state = readState(db, PROJECT);
    expect(state.jobs.filter((j) => j.deliverable === "doc:worldbook")).toHaveLength(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

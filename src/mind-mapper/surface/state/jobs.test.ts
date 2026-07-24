import { expect, test } from "bun:test";
import type { Job } from "../types";
import {
  groupJobsByStatus,
  JOB_STATUS_ORDER,
  jobLiveness,
  normalizeJobTitle,
  parseDeliverable,
  subtaskProgress,
} from "./jobs";

function job(over: Partial<Job>): Job {
  return {
    id: "j1",
    project: "p1",
    title: "A job",
    status: "queued",
    claimedBy: null,
    deliverable: null,
    subtasks: [],
    detail: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// ── grouping ──────────────────────────────────────────────────────────────

test("groupJobsByStatus orders groups running→queued→blocked→done→failed→canceled", () => {
  const jobs = [
    job({ id: "d", status: "done" }),
    job({ id: "q", status: "queued" }),
    job({ id: "r", status: "running" }),
    job({ id: "c", status: "canceled" }),
    job({ id: "b", status: "blocked" }),
    job({ id: "f", status: "failed" }),
  ];
  expect(groupJobsByStatus(jobs).map((g) => g.status)).toEqual([
    "running",
    "queued",
    "blocked",
    "done",
    "failed",
    "canceled",
  ]);
  // the canonical order constant is the source of truth
  expect(groupJobsByStatus(jobs).map((g) => g.status)).toEqual([...JOB_STATUS_ORDER]);
});

test("groupJobsByStatus drops empty groups and preserves within-group order", () => {
  const jobs = [
    job({ id: "r1", status: "running" }),
    job({ id: "r2", status: "running" }),
    job({ id: "q1", status: "queued" }),
  ];
  const groups = groupJobsByStatus(jobs);
  expect(groups.map((g) => g.status)).toEqual(["running", "queued"]);
  expect(groups[0]?.jobs.map((j) => j.id)).toEqual(["r1", "r2"]);
});

test("groupJobsByStatus surfaces an unknown status rather than hiding the job", () => {
  const jobs = [job({ id: "x", status: "archived" as unknown as Job["status"] })];
  const groups = groupJobsByStatus(jobs);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.status as string).toBe("archived");
});

// ── subtask progress ──────────────────────────────────────────────────────

test("subtaskProgress counts done vs total", () => {
  expect(
    subtaskProgress(
      job({
        subtasks: [
          { id: "a", label: "a", done: true },
          { id: "b", label: "b", done: false },
          { id: "c", label: "c", done: true },
        ],
      }),
    ),
  ).toEqual({ done: 2, total: 3 });
});

test("subtaskProgress on an empty checklist is 0/0", () => {
  expect(subtaskProgress(job({ subtasks: [] }))).toEqual({ done: 0, total: 0 });
});

// ── deliverable grammar ───────────────────────────────────────────────────

test("parseDeliverable recognizes doc: and node: refs and free text", () => {
  expect(parseDeliverable("doc:ramble-01")).toEqual({
    kind: "doc",
    id: "ramble-01",
    raw: "doc:ramble-01",
  });
  expect(parseDeliverable("node:maren")).toEqual({ kind: "node", id: "maren", raw: "node:maren" });
  expect(parseDeliverable("write the intro")).toEqual({ kind: "text", raw: "write the intro" });
});

test("parseDeliverable treats an unknown scheme as free text and is case-insensitive on the scheme", () => {
  expect(parseDeliverable("DOC:ramble-01")).toEqual({
    kind: "doc",
    id: "ramble-01",
    raw: "DOC:ramble-01",
  });
  // a colon inside prose (unknown scheme) stays text
  expect(parseDeliverable("TODO: ship it")?.kind).toBe("text");
});

test("parseDeliverable returns null on null/blank and drops a scheme with no id", () => {
  expect(parseDeliverable(null)).toBeNull();
  expect(parseDeliverable("   ")).toBeNull();
  expect(parseDeliverable("doc:")?.kind).toBe("text");
});

// ── the liveness join (D2 / SEAM D) ───────────────────────────────────────

test("jobLiveness — a claimed job whose owner is thinking/received is live", () => {
  const j = job({ status: "running", claimedBy: "circe" });
  expect(jobLiveness(j, { circe: "thinking" })).toBe("live");
  expect(jobLiveness(j, { circe: "received" })).toBe("live");
});

test("jobLiveness — a stalled owner is STALE (static), never live", () => {
  const j = job({ status: "running", claimedBy: "circe" });
  expect(jobLiveness(j, { circe: "stalled" })).toBe("stale");
});

test("jobLiveness — a claimed but idle owner, or no signal yet, is paused", () => {
  const j = job({ status: "running", claimedBy: "circe" });
  expect(jobLiveness(j, { circe: "idle" })).toBe("paused");
  expect(jobLiveness(j, {})).toBe("paused");
});

test("jobLiveness — an unclaimed job has no liveness question", () => {
  expect(jobLiveness(job({ status: "queued", claimedBy: null }), { circe: "thinking" })).toBe(
    "unclaimed",
  );
});

test("jobLiveness — terminal jobs are inactive regardless of activity", () => {
  const active = { circe: "thinking" as const };
  expect(jobLiveness(job({ status: "done", claimedBy: "circe" }), active)).toBe("inactive");
  expect(jobLiveness(job({ status: "failed", claimedBy: "circe" }), active)).toBe("inactive");
  expect(jobLiveness(job({ status: "canceled", claimedBy: "circe" }), active)).toBe("inactive");
});

// R10 F1 — the create-form title guard.

test("normalizeJobTitle trims and returns the title when non-empty", () => {
  expect(normalizeJobTitle("  draft the villain arc  ")).toBe("draft the villain arc");
  expect(normalizeJobTitle("x")).toBe("x");
});

test("normalizeJobTitle returns null for a blank or whitespace-only title (never POSTs an empty)", () => {
  expect(normalizeJobTitle("")).toBeNull();
  expect(normalizeJobTitle("   ")).toBeNull();
  expect(normalizeJobTitle("\t\n")).toBeNull();
});

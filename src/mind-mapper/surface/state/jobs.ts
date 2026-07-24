// Round 9 (Job Queue) — the JobsSidebar's pure derives (SEAM D + rendering
// support). All logic here is React-free and TDD'd in jobs.test.ts; the sidebar
// only renders what these compute.
//
// THE LIVENESS JOIN (D2 / SEAM D) — the "automate over discipline" heart. A job
// declares start (claim) and done (complete); the in-between "is this still
// alive?" is DERIVED from the owner's activity, exactly like a chat
// thinking-indicator, so an agent never has to babble status.
//
// SEAM D — RATIFIED, with a stated narrowing (verified against the live wire):
// the plan imagined the join keyed `claimedBy → the latest agent.activity for
// that owner`. The wire does NOT support per-owner keying — `agent.activity`
// carries `{state}` ONLY (server.ts emits `{ state }`, no agent identity), and
// presence is a bare COUNT of open tails. So the honest V1 join is
// PROJECT-SCOPED: the single latest activity applies to whatever agent holds a
// claim (single casting-agent-per-project — the multi-agent contention policy
// is D6-deferred). This does NOT breach D2: liveness stays a pure client join
// over what's already on the bus, zero new engine state. Per-OWNER liveness (a
// fleet each with its own pulse) is the FUTURE that would need agent identity
// ON agent.activity — an engine field, flagged NOT built (that is the D2
// boundary; if a future slice reaches for it, that's the breach to escalate).
//
// The function still takes an `activityByAgent` MAP so the shape is
// forward-compatible: the day the wire keys activity by owner, only the map's
// construction in App changes — this join is already per-owner by lookup. Today
// App builds the map by attributing the one project activity to the claimed
// owner(s).

import type { AgentActivityState, Job, JobStatus } from "../types";

// The status grouping order for the sidebar: live work first (running), then
// the backlog (queued/blocked), then the terminal outcomes (done/failed/
// canceled). Mirrors the plan's stated ordering.
export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  "running",
  "queued",
  "blocked",
  "done",
  "failed",
  "canceled",
];

export type JobGroup = { status: JobStatus; jobs: Job[] };

// Groups jobs by status in JOB_STATUS_ORDER, dropping empty groups. Within a
// group, order is preserved (the wire is newest-created-last). A status the
// order doesn't know (a future engine status) still surfaces, appended after
// the known ones, so an unknown status never silently hides a job.
export function groupJobsByStatus(jobs: Job[]): JobGroup[] {
  const byStatus = new Map<JobStatus, Job[]>();
  for (const job of jobs) {
    const bucket = byStatus.get(job.status);
    if (bucket) bucket.push(job);
    else byStatus.set(job.status, [job]);
  }
  const groups: JobGroup[] = [];
  for (const status of JOB_STATUS_ORDER) {
    const bucket = byStatus.get(status);
    if (bucket && bucket.length > 0) {
      groups.push({ status, jobs: bucket });
      byStatus.delete(status);
    }
  }
  // Any leftover (unknown) statuses, in first-seen order.
  for (const [status, bucket] of byStatus) {
    if (bucket.length > 0) groups.push({ status, jobs: bucket });
  }
  return groups;
}

export type SubtaskProgress = { done: number; total: number };

// The checklist progress (D4). total 0 = no checklist (the sidebar renders no
// progress row).
export function subtaskProgress(job: Pick<Job, "subtasks">): SubtaskProgress {
  const total = job.subtasks.length;
  const done = job.subtasks.reduce((n, s) => n + (s.done ? 1 : 0), 0);
  return { done, total };
}

// D5 — the deliverable jump-link grammar (the ground-ref grammar's sibling):
// `doc:<id>` → open the doc; `node:<id>` → select/focus the node; anything else
// is free text (many-jobs-one-deliverable can point at either a ref or a label).
// Prefix match is case-insensitive on the scheme; the id keeps its own case.
export type DeliverableRef =
  | { kind: "doc"; id: string; raw: string }
  | { kind: "node"; id: string; raw: string }
  | { kind: "text"; raw: string };

export function parseDeliverable(deliverable: string | null | undefined): DeliverableRef | null {
  if (typeof deliverable !== "string") return null;
  const raw = deliverable.trim();
  if (!raw) return null;
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const scheme = raw.slice(0, colon).toLowerCase();
    const id = raw.slice(colon + 1).trim();
    if (id && (scheme === "doc" || scheme === "node")) {
      return { kind: scheme, id, raw };
    }
  }
  return { kind: "text", raw };
}

// R10 F1 — the human create-job affordance's title guard. The V1 create form
// is title-only (status defaults `queued` server-side); the surface never POSTs
// an empty/whitespace title (the daemon requires one — POST /jobs 400s on a
// blank). Returns the trimmed title, or null when there's nothing to submit —
// the form gates its submit button on a non-null result and sends the trimmed
// value (never the raw input).
export function normalizeJobTitle(raw: string): string | null {
  const title = raw.trim();
  return title.length > 0 ? title : null;
}

// THE LIVENESS JOIN (D2 / SEAM D). Pure over (job, activityByAgent).
//   - inactive : terminal job (done/failed/canceled) — no liveness question.
//   - unclaimed: no owner (claimedBy null) — nothing to be live.
//   - live     : owner is engaged (received | thinking) → the working pulse.
//   - stale    : owner stalled (daemon-synthesized after the received-grace TTL)
//                → a STATIC attention look, NEVER the pulse (false-liveness rule,
//                mirrors state/activity.ts's stalled branch).
//   - paused   : owner claimed but idle, or no activity signal yet — quiet, not
//                stalled (the honest "we don't know it's live" neutral).
export type JobLiveness = "inactive" | "unclaimed" | "live" | "stale" | "paused";

export function jobLiveness(
  job: Pick<Job, "status" | "claimedBy">,
  activityByAgent: Record<string, AgentActivityState>,
): JobLiveness {
  if (job.status === "done" || job.status === "failed" || job.status === "canceled") {
    return "inactive";
  }
  if (!job.claimedBy) return "unclaimed";
  const activity = activityByAgent[job.claimedBy] ?? null;
  if (activity === "received" || activity === "thinking") return "live";
  if (activity === "stalled") return "stale";
  return "paused";
}

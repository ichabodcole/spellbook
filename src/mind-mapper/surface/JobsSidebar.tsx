// Round 9 (Job Queue) — the JobsSidebar: an off-canvas panel of AGENT WORK,
// grouped by status. IngestionTray's TWIN (same `<aside w-72 shrink-0 border-l>`
// off-canvas idiom, same toggled-from-the-top-bar lifecycle) — but where the
// tray is a pure client view over pending proposals, this renders real engine
// state (the jobs[] snapshot + job.* events the reducer applies).
//
// The design heart (D2 / SEAM D): a claimed job wears a LIVE pulse when its
// owner is active, a STATIC attention tint when the owner stalled (never the
// pulse — the false-liveness rule from state/activity.ts), and a quiet dot when
// paused. Liveness is a pure join (state/jobs.ts jobLiveness) over the job + the
// project's activity — the "chat thinking-indicator for work" the plan asks for.
//
// Human authoring is deliberately LIGHT (plan: watch + cancel for V1): the
// checklist and progress are READ-ONLY here (subtasks are driven via the CLI /
// the agent); the only human write is Cancel (a status flip). The deliverable
// jump-link routes doc:/node: refs back to the board (many-jobs-one-deliverable).

import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  ListChecks,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type DeliverableRef,
  groupJobsByStatus,
  type JobLiveness,
  jobLiveness,
  normalizeJobTitle,
  parseDeliverable,
  subtaskProgress,
} from "./state/jobs";
import type { AgentActivityState, Job, JobStatus } from "./types";
import { Button } from "./ui/button";

// Per-status header label + tint (semantic tokens only; icons carry the
// distinction where two statuses share a tint — story-local reads "done",
// attention reads "needs-attention", ink-faint reads "quiet/inert").
const STATUS_META: Record<JobStatus, { label: string; tint: string }> = {
  running: { label: "running", tint: "text-thread-tier" },
  queued: { label: "queued", tint: "text-ink-faint" },
  blocked: { label: "blocked", tint: "text-attention" },
  done: { label: "done", tint: "text-story-local" },
  failed: { label: "failed", tint: "text-attention" },
  canceled: { label: "canceled", tint: "text-ink-faint" },
};

// The liveness dot (the pulse is the point): live pulses in the agent tint,
// stale is a STATIC attention dot, paused is a quiet dot. unclaimed/inactive
// render no dot (there's no liveness question).
const LIVENESS_DOT: Record<JobLiveness, string | null> = {
  live: "bg-thread-tier animate-pulse",
  stale: "bg-attention",
  paused: "bg-ink-faint",
  unclaimed: null,
  inactive: null,
};

const LIVENESS_LABEL: Record<JobLiveness, string> = {
  live: "owner active",
  stale: "owner stalled",
  paused: "owner idle",
  unclaimed: "unclaimed",
  inactive: "inactive",
};

function DeliverableLink({
  ref,
  onOpen,
}: {
  ref: DeliverableRef;
  onOpen: (ref: DeliverableRef) => void;
}) {
  if (ref.kind === "text") {
    return <span className="italic text-ink-faint">→ {ref.raw}</span>;
  }
  const Icon = ref.kind === "doc" ? FileText : ArrowUpRight;
  return (
    <button
      type="button"
      onClick={() => onOpen(ref)}
      className="inline-flex items-center gap-1 text-story-local hover:underline"
      title={`Open ${ref.kind} ${ref.id}`}
    >
      <Icon size={10} aria-hidden />
      {ref.id}
    </button>
  );
}

function JobRow({
  job,
  activityByAgent,
  onOpenDeliverable,
  onCancel,
}: {
  job: Job;
  activityByAgent: Record<string, AgentActivityState>;
  onOpenDeliverable: (ref: DeliverableRef) => void;
  onCancel: (jobId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const liveness = jobLiveness(job, activityByAgent);
  const dot = LIVENESS_DOT[liveness];
  const progress = subtaskProgress(job);
  const deliverable = parseDeliverable(job.deliverable);
  const cancelable = liveness !== "inactive";

  return (
    <div className="rounded border border-edge bg-bg p-2">
      <div className="flex items-start justify-between gap-1.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs text-ink">
            {dot && (
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
                title={LIVENESS_LABEL[liveness]}
                aria-hidden
              />
            )}
            <span className="truncate">{job.title}</span>
          </p>
          {job.claimedBy && (
            <p className="mt-0.5 truncate text-[10px] text-ink-faint">
              <span className="sr-only">{LIVENESS_LABEL[liveness]} · </span>
              owner: {job.claimedBy}
            </p>
          )}
        </div>
        {cancelable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Cancel "${job.title}"`}
            title="Cancel this job"
            className="shrink-0 text-ink-faint hover:text-attention"
            onClick={() => onCancel(job.id)}
          >
            <Ban size={11} />
          </Button>
        )}
      </div>

      {job.detail && <p className="mt-1 text-[10px] text-ink-dim">{job.detail}</p>}

      {progress.total > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="flex items-center gap-1 text-[10px] text-ink-faint hover:text-ink"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <ListChecks size={10} aria-hidden />
            {progress.done}/{progress.total} subtasks
          </button>
          {expanded && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {job.subtasks.map((s) => (
                <li key={s.id} className="flex items-center gap-1 text-[10px] text-ink-dim">
                  {s.done ? (
                    <Check size={10} className="text-story-local" aria-hidden />
                  ) : (
                    <Square size={10} className="text-ink-faint" aria-hidden />
                  )}
                  <span className={s.done ? "line-through text-ink-faint" : ""}>{s.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {deliverable && (
        <p className="mt-1 text-[10px]">
          <DeliverableLink ref={deliverable} onOpen={onOpenDeliverable} />
        </p>
      )}
    </div>
  );
}

// R10 F1 — the human's create-job affordance. Collapsed, it's a full-width
// "＋ New job" button; expanded, a title-only form (V1 — status defaults
// `queued` server-side, everything else editable later via the CLI/agent). The
// submit is gated on normalizeJobTitle (no blank/whitespace title reaches the
// wire), and it sends the TRIMMED title. No optimistic insert: App POSTs and
// the job.added event round-trips through the reducer to populate the row.
function NewJobForm({ onCreate }: { onCreate: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalized = normalizeJobTitle(title);

  // Focus the title input when the form opens (a ref+effect, NOT autoFocus:
  // biome bans the attribute and it can't distinguish a click-opened form from
  // an input that steals focus at app boot — the R4 permanent-search lesson).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setTitle("");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        variant="outline"
        size="auto"
        className="flex w-full items-center justify-center gap-1 px-2 py-1 text-xs text-thread-tier"
        onClick={() => setOpen(true)}
      >
        <Plus size={12} aria-hidden />
        New job
      </Button>
    );
  }

  const submit = () => {
    if (!normalized) return;
    onCreate(normalized);
    close();
  };

  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
        placeholder="what should the agent do?"
        aria-label="New job title"
        className="w-full rounded border border-edge bg-bg px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-thread-tier focus:outline-none"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="auto"
          className="px-2 py-0.5 text-[10px] text-ink-faint"
          onClick={close}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="outline"
          size="auto"
          disabled={!normalized}
          className="px-2 py-0.5 text-[10px] text-thread-tier"
        >
          Add job
        </Button>
      </div>
    </form>
  );
}

export function JobsSidebar({
  jobs,
  activityByAgent,
  onOpenDeliverable,
  onCancel,
  onCreate,
  onClose,
}: {
  jobs: Job[];
  // The liveness join's other half (D2 / SEAM D): owner id → activity state.
  // App builds it by attributing the project's single activity to the claimed
  // owner(s) — the wire has no per-owner activity keying (see state/jobs.ts).
  activityByAgent: Record<string, AgentActivityState>;
  onOpenDeliverable: (ref: DeliverableRef) => void;
  onCancel: (jobId: string) => void;
  onCreate: (title: string) => void;
  onClose: () => void;
}) {
  const groups = groupJobsByStatus(jobs);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-edge bg-surface xl:w-80">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-faint">
          <ListChecks size={11} className="text-thread-tier" aria-hidden />
          Jobs · {jobs.length}
        </h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close jobs sidebar" onClick={onClose}>
          <X size={12} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {/* R10 F1 — the create affordance is persistent (whether or not jobs
            exist) so the human can always add one; the empty state below
            explains what the queue IS. */}
        <NewJobForm onCreate={onCreate} />
        {jobs.length === 0 ? (
          <div className="space-y-2 p-2 text-xs text-ink-faint">
            <p className="text-ink-dim">No jobs yet.</p>
            <p>
              A job is a unit of agent work — it carries a status, a checklist of subtasks, a
              deliverable it produces, and an ownership lease so you can see who's on it and whether
              they're live.
            </p>
            <p>Start one with “＋ New job” above, or let an agent open one from the CLI.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <section key={group.status}>
                <h3
                  className={`mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-widest ${
                    STATUS_META[group.status]?.tint ?? "text-ink-faint"
                  }`}
                >
                  {STATUS_META[group.status]?.label ?? group.status} · {group.jobs.length}
                </h3>
                <div className="space-y-1.5">
                  {group.jobs.map((job) => (
                    <JobRow
                      key={job.id}
                      job={job}
                      activityByAgent={activityByAgent}
                      onOpenDeliverable={onOpenDeliverable}
                      onCancel={onCancel}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

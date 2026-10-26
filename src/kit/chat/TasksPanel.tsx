// The work queue.
//
// A task is a title, who made it, and a status. Everything here is built on that:
// the count, the spinner, the list, the toast. A human's task is a request that
// shows on the agent's stream; an agent's is work it has started and will name the
// end of; a daemon's is work the daemon runs itself (a render), and reports
// `progress` while it does. An agent that only ever manages `task` and `task-done`
// still drives all of this correctly; `detail` and `progress` are richness on top.
import {
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  CornerDownRightIcon,
  LoaderIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import type { TaskAuthor, TaskStatus, TaskView } from "../workspace/protocol";

/** The statuses a task never leaves. `workspace/session.ts` has the same list; a test holds them equal. */
export const FINISHED_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];

export const isFinishedStatus = (s: TaskStatus): boolean => FINISHED_STATUSES.includes(s);

const WHO: Record<TaskAuthor, string> = { human: "You", agent: "Agent", daemon: "Workspace" };

const STATUS_LABEL: Record<TaskStatus, string> = {
  open: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? ""
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(t);
};

/** A quiet turning mark: "something is happening" without claiming progress. */
export function Spinner({ className }: { className?: string }) {
  return <LoaderIcon aria-hidden className={cn("size-3 animate-spin", className)} />;
}

function StatusMark({ status }: { status: TaskStatus }) {
  const cls = "mt-0.5 size-3 shrink-0";
  if (status === "running") return <Spinner className={cn(cls, "text-brand")} />;
  if (status === "open")
    return <CircleDashedIcon aria-hidden className={cn(cls, "text-ink-faint")} />;
  if (status === "done") return <CheckIcon aria-hidden className={cn(cls, "text-added")} />;
  if (status === "failed") return <XIcon aria-hidden className={cn(cls, "text-danger")} />;
  return <BanIcon aria-hidden className={cn(cls, "text-ink-faint")} />;
}

/** A progress bar for a running task: `progress` is 0 to 1, and is runtime-only. */
export function ProgressBar({ progress }: { progress: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="mt-1 h-1 overflow-hidden rounded-full bg-edge"
    >
      <div
        className="h-full rounded-full bg-brand transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Row({
  task,
  parent,
  onCancel,
  onRemove,
}: {
  task: TaskView;
  /** The task this one was delegated from, when it is still in the queue. */
  parent: TaskView | undefined;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const finished = isFinishedStatus(task.status);
  return (
    <div
      data-slot="task"
      data-status={task.status}
      data-by={task.by}
      className={cn(
        "group/task rounded-md border border-edge bg-bg px-2 py-1.5 text-xs",
        finished && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1.5">
        <StatusMark status={task.status} />
        <p
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap text-ink",
            task.status === "cancelled" && "line-through",
          )}
        >
          {task.title}
        </p>
        {finished ? (
          <button
            type="button"
            onClick={() => onRemove(task.id)}
            aria-label={`Remove task: ${task.title}`}
            title="Forget this task"
            className="shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 group-hover/task:opacity-100 hover:text-ink focus-visible:opacity-100"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        ) : (
          // THE HUMAN CAN ALWAYS STOP IT. An agent that dies mid-task would
          // otherwise leave the queue spinning forever, and a queue you cannot
          // clear stops being information. A running job is aborted by the daemon.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onCancel(task.id)}
            aria-label={`Cancel task: ${task.title}`}
            className="h-5 shrink-0 px-1.5 text-[10px]"
          >
            Cancel
          </Button>
        )}
      </div>
      {task.status === "running" && task.progress !== undefined && (
        <div className="pl-4.5">
          <ProgressBar progress={task.progress} />
        </div>
      )}
      {parent ? (
        <p
          data-slot="task-parent"
          className="mt-0.5 flex items-center gap-1 pl-4.5 text-[11px] text-ink-faint"
        >
          <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
          <span className="min-w-0 truncate" title={parent.title}>
            part of {parent.title}
          </span>
        </p>
      ) : (
        task.parent && (
          <p
            data-slot="task-parent"
            className="mt-0.5 flex items-center gap-1 pl-4.5 text-[11px] text-ink-faint"
          >
            <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
            delegated from another task
          </p>
        )
      )}
      {/* The current step, when there is one: indented under the task so it reads
          as part of it rather than a second task. */}
      {task.detail && (
        <p className="mt-0.5 pl-4.5 text-[11px] text-ink-dim italic">{task.detail}</p>
      )}
      {task.outcome && <p className="mt-0.5 pl-4.5 text-[11px] text-ink-dim">{task.outcome}</p>}
      <div className="mt-1 flex items-center gap-1.5 pl-4.5 text-[10px] text-ink-faint">
        <span>{WHO[task.by]}</span>
        <span>·</span>
        <span>{STATUS_LABEL[task.status]}</span>
        {task.kind && (
          <>
            <span>·</span>
            <span>{task.kind}</span>
          </>
        )}
        <span>·</span>
        <span>{when(task.createdAt)}</span>
      </div>
    </div>
  );
}

export function TasksPanel({
  tasks,
  onCancel,
  onRemove,
  onClear,
  onCreate,
}: {
  /** Newest first, finished ones included; running ones carry `progress`. */
  tasks: readonly TaskView[];
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  /** Forget every finished task. Outstanding ones stay. */
  onClear: () => void;
  /** A request for the agent, from the human. */
  onCreate: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const open = tasks.filter((t) => !isFinishedStatus(t.status));
  const done = tasks.filter((t) => isFinishedStatus(t.status));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onCreate(title.trim());
    setTitle("");
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tasks.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-ink-faint">
            Work the agent has started shows up here, and clears when it finishes.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {open.map((t) => (
              <Row
                key={t.id}
                task={t}
                parent={t.parent ? byId.get(t.parent) : undefined}
                onCancel={onCancel}
                onRemove={onRemove}
              />
            ))}
            {done.length > 0 && (
              <div className="mt-1 flex items-center gap-2">
                <p className="text-[10px] tracking-wide text-ink-faint uppercase">Finished</p>
                {/* CLEARS ONLY WHAT IS FINISHED. Outstanding work is never swept up
                    by a tidy: clearing is for what is over. */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onClear}
                  title="Forget every finished task; outstanding ones stay"
                  className="ml-auto h-5 px-1.5 text-[10px] text-ink-faint hover:text-ink"
                >
                  Clear {done.length} finished
                </Button>
              </div>
            )}
            {done.slice(0, 20).map((t) => (
              <Row
                key={t.id}
                task={t}
                parent={t.parent ? byId.get(t.parent) : undefined}
                onCancel={onCancel}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
      <form onSubmit={submit} className="flex shrink-0 items-center gap-1 border-t border-edge p-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Ask the agent to do something…"
          aria-label="New task"
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          disabled={!title.trim()}
          aria-label="Add task"
          title="Add a task for the agent"
        >
          <PlusIcon />
        </Button>
      </form>
    </div>
  );
}

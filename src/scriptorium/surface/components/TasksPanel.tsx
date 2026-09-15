// The work queue (E50).
//
// ⛔ EVERY AFFORDANCE HERE IS BUILT ON ONE TINY FACT: a task is a message with
// a `doneAt` or without one. The count, the spinner, the list, the toast — none
// of them need the agent to do anything beyond `task` and `task-done`, which is
// the whole point of Cole's framing. An agent that only ever manages those two
// verbs still drives all of this correctly.
//
// `status` is the optional richness on top: long multi-step work can say what
// step it is on, and work that never does is not shown as lesser.
import { cn } from "cn";
import { CheckIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/ui/button";
import type { Task } from "../../backend/protocol";

const when = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(new Date(ms));

/** A quiet turning mark — "something is happening" without claiming progress. */
export function Spinner({ className }: { className?: string }) {
  return <LoaderIcon aria-hidden className={cn("size-3 animate-spin", className)} />;
}

function Row({ task, onDone }: { task: Task; onDone: (id: string) => void }) {
  const open = task.doneAt === undefined;
  return (
    <div
      className={cn(
        "group/task rounded-md border border-edge bg-bg px-2 py-1.5 text-xs",
        !open && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1.5">
        {open ? (
          <Spinner className="mt-0.5 shrink-0 text-ink-faint" />
        ) : (
          <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-added" />
        )}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-ink">{task.text}</p>
      </div>
      {task.status && (
        // The current step, when there is one — indented under the task so it
        // reads as part of it rather than a second task.
        <p className="mt-0.5 pl-4.5 text-[11px] text-ink-dim italic">{task.status}</p>
      )}
      {task.outcome && <p className="mt-0.5 pl-4.5 text-[11px] text-ink-dim">{task.outcome}</p>}
      <div className="mt-1 flex items-center gap-1.5 pl-4.5 text-[10px] text-ink-faint">
        <span>{task.who === "agent" ? "Agent" : "You"}</span>
        <span>·</span>
        <span>{when(task.createdAt)}</span>
        {!open && task.doneAt !== undefined && <span>· done {when(task.doneAt)}</span>}
        {open && (
          // ⛔ THE HUMAN CAN ALWAYS CLOSE IT. An agent that dies mid-task would
          // otherwise leave the queue spinning forever, and a queue you cannot
          // clear stops being information.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDone(task.id)}
            className="ml-auto h-5 px-1.5 text-[10px] opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100"
          >
            Mark done
          </Button>
        )}
      </div>
    </div>
  );
}

export function TasksPanel({
  tasks,
  onDone,
  onClear,
}: {
  tasks: Task[];
  onDone: (id: string) => void;
  onClear: () => void;
}) {
  const open = tasks.filter((t) => t.doneAt === undefined);
  const done = tasks.filter((t) => t.doneAt !== undefined);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {tasks.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-ink-faint">
          Work the agent has started shows up here, and clears when it finishes.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((t) => (
            <Row key={t.id} task={t} onDone={onDone} />
          ))}
          {done.length > 0 && (
            <div className="mt-1 flex items-center gap-2">
              <p className="text-[10px] tracking-wide text-ink-faint uppercase">Done</p>
              {/* ⛔ CLEARS ONLY WHAT IS FINISHED. Outstanding work is never
                  swept up by a tidy — clearing is for what is OVER. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClear}
                title="Forget every finished task; outstanding ones stay"
                className="ml-auto h-5 px-1.5 text-[10px] text-ink-faint hover:text-ink"
              >
                Clear {done.length} completed
              </Button>
            </div>
          )}
          {done.slice(0, 20).map((t) => (
            <Row key={t.id} task={t} onDone={onDone} />
          ))}
        </div>
      )}
    </div>
  );
}

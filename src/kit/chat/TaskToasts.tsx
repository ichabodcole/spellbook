// "Agent started: ..." when the agent takes a task on, and "Done: ..." when one finishes.
//
// IT WATCHES THE QUEUE, NOT THE ACT. The human never marks most of these done; an
// agent does, in another process, or the daemon finishes a render, while the human
// is reading something else. A toast wired to a button would announce only the
// ones they did themselves, which is exactly backwards. Cancelling is the human's
// own act and needs no toast.
//
// A START IS NEWS ONLY FROM THE AGENT. The human watches the chat log, lower down
// than the Tasks tab's spinner, so a task the agent starts (or a human's task it
// picks up) is announced where they are looking, with a way to the Tasks tab. A
// daemon task (a render) is queued by someone who already knows; its start is not.
// Nor is a start the human is already looking at: with the conversation column
// open on Chat (where `task` posts its title) or on Tasks, the toast says twice
// what is on screen.
import { useEffect, useRef } from "react";
import type { ToastAction } from "../ui/toast-store.ts";
import type { TaskView } from "../workspace/protocol";

/** The start toast's button: what it says, and what a screen reader hears. */
export const SHOW_TASKS_ACTION = {
  label: "Show tasks",
  ariaLabel: "Open the conversation column on the Tasks tab",
} as const;

export function TaskToasts({
  tasks,
  announce,
  onShowTasks,
  startsInView = false,
}: {
  tasks: readonly TaskView[];
  announce: (title: string, description?: string, actions?: ToastAction[]) => void;
  /** Open the conversation column on the Tasks tab. Absent: the start toast has no button. */
  onShowTasks?: () => void;
  /** The start is already on screen (the column is open on Chat or Tasks): no start toast. */
  startsInView?: boolean;
}) {
  // Ids seen as finished. A task already finished when this mounts is history,
  // not news: otherwise a reload would replay every completion at once.
  const seen = useRef<Set<string> | null>(null);
  // Ids seen started (running or past it), seeded the same way: a task already
  // under way when this mounts was announced before the reload, or never will be.
  const started = useRef<Set<string> | null>(null);
  const showTasks = useRef(onShowTasks);
  showTasks.current = onShowTasks;
  const inView = useRef(startsInView);
  inView.current = startsInView;

  useEffect(() => {
    const finished = new Set(
      tasks.filter((t) => t.status === "done" || t.status === "failed").map((t) => t.id),
    );
    const cancelled = tasks.filter((t) => t.status === "cancelled").map((t) => t.id);
    const underway = tasks.filter((t) => t.status !== "open").map((t) => t.id);
    if (seen.current === null || started.current === null) {
      seen.current = new Set([...finished, ...cancelled]);
      started.current = new Set(underway);
      return;
    }
    for (const task of tasks) {
      // Running, from someone other than the daemon, for the first time. One that
      // started and settled between two snapshots is announced by its outcome.
      if (
        task.status === "running" &&
        task.by !== "daemon" &&
        !started.current.has(task.id) &&
        !inView.current
      )
        announce(
          `Agent started: ${task.title}`,
          undefined,
          showTasks.current
            ? [
                {
                  ...SHOW_TASKS_ACTION,
                  onAct: () => showTasks.current?.(),
                },
              ]
            : undefined,
        );
      // A quiet task's parent speaks for it (a batch's renders).
      if (seen.current.has(task.id) || task.quiet) continue;
      if (task.status === "done") announce(`Done: ${task.title}`, task.outcome);
      else if (task.status === "failed")
        announce(`Failed: ${task.title}`, task.detail ?? task.outcome);
    }
    seen.current = new Set([...finished, ...cancelled]);
    for (const id of underway) started.current.add(id);
  }, [tasks, announce]);

  return null;
}

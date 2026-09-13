// "Done: …" when a task finishes (E50).
//
// ⛔ IT WATCHES THE QUEUE, NOT THE ACT — the same shape as the version toast.
// The human never marks most of these done; an AGENT does, in another process,
// while the human is reading something else. A toast wired to a button would
// announce only the ones they did themselves, which is exactly backwards.
import { useEffect, useRef } from "react";
import type { Task } from "../../backend/protocol";

export function TaskToasts({
  tasks,
  announce,
}: {
  tasks: Task[];
  announce: (title: string, description?: string) => void;
}) {
  // Ids seen as DONE. A task already finished when this mounts is history, not
  // news — otherwise a reload would replay every completion at once.
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const done = new Set(tasks.filter((t) => t.doneAt !== undefined).map((t) => t.id));
    if (seen.current === null) {
      seen.current = done;
      return;
    }
    for (const task of tasks) {
      if (task.doneAt === undefined || seen.current.has(task.id)) continue;
      announce(`Done: ${task.text}`, task.outcome);
    }
    seen.current = done;
  }, [tasks, announce]);

  return null;
}

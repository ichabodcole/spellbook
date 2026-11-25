/**
 * The task list (`m.tasks`) and its verbs: one list, three creators (the human,
 * the agent, the daemon). Tier 3 of the session parts
 * (docs/architecture/workspace-session.md), beside the documents, as Story
 * Studio's; ours needs nothing above the core, so it takes the core (`state`)
 * and imports only tier 0 and `state`.
 *
 * Not `../tasks.ts`: that is the daemon's task engine (`TaskEngine`), which
 * runs tasks and drives them through these verbs on the facade.
 *
 * It writes the record through the facade's `persist` (a hook), not
 * `core.persist`, so a test that replaces `persist` on a session still sees
 * every write.
 */

import type { Task, TaskStatus } from "../protocol";
import { SessionError } from "./errors.ts";
import { nowIso, randHex } from "./names.ts";
import type { State } from "./state.ts";
import { isFinished, type NewTask, TASK_NEXT } from "./types.ts";

export class Tasks {
  constructor(
    private readonly core: State,
    private readonly hooks: { persist: () => void },
  ) {}

  /**
   * One list, three creators. A task starts `open` (or `running`, when its
   * creator is already on it) and only ever moves along `TASK_NEXT`.
   */
  createTask(input: NewTask): Task {
    const title = input.title.trim();
    if (!title) throw new SessionError("a task needs to say what the work is", 400);
    if (input.parent !== undefined) this.taskOrDie(input.parent);
    const at = nowIso();
    let id = `t-${randHex(4)}`;
    while (this.core.m.tasks.some((t) => t.id === id)) id = `t-${randHex(4)}`;
    const task: Task = {
      id,
      title,
      by: input.by,
      status: input.status ?? "open",
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.quiet ? { quiet: true as const } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.core.m.tasks.push(task);
    this.hooks.persist();
    return task;
  }

  private taskOrDie(id: string): Task {
    const task = this.core.m.tasks.find((t) => t.id === id);
    if (!task)
      throw new SessionError(
        `no task ${id} in this session`,
        404,
        this.core.m.tasks.filter((t) => !isFinished(t.status)).map((t) => t.id),
      );
    return task;
  }

  task(id: string): Task {
    return this.taskOrDie(id);
  }

  /**
   * Move a task along its transitions. Idempotent on purpose: a task finished
   * twice (an agent retrying, a human clicking as the agent reports) is not an
   * error, and refusing would make the surface handle a race it did not cause.
   * An illegal move (done to running, cancelled to done) is a conflict.
   */
  transitionTask(
    id: string,
    to: TaskStatus,
    patch: { detail?: string; outcome?: string } = {},
  ): { task: Task; from: TaskStatus; changed: boolean } {
    const task = this.taskOrDie(id);
    const from = task.status;
    if (from === to) return { task, from, changed: false };
    if (!TASK_NEXT[from].includes(to))
      throw new SessionError(`task ${id} is ${from}: it cannot become ${to}`, 409);
    task.status = to;
    task.updatedAt = nowIso();
    if (patch.detail !== undefined) task.detail = patch.detail.trim() || undefined;
    if (patch.outcome?.trim()) task.outcome = patch.outcome.trim();
    this.hooks.persist();
    return { task, from, changed: true };
  }

  /**
   * Set a task's detail without persisting: it rides progress reports, which are
   * runtime, and is written with the next status change.
   */
  setTaskDetail(id: string, detail: string): Task {
    const task = this.taskOrDie(id);
    task.detail = detail.trim() || undefined;
    return task;
  }

  /** Forget a finished task: one started by mistake, or no longer worth listing. */
  removeTask(id: string): Task {
    const task = this.taskOrDie(id);
    if (!isFinished(task.status))
      throw new SessionError(`task ${id} is ${task.status}: cancel it before removing it`, 409);
    this.core.m.tasks = this.core.m.tasks.filter((t) => t.id !== id);
    this.hooks.persist();
    return task;
  }

  /** Forget every finished task. Outstanding ones are untouched. */
  clearFinishedTasks(): number {
    const before = this.core.m.tasks.length;
    this.core.m.tasks = this.core.m.tasks.filter((t) => !isFinished(t.status));
    const cleared = before - this.core.m.tasks.length;
    if (cleared > 0) this.hooks.persist();
    return cleared;
  }

  /** Newest first: a queue is read from the top. */
  tasks(): Task[] {
    return [...this.core.m.tasks].reverse();
  }
}

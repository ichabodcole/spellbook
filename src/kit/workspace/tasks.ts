/**
 * The task engine: one list, three creators, and the runners that do the
 * daemon's own work.
 *
 * - A render (or any job the daemon runs) is a task created with `by: "daemon"`
 *   and a `kind` that has a registered runner. The engine runs it, reports its
 *   progress, and settles it.
 * - An agent task is created by the agent and closed by the agent; the engine
 *   only keeps the state legal and tells the stream.
 * - A human task is a request typed in the task panel; it sits `open` until the
 *   agent picks it up or the human cancels it.
 *
 * Statuses move `open` to `running` to one of `done`, `failed`, `cancelled`, and
 * `open` may go straight to `cancelled`. Progress (0 to 1) lives in memory here
 * and is emitted as events; the manifest is written on status changes, never on
 * progress ticks (the session enforces the first half, this module the second).
 *
 * One runner runs at a time per kind: a second request queues as an `open` task
 * and starts when the first settles. Cancelling a running runner task aborts its
 * signal and settles it `cancelled` at once; the runner's own return is then
 * ignored, so a cancelled job can never be reported as finished.
 *
 * The engine does no I/O of its own. The daemon hands it three hooks: one to put
 * an event on the log, one to say a line in the chat, and one to tell the
 * surface the state changed.
 */

import type { Message, Task, TaskStatus, TaskView } from "./protocol";
import type { WorkspaceContext } from "./server";
import { isFinished, type NewTask, SessionError, type WorkspaceSession } from "./session";

/** What a runner may report while it works. `progress` is 0 to 1; out-of-range is clamped. */
export type TaskReport = (update: { progress?: number; detail?: string }) => void;

/** What a runner may hand back when it finishes. */
export type TaskResult = { outcome?: string; detail?: string };

/**
 * The work behind one task `kind`. `run` gets the task as it was when it
 * started, a signal that aborts when the task is cancelled (or the daemon
 * closes), and `report` for progress. Throwing fails the task with the error's
 * message; returning settles it `done`.
 *
 * On abort a runner should stop and leave nothing behind: the engine has already
 * recorded the task as cancelled and will ignore what the runner returns.
 */
/** The task a runner is handed: the stored task plus the `input` it was created with, if any. */
export type RunnerTask = Task & { input?: unknown };

export type TaskRunner = {
  run(
    task: RunnerTask,
    signal: AbortSignal,
    report: TaskReport,
    /** The running daemon's context: the session, the log, the chat. */
    ctx: WorkspaceContext,
  ): Promise<TaskResult | undefined> | TaskResult | undefined;
  /**
   * What a cancel of a running task did, said after `Cancelled: <title>` in
   * the one chat line a cancel makes (a batch: "1 rendered, 2 cancelled").
   * Asked after the signal is aborted, so the runner's abort handling has run.
   */
  cancelNote?(task: Task, ctx: WorkspaceContext): string | undefined;
};

export type EngineHooks = {
  /** Put an event on the log. */
  emit(type: string, fields: Record<string, unknown>): void;
  /** Say a line in the chat. */
  say(input: { from: Message["from"]; type: Message["type"]; text: string }): void;
  /** The state changed: the surface needs a new snapshot. */
  changed(): void;
  /** The daemon's context, handed to each runner. */
  context(): WorkspaceContext;
};

/** Who did it, for the event: a task's creator is not always who settles it. */
export type Actor = "human" | "agent" | "daemon";

type Running = { id: string; controller: AbortController; done: Promise<void> };

export class TaskEngine {
  private runners = new Map<string, TaskRunner>();
  private progress = new Map<string, number>();
  /** `input` by task id: memory only, dropped when the task settles or is cancelled. */
  private inputs = new Map<string, unknown>();
  private active = new Map<string, Running>();
  private closing = false;

  constructor(
    private readonly session: WorkspaceSession,
    runners: Record<string, TaskRunner>,
    private readonly hooks: EngineHooks,
  ) {
    if (typeof hooks.context !== "function")
      throw new Error("a task engine needs the daemon's context hook: runners are handed it");
    for (const [kind, runner] of Object.entries(runners)) this.registerRunner(kind, runner);
  }

  /** Register the runner for a task kind. One per kind; a second is a programming error. */
  registerRunner(kind: string, runner: TaskRunner): void {
    if (this.runners.has(kind)) throw new Error(`a runner is already registered for "${kind}"`);
    this.runners.set(kind, runner);
  }

  /** Whether a kind has a runner. */
  hasRunner(kind: string): boolean {
    return this.runners.has(kind);
  }

  /** The tasks for the snapshot, newest first, with runtime progress on the ones that have it. */
  view(): TaskView[] {
    return this.session.tasks().map((t) => {
      const progress = this.progress.get(t.id);
      return progress === undefined ? t : { ...t, progress };
    });
  }

  progressOf(id: string): number | undefined {
    return this.progress.get(id);
  }

  /**
   * Create a task. A daemon task whose kind has a runner is queued and starts as
   * soon as nothing else of its kind is running.
   */
  create(input: NewTask): Task {
    // A daemon task is one the daemon runs: a kind with no runner behind it would
    // sit `open` for ever, so it is refused here, naming the kind.
    if (input.by === "daemon") {
      if (!input.kind)
        throw new SessionError("a daemon task needs a kind, and a runner registered for it", 400);
      if (!this.runners.has(input.kind))
        throw new SessionError(`no runner is registered for task kind "${input.kind}"`, 400, [
          ...this.runners.keys(),
        ]);
    }
    const task = this.session.createTask(input);
    if (input.input !== undefined) this.inputs.set(task.id, input.input);
    this.hooks.emit("task.created", {
      task: task.id,
      title: task.title,
      by: task.by,
      status: task.status,
      ...(task.kind ? { kind: task.kind } : {}),
      ...(task.parent ? { parent: task.parent } : {}),
      ...(task.detail ? { detail: task.detail } : {}),
      ...(task.messageId ? { message_id: task.messageId } : {}),
    });
    if (task.status === "running")
      this.hooks.emit("task.started", this.startedFields(task, task.by));
    this.hooks.changed();
    if (task.by === "daemon" && task.kind) this.pump(task.kind);
    return task;
  }

  /** `open` to `running`: someone (the agent, a runner) is on it. Idempotent once running. */
  start(id: string, by: Actor): Task {
    this.ownedByDaemon(id, by);
    const { task, changed } = this.session.transitionTask(id, "running");
    if (changed) {
      this.hooks.emit("task.started", this.startedFields(task, by));
      this.hooks.changed();
    }
    return task;
  }

  /**
   * Say what a running task is on. A queued task is picked up first (the agent
   * naming what it is doing is the agent starting it).
   */
  setDetail(id: string, detail: string, by: Actor): Task {
    const current = this.session.task(id);
    this.ownedByDaemon(id, by);
    // Checked before anything changes: a finished task's detail is its record.
    if (isFinished(current.status))
      throw new SessionError(`task ${id} is ${current.status}: its detail cannot change`, 409);
    if (current.status === "open") this.start(id, by);
    const task = this.session.setTaskDetail(id, detail);
    this.hooks.emit("task.progress", {
      task: id,
      title: task.title,
      ...(task.detail ? { detail: task.detail } : {}),
      ...(this.progress.has(id) ? { progress: this.progress.get(id) } : {}),
    });
    this.hooks.changed();
    return task;
  }

  /**
   * Settle a task `done` or `failed`. A queued task is started first, so the
   * transitions stay the legal ones. Idempotent: settling twice reports `already`.
   */
  finish(
    id: string,
    status: "done" | "failed",
    patch: { outcome?: string; detail?: string },
    by: Actor,
  ): { task: Task; already: boolean } {
    this.ownedByDaemon(id, by);
    if (this.session.task(id).status === "open") this.start(id, by);
    const { task, changed } = this.session.transitionTask(id, status, patch);
    if (!changed) return { task, already: true };
    this.progress.delete(id);
    if (status === "done") {
      this.hooks.emit("task.done", {
        task: id,
        title: task.title,
        by,
        ...(task.outcome ? { outcome: task.outcome } : {}),
      });
      if (!task.quiet)
        this.hooks.say({
          from: "system",
          type: "result",
          text: `Done: ${task.title}${task.outcome ? `: ${task.outcome}` : ""}`,
        });
    } else {
      this.hooks.emit("task.failed", {
        task: id,
        title: task.title,
        by,
        message: task.detail ?? "failed",
      });
      if (!task.quiet)
        this.hooks.say({
          from: "system",
          type: "result",
          text: `Failed: ${task.title}${task.detail ? `: ${task.detail}` : ""}`,
        });
    }
    this.hooks.changed();
    return { task, already: false };
  }

  /**
   * Cancel a task. The human can cancel any task. A queued task just leaves the
   * queue; a running runner task has its signal aborted; an agent task emits
   * `task.cancelled` on the agent's stream and the agent stops and acknowledges.
   * A finished task cannot be cancelled (a conflict); cancelling twice is fine.
   */
  cancel(id: string, by: Actor): { task: Task; already: boolean } {
    const { task, from, changed } = this.session.transitionTask(id, "cancelled");
    if (!changed) return { task, already: true };
    this.progress.delete(id);
    this.inputs.delete(id);
    const running = [...this.active.values()].find((r) => r.id === id);
    running?.controller.abort();
    this.hooks.emit("task.cancelled", { task: id, title: task.title, by, was: from });
    if (!task.quiet) {
      const runner = running && task.kind ? this.runners.get(task.kind) : undefined;
      let note: string | undefined;
      try {
        note = runner?.cancelNote?.(task, this.hooks.context())?.trim() || undefined;
      } catch {
        /* a note that cannot be had leaves the line as it is */
      }
      this.hooks.say({
        from: "system",
        type: "info",
        text: `Cancelled: ${task.title}${note ? `: ${note}` : ""}`,
      });
    }
    this.hooks.changed();
    return { task, already: false };
  }

  /**
   * Report progress for a running task. Ignored once the task has settled, so a
   * runner that keeps ticking after a cancel cannot resurrect it.
   */
  report(id: string, update: { progress?: number; detail?: string }): void {
    const current = this.session.task(id);
    if (current.status !== "running") return;
    const fields: Record<string, unknown> = { task: id, title: current.title };
    if (update.progress !== undefined && Number.isFinite(update.progress)) {
      const p = Math.min(1, Math.max(0, update.progress));
      this.progress.set(id, p);
      fields.progress = p;
    }
    if (update.detail !== undefined) {
      const task = this.session.setTaskDetail(id, update.detail);
      if (task.detail) fields.detail = task.detail;
    }
    if (!("progress" in fields) && !("detail" in fields)) return;
    this.hooks.emit("task.progress", fields);
    this.hooks.changed();
  }

  /**
   * Cancel every daemon job that has not finished, running or queued, for a
   * daemon that is closing: a job must not outlive the session that owns it, and
   * a queue that kept starting the next job as each one aborted would never
   * drain. Returns once the runners have returned.
   */
  async abortAll(): Promise<void> {
    this.closing = true;
    for (const t of this.session.tasks()) {
      if (t.by !== "daemon" || !t.kind || !this.runners.has(t.kind) || isFinished(t.status))
        continue;
      try {
        this.cancel(t.id, "daemon");
      } catch {
        /* settled under us */
      }
    }
    for (const r of this.active.values()) r.controller.abort();
    await this.idle();
  }

  /** Resolves when no runner is running. For teardown and for tests. */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map((r) => r.done));
  }

  /**
   * A daemon's task is the daemon's: its runner starts it, reports it and settles
   * it. Anyone else may cancel it (cancel aborts the runner) and nothing more, so
   * an agent's `task-done` can never mark a render finished while it still runs.
   */
  private ownedByDaemon(id: string, by: Actor): void {
    const task = this.session.task(id);
    if (task.by === "daemon" && by !== "daemon")
      throw new SessionError(
        `task ${id} is the daemon's (${task.kind ?? "a job"}): it settles itself`,
        409,
        undefined,
        `only cancel is allowed on a daemon task: task-cancel ${id}`,
      );
  }

  // ── the queue ───────────────────────────────────────────────────────────

  private startedFields(task: Task, by: Actor): Record<string, unknown> {
    return {
      task: task.id,
      title: task.title,
      by,
      ...(task.kind ? { kind: task.kind } : {}),
      ...(task.parent ? { parent: task.parent } : {}),
    };
  }

  /** Start the oldest queued daemon task of `kind`, if nothing of that kind is running. */
  private pump(kind: string): void {
    const runner = this.runners.get(kind);
    if (!runner || this.closing || this.active.has(kind)) return;
    // The session lists newest first; the queue is served oldest first.
    const next = [...this.session.tasks()]
      .reverse()
      .find((t) => t.kind === kind && t.by === "daemon" && t.status === "open");
    if (!next) return;
    this.execute(next, runner);
  }

  private execute(queued: Task, runner: TaskRunner): void {
    const kind = queued.kind as string;
    const controller = new AbortController();
    const task = this.start(queued.id, "daemon");
    const settled = (): boolean => isFinished(this.session.task(task.id).status);

    const done = (async () => {
      try {
        const result = await runner.run(
          { ...task, ...(this.inputs.has(task.id) ? { input: this.inputs.get(task.id) } : {}) },
          controller.signal,
          (update) => this.report(task.id, update),
          this.hooks.context(),
        );
        if (settled()) return; // cancelled while it ran: its return means nothing
        this.finish(
          task.id,
          "done",
          { outcome: result?.outcome, detail: result?.detail },
          "daemon",
        );
      } catch (e) {
        if (settled()) return;
        const message = e instanceof Error ? e.message : String(e);
        this.finish(task.id, "failed", { detail: message }, "daemon");
      }
    })().finally(() => {
      this.active.delete(kind);
      this.progress.delete(task.id);
      this.inputs.delete(task.id);
      this.pump(kind);
    });
    this.active.set(kind, { id: task.id, controller, done });
  }
}

export type { TaskStatus };

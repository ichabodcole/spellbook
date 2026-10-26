// Tasks: the transitions, the runner registry, progress as events (never as
// manifest writes), cancel through the runner's signal, and the queue.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceContext } from "./server";
import { WorkspaceSession } from "./session";
import { TaskEngine, type TaskRunner } from "./tasks";
import { refusal, tempRoot, testApp } from "./testing";

let root: string;
let session: WorkspaceSession;
let events: { type: string; [k: string]: unknown }[];
let said: { from: string; type: string; text: string }[];
let changes: number;

beforeEach(() => {
  root = tempRoot("workspace-tasks");
  session = WorkspaceSession.create(join(root, "sessions"), testApp);
  events = [];
  said = [];
  changes = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const engineWith = (runners: Record<string, TaskRunner> = {}) =>
  new TaskEngine(session, runners, {
    emit: (type, fields) => events.push({ ...fields, type }),
    say: (m) => said.push(m),
    changed: () => {
      changes += 1;
    },
    context: () => ({ app: "kit-test" }) as unknown as WorkspaceContext,
  });

test("an engine built without the context hook is refused", () => {
  expect(
    () =>
      new TaskEngine(session, {}, { emit: () => {}, say: () => {}, changed: () => {} } as never),
  ).toThrow("context hook");
});

const types = () => events.map((e) => e.type);
const manifestTasks = () =>
  (JSON.parse(readFileSync(join(session.dir, "manifest.json"), "utf8")) as { tasks: unknown[] })
    .tasks;

/** A runner under the test's control: it runs until `release()` is called, or its signal aborts. */
function gated() {
  const calls: { task: string; signal: AbortSignal; report: (u: object) => void }[] = [];
  const releases: ((r?: { outcome?: string; detail?: string }) => void)[] = [];
  const fails: ((e: Error) => void)[] = [];
  const runner: TaskRunner = {
    run: (task, signal, report) =>
      new Promise((resolve, reject) => {
        calls.push({ task: task.id, signal, report });
        releases.push(resolve);
        fails.push(reject);
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
  };
  return {
    runner,
    calls,
    release: (i = 0, r?: { outcome?: string }) => releases[i]?.(r),
    fail: (i = 0, m = "boom") => fails[i]?.(new Error(m)),
  };
}

describe("the session's transitions", () => {
  test("open to running to done, and open straight to cancelled", () => {
    const a = session.createTask({ title: "A", by: "agent" });
    expect(a.status).toBe("open");
    expect(session.transitionTask(a.id, "running").task.status).toBe("running");
    expect(session.transitionTask(a.id, "done", { outcome: "ok" }).task).toMatchObject({
      status: "done",
      outcome: "ok",
    });
    const b = session.createTask({ title: "B", by: "human" });
    expect(session.transitionTask(b.id, "cancelled").task.status).toBe("cancelled");
  });

  test("the illegal moves are conflicts, and leave the task as it was", () => {
    const t = session.createTask({ title: "T", by: "agent" });
    // open cannot be done or failed without running
    expect(refusal(() => session.transitionTask(t.id, "done")).status).toBe(409);
    expect(refusal(() => session.transitionTask(t.id, "failed")).status).toBe(409);
    session.transitionTask(t.id, "running");
    // running cannot go back to open
    expect(refusal(() => session.transitionTask(t.id, "open")).status).toBe(409);
    session.transitionTask(t.id, "failed", { detail: "no" });
    // nothing leaves a terminal status
    for (const to of ["open", "running", "done", "cancelled"] as const)
      expect(refusal(() => session.transitionTask(t.id, to)).status, to).toBe(409);
    expect(session.task(t.id)).toMatchObject({ status: "failed", detail: "no" });
  });

  test("moving to the status a task is already in is a quiet no-op", () => {
    const t = session.createTask({ title: "T", by: "agent", status: "running" });
    expect(session.transitionTask(t.id, "running").changed).toBe(false);
    session.transitionTask(t.id, "done");
    const again = session.transitionTask(t.id, "done");
    expect(again.changed).toBe(false);
  });

  test("a task has by, kind, parent and messageId, and updatedAt moves with its status", async () => {
    const parent = session.createTask({ title: "Manage", by: "agent", status: "running" });
    const child = session.createTask({
      title: "Delegate",
      by: "agent",
      kind: "research",
      parent: parent.id,
      messageId: "m-1",
    });
    expect(child).toMatchObject({
      by: "agent",
      kind: "research",
      parent: parent.id,
      messageId: "m-1",
    });
    expect(child.createdAt).toBe(child.updatedAt);
    await Bun.sleep(5);
    session.transitionTask(child.id, "running");
    expect(session.task(child.id).updatedAt > session.task(child.id).createdAt).toBe(true);
  });

  test("a parent that is not a task is refused, and an empty title too", () => {
    expect(
      refusal(() => session.createTask({ title: "x", by: "agent", parent: "t-nope" })).status,
    ).toBe(404);
    expect(refusal(() => session.createTask({ title: "  ", by: "agent" })).status).toBe(400);
  });

  test("only a finished task can be removed", () => {
    const t = session.createTask({ title: "T", by: "human" });
    expect(refusal(() => session.removeTask(t.id)).message).toContain("cancel it");
    session.transitionTask(t.id, "cancelled");
    expect(session.removeTask(t.id).id).toBe(t.id);
    const u = session.createTask({ title: "U", by: "human" });
    const v = session.createTask({ title: "V", by: "human" });
    session.transitionTask(v.id, "cancelled");
    expect(session.clearFinishedTasks()).toBe(1);
    expect(session.tasks().map((x) => x.id)).toEqual([u.id]);
  });

  test("the list is newest first", () => {
    const a = session.createTask({ title: "A", by: "human" });
    const b = session.createTask({ title: "B", by: "human" });
    expect(session.tasks().map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

describe("the engine: agent and human tasks", () => {
  test("an agent task created running says created and started, and finishing says done", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Tighten the ending", by: "agent", status: "running" });
    expect(types()).toEqual(["task.created", "task.started"]);
    expect(events[1]).toMatchObject({ task: t.id, by: "agent", title: "Tighten the ending" });
    const r = engine.finish(t.id, "done", { outcome: "cut two paragraphs" }, "agent");
    expect(r.already).toBe(false);
    expect(types().at(-1)).toBe("task.done");
    expect(events.at(-1)).toMatchObject({ task: t.id, outcome: "cut two paragraphs" });
    expect(said.at(-1)).toMatchObject({ from: "system", type: "result" });
    expect(said.at(-1)?.text).toContain("cut two paragraphs");
    // Finishing again is not an error.
    expect(engine.finish(t.id, "done", {}, "agent").already).toBe(true);
    expect(types().filter((x) => x === "task.done")).toHaveLength(1);
  });

  test("a human task sits open on the stream until the agent picks it up", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Render all sections", by: "human" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task.created",
      by: "human",
      status: "open",
      task: t.id,
    });
    // The agent naming what it is doing picks it up.
    engine.setDetail(t.id, "rendering section 1", "agent");
    expect(types()).toEqual(["task.created", "task.started", "task.progress"]);
    expect(session.task(t.id)).toMatchObject({ status: "running", detail: "rendering section 1" });
  });

  test("finishing a queued task starts it first, so the transitions stay legal", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Quick one", by: "human" });
    engine.finish(t.id, "done", { outcome: "done at once" }, "agent");
    expect(types()).toEqual(["task.created", "task.started", "task.done"]);
    expect(session.task(t.id).status).toBe("done");
  });

  test("failing records the reason, says so on the stream and in the chat", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Try", by: "agent", status: "running" });
    engine.finish(t.id, "failed", { detail: "the provider said no" }, "agent");
    expect(events.at(-1)).toMatchObject({ type: "task.failed", message: "the provider said no" });
    expect(said.at(-1)?.text).toContain("the provider said no");
  });

  test("cancelling a human task emits task.cancelled, names who did it, and is idempotent", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Mine", by: "agent", status: "running" });
    const r = engine.cancel(t.id, "human");
    expect(r.already).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "task.cancelled",
      task: t.id,
      by: "human",
      was: "running",
    });
    expect(engine.cancel(t.id, "human").already).toBe(true);
    expect(types().filter((x) => x === "task.cancelled")).toHaveLength(1);
    // A cancelled task cannot be finished by an agent that has not noticed.
    expect(refusal(() => engine.finish(t.id, "done", {}, "agent")).status).toBe(409);
  });

  test("a finished task cannot be cancelled", () => {
    const engine = engineWith();
    const t = engine.create({ title: "Done already", by: "agent", status: "running" });
    engine.finish(t.id, "done", {}, "agent");
    expect(refusal(() => engine.cancel(t.id, "human")).status).toBe(409);
  });

  test("a quiet task settles with no chat line, its events still on the log", () => {
    const engine = engineWith();
    const parent = engine.create({ title: "Batch", by: "agent", status: "running" });
    const done = engine.create({ title: "Child one", by: "agent", parent: parent.id, quiet: true });
    const failed = engine.create({
      title: "Child two",
      by: "agent",
      parent: parent.id,
      quiet: true,
    });
    const cancelled = engine.create({ title: "Child three", by: "agent", quiet: true });
    expect(done.quiet).toBe(true);
    said.length = 0;
    engine.finish(done.id, "done", { outcome: "ok" }, "agent");
    engine.finish(failed.id, "failed", { detail: "no" }, "agent");
    engine.cancel(cancelled.id, "human");
    expect(said).toEqual([]);
    expect(
      events.filter((e) =>
        ["task.done", "task.failed", "task.cancelled"].includes(e.type as string),
      ),
    ).toHaveLength(3);
    // A task that is not quiet still says how it went.
    engine.finish(parent.id, "done", { outcome: "2 of 3" }, "agent");
    expect(said.at(-1)?.text).toBe("Done: Batch: 2 of 3");
  });

  test("a running task's runner may add what the cancel did to its one chat line", async () => {
    let release = () => {};
    const engine = engineWith({
      job: {
        run: (_t, signal) =>
          new Promise((resolve) => {
            release = () => resolve(undefined);
            signal.addEventListener("abort", () => resolve(undefined));
          }),
        cancelNote: () => "2 kept, 1 dropped",
      },
    });
    const t = engine.create({ title: "Batch", by: "daemon", kind: "job" });
    said.length = 0;
    engine.cancel(t.id, "human");
    expect(said).toEqual([
      { from: "system", type: "info", text: "Cancelled: Batch: 2 kept, 1 dropped" },
    ]);
    release();
    await engine.idle();
    // A queued task (no runner running) says the plain line.
    const busy = engine.create({ title: "Busy", by: "daemon", kind: "job" });
    const queued = engine.create({ title: "Queued", by: "daemon", kind: "job" });
    said.length = 0;
    engine.cancel(queued.id, "human");
    expect(said.map((m) => m.text)).toEqual(["Cancelled: Queued"]);
    engine.cancel(busy.id, "human");
    await engine.idle();
  });

  test("a delegated task names its parent on the stream", () => {
    const engine = engineWith();
    const parent = engine.create({ title: "Manage", by: "agent", status: "running" });
    engine.create({ title: "Delegate", by: "agent", status: "running", parent: parent.id });
    expect(events.find((e) => e.type === "task.created" && e.parent === parent.id)).toBeDefined();
  });
});

describe("runners", () => {
  test("a runner is handed the daemon's context as its fourth argument", async () => {
    const ctx = { app: "the-app" } as unknown as WorkspaceContext;
    let seen: unknown;
    const engine = new TaskEngine(
      session,
      {
        render: {
          run: (_task, _signal, _report, c) => {
            seen = c;
            return undefined;
          },
        },
      },
      { emit: () => {}, say: () => {}, changed: () => {}, context: () => ctx },
    );
    engine.create({ title: "Render", by: "daemon", kind: "render" });
    await engine.idle();
    expect(seen).toBe(ctx);
  });

  test("a daemon task with a runner starts at once, reports progress as events, and settles done", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render intro", by: "daemon", kind: "render" });
    expect(session.task(t.id).status).toBe("running");
    expect(types()).toEqual(["task.created", "task.started"]);

    g.calls[0]?.report({ progress: 0.25, detail: "section 1" });
    g.calls[0]?.report({ progress: 0.75 });
    const progress = events.filter((e) => e.type === "task.progress");
    expect(progress.map((e) => e.progress)).toEqual([0.25, 0.75]);
    expect(progress[0]?.detail).toBe("section 1");
    expect(engine.progressOf(t.id)).toBe(0.75);
    // The snapshot's task carries the runtime progress; the stored one never does.
    expect(engine.view()[0]?.progress).toBe(0.75);
    expect(session.task(t.id)).not.toHaveProperty("progress");

    g.release(0, { outcome: "rendered 12s" });
    await engine.idle();
    expect(session.task(t.id)).toMatchObject({ status: "done", outcome: "rendered 12s" });
    expect(types().at(-1)).toBe("task.done");
    // Progress is gone with the task's running state.
    expect(engine.progressOf(t.id)).toBeUndefined();
    expect(engine.view()[0]?.progress).toBeUndefined();
  });

  test("progress is clamped to 0..1, ignored when not a number, and never touches the manifest", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    const before = readFileSync(join(session.dir, "manifest.json"), "utf8");
    g.calls[0]?.report({ progress: 7 });
    g.calls[0]?.report({ progress: -3 });
    g.calls[0]?.report({ progress: Number.NaN });
    g.calls[0]?.report({});
    expect(events.filter((e) => e.type === "task.progress").map((e) => e.progress)).toEqual([1, 0]);
    // A detail rides along in memory; the file did not change on any tick.
    g.calls[0]?.report({ progress: 0.5, detail: "halfway" });
    expect(readFileSync(join(session.dir, "manifest.json"), "utf8")).toBe(before);
    expect(session.task(t.id).detail).toBe("halfway");
    // ...and is written with the status change.
    g.release();
    await engine.idle();
    expect(manifestTasks()).toMatchObject([{ id: t.id, status: "done", detail: "halfway" }]);
  });

  test("a runner that throws fails the task with the error's message", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    g.fail(0, "ELEVENLABS_API_KEY is not set");
    await engine.idle();
    expect(session.task(t.id)).toMatchObject({
      status: "failed",
      detail: "ELEVENLABS_API_KEY is not set",
    });
    expect(events.at(-1)).toMatchObject({
      type: "task.failed",
      message: "ELEVENLABS_API_KEY is not set",
    });
  });

  test("cancelling aborts the runner's signal, emits task.cancelled, and the runner's return is ignored", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    expect(g.calls[0]?.signal.aborted).toBe(false);
    engine.cancel(t.id, "human");
    expect(g.calls[0]?.signal.aborted).toBe(true);
    // Settled at once, before the runner has even returned.
    expect(session.task(t.id).status).toBe("cancelled");
    expect(events.at(-1)).toMatchObject({
      type: "task.cancelled",
      task: t.id,
      by: "human",
      was: "running",
    });
    await engine.idle();
    // The runner resolved (as an aborted one does) and that changed nothing.
    expect(session.task(t.id).status).toBe("cancelled");
    expect(types()).not.toContain("task.done");
    // A late tick from a runner that did not stop cannot resurrect it.
    const n = events.length;
    g.calls[0]?.report({ progress: 0.9 });
    expect(events).toHaveLength(n);
    expect(engine.progressOf(t.id)).toBeUndefined();
  });

  test("a runner that throws because it was aborted does not turn a cancel into a failure", async () => {
    const calls: AbortSignal[] = [];
    const engine = engineWith({
      render: {
        run: (_task, signal) =>
          new Promise((_resolve, reject) => {
            calls.push(signal);
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      },
    });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    engine.cancel(t.id, "human");
    await engine.idle();
    expect(session.task(t.id).status).toBe("cancelled");
    expect(types()).not.toContain("task.failed");
  });

  test("one runner runs at a time per kind: a second request queues as open and starts when the first settles", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const first = engine.create({ title: "One", by: "daemon", kind: "render" });
    const second = engine.create({ title: "Two", by: "daemon", kind: "render" });
    const third = engine.create({ title: "Three", by: "daemon", kind: "render" });
    expect(session.task(first.id).status).toBe("running");
    expect(session.task(second.id).status).toBe("open");
    expect(session.task(third.id).status).toBe("open");
    expect(g.calls).toHaveLength(1);

    g.release(0);
    await Bun.sleep(0);
    expect(session.task(first.id).status).toBe("done");
    expect(session.task(second.id).status).toBe("running");
    expect(session.task(third.id).status).toBe("open");
    expect(g.calls).toHaveLength(2);

    g.release(1);
    await Bun.sleep(0);
    g.release(2);
    await engine.idle();
    expect(session.tasks().map((t) => t.status)).toEqual(["done", "done", "done"]);
    // Oldest first.
    expect(g.calls.map((c) => c.task)).toEqual([first.id, second.id, third.id]);
  });

  test("cancelling a queued task takes it out of the queue; the next one still runs", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    engine.create({ title: "One", by: "daemon", kind: "render" });
    const queued = engine.create({ title: "Two", by: "daemon", kind: "render" });
    const last = engine.create({ title: "Three", by: "daemon", kind: "render" });
    engine.cancel(queued.id, "human");
    expect(session.task(queued.id).status).toBe("cancelled");
    expect(g.calls).toHaveLength(1); // no runner was ever started for it
    g.release(0);
    await Bun.sleep(0);
    expect(session.task(last.id).status).toBe("running");
    expect(g.calls.map((c) => c.task)).not.toContain(queued.id);
    g.release(1);
    await engine.idle();
  });

  test("kinds do not block each other", async () => {
    const a = gated();
    const b = gated();
    const engine = engineWith({ render: a.runner, export: b.runner });
    const r = engine.create({ title: "Render", by: "daemon", kind: "render" });
    const e = engine.create({ title: "Export", by: "daemon", kind: "export" });
    expect(session.task(r.id).status).toBe("running");
    expect(session.task(e.id).status).toBe("running");
    a.release();
    b.release();
    await engine.idle();
  });

  test("input reaches the runner as task.input, is never persisted, and is dropped when the task settles or is cancelled", async () => {
    const seen: unknown[] = [];
    const g = gated();
    const engine = engineWith({
      job: {
        run: (task, signal, report, ctx) => {
          seen.push(task.input);
          return g.runner.run(task, signal, report, ctx);
        },
      },
    });
    const first = engine.create({
      title: "a",
      by: "daemon",
      kind: "job",
      input: { doc: "story", voice: "warm" },
    });
    const second = engine.create({
      title: "b",
      by: "daemon",
      kind: "job",
      input: { doc: "other" },
    });
    await Bun.sleep(10);
    expect(seen).toEqual([{ doc: "story", voice: "warm" }]);
    // The stored task, the snapshot and the manifest never carry it.
    expect(JSON.stringify(manifestTasks())).not.toContain("warm");
    expect(JSON.stringify(engine.view())).not.toContain("warm");
    // Cancelling the queued task drops its input: when the queue moves on, it is not run.
    engine.cancel(second.id, "human");
    g.release(0);
    await engine.idle();
    expect(seen).toHaveLength(1);
    expect((engine as unknown as { inputs: Map<string, unknown> }).inputs.size).toBe(0);
    expect(session.task(first.id).status).toBe("done");
  });

  test("a task made without input hands the runner none", async () => {
    let got: unknown = "unset";
    const engine = engineWith({
      job: {
        run: (task) => {
          got = "input" in task ? task.input : "absent";
          return undefined;
        },
      },
    });
    engine.create({ title: "a", by: "daemon", kind: "job" });
    await engine.idle();
    expect(got).toBe("absent");
  });

  test("a task by an agent or a human is never run by the engine, whatever its kind", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const agent = engine.create({ title: "Agent's", by: "agent", kind: "render" });
    const human = engine.create({ title: "Human's", by: "human", kind: "render" });
    expect(g.calls).toHaveLength(0);
    expect([agent, human].map((t) => session.task(t.id).status)).toEqual(["open", "open"]);
  });

  test("the text a runner sees is the task as it was when it started", async () => {
    const seen: string[] = [];
    const engine = engineWith({
      render: {
        run: async (task) => {
          seen.push(`${task.id}:${task.status}`);
          return undefined;
        },
      },
    });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    await engine.idle();
    expect(seen).toEqual([`${t.id}:running`]);
  });

  test("abortAll cancels what is running and waits for the runners to return", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    const queued = engine.create({ title: "Queued", by: "daemon", kind: "render" });
    await engine.abortAll();
    expect(g.calls[0]?.signal.aborted).toBe(true);
    expect(session.task(t.id).status).toBe("cancelled");
    expect(events.find((e) => e.type === "task.cancelled" && e.by === "daemon")).toBeDefined();
    // The queue does not start the next job as the first aborts: it is cancelled too.
    expect(session.task(queued.id).status).toBe("cancelled");
    expect(g.calls).toHaveLength(1);
  });

  test("a second runner for a kind is a programming error", () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    expect(() => engine.registerRunner("render", g.runner)).toThrow(/already registered/);
    expect(engine.hasRunner("render")).toBe(true);
    expect(engine.hasRunner("export")).toBe(false);
  });

  test("every status change tells the surface the state changed", () => {
    const engine = engineWith();
    const t = engine.create({ title: "T", by: "agent", status: "running" });
    const before = changes;
    engine.finish(t.id, "done", {}, "agent");
    expect(changes).toBeGreaterThan(before);
  });
});

describe("a daemon's task is the daemon's", () => {
  test("another party cannot settle, detail or start it: only cancel is allowed, and the hint says so", async () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const running = engine.create({ title: "Render", by: "daemon", kind: "render" });
    const queued = engine.create({ title: "Render two", by: "daemon", kind: "render" });
    for (const act of [
      () => engine.finish(running.id, "done", { outcome: "lies" }, "agent"),
      () => engine.finish(running.id, "failed", {}, "human"),
      () => engine.setDetail(queued.id, "I am on it", "agent"),
      () => engine.start(queued.id, "agent"),
    ]) {
      const e = refusal(act);
      expect(e.status).toBe(409);
      expect(e.hint).toContain("only cancel is allowed");
    }
    // Nothing moved: the render is still running, and the queue is still waiting its turn.
    expect(session.task(running.id).status).toBe("running");
    expect(session.task(queued.id)).toMatchObject({ status: "open" });
    expect(session.task(queued.id).detail).toBeUndefined();
    g.release(0);
    await Bun.sleep(0);
    expect(session.task(running.id).status).toBe("done");
    expect(session.task(queued.id).status).toBe("running");
    g.release(1);
    await engine.idle();
  });

  test("cancel stays the one outside act, and it aborts the runner", () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const t = engine.create({ title: "Render", by: "daemon", kind: "render" });
    expect(engine.cancel(t.id, "agent").already).toBe(false);
    expect(g.calls[0]?.signal.aborted).toBe(true);
  });

  test("a daemon task with no runner for its kind, or no kind, is refused at create", () => {
    const g = gated();
    const engine = engineWith({ render: g.runner });
    const e = refusal(() => engine.create({ title: "Mystery", by: "daemon", kind: "mystery" }));
    expect(e.status).toBe(400);
    expect(e.message).toContain('"mystery"');
    expect(e.choices).toEqual(["render"]);
    expect(refusal(() => engine.create({ title: "Kindless", by: "daemon" })).status).toBe(400);
    expect(session.tasks()).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("setDetail on a finished task is refused and leaves its record as it was", () => {
    const engine = engineWith();
    const t = engine.create({ title: "T", by: "agent", status: "running" });
    engine.setDetail(t.id, "step one", "agent");
    engine.finish(t.id, "done", { outcome: "ok" }, "agent");
    const n = events.length;
    expect(refusal(() => engine.setDetail(t.id, "rewriting history", "agent")).status).toBe(409);
    expect(session.task(t.id).detail).toBe("step one");
    expect(events).toHaveLength(n);
    const c = engine.create({ title: "C", by: "human" });
    engine.cancel(c.id, "human");
    expect(refusal(() => engine.setDetail(c.id, "x", "agent")).status).toBe(409);
    expect(session.task(c.id).status).toBe("cancelled");
  });
});

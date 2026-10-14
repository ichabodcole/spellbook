// A small app built on the workspace substrate, for the integration tests: the
// same composition a real app does (a name and a slot, a runner, an app verb, an
// app event), driven through real launchers. Not exported from the subpath.

import { join } from "node:path";
import {
  type AppDeclaration,
  createWorkspaceDaemon,
  type TaskRunner,
  type VerbHandler,
  type WorkspaceDaemonOptions,
} from "../index";

export const fixtureApp: AppDeclaration = {
  name: "kit-fixture",
  launcher: "bun /fixture/scripts/cli.ts",
  slot: {
    version: 1,
    migrate: (prev) => ({ renders: [], ...prev }),
  },
};

/** Where the fixture keeps its sessions: the test points `KIT_FIXTURE_HOME` at a temp folder. */
export function fixtureSessionsRoot(): string {
  const home = process.env.KIT_FIXTURE_HOME;
  if (!home) throw new Error("KIT_FIXTURE_HOME is not set");
  return join(home, "sessions");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** Four steps, reporting progress after each; aborts promptly. */
export const demoRunner: TaskRunner = {
  async run(_task, signal, report) {
    const stepMs = Number(process.env.KIT_FIXTURE_STEP_MS ?? 25);
    for (let i = 1; i <= 4; i++) {
      await sleep(stepMs, signal);
      report({ progress: i / 4, detail: `step ${i} of 4` });
    }
    return { outcome: "4 steps" };
  },
};

/**
 * Reports once, then runs until it is cancelled. For a test that cancels a
 * running job: the demo's four steps end on their own, and a cancel sent from a
 * cold CLI process on a loaded machine can arrive after the last one.
 */
export const holdRunner: TaskRunner = {
  async run(_task, signal, report) {
    report({ progress: 0.5, detail: "holding until cancelled" });
    await new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return { outcome: "never" };
  },
};

export const fixtureVerbs: Record<string, VerbHandler> = {
  "kit-fixture.demo": (ctx, args) => {
    const task = ctx.tasks.create({
      title: typeof args.title === "string" ? args.title : "Demo",
      by: "daemon",
      kind: args.hold === true ? "hold" : "demo",
    });
    return { task: task.id };
  },
  "kit-fixture.ping": (ctx, args) => {
    ctx.emit("kit-fixture.pinged", { n: args.n ?? 1 });
    return { pinged: true };
  },
};

export function fixtureDaemonOptions(
  overrides: Partial<WorkspaceDaemonOptions> = {},
): WorkspaceDaemonOptions {
  return {
    app: fixtureApp,
    sessionsRoot: fixtureSessionsRoot(),
    runners: { demo: demoRunner, hold: holdRunner },
    verbs: fixtureVerbs,
    events: { "kit-fixture.pinged": "wake", "kit-fixture.glanced": "quiet" },
    // A tail or a socket still open at teardown costs the full 150 ms grace
    // otherwise; loopback needs far less to flush a frame.
    drainGraceMs: 10,
    // No test reaches the real Trash, whatever NODE_ENV says: a test that
    // deletes passes its own (a move into a temp folder).
    trash: async () => {
      throw new Error("the fixture daemon has no Trash: pass a trash function");
    },
    ...overrides,
  };
}

export const fixtureDaemon = (overrides: Partial<WorkspaceDaemonOptions> = {}) =>
  createWorkspaceDaemon(fixtureDaemonOptions(overrides));

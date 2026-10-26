// An app following a rename or move (`hooks.followMove`), through a real
// daemon and its socket: the hook hears each act once, from either party; its
// way back rides on the kit's act, so one arrow undoes the file and the app's
// part together, and redo does both again; an undo or redo never calls the
// hook afresh; a hook that fails leaves the act done and says so.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import { type Follow, FollowError } from "./history";
import type { WorkspaceDaemon, WorkspaceDaemonOptions } from "./server";
import { seedDocs, tempRoot } from "./testing";

type Moved = Parameters<NonNullable<NonNullable<WorkspaceDaemonOptions["hooks"]>["followMove"]>>[0];

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;
/** What the hook heard, and what each follow did, in order. */
let heard: Moved[];
let did: string[];
/** How the hook answers: a way back, nothing, a throw, or a throw after doing part of it. */
let answer: "follow" | "none" | "throw" | "part";

/** A follow between two names: running it does the way back and returns the way forward. */
const between = (a: string, b: string): Follow => {
  return () => {
    did.push(`${a} <- ${b}`);
    return between(b, a);
  };
};

beforeEach(() => {
  root = tempRoot("history-follow");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  heard = [];
  did = [];
  answer = "follow";
});

afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  daemon = null;
  surface = null;
  rmSync(root, { recursive: true, force: true });
});

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    hooks: {
      followMove: (moved) => {
        heard.push(moved);
        if (answer === "throw") throw new Error("the app's list does not read");
        if (answer === "none") return undefined;
        if (answer === "part") {
          did.push("part done");
          throw new FollowError("the rest could not be done", () => {
            did.push("part undone");
            return undefined;
          });
        }
        did.push(`${base(moved.from)} -> ${base(moved.to)}`);
        return between(base(moved.from), base(moved.to));
      },
    },
  });
  await daemon.start();
  const d = daemon;
  surface = new FakeSurface();
  await surface.connect(d.port);
  const s = surface;
  s.send({ op: "context.add", path: docs });
  await waitUntil("context", () => s.state.context.length === 1);
  const ok = async (body: { op: string; [key: string]: unknown }) => {
    const r = await cmd(d.url, body);
    if (r.status !== 200) throw new Error(`${body.op}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { s, ok };
}

describe("hooks.followMove", () => {
  test("a rename: heard once; one undo puts the file and the app's part back, and redo does both", async () => {
    const { s } = await start();
    const a = join(docs, "set", "a.md");
    const aa = join(docs, "set", "aa.md");
    s.send({ op: "rename", path: a, name: "aa.md" });
    await waitUntil("renamed", () => s.state.history.undoLabel === "renamed a.md to aa.md");
    expect(heard).toEqual([{ op: "rename", from: a, to: aa, by: "human" }]);
    expect(did).toEqual(["a.md -> aa.md"]);

    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    expect(existsSync(a)).toBe(true);
    expect(did).toEqual(["a.md -> aa.md", "a.md <- aa.md"]);
    // Still one step: the arrow took the rename and its follow together.
    expect(s.state.history.canUndo).toBe(false);

    s.send({ op: "history.redo" });
    await waitUntil("redone", () => !s.state.history.canRedo);
    expect(existsSync(aa)).toBe(true);
    expect(did).toEqual(["a.md -> aa.md", "a.md <- aa.md", "aa.md <- a.md"]);
    s.send({ op: "history.undo" });
    await waitUntil("undone again", () => s.state.history.canRedo);
    expect(did.at(-1)).toBe("a.md <- aa.md");
    // The hook heard the act only: never its undo or redo.
    expect(heard).toHaveLength(1);
  });

  test("a move by the agent: heard with who did it, and undone with its follow", async () => {
    const { s, ok } = await start();
    const solo = join(docs, "solo.md");
    const into = join(docs, "set");
    await ok({ op: "move", path: solo, into });
    await waitUntil("moved", () => s.state.history.canUndo);
    expect(heard).toEqual([{ op: "move", from: solo, to: join(into, "solo.md"), by: "agent" }]);
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    expect(existsSync(solo)).toBe(true);
    expect(did).toEqual(["solo.md -> solo.md", "solo.md <- solo.md"]);
  });

  test("a hook with nothing to follow changes nothing; one that throws leaves the act done, and says so", async () => {
    const { s } = await start();
    answer = "none";
    s.send({ op: "rename", path: join(docs, "solo.md"), name: "one.md" });
    await waitUntil("renamed", () => s.state.history.undoLabel === "renamed solo.md to one.md");
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => existsSync(join(docs, "solo.md")));

    answer = "throw";
    s.send({ op: "rename", path: join(docs, "sibling.md"), name: "two.md" });
    await waitUntil("renamed", () => s.state.history.undoLabel === "renamed sibling.md to two.md");
    expect(existsSync(join(docs, "two.md"))).toBe(true);
    await waitUntil("said", () =>
      s.state.chat.some(
        (m) =>
          m.text.startsWith("You renamed ") &&
          m.text.endsWith("two.md. kit-fixture could not follow it: the app's list does not read."),
      ),
    );
  });

  test("a hook that did only part keeps the way back from that part, and says what it could not do", async () => {
    const { s } = await start();
    answer = "part";
    s.send({ op: "rename", path: join(docs, "solo.md"), name: "one.md" });
    await waitUntil("renamed", () => s.state.history.undoLabel === "renamed solo.md to one.md");
    await waitUntil("said", () =>
      s.state.chat.some((m) =>
        m.text.endsWith("one.md. kit-fixture could not follow it: the rest could not be done."),
      ),
    );
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => existsSync(join(docs, "solo.md")));
    await waitUntil("its part undone", () => did.includes("part undone"));
    expect(did).toEqual(["part done", "part undone"]);
  });
});

// `set.make` and `folder.add` through a real daemon: the chat line and the
// fact on the agent's tail, the entry's id kept, the new folder watched, the
// links the move broke said and not rewritten, and the context's undo and redo.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;
let tail: ReturnType<typeof collectEvents> | null = null;

beforeEach(() => {
  root = tempRoot("workspace-set-promotion-daemon");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "solo.md"), "# Solo\n\nSee [the sibling](sibling.md).\n");
});

afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  daemon = null;
  surface = null;
  tail = null;
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    platform: "darwin",
    reveal: () => {},
    trash: async () => {
      throw new Error("no Trash in this test");
    },
  });
  await daemon.start();
  const d = daemon;
  tail = collectEvents(d.url);
  surface = new FakeSurface();
  await surface.connect(d.port);
  const s = surface;
  s.send({ op: "context.add", path: join(docs, "solo.md") });
  s.send({ op: "context.add", path: join(docs, "sibling.md") });
  await waitUntil("context", () => s.state.context.length === 2);
  return { s, t: tail, d };
}

describe("set.make through the daemon", () => {
  test("said in the chat and on the tail, the entry kept, the broken links named and left", async () => {
    const { s, t, d } = await start();
    const id = s.state.context.find((e) => e.label === "solo.md")?.id ?? "";
    const r = await cmd(d.url, { op: "set.make", path: join(docs, "solo.md") });
    expect(r.status).toBe(200);
    const folder = join(docs, "solo");
    expect(r.body).toMatchObject({ folder, path: join(folder, "solo.md"), entry: id });
    const broken = (r.body as { broken?: { count: number; hint: string } }).broken;
    expect(broken?.count).toBe(1);
    expect(broken?.hint).toContain("make-set does not rewrite links");
    expect(readFileSync(join(folder, "solo.md"), "utf8")).toContain("(sibling.md)");
    await waitUntil("mirrored", () =>
      s.state.context.some((e) => e.id === id && e.membership === "mirrored" && e.root === folder),
    );
    expect(
      s.state.chat.some((m) => m.text.startsWith("Agent turned solo.md into a set: solo.")),
    ).toBe(true);
    await t.waitFor((e) => e.type === "system" && e.fact === "set.make" && e.entry === id);
    expect(s.state.history.undoLabel).toBe("turned solo.md into a set");
  });

  test("the new folder is watched: a document made there by another program reaches the tree", async () => {
    const { s, d } = await start();
    await cmd(d.url, { op: "set.make", path: join(docs, "solo.md") });
    const folder = join(docs, "solo");
    const id = s.state.context.find((e) => e.root === folder)?.id;
    await writeUntilSeen(
      "the new document",
      () => writeFileSync(join(folder, "later.md"), "# Later\n"),
      () => s.state.context.find((e) => e.id === id)?.nodes.some((n) => n.rel === "later.md"),
    );
  });

  test("undo puts the document back, listed by the same entry; redo makes the set again", async () => {
    const { s, d } = await start();
    const id = s.state.context.find((e) => e.label === "solo.md")?.id ?? "";
    await cmd(d.url, { op: "set.make", path: join(docs, "solo.md") });
    await waitUntil("set", () => s.state.history.undoLabel === "turned solo.md into a set");
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    expect(existsSync(join(docs, "solo.md"))).toBe(true);
    expect(existsSync(join(docs, "solo"))).toBe(false);
    expect(s.state.context.find((e) => e.id === id)).toMatchObject({
      membership: "listed",
      root: docs,
    });
    expect(s.state.chat.some((m) => m.text === "You undid: turned solo.md into a set.")).toBe(true);
    s.send({ op: "history.redo" });
    await waitUntil("redone", () => existsSync(join(docs, "solo", "solo.md")));
    await waitUntil("mirrored again", () =>
      s.state.context.some((e) => e.id === id && e.membership === "mirrored"),
    );
    // And back once more: the redo's own undo follows where the document is.
    s.send({ op: "history.undo" });
    await waitUntil("undone again", () => existsSync(join(docs, "solo.md")));
  });

  test("a document in a set is refused with the shipped words, and nothing changes", async () => {
    const { s, d } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("the set", () => s.state.context.length === 3);
    const r = await cmd(d.url, { op: "set.make", path: join(docs, "set", "a.md") });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("make a folder there instead");
    expect(existsSync(join(docs, "set", "a"))).toBe(false);
  });
});

describe("folder.add through the daemon", () => {
  test("a folder where the caller names it is a new set, said, and undone as a creation", async () => {
    const { s, t, d } = await start();
    const where = join(root, "elsewhere");
    const r = await cmd(d.url, { op: "folder.add", path: where });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: where, set: true });
    await waitUntil("a set", () => s.state.context.some((e) => e.root === where));
    expect(s.state.chat.some((m) => m.text.startsWith("Agent created the set "))).toBe(true);
    await t.waitFor((e) => e.type === "system" && e.fact === "folder.add" && e.set === true);
    expect(s.state.history.undoLabel).toBe("created the set elsewhere");
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("gone", () => !existsSync(where));
  });

  test("a parent that is not on disk is refused, and says so", async () => {
    const { d } = await start();
    const r = await cmd(d.url, { op: "folder.add", path: join(root, "nowhere", "x") });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("is not a folder on disk");
  });
});

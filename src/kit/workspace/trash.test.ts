// Delete to the Trash: the argv per platform, what the session says would go,
// and the daemon's human-only op. No test here touches the real Trash: the
// daemon is given a trash function that moves the path into a temp folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { underTest } from "../lib/home";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { inContext, refusal, seedDocs, tempRoot } from "./testing";
import { MAC_TRASH, MAC_TRASH_JXA, trashCommand } from "./trash";

describe("the command, per platform", () => {
  const none = () => null;
  test("macOS 15+ uses /usr/bin/trash, failing loudly", () => {
    expect(trashCommand({ platform: "darwin", exists: () => true }, "/w/a.md")).toEqual([
      MAC_TRASH,
      "-s",
      "/w/a.md",
    ]);
  });

  test("older macOS asks NSFileManager through osascript, the path as an argument", () => {
    const argv = trashCommand({ platform: "darwin", exists: () => false }, "/w/a.md");
    expect(argv).toEqual(["osascript", "-l", "JavaScript", "-e", MAC_TRASH_JXA, "/w/a.md"]);
    expect(MAC_TRASH_JXA).toContain("trashItemAtURL");
    expect(MAC_TRASH_JXA).not.toContain("Finder");
  });

  test("Linux uses gio, else trash-cli, else nothing", () => {
    const which = (have: string[]) => (c: string) => (have.includes(c) ? `/usr/bin/${c}` : null);
    expect(trashCommand({ platform: "linux", which: which(["gio", "trash-put"]) }, "/w/a")).toEqual(
      ["/usr/bin/gio", "trash", "--", "/w/a"],
    );
    expect(trashCommand({ platform: "linux", which: which(["trash-put"]) }, "/w/a")).toEqual([
      "/usr/bin/trash-put",
      "--",
      "/w/a",
    ]);
    expect(trashCommand({ platform: "linux", which: none }, "/w/a")).toBeNull();
  });

  test("Windows and the rest get nothing, so the daemon can refuse in words", () => {
    expect(trashCommand({ platform: "win32", which: none }, "/w/a.md")).toBeNull();
    expect(trashCommand({ platform: "freebsd", which: none }, "/w/a.md")).toBeNull();
  });

  test("the path is one argv element, whatever it holds, and must be absolute", () => {
    const nasty = "/w/a b; rm -rf ~/$(x)'\".md";
    const argv = trashCommand({ platform: "darwin", exists: () => true }, nasty);
    expect(argv?.at(-1)).toBe(nasty);
    expect(argv).toHaveLength(3);
    expect(() => trashCommand({ platform: "darwin" }, "-rf")).toThrow(/absolute/);
  });
});

let root: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-trash");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
});

describe("what would go", () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a folder: its files and folders counted, and the documents the session holds", () => {
    const s = inContext(join(root, "sessions"), docs);
    s.openPath(join(docs, "set", "a.md"));
    s.edit("a", 1, "unsaved\n");
    s.openPath(join(docs, "set", "part", "b.md"));
    const p = s.trashPreview(join(docs, "set"));
    expect(p).toMatchObject({ path: join(docs, "set"), dir: true, files: 3, folders: 1 });
    expect(p.docs).toEqual([
      { slug: "a", name: "a.md", unsaved: true, versions: 1, open: false },
      { slug: "b", name: "b.md", unsaved: false, versions: 1, open: true },
    ]);
    expect(p.truncated).toBeUndefined();
  });

  test("a document is one file", () => {
    const s = inContext(join(root, "sessions"), docs);
    expect(s.trashPreview(join(docs, "solo.md"))).toMatchObject({
      dir: false,
      files: 1,
      folders: 0,
      docs: [],
    });
  });

  test("a whole set and a path outside the context are refused", () => {
    const s = inContext(join(root, "sessions"), docs);
    expect(refusal(() => s.trashPreview(docs)).message).toContain("whole set");
    expect(refusal(() => s.trashPreview(join(root, "elsewhere.md"))).status).toBe(404);
    expect(refusal(() => s.trashPreview("relative/a.md")).status).toBe(400);
  });

  test("after it went: the documents are missing, the open one closes, versions stay", () => {
    const s = inContext(join(root, "sessions"), docs);
    s.openPath(join(docs, "set", "part", "b.md"));
    const versionFile = s.doc("b").versions[0]?.path ?? "";
    rmSync(join(docs, "set", "part"), { recursive: true });
    const r = s.trashed(join(docs, "set", "part"));
    expect(r).toEqual({ docs: ["b"], closed: "b" });
    expect(s.openDocSlug).toBeNull();
    expect(s.doc("b").missing).toBe("folder");
    expect(existsSync(versionFile)).toBe(true);
    // The set no longer shows the folder.
    expect(JSON.stringify(s.view().context)).not.toContain("part");
  });
});

describe("the daemon's trash op", () => {
  let daemon: WorkspaceDaemon | null = null;
  let surface: FakeSurface | null = null;
  let tail: ReturnType<typeof collectEvents> | null = null;
  let bin: string;
  let trashedPaths: string[];

  afterEach(async () => {
    surface?.close();
    await tail?.stop();
    if (daemon) await daemon.stop();
    daemon = null;
    surface = null;
    tail = null;
    rmSync(root, { recursive: true, force: true });
  });

  async function start(withTrash = true) {
    bin = join(root, "fake-trash");
    mkdirSync(bin, { recursive: true });
    trashedPaths = [];
    daemon = fixtureDaemon({
      tmp: join(root, "tmp"),
      platform: "darwin",
      reveal: () => {},
      ...(withTrash
        ? {
            trash: async (p: string) => {
              trashedPaths.push(p);
              renameSync(p, join(bin, basename(p)));
            },
          }
        : // Explicitly none, past the fixture's own refusing default: the
          // daemon's NODE_ENV guard is what answers.
          { trash: undefined }),
    });
    await daemon.start();
    tail = collectEvents(daemon.url);
    surface = new FakeSurface();
    await surface.connect(daemon.port);
    surface.send({ op: "context.add", path: docs });
    await waitUntil("context", () => surface?.state.context.length === 1);
    return { s: surface, t: tail, base: daemon.url };
  }

  test("a preview answers the sender; trash moves it, says so, and closes the open document", async () => {
    const { s, t } = await start();
    s.send({ op: "open", path: join(docs, "set", "part", "b.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "edit", doc: "b", version: 1, text: "unsaved\n" });
    await waitUntil("dirty", () => s.state.docs[0]?.dirty);

    s.send({ op: "trash.preview", path: join(docs, "set", "part"), rid: 3 } as never);
    const pre = await s.waitFor((m) => m.op === "trash.preview");
    expect(pre).toMatchObject({ dir: true, files: 1, folders: 0, shown: "docs/set/part" });

    s.send({ op: "trash", path: join(docs, "set", "part"), rid: 4 } as never);
    expect(await s.waitFor((m) => m.op === "trash.done")).toMatchObject({
      path: join(docs, "set", "part"),
    });
    expect(trashedPaths).toEqual([join(docs, "set", "part")]);
    expect(readFileSync(join(bin, "part", "b.md"), "utf8")).toBe("# B\n");

    const ev = await t.waitFor((e) => e.type === "system" && e.fact === "trash");
    expect(ev).toMatchObject({ by: "human", dir: true, files: 1, docs: ["b"], closed: "b" });
    expect(String(ev.text)).toContain("to the Trash");
    expect(String(ev.text)).toContain("The versions of b.md are kept in the session.");
    await waitUntil("closed", () => s.state.openDoc === null);
    expect(s.state.docs[0]?.missing).toBe("folder");
    // The chat records it like the other structure changes.
    expect(s.state.chat.some((m) => m.text.startsWith("You moved the folder docs/set/part"))).toBe(
      true,
    );
    // The watcher's own sight of the deletion does not announce it a second time.
    await Bun.sleep(300);
    expect(t.events.some((e) => e.type === "system" && e.fact === "original.missing")).toBe(false);
  });

  test("a single listed document goes, and its entry with it", async () => {
    const { s } = await start();
    const solo = join(docs, "..", "solo-listed.md");
    writeFileSync(solo, "# Listed\n");
    s.send({ op: "context.add", path: solo });
    await waitUntil("listed", () => s.state.context.length === 2);
    s.send({ op: "trash", path: solo });
    await s.waitFor((m) => m.op === "trash.done");
    await waitUntil("entry gone", () => s.state.context.length === 1);
    expect(existsSync(solo)).toBe(false);
  });

  test("the agent has no way to it: no command, and the structure verbs do not take it", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "trash", path: join(docs, "set", "a.md") });
    expect(r.status).not.toBe(200);
    const p = await cmd(base, { op: "trash.preview", path: join(docs, "set", "a.md") });
    expect(p.status).not.toBe(200);
    expect(existsSync(join(docs, "set", "a.md"))).toBe(true);
    expect(trashedPaths).toEqual([]);
  });

  test("under test, a daemon with no trash function refuses rather than use the real Trash", async () => {
    // ⛔ CHECKED BEFORE THE OP IS SENT, AND THROWN, NOT EXPECTED: this daemon
    // has no trash function, so outside a test run it would use the real Trash.
    if (!underTest())
      throw new Error("not under test: refusing to send a delete with no trash function");
    const { s } = await start(false);
    s.send({ op: "trash", path: join(docs, "set", "a.md"), rid: 5 } as never);
    const err = await s.waitFor((m) => m.op === "error" && m.requestId === 5);
    expect(err.op === "error" && err.message).toContain("not used under test");
    expect(existsSync(join(docs, "set", "a.md"))).toBe(true);
  });

  test("the fixture daemon's default trash refuses, so no test can reach the real Trash", async () => {
    await start(true);
    await daemon?.stop();
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), platform: "darwin" });
    await daemon.start();
    surface?.close();
    surface = new FakeSurface();
    await surface.connect(daemon.port);
    surface.send({ op: "context.add", path: docs });
    await waitUntil("context", () => surface?.state.context.length === 1);
    surface.send({ op: "trash", path: join(docs, "set", "a.md"), rid: 8 } as never);
    const err = await surface.waitFor((m) => m.op === "error" && m.requestId === 8);
    expect(err.op === "error" && err.message).toContain("fixture daemon has no Trash");
    expect(existsSync(join(docs, "set", "a.md"))).toBe(true);
  });

  test("a failed move says why, and changes nothing in the session", async () => {
    const { s } = await start();
    daemon?.session.openPath(join(docs, "set", "a.md"));
    await daemon?.stop();
    daemon = fixtureDaemon({
      tmp: join(root, "tmp"),
      platform: "darwin",
      restore: basename(daemon?.dir ?? ""),
      trash: async () => {
        throw new Error("the disk said no");
      },
    });
    await daemon.start();
    surface?.close();
    surface = new FakeSurface();
    await surface.connect(daemon.port);
    void s;
    surface.send({ op: "trash", path: join(docs, "set", "a.md"), rid: 6 } as never);
    const err = await surface.waitFor((m) => m.op === "error" && m.requestId === 6);
    expect(err.op === "error" && err.message).toContain("the disk said no");
    expect(daemon.session.doc("a").missing).toBeUndefined();
  });
});

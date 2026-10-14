// Following a link over a real daemon: `link.open` carries the href exactly as
// the document wrote it, the session resolves it against the context, an
// `in-context` target opens as `open` would, and `link.target` answers every
// time with the state. Nothing is ever added to the context.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import type { ServerOp } from "./protocol";
import { CONTEXT_CHANGED_SETTLE_MS, isDotPath, type WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

/** Whether the temp disk is case-insensitive (macOS by default; Linux CI is not). */
const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), "case-probe-"));
  try {
    writeFileSync(join(dir, "Probe"), "");
    return existsSync(join(dir, "probe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let surface: FakeSurface;

beforeEach(async () => {
  root = tempRoot("workspace-links");
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "Maren's Bakery.md"), "# Maren\n");
  daemon = fixtureDaemon({ tmp, platform: "darwin", reveal: () => {} });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: join(docs, "set") });
  await waitUntil("context", () => surface.state.context.length === 1);
  surface.send({ op: "open", path: join(docs, "set", "a.md") });
  await surface.waitFor((m) => m.op === "version.text" && m.doc === "a");
});
afterEach(async () => {
  surface.close();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

/** The request id a reply echoes. */
const rid = (m: ServerOp) => (m as { requestId?: unknown }).requestId;

let asked = 0;
const follow = async (target: string, doc?: string, from?: "chat") => {
  const id = `f${++asked}`;
  surface.send({
    op: "link.open",
    target,
    ...(doc ? { doc } : {}),
    ...(from ? { from } : {}),
    rid: id,
  } as never);
  return surface.waitFor((m) => m.op === "link.target" && rid(m) === id);
};

describe("link.open", () => {
  test("a relative href is not a path `open` takes: the reason the pane needed a resolver", async () => {
    surface.send({ op: "open", path: "./part/b.md", rid: "raw" } as never);
    const r = await surface.waitFor((m) => m.op === "error" && rid(m) === "raw");
    expect(String((r as { message?: string }).message)).toContain("is not a full path");
  });

  test("an in-context target opens, sends its text first, and answers in-context", async () => {
    const r = await follow("./part/b.md?rel=sister-of,extends#top", "a");
    expect(r).toMatchObject({
      op: "link.target",
      target: "./part/b.md?rel=sister-of,extends#top",
      state: "in-context",
      path: join(docs, "set", "part", "b.md"),
    });
    await waitUntil("b open", () => surface.state.openDoc === "b");
    expect(surface.frames.some((m) => m.op === "version.text" && m.doc === "b")).toBe(true);
  });

  test("a `../` link from a nested document comes back up", async () => {
    await follow("./part/b.md", "a");
    await waitUntil("b open", () => surface.state.openDoc === "b");
    const r = await follow("../a.md", "b");
    expect(r).toMatchObject({ state: "in-context", path: join(docs, "set", "a.md") });
    await waitUntil("a open", () => surface.state.openDoc === "a");
  });

  test("a percent-encoded name with an apostrophe opens the file it names", async () => {
    const r = await follow("Maren's%20Bakery.md?rel=located-in", "a");
    expect(r).toMatchObject({ state: "in-context", path: join(docs, "set", "Maren's Bakery.md") });
  });

  test("a target outside the context answers outside, opens nothing and adds nothing", async () => {
    const r = await follow("../solo.md", "a");
    expect(r).toMatchObject({ state: "outside", path: join(docs, "solo.md") });
    expect(surface.state.openDoc).toBe("a");
    expect(surface.state.context).toHaveLength(1);
    expect(surface.state.docs.map((d) => d.slug)).toEqual(["a"]);
  });

  test("a missing target answers missing, with where it looked", async () => {
    const r = await follow("./gone.md", "a");
    expect(r).toMatchObject({ state: "missing", tried: [join(docs, "set", "gone.md")] });
  });

  test("a link to a folder answers folder, not a missing `.md`", async () => {
    const r = await follow("./part/", "a");
    expect(r).toMatchObject({ state: "folder", path: join(docs, "set", "part") });
  });

  // Only meaningful on a case-insensitive disk, where `./Part/B.md` is the same file;
  // on a case-sensitive one (Linux CI) it is simply missing.
  test.skipIf(!caseInsensitive)(
    "a link in the wrong case comes back in the file's own case",
    async () => {
      const r = await follow("./Part/B.md", "a");
      expect(r).toMatchObject({ state: "in-context", path: join(docs, "set", "part", "b.md") });
      await waitUntil("b open", () => surface.state.openDoc === "b");
      expect(surface.state.docs.find((d) => d.slug === "b")?.original).toBe(
        join(docs, "set", "part", "b.md"),
      );
    },
  );

  test("a chat link's `./` falls back to the root when a nested document is open", async () => {
    await follow("./part/b.md", "a");
    await waitUntil("b open", () => surface.state.openDoc === "b");
    // Written in b.md, `./part/b.md` would mean part/part/b.md; from the chat it
    // means the context.
    expect(await follow("./part/b.md", "b")).toMatchObject({ state: "missing" });
    expect(await follow("./part/b.md", "b", "chat")).toMatchObject({
      state: "in-context",
      path: join(docs, "set", "part", "b.md"),
    });
  });

  test("a file that is not a document answers not-a-doc", async () => {
    writeFileSync(join(docs, "set", "notes.zip"), "PK");
    const r = await follow("./notes.zip", "a");
    expect(r).toMatchObject({ state: "not-a-doc", path: join(docs, "set", "notes.zip") });
  });

  test("an image the tree shows opens in the viewer (kit-image-files)", async () => {
    const r = await follow("./skip.png", "a");
    expect(r).toMatchObject({ state: "in-context", path: join(docs, "set", "skip.png") });
    await waitUntil("the viewer", () => surface.state.openImage?.name === "skip.png");
  });

  test("with no document named (the chat, nothing open), a link reads from the context's root", async () => {
    const r = await follow("part/b.md");
    expect(r).toMatchObject({ state: "in-context", path: join(docs, "set", "part", "b.md") });
  });

  test("an unknown document is refused by name", async () => {
    surface.send({ op: "link.open", target: "./b.md", doc: "nope", rid: "bad" } as never);
    const r = await surface.waitFor((m) => m.op === "error" && rid(m) === "bad");
    expect(String((r as { message?: string }).message)).toContain("nope");
  });
});

describe("link.backlinks", () => {
  const backlinks = async (doc: string) => {
    const id = `b${++asked}`;
    surface.send({ op: "link.backlinks", doc, rid: id } as never);
    return (await surface.waitFor((m) => m.op === "link.backlinks" && rid(m) === id)) as Extract<
      ServerOp,
      { op: "link.backlinks" }
    >;
  };

  test("the links that land, read as the documents write them", async () => {
    writeFileSync(
      join(docs, "set", "part", "c.md"),
      [
        "---",
        "title: C",
        "---",
        "",
        "Builds on [A](../a.md?rel=extends).",
        // From part/, `./a.md` names part/a.md: broken where it is written,
        // though the chat's fallback to the root would land it.
        "Not [this](./a.md).",
      ].join("\n"),
    );
    writeFileSync(join(docs, "set", "a.md"), "# A\n\nMe: [here](./a.md#top)\n");
    await waitUntil("c listed", () => JSON.stringify(surface.state.context).includes("c.md"));
    const r = await backlinks("a");
    expect(r).toMatchObject({ doc: "a", path: join(docs, "set", "a.md"), count: 1, bare: 0 });
    expect(r.backlinks).toEqual([
      {
        source: join(docs, "set", "part", "c.md"),
        name: "c.md",
        shown: "part/c.md",
        line: 5,
        raw: "../a.md?rel=extends",
        rel: ["extends"],
        kind: "markdown",
        label: "A",
        context: "Builds on [A](../a.md?rel=extends).",
        from: 28,
        to: 52,
      },
    ]);
    expect(r.relations).toEqual([{ rel: "extends", count: 1 }]);
  });

  test("an unsaved edit in another document counts, and a change on disk is read again", async () => {
    surface.send({ op: "open", path: join(docs, "set", "part", "b.md") });
    await surface.waitFor((m) => m.op === "version.text" && m.doc === "b");
    surface.send({ op: "edit", doc: "b", version: 1, text: "# B\n\nsee [A](../a.md)\n" });
    await waitUntil("dirty", () => surface.state.docs.find((d) => d.slug === "b")?.dirty);
    const first = await backlinks("a");
    expect(first.backlinks.map((b) => [b.shown, b.line, b.rel])).toEqual([["part/b.md", 3, []]]);
    expect(first.bare).toBe(1);

    // A document the session does not hold is read from disk, and read again
    // when it changes (the cache is keyed by the file's stamp).
    writeFileSync(join(docs, "set", "part", "d.md"), "[A](../a.md?rel=sister-of)\n");
    await waitUntil("d listed", () => JSON.stringify(surface.state.context).includes("d.md"));
    expect((await backlinks("a")).count).toBe(2);
    writeFileSync(join(docs, "set", "part", "d.md"), "no link now, and a longer line\n");
    expect((await backlinks("a")).count).toBe(1);
  });

  test("an unknown document is refused by name", async () => {
    surface.send({ op: "link.backlinks", doc: "nope", rid: "bad-b" } as never);
    const r = await surface.waitFor((m) => m.op === "error" && rid(m) === "bad-b");
    expect(String((r as { message?: string }).message)).toContain("nope");
  });
});

describe("link.check", () => {
  test("answers the sender with the session's check, read-only", async () => {
    // Written until listed: under a doubled load (a rerun beside the parallel
    // suite) this write was once never reported, 5 s on, though the set's watch
    // had been live for seconds. The same bytes again are harmless.
    await writeUntilSeen(
      "c listed",
      () =>
        writeFileSync(
          join(docs, "set", "part", "c.md"),
          "# C\n\n[x](op:doc/1) [y](./nowhere.md)\n",
        ),
      () => JSON.stringify(surface.state.context).includes("c.md"),
    );
    surface.send({ op: "link.check", rid: "chk" } as never);
    const r = (await surface.waitFor((m) => m.op === "link.check" && rid(m) === "chk")) as Extract<
      ServerOp,
      { op: "link.check" }
    >;
    expect(r.dangling.links.map((l) => [l.shown, l.line, l.raw])).toEqual([
      ["part/c.md", 3, "./nowhere.md"],
    ]);
    expect(r.unsupported.links.map((l) => [l.shown, l.scheme])).toEqual([["part/c.md", "op"]]);
    expect(r.unsupported.schemes).toEqual(["op"]);
    expect(r.duplicates.count).toBe(0);
  });

  test("a change on disk to a document the session does not hold is pushed as context.changed", async () => {
    const seen = surface.frames.length;
    // The set's watch was armed a moment ago, by context.add.
    await writeUntilSeen(
      "context.changed",
      () => writeFileSync(join(docs, "set", "part", "b.md"), "# B, changed outside\n"),
      () => surface.frames.slice(seen).some((m) => m.op === "context.changed"),
    );
  });

  test("dot-paths (.git, .DS_Store, .obsidian) never push context.changed", async () => {
    // Let anything from setup settle, then start counting.
    await Bun.sleep(CONTEXT_CHANGED_SETTLE_MS + 300);
    const seen = surface.frames.length;
    const pushed = () =>
      surface.frames.slice(seen).filter((m) => m.op === "context.changed").length;
    mkdirSync(join(docs, "set", ".git", "refs"), { recursive: true });
    writeFileSync(join(docs, "set", ".git", "refs", "HEAD"), "ref: x\n");
    writeFileSync(join(docs, "set", ".DS_Store"), "x");
    mkdirSync(join(docs, "set", "part", ".obsidian"), { recursive: true });
    writeFileSync(join(docs, "set", "part", ".obsidian", "workspace.json"), "{}");
    await Bun.sleep(CONTEXT_CHANGED_SETTLE_MS + 500);
    expect(pushed()).toBe(0);
    // A document's change still does, so the watcher was listening all along.
    writeFileSync(join(docs, "set", "part", "b.md"), "# B, changed outside\n");
    await waitUntil("a push", () => pushed() > 0);
  });

  test("a listed document's _meta/profiles made after the session started is watched", async () => {
    surface.send({ op: "context.add", path: join(docs, "solo.md") });
    await waitUntil("listed", () => surface.state.context.length === 2);
    // The folder's own watcher sees `_meta` appear, and syncs the watchers
    // again. That watch was armed a moment ago, by context.add, so `_meta` is
    // made again until the folder's watch has said so.
    const listed = surface.frames.length;
    await writeUntilSeen(
      "_meta seen",
      () => {
        rmSync(join(docs, "_meta"), { recursive: true, force: true });
        mkdirSync(join(docs, "_meta", "profiles"), { recursive: true });
      },
      () => surface.frames.slice(listed).some((m) => m.op === "context.changed"),
      // Past the context's settle, so a repeat is only ever of a lost one.
      { everyMs: 1500 },
    );
    // The profiles' own watch is armed by that sync, a moment later still.
    const seen = surface.frames.length;
    await writeUntilSeen(
      "the profile's change",
      () => writeFileSync(join(docs, "_meta", "profiles", "note.json"), '{"kind":"note"}'),
      () => surface.frames.slice(seen).some((m) => m.op === "context.changed"),
    );
  });

  test("isDotPath reads every segment", () => {
    for (const p of [".git/HEAD", ".DS_Store", "part/.obsidian/x.json", "a\\.hidden\\b.md"])
      expect(isDotPath(p)).toBe(true);
    for (const p of ["a.md", "part/b.md", "notes.v2/c.md"]) expect(isDotPath(p)).toBe(false);
  });
});

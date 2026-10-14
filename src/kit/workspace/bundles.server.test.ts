// Bundles through the daemon: New, Rename, Move to, Duplicate and the Trash
// each act on the whole folder as one act, with one undo entry where the
// context's history keeps one; a rename offers to update the links that point
// at the bundle; and the watcher reports a change inside a bundle as a change
// to the bundle. No test here touches the real Trash: the daemon is given a
// trash function that moves the path into a temp folder.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { jpegBytes, pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { ContextNode, ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { TEST_BUNDLE, tempRoot, writeBundle } from "./testing";

let root: string;
let set: string;
let well: string;
let bin: string;
let trashed: string[];
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;
let tail: ReturnType<typeof collectEvents> | null = null;

beforeAll(() => registerBundleType(TEST_BUNDLE));
afterAll(() => unregisterBundleType(TEST_BUNDLE.extension));

beforeEach(() => {
  root = tempRoot("workspace-bundles-daemon");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "set");
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), "# A\n\nSee [the well](./The%20well.boardbundle).\n");
  // A title that is not the folder's stem, so an undo that only renamed the
  // folder back would be seen.
  well = writeBundle(set, "The well", {
    version: 1,
    type: "board",
    title: "The well at the Glade",
  });
  bin = join(root, "fake-trash");
  mkdirSync(bin, { recursive: true });
  trashed = [];
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
    trash: async (p: string) => {
      trashed.push(p);
      renameSync(p, join(bin, basename(p)));
    },
  });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: set });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { s: surface, t: tail };
}

const flat = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n, ...flat(n.children)] : [n]));
const rowsOf = (s: FakeSurface) => flat(s.state.context[0]?.nodes ?? []);
const done = (s: FakeSurface, of: string, after: number) =>
  s.waitFor((m) => m.op === "structure.done" && m.of === of && s.frames.indexOf(m) >= after);
const info = (bundle: string) => JSON.parse(readFileSync(join(bundle, "info.json"), "utf8"));
/**
 * The chat's line for an act, once it is there: a bundle is named by its
 * title, never its folder. What follows it (the links the act broke) is not
 * the act's name for the bundle.
 */
const said = async (s: FakeSurface, text: string) => {
  await waitUntil(`the chat line "${text}"`, () =>
    s.state.chat.some((m) => m.text.startsWith(text)),
  );
};

describe("one act each, one undo entry each", () => {
  test("New: an empty bundle where asked, undone to the Trash while it is as made", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "bundle.create", dir: join(set, "part"), extension: TEST_BUNDLE.extension });
    const made = (await done(s, "bundle.create", at)) as Extract<
      ServerOp,
      { op: "structure.done" }
    >;
    const abs = join(set, "part", "Untitled.boardbundle");
    expect(made.path).toBe(abs);
    await waitUntil("row", () =>
      rowsOf(s).some((n) => n.kind === "bundle" && n.rel === "part/Untitled.boardbundle"),
    );
    expect(s.state.history).toMatchObject({
      canUndo: true,
      undoLabel: "created Untitled",
      undoDeletes: { path: abs, dir: true },
    });
    await said(s, "You created the board Untitled in set/part.");
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("gone", () => !existsSync(abs));
    expect(trashed).toEqual([abs]);
    // The daemon's snapshot after the undo, not the last one seen: the file is
    // gone before the state that says so has crossed the socket.
    await waitUntil("the undo's snapshot", () => s.state.history.canUndo === false);
  });

  test("New: once written into, its undo leaves it", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "bundle.create", dir: set, extension: TEST_BUNDLE.extension });
    await done(s, "bundle.create", at);
    const abs = join(set, "Untitled.boardbundle");
    writeFileSync(join(abs, "board.board"), '{"nodes":[{"id":"x"}],"edges":[]}\n');
    const errAt = s.frames.length;
    s.send({ op: "history.undo", confirmDelete: true });
    const err = await s.waitFor((m) => m.op === "error" && s.frames.indexOf(m) >= errAt);
    expect(err.op === "error" && err.message).toContain("written into");
    expect(existsSync(abs)).toBe(true);
    expect(trashed).toEqual([]);
  });

  test("Rename: the folder and its title, one undo for both, and a redo", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "rename", path: well, name: "The dry well" });
    await done(s, "rename", at);
    const to = join(set, "The dry well.boardbundle");
    expect(info(to).title).toBe("The dry well");
    expect(s.state.history.undoLabel).toBe("renamed The well at the Glade to The dry well");
    await said(s, "You renamed the board The well at the Glade to The dry well.");
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(well));
    expect(existsSync(to)).toBe(false);
    expect(info(well).title).toBe("The well at the Glade");
    await waitUntil("redo offered", () => s.state.history.canRedo);
    expect(s.state.history.redoLabel).toBe("renamed The dry well back to The well at the Glade");
    await said(s, "You undid: renamed The well at the Glade to The dry well.");
    s.send({ op: "history.redo" });
    await waitUntil("again", () => existsSync(to));
    expect(info(to).title).toBe("The dry well");
  });

  test("Rename: a bundle with a title-less info.json gets no title back on undo", async () => {
    const plain = writeBundle(set, "plain", { version: 1, type: "board", colour: "red" });
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "rename", path: plain, name: "Fancy" });
    await done(s, "rename", at);
    expect(info(join(set, "Fancy.boardbundle")).title).toBe("Fancy");
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(plain));
    expect(info(plain)).toEqual({ version: 1, type: "board", colour: "red" });
  });

  test("Rename: with no info.json, none is made, and the undo leaves none", async () => {
    const plain = writeBundle(set, "bare", null);
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "rename", path: plain, name: "Named" });
    await done(s, "rename", at);
    expect(existsSync(join(set, "Named.boardbundle", "info.json"))).toBe(false);
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(plain));
    expect(existsSync(join(plain, "info.json"))).toBe(false);
  });

  test("Rename: an info.json that does not parse is the same bytes after the rename and its undo", async () => {
    const broken = '{"title": "Half", oops\n';
    writeFileSync(join(well, "info.json"), broken);
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "rename", path: well, name: "Dry" });
    await done(s, "rename", at);
    expect(readFileSync(join(set, "Dry.boardbundle", "info.json"), "utf8")).toBe(broken);
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(well));
    expect(readFileSync(join(well, "info.json"), "utf8")).toBe(broken);
  });

  test("Rename: the links that point at the bundle are offered for updating, as for a document", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "rename", path: well, name: "Dry" });
    await done(s, "rename", at);
    await waitUntil("offer", () => s.state.relink);
    expect(s.state.relink?.docs).toEqual([
      expect.objectContaining({
        path: join(set, "a.md"),
        fixes: [
          expect.objectContaining({ from: "./The%20well.boardbundle", to: "./Dry.boardbundle" }),
        ],
      }),
    ]);
    s.send({ op: "relink" });
    await waitUntil("rewritten", () =>
      readFileSync(join(set, "a.md"), "utf8").includes("(./Dry.boardbundle)"),
    );
  });

  test("Move to: the whole folder, and one undo puts it back", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "move", path: well, into: join(set, "part") });
    await done(s, "move", at);
    const to = join(set, "part", "The well.boardbundle");
    expect(existsSync(join(to, "assets", "fox.png"))).toBe(true);
    expect(s.state.history.undoLabel).toBe("moved The well at the Glade into part");
    await said(s, "You moved the board The well at the Glade to set/part.");
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(join(well, "assets", "fox.png")));
  });

  test("Duplicate: a whole copy beside it, undone to the Trash", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "duplicate", path: well });
    await done(s, "duplicate", at);
    const copy = join(set, "The well copy.boardbundle");
    expect(existsSync(join(copy, "assets", "fox.png"))).toBe(true);
    expect(s.state.history).toMatchObject({
      undoLabel: "duplicated The well at the Glade as The well at the Glade copy",
      undoDeletes: { path: copy, dir: true },
    });
    await said(s, "You duplicated the board The well at the Glade as The well at the Glade copy.");
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("gone", () => !existsSync(copy));
    expect(trashed).toEqual([copy]);
    expect(existsSync(well)).toBe(true);
  });

  test("Trash: the whole folder goes as one item, named as its row is", async () => {
    const { s, t } = await start();
    s.send({ op: "open", path: well });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "trash", path: well });
    await s.waitFor((m) => m.op === "trash.done");
    expect(trashed).toEqual([well]);
    expect(existsSync(join(bin, "The well.boardbundle", "assets", "fox.png"))).toBe(true);
    const ev = await t.waitFor((e) => e.type === "system" && e.fact === "trash");
    expect(String(ev.text)).toBe(
      "You moved the board The well at the Glade (in set) to the Trash. The versions of The well at the Glade are kept in the session.",
    );
    await waitUntil("closed", () => s.state.openDoc === null);
  });
});

describe("the watcher", () => {
  test("a change to a file inside a bundle is reported as a change to the bundle", async () => {
    const { s, t } = await start();
    // Let the watcher settle on the tree as it is.
    await Bun.sleep(150);
    writeFileSync(join(well, "assets", "fox.png"), "changed bytes");
    const op = await s.waitFor((m) => m.op === "bundle.changed");
    expect(op).toEqual({
      op: "bundle.changed",
      path: well,
      file: join(well, "assets", "fox.png"),
    });
    const ev = await t.waitFor((e) => e.type === "system" && e.fact === "bundle.changed");
    expect(ev).toMatchObject({ path: well, file: join(well, "assets", "fox.png") });
  });

  test("a new title in info.json reaches the row", async () => {
    const { s } = await start();
    await Bun.sleep(150);
    writeFileSync(join(well, "info.json"), '{"version":1,"type":"board","title":"Retitled"}\n');
    await waitUntil("title", () =>
      rowsOf(s).some((n) => n.kind === "bundle" && n.title === "Retitled"),
    );
  });
});

describe("a bundle's own images", () => {
  const file = (path: string) => fetch(`${daemon?.url}/fs/file?path=${encodeURIComponent(path)}`);

  test("the file route serves an image inside a bundle the tree shows, though its row hides it", async () => {
    writeFileSync(join(well, "assets", "lens.png"), pngBytes(6, 6));
    await start();
    const res = await file(join(well, "assets", "lens.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    // Still sniffed: the fixture's fox.png is text under an image's name.
    expect((await file(join(well, "assets", "fox.png"))).status).toBe(400);
    // The main file is a document, never an image, whatever it is called.
    expect((await file(join(well, TEST_BUNDLE.main))).status).toBe(400);
  });

  test("an image in a bundle outside the context, or in a folder beside one, is not served", async () => {
    const other = join(root, "elsewhere");
    mkdirSync(other, { recursive: true });
    const away = writeBundle(other, "Away", null);
    writeFileSync(join(away, "assets", "lens.png"), pngBytes(6, 6));
    // A folder named like a bundle's assets, in the set but in no bundle.
    mkdirSync(join(set, "assets"), { recursive: true });
    writeFileSync(join(set, "assets", "loose.png"), pngBytes(6, 6));
    await start();
    expect((await file(join(away, "assets", "lens.png"))).status).toBe(404);
    // The tree shows a loose image, so this one is served as any image is...
    expect((await file(join(set, "assets", "loose.png"))).status).toBe(200);
    // ...but a path that only names a bundle's folder is not a bundle's image.
    expect((await file(join(set, "No such.boardbundle", "assets", "x.png"))).status).toBe(404);
  });
});

describe("cardSummaries", () => {
  test("a document as a card shows it: its description and how many links it writes", async () => {
    writeFileSync(
      join(set, "b.md"),
      "---\ntitle: The bay\ndescription: Where the boats come in.\nstatus: draft\n---\n\nSee [a](a.md), [the well](./The%20well.boardbundle) and [the web](https://example.org).\n",
    );
    await start();
    const got = daemon?.session.cardSummaries([join(set, "b.md"), join(set, "a.md")]);
    expect(got).toEqual([
      expect.objectContaining({
        path: join(set, "b.md"),
        title: "The bay",
        description: "Where the boats come in.",
        status: "draft",
        links: 2,
      }),
      expect.objectContaining({ path: join(set, "a.md"), title: "A", links: 1 }),
    ]);
    // A plain summary carries neither.
    expect(daemon?.session.summaries([join(set, "b.md")])[0]).not.toHaveProperty("links");
  });
});

describe("linksAmong", () => {
  test("the links among some documents, each once, with the heading they name", async () => {
    writeFileSync(
      join(set, "b.md"),
      "# B\n\nSee [a](a.md), [a again](./a.md), [[c#The Quay|the quay]], [c](c.md#the-quay), [d](d.md), [me](b.md) and [the web](https://example.org).\n",
    );
    writeFileSync(join(set, "c.md"), "# C\n\n## The Quay\n\nBack to [b](b.md).\n");
    writeFileSync(join(set, "d.md"), "# D\n");
    await start();
    const got = daemon?.session.linksAmong([
      join(set, "a.md"),
      join(set, "b.md"),
      join(set, "c.md"),
      "relative.md",
    ]);
    expect(got).toEqual([
      { from: join(set, "b.md"), to: join(set, "a.md") },
      { from: join(set, "b.md"), to: join(set, "c.md"), anchor: "The Quay" },
      { from: join(set, "b.md"), to: join(set, "c.md"), anchor: "the-quay" },
      { from: join(set, "c.md"), to: join(set, "b.md") },
    ]);
  });
});

describe("images into a bundle's assets", () => {
  const post = (q: string, bytes: Uint8Array<ArrayBuffer>) =>
    fetch(`${daemon?.url}/fs/image?${q}`, { method: "POST", body: bytes });

  test("an image dropped on a bundle's view lands in its assets/, under a free name, never asked", async () => {
    await start();
    const q = (name: string) =>
      new URLSearchParams({ bundle: well, name, how: "drop", onTaken: "ask" }).toString();
    const one = (await (await post(q("lens.png"), pngBytes(8, 8))).json()) as {
      ok: boolean;
      path: string;
      card: string;
    };
    expect(one.ok).toBe(true);
    expect(one.path.startsWith(join(well, "assets"))).toBe(true);
    expect(one.card).toBe(`./assets/${basename(one.path)}`);
    expect(existsSync(one.path)).toBe(true);
    // The same name again: a second file beside it, not a question.
    const two = (await (await post(q("lens.png"), pngBytes(8, 8))).json()) as {
      ok: boolean;
      path: string;
    };
    expect(two.ok).toBe(true);
    expect(two.path).not.toBe(one.path);
    // Not an image inside: refused, nothing written.
    const bad = await post(q("fake.png"), new TextEncoder().encode("<html></html>"));
    expect(bad.status).toBe(400);
  });

  test("a pasted image is named by its bytes, whatever the clipboard's type said; a drop keeps its name", async () => {
    await start();
    const jpeg = await jpegBytes(8, 8);
    const q = (name: string, how: string) =>
      new URLSearchParams({ bundle: well, name, how }).toString();
    const pasted = (await (
      await post(q("pasted-2026-10-09-101500.png", "paste"), jpeg)
    ).json()) as {
      ok: boolean;
      path: string;
      card: string;
    };
    expect(pasted.ok).toBe(true);
    expect(pasted.card).toBe("./assets/pasted-2026-10-09-101500.jpg");
    expect(existsSync(join(well, "assets", "pasted-2026-10-09-101500.png"))).toBe(false);
    // A drop keeps the name the user's file has.
    const dropped = (await (await post(q("photo.jpeg", "drop"), jpeg)).json()) as { card: string };
    expect(dropped.card).toBe("./assets/photo.jpeg");
  });

  test("only a bundle a set shows is written into", async () => {
    const other = join(root, "elsewhere");
    mkdirSync(other, { recursive: true });
    const away = writeBundle(other, "Away", null);
    await start();
    const ask = (bundle: string) =>
      post(new URLSearchParams({ bundle, name: "x.png" }).toString(), pngBytes(8, 8));
    expect((await ask(away)).status).toBe(404);
    // A folder that is not a bundle, and a path inside one.
    expect((await ask(join(set, "part"))).status).toBe(400);
    expect((await ask(join(well, "assets"))).status).toBe(400);
    expect(existsSync(join(away, "assets", "x.png"))).toBe(false);
  });

  test("an image the tree shows is copied into a bundle with its description", async () => {
    mkdirSync(join(set, "images"), { recursive: true });
    writeFileSync(join(set, "images", "gull.png"), pngBytes(6, 6));
    writeFileSync(
      join(set, "images", "gull.png.md"),
      "---\ntype: image\n---\n\nA gull on a bollard.\n",
    );
    await start();
    const r = daemon?.session.copyImageIntoBundle(join(set, "images", "gull.png"), well);
    expect(r?.card).toBe("./assets/gull.png");
    expect(readFileSync(join(well, "assets", "gull.png"))).toEqual(
      readFileSync(join(set, "images", "gull.png")),
    );
    expect(r?.sidecar).toBe(join(well, "assets", "gull.png.md"));
    expect(readFileSync(join(well, "assets", "gull.png.md"), "utf8")).toContain(
      "A gull on a bollard.",
    );
    // The original and its description stay where they were.
    expect(existsSync(join(set, "images", "gull.png.md"))).toBe(true);
    // A second copy takes a free name; an image outside the tree is never read.
    expect(daemon?.session.copyImageIntoBundle(join(set, "images", "gull.png"), well).card).toBe(
      "./assets/gull 2.png",
    );
    expect(() => daemon?.session.copyImageIntoBundle(join(root, "nowhere.png"), well)).toThrow();
  });
});

describe("a description left behind is never borrowed", () => {
  const orphan = "---\ntype: image\n---\n\nA description whose image went.\n";

  test("an image copied or dropped in takes a name whose sidecar is free too", async () => {
    mkdirSync(join(set, "images"), { recursive: true });
    writeFileSync(join(set, "images", "pic.png"), pngBytes(6, 6));
    mkdirSync(join(well, "assets"), { recursive: true });
    writeFileSync(join(well, "assets", "pic.png"), pngBytes(6, 6));
    // `pic 2.png` went, and left its description.
    writeFileSync(join(well, "assets", "pic 2.png.md"), orphan);
    await start();
    const copied = daemon?.session.copyImageIntoBundle(join(set, "images", "pic.png"), well);
    expect(copied?.card).toBe("./assets/pic 3.png");
    const dropped = (await (
      await fetch(
        `${daemon?.url}/fs/image?${new URLSearchParams({ bundle: well, name: "pic.png" })}`,
        { method: "POST", body: pngBytes(6, 6) },
      )
    ).json()) as { card: string };
    expect(dropped.card).toBe("./assets/pic 4.png");
    // The orphan stays an orphan: nothing was given its name.
    expect(existsSync(join(well, "assets", "pic 2.png"))).toBe(false);
  });

  test("a paste onto a board takes a free name that counts a description left behind", async () => {
    mkdirSync(join(well, "assets"), { recursive: true });
    // An earlier paste went, and left its description.
    writeFileSync(join(well, "assets", "pasted-2026-10-09-101500.png.md"), orphan);
    await start();
    const r = (await (
      await fetch(
        `${daemon?.url}/fs/image?${new URLSearchParams({ bundle: well, name: "pasted-2026-10-09-101500.png", how: "paste" })}`,
        { method: "POST", body: pngBytes(6, 6) },
      )
    ).json()) as { ok: boolean; card: string };
    expect(r.ok).toBe(true);
    expect(r.card).toBe("./assets/pasted-2026-10-09-101500 2.png");
    expect(existsSync(join(well, "assets", "pasted-2026-10-09-101500.png"))).toBe(false);
  });

  test("a desktop drop into a set does not take up a description whose image went", async () => {
    writeFileSync(join(set, "x.png.md"), orphan);
    await start();
    const r = (await (
      await fetch(
        `${daemon?.url}/fs/image?${new URLSearchParams({ dir: set, name: "x.png", onTaken: "ask" })}`,
        { method: "POST", body: pngBytes(6, 6) },
      )
    ).json()) as { ok: boolean; path: string };
    expect(r.ok).toBe(true);
    expect(basename(r.path)).toBe("x 2.png");
    expect(existsSync(join(set, "x.png"))).toBe(false);
  });
});

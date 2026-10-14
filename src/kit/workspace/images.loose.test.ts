// Loose images (the kit-image-loose item): an image dropped on the context list
// rather than a set is copied into the workspace folder and listed as its own
// entry, as a dropped document is; a single image can be added by path; the
// file route serves a listed image with the same checks as one in a set, and
// never its siblings; and Trash, rename and removing the entry work for it as
// for a loose document. The workspace here is NOT any set's folder: the case
// the user hit.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { ContextEntry } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let ws: string;
let world: string;
let outside: string;
let bin: string;
let trashed: string[];
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

/** A real PNG with text after its end: what a text tool would find if it read the bytes. */
const MARKED = (() => {
  const png = pngBytes(8, 8);
  const tail = new TextEncoder().encode("\nZEBRAQUILL [the target](target.md)\n");
  const out = new Uint8Array(png.length + tail.length);
  out.set(png);
  out.set(tail, png.length);
  return out;
})();

beforeEach(() => {
  root = tempRoot("workspace-images-loose");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The workspace is a folder of its own, beside the set, not inside it.
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  world = join(root, "world");
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "target.md"), "# Target\n");
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET: not an image\n");
  writeFileSync(join(outside, "secret.png"), pngBytes(4, 4));
  bin = join(root, "fake-trash");
  mkdirSync(bin, { recursive: true });
  trashed = [];
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: ws,
    platform: "darwin",
    trash: async (p: string) => {
      trashed.push(p);
      renameSync(p, join(bin, `${trashed.length}-${basename(p)}`));
    },
  });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { base: daemon.url, s: surface, d: daemon };
}

const drop = (base: string, name: string, body: Uint8Array<ArrayBuffer>, q = {}) =>
  fetch(`${base}/fs/image?${new URLSearchParams({ name, ...q })}`, { method: "POST", body });

const file = (base: string, path: string) =>
  fetch(`${base}/fs/file?path=${encodeURIComponent(path)}`);

const thumb = (base: string, path: string) =>
  fetch(`${base}/fs/thumb?w=256&path=${encodeURIComponent(path)}`);

/** The listed entry holding exactly `path`, from the newest state. */
const listedAt = (s: FakeSurface, path: string): ContextEntry | undefined =>
  s.state.context.find(
    (e) =>
      e.membership === "listed" &&
      e.nodes.length === 1 &&
      join(e.root, e.nodes[0]?.rel ?? "") === path,
  );

describe("an image dropped on the context list", () => {
  test("is copied into the workspace folder, listed as its own entry, and opens in the viewer", async () => {
    const { base, s } = await start();
    const bytes = pngBytes(16, 16);
    const res = await drop(base, "map.png", bytes);
    expect(res.status).toBe(200);
    const path = join(ws, "map.png");
    expect(await res.json()).toEqual({ ok: true, path });
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    expect(listedAt(s, path)).toMatchObject({
      root: ws,
      label: "map.png",
      membership: "listed",
      nodes: [{ kind: "image", rel: "map.png" }],
    });
    // Nothing went into the set.
    expect(readdirSync(world)).toEqual(["target.md"]);
    s.send({ op: "open", path });
    await waitUntil("the viewer", () => s.state.openImage?.path === path);
    expect(s.state.openImage).toMatchObject({ name: "map.png", type: "image/png" });
    const served = await file(base, path);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    expect(s.state.history.canUndo).toBe(true);
  });

  test("a taken name is asked about: keep both lists the copy beside it, replace trashes the old", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", MARKED);
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    const ask = await drop(base, "map.png", pngBytes(4, 4));
    expect(ask.status).toBe(409);
    expect(await ask.json()).toMatchObject({ ok: false, choices: ["replace", "keep-both"] });
    const both = await drop(base, "map.png", pngBytes(4, 4), { onTaken: "keep-both" });
    expect(await both.json()).toEqual({ ok: true, path: join(ws, "map 2.png") });
    await waitUntil("both listed", () => listedAt(s, join(ws, "map 2.png")) !== undefined);
    const next = pngBytes(32, 32, [200, 0, 0], [0, 0, 200]);
    const rep = await drop(base, "map.png", next, { onTaken: "replace" });
    expect(await rep.json()).toEqual({ ok: true, path, replaced: true });
    expect(trashed).toEqual([path]);
    expect(new Uint8Array(readFileSync(join(bin, "1-map.png")))).toEqual(MARKED);
    expect(new Uint8Array(readFileSync(path))).toEqual(next);
    // Still its own entry, once.
    expect(s.state.context.filter((e) => e.label === "map.png")).toHaveLength(1);
    expect(readdirSync(ws).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("replacing one removed from the list puts the new one in its place and lists it again", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    writeFileSync(path, MARKED);
    const ask = await drop(base, "map.png", pngBytes(4, 4));
    expect(ask.status).toBe(409);
    const rep = await drop(base, "map.png", pngBytes(6, 6), { onTaken: "replace" });
    expect(rep.status).toBe(200);
    expect(trashed).toEqual([path]);
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    // A link under that name is no plain image to replace, wherever it leads.
    const link = join(ws, "link.png");
    symlinkSync(join(outside, "secret.png"), link);
    const refused = await drop(base, "link.png", pngBytes(4, 4), { onTaken: "replace" });
    expect(refused.status).toBe(404);
    expect(trashed).toEqual([path]);
    expect(new Uint8Array(readFileSync(join(outside, "secret.png")))).toEqual(pngBytes(4, 4));
    // Nor is a file that is no image inside, whatever its name says.
    writeFileSync(join(ws, "page.png"), "<html></html>");
    const page = await drop(base, "page.png", pngBytes(4, 4), { onTaken: "replace" });
    expect(page.status).toBe(404);
    expect(readFileSync(join(ws, "page.png"), "utf8")).toBe("<html></html>");
    expect(trashed).toEqual([path]);
  });
});

describe("a single image added by path", () => {
  test("through the agent's add, is its own entry, served and opened", async () => {
    const { base, s } = await start();
    const pic = join(outside, "secret.png");
    const r = await cmd(base, { op: "context.add", paths: [pic] });
    expect(r.status).toBe(200);
    await waitUntil("listed", () => listedAt(s, pic) !== undefined);
    expect(listedAt(s, pic)?.nodes).toEqual([{ kind: "image", rel: "secret.png" }]);
    expect((await file(base, pic)).status).toBe(200);
    expect((await thumb(base, pic)).status).toBe(200);
    s.send({ op: "open", path: pic });
    await waitUntil("the viewer", () => s.state.openImage?.path === pic);
  });

  test("through the surface's Add box, the same way", async () => {
    const { s } = await start();
    const pic = join(outside, "secret.png");
    s.send({ op: "context.add", path: pic });
    await waitUntil("listed", () => listedAt(s, pic) !== undefined);
  });
});

describe("the file route, for a listed image", () => {
  test("⛔ refuses a sibling beside it, on every route, and opens nothing", async () => {
    const { base, s } = await start();
    const pic = join(outside, "secret.png");
    await cmd(base, { op: "context.add", paths: [pic] });
    await waitUntil("listed", () => listedAt(s, pic) !== undefined);
    const sibling = join(outside, "sibling.png");
    writeFileSync(sibling, pngBytes(5, 5));
    expect((await file(base, sibling)).status).toBe(404);
    expect((await thumb(base, sibling)).status).toBe(404);
    // The folder itself, and a text file in it, are no more served.
    expect((await file(base, join(outside, "secret.txt"))).status).toBe(400);
    expect((await file(base, outside)).status).toBe(400);
    s.send({ op: "open", path: sibling });
    const err = await s.waitFor((f) => f.op === "error");
    expect(err.op === "error" && err.message).toContain("not an image shown in this session");
    expect(s.state.openImage ?? null).toBeNull();
  });

  test("⛔ refuses a listed image that is a link, whether it leads out or to a sibling", async () => {
    const { base, s } = await start();
    const out = join(ws, "escape.png");
    symlinkSync(join(outside, "secret.png"), out);
    const near = join(ws, "near.png");
    writeFileSync(join(ws, "real.png"), pngBytes(3, 3));
    symlinkSync(join(ws, "real.png"), near);
    await cmd(base, { op: "context.add", paths: [out, near] });
    await waitUntil("listed", () => listedAt(s, near) !== undefined);
    expect(listedAt(s, out)).toBeDefined();
    for (const p of [out, near]) {
      expect((await file(base, p)).status).toBe(404);
      expect((await thumb(base, p)).status).toBe(404);
    }
    s.send({ op: "open", path: out });
    const err = await s.waitFor((f) => f.op === "error");
    expect(err.op === "error" && err.message).toBe("escape.png is a link: not opened");
    expect(s.state.openImage ?? null).toBeNull();
    const said = (await (await file(base, out)).json()) as { error: string };
    expect(said.error).toBe("escape.png is a link: not served");
  });

  test("⛔ in a linked folder retargeted after it was added, is not followed to the new place", async () => {
    const { base, s } = await start();
    // A folder reached through a link: the listed image is added through it.
    const real = join(root, "real-pics");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "pic.png"), pngBytes(6, 6));
    const via = join(root, "via");
    symlinkSync(real, via);
    const pic = join(via, "pic.png");
    await cmd(base, { op: "context.add", paths: [pic] });
    await waitUntil("listed", () => listedAt(s, pic) !== undefined);
    expect((await file(base, pic)).status).toBe(200);
    // The link now points at another folder holding a file under the same name.
    const other = join(root, "other-pics");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "pic.png"), pngBytes(7, 7));
    rmSync(via);
    symlinkSync(other, via);
    expect((await file(base, pic)).status).toBe(404);
    expect((await thumb(base, pic)).status).toBe(404);
    s.send({ op: "open", path: pic });
    const err = await s.waitFor((f) => f.op === "error");
    expect(err.op === "error" && err.message).toContain("leads elsewhere now");
  });

  test("⛔ a set whose linked root is retargeted after it was added serves nothing from the new place", async () => {
    const { base, s } = await start();
    const real = join(root, "real-set");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "pic.png"), pngBytes(6, 6));
    const via = join(root, "via-set");
    symlinkSync(real, via);
    await cmd(base, { op: "context.add", paths: [via] });
    await waitUntil("the set", () => s.state.context.some((e) => e.root === via));
    const pic = join(via, "pic.png");
    expect((await file(base, pic)).status).toBe(200);
    const other = join(root, "other-set");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "pic.png"), pngBytes(7, 7));
    rmSync(via);
    symlinkSync(other, via);
    expect((await file(base, pic)).status).toBe(404);
  });

  test("⛔ never serves a listed image swapped for a link while it is served", async () => {
    const { base, s } = await start();
    const race = join(ws, "race.png");
    const fox = join(root, "fox.png");
    writeFileSync(fox, pngBytes(8, 8));
    copyFileSync(fox, race);
    await cmd(base, { op: "context.add", paths: [race] });
    await waitUntil("listed", () => listedAt(s, race) !== undefined);
    const swapper = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const fs = require("node:fs");
         const [dir, fox, secret] = process.argv.slice(1);
         for (;;) { try {
           fs.copyFileSync(fox, dir + "/.r-file"); fs.renameSync(dir + "/.r-file", dir + "/race.png");
           try { fs.rmSync(dir + "/.r-link"); } catch {}
           fs.symlinkSync(secret, dir + "/.r-link"); fs.renameSync(dir + "/.r-link", dir + "/race.png");
         } catch {} }`,
        ws,
        fox,
        join(outside, "secret.txt"),
      ],
      { env: process.env, stdout: "ignore", stderr: "ignore" },
    );
    let leaks = 0;
    let served = 0;
    try {
      await Bun.sleep(100);
      // At least 400 requests, and on until one lands while the file is a file
      // (a loaded runner can see the link every time), up to a cap.
      for (let i = 0; i < 4000 && (i < 400 || served === 0); i++) {
        const r = await file(base, race);
        const body = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
        if (r.status === 200) served++;
        if (body.includes("TOP-SECRET") && r.status === 200) leaks++;
      }
    } finally {
      swapper.kill();
      await swapper.exited;
    }
    expect(leaks).toBe(0);
    expect(served).toBeGreaterThan(0);
  }, 30_000);
});

describe("a loose image's lifecycle", () => {
  test("rename follows it, keeps an image's extension, and keeps it open", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    s.send({ op: "open", path });
    await waitUntil("open", () => s.state.openImage?.path === path);
    s.send({ op: "rename", path, name: "chart.md" });
    const moved = join(ws, "chart.md.png");
    await waitUntil("followed", () => s.state.openImage?.path === moved);
    expect(listedAt(s, moved)).toMatchObject({
      label: "chart.md.png",
      nodes: [{ kind: "image", rel: "chart.md.png" }],
    });
    expect(listedAt(s, path)).toBeUndefined();
    expect((await file(base, moved)).status).toBe(200);
    expect((await file(base, path)).status).toBe(404);
  });

  test("Trash asks what goes, moves it to the Trash, drops its entry and closes it", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    s.send({ op: "open", path });
    await waitUntil("open", () => s.state.openImage?.path === path);
    s.send({ op: "trash.preview", path });
    const pre = await s.waitFor((f) => f.op === "trash.preview");
    expect(pre).toMatchObject({ path, dir: false, files: 1, folders: 0, docs: [] });
    s.send({ op: "trash", path });
    await s.waitFor((f) => f.op === "trash.done");
    expect(trashed).toEqual([path]);
    await waitUntil("gone", () => listedAt(s, path) === undefined);
    expect(s.state.openImage ?? null).toBeNull();
    expect(s.state.context).toHaveLength(1);
  });

  test("removing the entry stops showing and serving it, closes it, and deletes nothing", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    s.send({ op: "open", path });
    await waitUntil("open", () => s.state.openImage?.path === path);
    s.send({ op: "context.remove", id: listedAt(s, path)?.id ?? "" });
    await waitUntil("removed", () => listedAt(s, path) === undefined);
    expect(s.state.openImage ?? null).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect((await file(base, path)).status).toBe(404);
  });

  test("its thumbnail is cached, kept while it is listed, and pruned when the entry is removed", async () => {
    const { base, s, d } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    const thumbs = join(d.session.dir, "thumbs");
    expect((await thumb(base, path)).status).toBe(200);
    expect(readdirSync(thumbs)).toHaveLength(1);
    expect(d.session.imageStamps().size).toBe(1);
    s.send({ op: "context.remove", id: listedAt(s, path)?.id ?? "" });
    await waitUntil("pruned", () => readdirSync(thumbs).length === 0);
    expect(d.session.imageStamps().size).toBe(0);
  });

  test("an in-place edit of a loose image is seen by its folder's watch, and the old thumbnail goes", async () => {
    const { base, s, d } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    const thumbs = join(d.session.dir, "thumbs");
    expect((await thumb(base, path)).status).toBe(200);
    // The folder's watch was made by the drop, and a new watch may miss what
    // happens in its first moments: the edit is made again until it is seen,
    // each time with new bytes, as an editor saving twice would.
    let n = 9;
    const edit = () => writeFileSync(path, pngBytes(n++, 9));
    edit();
    let last = Date.now();
    await waitUntil(
      "pruned",
      () => {
        if (readdirSync(thumbs).length === 0) return true;
        if (Date.now() - last > 600) {
          edit();
          last = Date.now();
        }
        return false;
      },
      8000,
    );
  }, 15_000);

  test("undoing the drop removes the copy and its entry", async () => {
    const { base, s } = await start();
    const path = join(ws, "map.png");
    await drop(base, "map.png", pngBytes(8, 8));
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    expect(s.state.history.undoDeletes).toEqual({ path, dir: false });
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("undone", () => listedAt(s, path) === undefined);
    expect(existsSync(path)).toBe(false);
  });
});

describe("the text tools never read a loose image", () => {
  test("search, link check and the map pass over it; it is no document to the agent", async () => {
    const { base, s } = await start();
    const path = join(ws, "marked.png");
    await drop(base, "marked.png", MARKED);
    await waitUntil("listed", () => listedAt(s, path) !== undefined);
    s.send({ op: "open", path });
    await waitUntil("open", () => s.state.openImage !== null);
    const search = await cmd(base, { op: "search", query: "ZEBRAQUILL" });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain("marked.png");
    const check = await cmd(base, { op: "link.check" });
    expect(JSON.stringify(check.body)).not.toContain("marked.png");
    const graph = await cmd(base, { op: "graph" });
    expect(JSON.stringify(graph.body)).not.toContain("marked.png");
    expect((await cmd(base, { op: "version.new", doc: path })).status).toBe(400);
    expect(s.state.docs).toEqual([]);
  });
});

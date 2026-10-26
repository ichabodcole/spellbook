// The image routes' harder guards (the kit-image-files review): a file swapped
// for a link while it is served, a name rebound to loopback, a link out of the
// set seen through the snapshot, a linked folder as a drop's target, a chunked
// upload past the cap; and Close bringing the document back, thumbnails pruned,
// and a followed link to an image opening the viewer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import { pruneThumbs, stampOf } from "./images";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let outside: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-image-guards");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "images"), { recursive: true });
  writeFileSync(join(world, "story.md"), "# Story\n\nThe [fox](images/fox.png).\n");
  writeFileSync(join(world, "images", "fox.png"), pngBytes(8, 8));
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "TOP-SECRET: not an image\n");
  writeFileSync(join(outside, "secret.png"), pngBytes(4, 4));
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "ws") });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { base: daemon.url, s: surface, d: daemon };
}

const fileUrl = (base: string, path: string) => `${base}/fs/file?path=${encodeURIComponent(path)}`;

describe("a file swapped for a link while it is served", () => {
  test("⛔ is never served: the file is opened once and checked by its descriptor", async () => {
    const race = join(world, "images", "race.png");
    copyFileSync(join(world, "images", "fox.png"), race);
    const { base } = await start();
    expect(JSON.stringify(surface?.state.context)).toContain("images/race.png");
    // Another process swaps the image for a link to an outside text file and
    // back, as fast as it can, while this one asks for it. Every SWAP_MS it
    // stops for HOLD_MS with the plain image in place, so some requests are
    // served on any runner: with no pause, a slow one can take longer over the
    // guard than the image ever stays put, and refuse every request (the race
    // then never happened, and a route refusing everything would pass).
    const swapper = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const fs = require("node:fs");
         const [dir, fox, secret] = process.argv.slice(1);
         const SWAP_MS = 20, HOLD_MS = 20;
         const fileIn = () => { fs.copyFileSync(fox, dir + "/.r-file"); fs.renameSync(dir + "/.r-file", dir + "/race.png"); };
         for (;;) {
           const until = Date.now() + SWAP_MS;
           while (Date.now() < until) { try {
             fileIn();
             try { fs.rmSync(dir + "/.r-link"); } catch {}
             fs.symlinkSync(secret, dir + "/.r-link"); fs.renameSync(dir + "/.r-link", dir + "/race.png");
           } catch {} }
           try { fileIn(); } catch {}
           Bun.sleepSync(HOLD_MS);
         }`,
        join(world, "images"),
        join(world, "images", "fox.png"),
        join(outside, "secret.txt"),
      ],
      { env: process.env, stdout: "ignore", stderr: "ignore" },
    );
    let leaks = 0;
    let served = 0;
    let refused = 0;
    try {
      await Bun.sleep(100);
      // At least 400 requests, and on until some were served and some refused.
      const deadline = Date.now() + 20_000;
      for (let i = 0; i < 400 || ((served === 0 || refused === 0) && Date.now() < deadline); i++) {
        const r = await fetch(fileUrl(base, race));
        const body = new TextDecoder().decode(new Uint8Array(await r.arrayBuffer()));
        if (r.status === 200) served++;
        else refused++;
        if (body.includes("TOP-SECRET") && r.status === 200) leaks++;
      }
    } finally {
      swapper.kill();
      await swapper.exited;
    }
    expect(leaks).toBe(0);
    // The race was real: some answers were served, some refused.
    expect(served).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  }, 30_000);
});

describe("a name rebound to loopback (DNS rebinding)", () => {
  test("⛔ is refused on every route, even a same-origin GET with no Origin", async () => {
    const { base, d } = await start();
    const evil = { Host: `evil.example:${d.port}` };
    expect(
      (await fetch(fileUrl(base, join(world, "images", "fox.png")), { headers: evil })).status,
    ).toBe(403);
    expect((await fetch(`${base}/state`, { headers: evil })).status).toBe(403);
    // Both names the daemon is reached by still work.
    expect((await fetch(fileUrl(base, join(world, "images", "fox.png")))).status).toBe(200);
    const local = await fetch(`http://localhost:${d.port}/state`);
    expect(local.status).toBe(200);
  });
});

describe("a link in the set that leads out of it", () => {
  test("is not opened, and the snapshot never carries its size or stamp", async () => {
    const linkOut = join(world, "images", "escape.png");
    symlinkSync(join(outside, "secret.png"), linkOut);
    const { s } = await start();
    expect(JSON.stringify(s.state.context)).toContain("escape.png");
    s.send({ op: "open", path: linkOut });
    const err = await s.waitFor((f) => f.op === "error");
    expect(err.op === "error" && err.message).toContain("leads outside");
    expect(s.state.openImage ?? null).toBeNull();
    // An open image swapped for a link out shows as nothing, not as the other file.
    const fox = join(world, "images", "fox.png");
    s.send({ op: "open", path: fox });
    await waitUntil("open", () => s.state.openImage?.path === fox);
    rmSync(fox);
    symlinkSync(join(outside, "secret.png"), fox);
    const st = (await (await fetch(`${daemon?.url}/state`)).json()) as {
      openImage: unknown;
    };
    expect(st.openImage).toBeNull();
  });

  test("a linked folder in the set that leads out is no place to drop an image", async () => {
    symlinkSync(outside, join(world, "linked"));
    const { base, s } = await start();
    expect(JSON.stringify(s.state.context)).toContain('"linked"');
    const res = await fetch(
      `${base}/fs/image?${new URLSearchParams({ name: "x.png", dir: join(world, "linked") })}`,
      { method: "POST", body: pngBytes(2, 2) },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("leads outside");
    expect(existsSync(join(outside, "x.png"))).toBe(false);
  });
});

describe("a chunked upload with no length", () => {
  test("stops at the cap, and writes nothing", async () => {
    const { base } = await start();
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(pngBytes(2, 2));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= 25) c.close();
        else c.enqueue(chunk);
      },
    });
    const res = await fetch(
      `${base}/fs/image?${new URLSearchParams({ name: "huge.png", dir: join(world, "images") })}`,
      { method: "POST", body, duplex: "half" } as RequestInit,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("larger than 20 MB");
    expect(existsSync(join(world, "images", "huge.png"))).toBe(false);
  });
});

describe("Close", () => {
  test("brings back the document the image was opened over, edits and all", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document", () => s.state.openDoc === "story");
    s.send({ op: "edit", doc: "story", version: 1, text: "# Story\n\nUnsaved words.\n" });
    s.send({ op: "open", path: join(world, "images", "fox.png") });
    await waitUntil("the image", () => s.state.openImage !== null);
    expect(s.state.openDoc).toBeNull();
    s.send({ op: "image.close" });
    await waitUntil("the document again", () => s.state.openDoc === "story");
    expect(s.state.openImage).toBeNull();
    expect(daemon?.session.readVersion("story", 1).text).toBe("# Story\n\nUnsaved words.\n");
  });

  test("with no document under it, or one closed meanwhile, leaves nothing open", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "images", "fox.png") });
    await waitUntil("the image", () => s.state.openImage !== null);
    s.send({ op: "image.close" });
    await waitUntil("closed", () => s.state.openImage === null);
    expect(s.state.openDoc).toBeNull();
  });
});

describe("cached thumbnails", () => {
  test("those of a changed or deleted image are pruned once the context settles", async () => {
    const { base, d } = await start();
    const fox = join(world, "images", "fox.png");
    const thumbs = join(d.session.dir, "thumbs");
    const r = await fetch(`${base}/fs/thumb?w=256&path=${encodeURIComponent(fox)}`);
    expect(r.status).toBe(200);
    expect(readdirSync(thumbs)).toHaveLength(1);
    // The world's watch was armed a moment ago, by context.add.
    await writeUntilSeen(
      "pruned",
      () => writeFileSync(fox, pngBytes(9, 9)),
      () => readdirSync(thumbs).length === 0,
      // Past the context's settle, so a repeat never holds the prune off.
      { everyMs: 1500 },
    );
  });

  test("pruneThumbs keeps current stamps, drops the rest and stale temporary ones", () => {
    const dir = join(root, "sess");
    mkdirSync(join(dir, "thumbs"), { recursive: true });
    const keep = stampOf({ ino: 1, size: 2, mtimeMs: 3 });
    const old = stampOf({ ino: 4, size: 5, mtimeMs: 6 });
    for (const n of [`${keep}-256.webp`, `${keep}-1024.webp`, `${old}-256.webp`, "notes.txt"])
      writeFileSync(join(dir, "thumbs", n), "x");
    const fresh = `${keep}-256.webp.0a1b2c3d.tmp`;
    const stale = `${old}-256.webp.deadbeef.tmp`;
    writeFileSync(join(dir, "thumbs", fresh), "x");
    writeFileSync(join(dir, "thumbs", stale), "x");
    const long = new Date(Date.now() - 120_000);
    utimesSync(join(dir, "thumbs", stale), long, long);
    expect(pruneThumbs(dir, new Set([keep]))).toBe(2);
    expect(readdirSync(join(dir, "thumbs")).sort()).toEqual(
      [`${keep}-1024.webp`, `${keep}-256.webp`, fresh, "notes.txt"].sort(),
    );
  });
});

describe("a followed link to an image", () => {
  test("opens the viewer when the tree shows it", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document", () => s.state.openDoc === "story");
    s.send({ op: "link.open", target: "images/fox.png", doc: "story" });
    const said = await s.waitFor((f) => f.op === "link.target");
    expect(said).toMatchObject({ state: "in-context", path: join(world, "images", "fox.png") });
    await waitUntil("the viewer", () => s.state.openImage?.name === "fox.png");
  });

  test("one no set shows answers not-a-doc, and opens nothing", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document", () => s.state.openDoc === "story");
    s.send({ op: "link.open", target: "../outside/secret.png", doc: "story" });
    const said = await s.waitFor((f) => f.op === "link.target");
    expect(said).toMatchObject({ state: "not-a-doc", path: join(outside, "secret.png") });
    expect(s.state.openImage ?? null).toBeNull();
  });

  test("one the tree shows that is a link leading out says why it did not open", async () => {
    symlinkSync(join(outside, "secret.png"), join(world, "images", "escape.png"));
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document", () => s.state.openDoc === "story");
    s.send({ op: "link.open", target: "images/escape.png", doc: "story" });
    const said = await s.waitFor((f) => f.op === "link.target");
    // The reason openImage refused, not "no set shows it": the tree does show it.
    expect(said).toMatchObject({ state: "in-context", path: join(world, "images", "escape.png") });
    expect(said.op === "link.target" && said.refused).toContain("leads outside");
    expect(s.frames.some((f) => f.op === "error")).toBe(false);
    expect(s.state.openImage ?? null).toBeNull();
  });
});

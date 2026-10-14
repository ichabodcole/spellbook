// The image import settings through the daemon (kit-image-import-settings): an
// app preference in the app's `prefs.json`, the same for every session and
// world, set by the surface (`prefs.set`) or the agent (`image.settings`), and
// applied on the one path every drop and paste goes through. A converted image
// takes its new extension and keeps its stem; the embed points at it; its
// description records the name it came in with; what is left as it came says so.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_PREF_KEYS } from "../lib/imageImport.ts";
import { GIF_2_FRAMES, jpegBytes, jpegWithMetadata, pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("workspace-images-import");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  mkdirSync(join(root, "ws"), { recursive: true });
  world = join(root, "world");
  mkdirSync(join(world, "images"), { recursive: true });
  writeFileSync(join(world, "story.md"), "# Story\n");
  daemon = null;
  surface = null;
  tail = null;
});
afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: join(root, "ws"),
    imageArrivalMs: 60,
  });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { base: daemon.url, s: surface, t: tail };
}

/** The app's prefs file: beside the sessions folder, shared by every session. */
const prefsFile = () => join(root, "home", "prefs.json");

const post = (base: string, q: Record<string, string>, body: Uint8Array<ArrayBuffer>) =>
  fetch(`${base}/fs/image?${new URLSearchParams(q)}`, { method: "POST", body }).then(
    async (res) => ({
      status: res.status,
      body: (await res.json()) as {
        ok: boolean;
        path?: string;
        href?: string;
        converted?: boolean;
        kept?: boolean;
        note?: string;
        error?: string;
      },
    }),
  );

const meta = (path: string) => new Bun.Image(readFileSync(path)).metadata();

describe("the settings", () => {
  test("the agent reads the defaults, sets some, and the change is said in the chat", async () => {
    const { base, s } = await start();
    const read = await cmd(base, { op: "image.settings" });
    expect(read.body).toMatchObject({
      ok: true,
      settings: { format: "keep", quality: 80, maxSide: null },
      summary: "kept as they come in",
      changed: false,
    });
    expect(existsSync(prefsFile())).toBe(false);
    const set = await cmd(base, { op: "image.settings", format: "webp", maxSide: "2048" });
    expect(set.body).toMatchObject({
      settings: { format: "webp", quality: 80, maxSide: 2048 },
      changed: true,
    });
    expect(JSON.parse(readFileSync(prefsFile(), "utf8"))).toEqual({
      [IMAGE_PREF_KEYS.format]: "webp",
      [IMAGE_PREF_KEYS.maxSide]: "2048",
    });
    await waitUntil("said", () =>
      s.state.chat.some(
        (m) =>
          m.text ===
          "Agent changed the image import settings: convert to WebP, longest side 2048 px. Images brought in are now WebP at quality 80, longest side 2048 px.",
      ),
    );
    // The surface sees them in its prefs, as every pref.
    await waitUntil("in prefs", () => s.state.prefs[IMAGE_PREF_KEYS.format] === "webp");
    // `none` takes the cap off again.
    const off = await cmd(base, { op: "image.settings", maxSide: "none" });
    expect(off.body).toMatchObject({ settings: { maxSide: null } });
  });

  test("a change the summary does not show is still named in the chat", async () => {
    const { base, s } = await start();
    await cmd(base, { op: "image.settings", maxSide: "1000" });
    await cmd(base, { op: "image.settings", quality: "60" });
    await waitUntil("said", () =>
      s.state.chat.some(
        (m) =>
          m.text ===
          "Agent changed the image import settings: quality 60. Images brought in are now in their own format, longest side 1000 px.",
      ),
    );
  });

  test("a bad value is refused whole, and nothing is written", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "image.settings", format: "webp", quality: "0" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("1 to 100");
    expect(existsSync(prefsFile())).toBe(false);
  });

  test("the surface sets them as prefs, and a bad value is refused", async () => {
    const { s } = await start();
    s.send({ op: "prefs.set", key: IMAGE_PREF_KEYS.quality, value: "65" });
    await waitUntil("set", () => s.state.prefs[IMAGE_PREF_KEYS.quality] === "65");
    s.send({ op: "prefs.set", key: IMAGE_PREF_KEYS.format, value: "tiff" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("keep or webp");
    expect(JSON.parse(readFileSync(prefsFile(), "utf8"))).toEqual({
      [IMAGE_PREF_KEYS.quality]: "65",
    });
  });
});

describe("metadata, whatever the settings", () => {
  test("a photo dropped with the defaults loses its location, keeps its pixels, and the chat says so", async () => {
    const { base, s } = await start();
    const photo = jpegWithMetadata(await jpegBytes(120, 80), 6);
    const r = await post(base, { name: "trip.jpg", dir: join(world, "images") }, photo);
    const path = join(world, "images", "trip.jpg");
    expect(r.body).toEqual({
      ok: true,
      path,
      note: "its EXIF, XMP and IPTC metadata was removed, location included, but its orientation was kept",
    });
    const written = new Uint8Array(readFileSync(path));
    expect(Buffer.from(written).includes("GPSLatitude")).toBe(false);
    // Still upright, at its own size.
    expect(await new Bun.Image(written).metadata()).toMatchObject({ width: 80, height: 120 });
    await waitUntil("said", () =>
      s.state.chat.some(
        (m) =>
          m.text.startsWith("You copied trip.jpg in as") &&
          m.text.endsWith(
            ", its EXIF, XMP and IPTC metadata was removed, location included, but its orientation was kept.",
          ),
      ),
    );
  });
});

describe("a drop on the tree, converted", () => {
  test("is written as WebP under its own stem, capped, and said in the chat; the source is untouched", async () => {
    const { base, s, t } = await start();
    await cmd(base, { op: "image.settings", format: "webp", maxSide: "200" });
    // The file the user dragged, outside the world.
    const source = join(root, "photo.jpg");
    writeFileSync(source, await jpegBytes(400, 200));
    const before = readFileSync(source);
    const r = await post(
      base,
      { name: "photo.jpg", dir: join(world, "images") },
      new Uint8Array(readFileSync(source)),
    );
    expect(r.status).toBe(200);
    const path = join(world, "images", "photo.webp");
    expect(r.body).toMatchObject({ ok: true, path, converted: true });
    expect(r.body.note).toStartWith(
      "converted from JPEG to WebP at quality 80, made smaller from 400×200 to 200×100: ",
    );
    expect(await meta(path)).toMatchObject({ format: "webp", width: 200, height: 100 });
    expect(existsSync(join(world, "images", "photo.jpg"))).toBe(false);
    expect(readFileSync(source).equals(before)).toBe(true);
    const said = await waitUntil("said", () =>
      s.state.chat.find((m) => m.text.startsWith("You copied photo.jpg in as")),
    );
    expect(said?.text).toContain("photo.webp, converted from JPEG to WebP");
    await t.waitFor((e) => e.type === "system" && e.fact === "image.import" && e.path === path);
  });

  test("the clash is on the name it would be written under, and the refusal names it", async () => {
    const { base } = await start();
    await cmd(base, { op: "image.settings", format: "webp" });
    const dir = join(world, "images");
    const jpg = await jpegBytes(300, 200);
    writeFileSync(join(dir, "existing.jpg"), jpg);
    // existing.jpg is there, but existing.webp is what would be written: no clash.
    const first = await post(base, { name: "existing.jpg", dir }, jpg);
    expect(first.body.path).toBe(join(dir, "existing.webp"));
    // Now existing.webp is taken: the refusal names it, not the dropped name.
    const again = await post(base, { name: "existing.jpg", dir }, jpg);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, name: "existing.webp" });
    // Keep both writes a free name beside it; existing.jpg is never touched.
    const both = await post(base, { name: "existing.jpg", dir, onTaken: "keep-both" }, jpg);
    expect(both.body.path).toMatch(/existing.*\.webp$/);
    expect(both.body.path).not.toBe(join(dir, "existing.webp"));
    expect(new Uint8Array(readFileSync(join(dir, "existing.jpg")))).toEqual(jpg);
  });

  test("its description records the name it came in with, after a rename too", async () => {
    const { base } = await start();
    await cmd(base, { op: "image.settings", format: "webp" });
    const r = await post(
      base,
      { name: "IMG_0042.png", dir: join(world, "images") },
      pngBytes(300, 200),
    );
    const path = join(world, "images", "IMG_0042.webp");
    expect(r.body.path).toBe(path);
    const renamed = await cmd(base, { op: "rename", path, name: "fox-at-dusk.webp" });
    expect(renamed.status).toBe(200);
    const fox = join(world, "images", "fox-at-dusk.webp");
    const d = await cmd(base, { op: "image.describe", image: fox });
    expect(d.status).toBe(200);
    const sidecar = readFileSync(`${fox}.md`, "utf8");
    expect(sidecar).toContain('original-name: "IMG_0042.png"');
  });

  test("an image dropped under its own name has its own name recorded", async () => {
    const { base } = await start();
    await cmd(base, { op: "image.settings", format: "webp" });
    // Already WebP: left as it came, under its own name.
    const webp = new Uint8Array(await new Bun.Image(pngBytes(40, 40)).webp().bytes());
    const r = await post(base, { name: "leaf.webp", dir: join(world, "images") }, webp);
    // Said, but not as something the settings failed at: it already was WebP.
    expect(r.body).toEqual({
      ok: true,
      path: join(world, "images", "leaf.webp"),
      note: "kept as it came: it is already WebP",
    });
    const d = await cmd(base, { op: "image.describe", image: r.body.path as string });
    expect(d.status).toBe(200);
    expect(readFileSync(`${r.body.path}.md`, "utf8")).toContain('original-name: "leaf.webp"');
  });

  test("an animated GIF is copied as it came, and the chat says why", async () => {
    const { base, s } = await start();
    await cmd(base, { op: "image.settings", format: "webp", maxSide: "64" });
    const r = await post(base, { name: "spin.gif", dir: join(world, "images") }, GIF_2_FRAMES);
    const path = join(world, "images", "spin.gif");
    expect(r.body).toEqual({
      ok: true,
      path,
      kept: true,
      note: "kept as it came: it is animated, and only its first frame would be kept",
    });
    expect(new Uint8Array(readFileSync(path))).toEqual(GIF_2_FRAMES);
    await waitUntil("said", () =>
      s.state.chat.some(
        (m) =>
          m.text.startsWith("You copied spin.gif in as") &&
          m.text.endsWith(", as it came: it is animated, and only its first frame would be kept."),
      ),
    );
  });
});

describe("a paste into a document, converted", () => {
  test("is written as WebP, the embed points at it, and the agent's fact carries the note", async () => {
    const { base, t } = await start();
    await cmd(base, { op: "image.settings", format: "webp", quality: "50" });
    const doc = join(world, "story.md");
    const r = await post(
      base,
      { name: "pasted-2026-10-06-101500.png", doc, how: "paste" },
      pngBytes(400, 300),
    );
    const path = join(world, "images", "pasted-2026-10-06-101500.webp");
    expect(r.body).toMatchObject({
      ok: true,
      path,
      href: "./images/pasted-2026-10-06-101500.webp",
      converted: true,
    });
    expect(await meta(path)).toMatchObject({ format: "webp", width: 400, height: 300 });
    const fact = await t.waitFor((e) => e.type === "system" && e.fact === "image.pasted");
    const notes = (fact as { notes?: Record<string, string> }).notes ?? {};
    expect(notes[path]).toStartWith("converted from PNG to WebP at quality 50: ");
    expect(String((fact as { text?: string }).text)).toContain(
      "images/pasted-2026-10-06-101500.webp (converted from PNG to WebP",
    );
  });

  test("a drop into a document keeps the dropped file's stem", async () => {
    const { base } = await start();
    await cmd(base, { op: "image.settings", format: "webp" });
    const r = await post(
      base,
      { name: "map sketch.jpg", doc: join(world, "story.md"), how: "drop" },
      await jpegBytes(300, 300),
    );
    expect(r.body.path).toBe(join(world, "images", "map sketch.webp"));
    expect(r.body.href).toBe("./images/map%20sketch.webp");
  });
});

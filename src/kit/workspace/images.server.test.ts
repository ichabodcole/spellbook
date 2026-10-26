// Images through the daemon (the kit-image-files item): the tree shows them,
// `open` puts one in the viewer and the open document aside, the file route
// serves only an image the tree shows (and refuses everything else, however it
// is asked), a dropped image is written as a plain file, replacing one sends the
// old file to the Trash, and no text tool ever reads an image as text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import { SVG_REFUSED } from "../lib/docFormat.ts";
import {
  CMYK_JPEG,
  GIF_1PX,
  heicBytes,
  jpegBytes,
  pngBytes,
  webpBytes,
} from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import { cutShort } from "./images";
import type { ContextNode } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let outside: string;
let bin: string;
let trashed: string[];
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

/** A real PNG with text after its end: what a text tool would find if it read the bytes. */
const MARKED = (() => {
  const png = pngBytes(8, 8);
  const tail = new TextEncoder().encode(
    "\nZEBRAQUILL [the target](target.md) [[target]]\n---\ntype: location\n---\n",
  );
  const out = new Uint8Array(png.length + tail.length);
  out.set(png);
  out.set(tail, png.length);
  return out;
})();

beforeEach(async () => {
  root = tempRoot("workspace-images");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "images"), { recursive: true });
  mkdirSync(join(world, "_meta", "profiles"), { recursive: true });
  writeFileSync(join(world, "_meta", "profiles", "location.json"), '{ "type": "object" }\n');
  writeFileSync(join(world, "target.md"), "# Target\n");
  writeFileSync(join(world, "story.md"), "# Story\n\nSee [the target](target.md).\n");
  writeFileSync(join(world, "images", "fox.png"), MARKED);
  writeFileSync(join(world, "images", "photo.jpg"), await jpegBytes(40, 30));
  writeFileSync(join(world, "images", "leaf.webp"), await webpBytes(20, 20));
  writeFileSync(join(world, "images", "dot.gif"), GIF_1PX);
  // Named as an image, but a page inside: never served.
  writeFileSync(join(world, "images", "fake.png"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(world, "logo.svg"), "<svg><script>alert(1)</script></svg>");
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.png"), pngBytes(4, 4));
  // A link in the set that leads out of it, under an image's name.
  symlinkSync(join(outside, "secret.png"), join(world, "images", "escape.png"));
  bin = join(root, "fake-trash");
  mkdirSync(bin, { recursive: true });
  trashed = [];
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
    platform: "darwin",
    trash: async (p: string) => {
      trashed.push(p);
      renameSync(p, join(bin, `${trashed.length}-${basename(p)}`));
    },
  });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { base: daemon.url, s: surface, t: tail, d: daemon };
}

const file = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/fs/file?path=${encodeURIComponent(path)}`, { headers });

const nodesOf = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n, ...nodesOf(n.children)] : [n]));

describe("the tree and the viewer", () => {
  test("images show in the tree as image nodes; an SVG does not", async () => {
    const { s } = await start();
    const nodes = nodesOf(s.state.context[0]?.nodes ?? []);
    const images = nodes.filter((n) => n.kind === "image").map((n) => n.rel);
    expect(images.sort()).toEqual([
      "images/dot.gif",
      "images/escape.png",
      "images/fake.png",
      "images/fox.png",
      "images/leaf.webp",
      "images/photo.jpg",
    ]);
    expect(nodes.some((n) => n.rel.endsWith(".svg"))).toBe(false);
  });

  test("open puts an image in the viewer and the document aside; a document puts it away", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document", () => s.state.openDoc === "story");
    const fox = join(world, "images", "fox.png");
    s.send({ op: "open", path: fox });
    await waitUntil("the image", () => s.state.openImage?.path === fox);
    expect(s.state.openDoc).toBeNull();
    expect(s.state.openImage).toMatchObject({
      name: "fox.png",
      rel: "images/fox.png",
      size: MARKED.length,
      type: "image/png",
    });
    // Never a document: no record, no version, no text sent.
    expect(s.state.docs.map((d) => d.name)).toEqual(["story.md"]);
    expect(s.frames.some((f) => f.op === "version.text" && f.doc.startsWith("fox"))).toBe(false);
    // A document coming on screen puts the image away, and back again.
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("the document again", () => s.state.openDoc === "story");
    expect(s.state.openImage).toBeNull();
    s.send({ op: "open", path: fox });
    await waitUntil("the image again", () => s.state.openImage !== null);
    s.send({ op: "image.close" });
    await waitUntil("closed", () => s.state.openImage === null);
  });

  test("an image outside the context is not opened", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(outside, "secret.png") });
    const err = await s.waitFor((f) => f.op === "error");
    expect(err.op === "error" && err.message).toContain("not an image shown in this session");
    expect(s.state.openImage ?? null).toBeNull();
  });

  test("a renamed open image is followed; a trashed one closes", async () => {
    const { s, base } = await start();
    const fox = join(world, "images", "fox.png");
    s.send({ op: "open", path: fox });
    await waitUntil("the image", () => s.state.openImage?.path === fox);
    // A rename to a document's name keeps the image's extension.
    s.send({ op: "rename", path: fox, name: "vixen.md" });
    const moved = join(world, "images", "vixen.md.png");
    await waitUntil("followed", () => s.state.openImage?.path === moved);
    expect(existsSync(moved)).toBe(true);
    expect((await file(base, moved)).status).toBe(200);
    s.send({ op: "trash", path: moved });
    await s.waitFor((f) => f.op === "trash.done");
    await waitUntil("closed", () => s.state.openImage === null);
    expect(trashed).toEqual([moved]);
  });
});

describe("the file route's guard", () => {
  test("an image the tree shows is served as its bytes say, revalidated, and kept to our page", async () => {
    const { base } = await start();
    const res = await file(base, join(world, "images", "photo.jpg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const etag = res.headers.get("etag") as string;
    expect(etag).toMatch(/^".+"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array(readFileSync(join(world, "images", "photo.jpg"))),
    );
    const again = await file(base, join(world, "images", "photo.jpg"), { "If-None-Match": etag });
    expect(again.status).toBe(304);
    // Every shown type, each by what its bytes are.
    for (const [name, type] of [
      ["fox.png", "image/png"],
      ["leaf.webp", "image/webp"],
      ["dot.gif", "image/gif"],
    ] as const)
      expect((await file(base, join(world, "images", name))).headers.get("content-type")).toBe(
        type,
      );
  });

  test("a path outside every entry, a link out of the set, .., a relative path and a non-image are refused", async () => {
    const { base } = await start();
    const outsideRes = await file(base, join(outside, "secret.png"));
    expect(outsideRes.status).toBe(404);
    const linkOut = await file(base, join(world, "images", "escape.png"));
    expect(linkOut.status).toBe(404);
    expect(((await linkOut.json()) as { error: string }).error).toContain("leads outside");
    const dotdot = await file(base, `${join(world, "images")}/../../outside/secret.png`);
    expect(dotdot.status).toBe(400);
    expect(((await dotdot.json()) as { error: string }).error).toContain("..");
    expect((await file(base, "images/fox.png")).status).toBe(400);
    const doc = await file(base, join(world, "story.md"));
    expect(doc.status).toBe(400);
    expect(((await doc.json()) as { error: string }).error).toContain("not an image");
    const svg = await file(base, join(world, "logo.svg"));
    expect(svg.status).toBe(400);
    // Named as an image, a page inside: refused, never served as anything.
    const fake = await file(base, join(world, "images", "fake.png"));
    expect(fake.status).toBe(400);
    expect(((await fake.json()) as { error: string }).error).toContain("whatever its name says");
    // Nothing refused leaked a byte of the file.
    for (const r of [outsideRes, linkOut, dotdot, doc, svg, fake])
      expect(r.headers.get("content-type")).toContain("application/json");
  });

  test("another site's page cannot load an image, by an img tag or a fetch", async () => {
    const { base } = await start();
    const fox = join(world, "images", "fox.png");
    const img = await file(base, fox, { "Sec-Fetch-Site": "cross-site" });
    expect(img.status).toBe(403);
    const sameSite = await file(base, fox, { "Sec-Fetch-Site": "same-site" });
    expect(sameSite.status).toBe(403);
    const foreign = await file(base, fox, { Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    // Our own page, and the CLI (no header at all), are served.
    expect((await file(base, fox, { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await file(base, fox)).status).toBe(200);
  });

  test("a thumbnail is a cached WebP no wider than asked, and only at the widths offered", async () => {
    const { base, d } = await start();
    // The world's watch was armed a moment ago, by context.add.
    const big = pngBytes(600, 300);
    await writeUntilSeen(
      "the new image",
      () => writeFileSync(join(world, "images", "big.png"), big),
      () => nodesOf(surface?.state.context[0]?.nodes ?? []).some((n) => n.rel === "images/big.png"),
    );
    const path = join(world, "images", "big.png");
    const res = await fetch(`${base}/fs/thumb?path=${encodeURIComponent(path)}&w=256`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const meta = await new Bun.Image(new Uint8Array(await res.arrayBuffer())).metadata();
    expect(meta).toMatchObject({ width: 256, height: 128, format: "webp" });
    const cached = readdirSync(join(d.session.dir, "thumbs"));
    expect(cached.filter((n) => n.endsWith("-256.webp"))).toHaveLength(1);
    // The same guard as the file route.
    const out = await fetch(
      `${base}/fs/thumb?path=${encodeURIComponent(join(outside, "secret.png"))}&w=256`,
    );
    expect(out.status).toBe(404);
    expect((await fetch(`${base}/fs/thumb?path=${encodeURIComponent(path)}&w=100`)).status).toBe(
      400,
    );
  });
});

describe("a dropped image", () => {
  const drop = (
    base: string,
    name: string,
    body: Uint8Array<ArrayBuffer> | string,
    q: Record<string, string> = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/fs/image?${new URLSearchParams({ name, ...q })}`, {
      method: "POST",
      body,
      headers,
    });

  test("is written as a plain file where it was dropped, and said in the chat", async () => {
    const { base, s, t } = await start();
    const bytes = pngBytes(16, 16);
    const res = await drop(base, "new.png", bytes, { dir: join(world, "images") });
    expect(res.status).toBe(200);
    const path = join(world, "images", "new.png");
    expect(await res.json()).toEqual({ ok: true, path });
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    await waitUntil("in the tree", () =>
      nodesOf(s.state.context[0]?.nodes ?? []).some((n) => n.rel === "images/new.png"),
    );
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "image.import");
    expect(said.path).toBe(path);
    expect(s.state.history.canUndo).toBe(true);
  });

  test("a taken name is asked about; keep both gives it a free name", async () => {
    const { base } = await start();
    const dir = join(world, "images");
    const ask = await drop(base, "fox.png", pngBytes(4, 4), { dir });
    expect(ask.status).toBe(409);
    expect(await ask.json()).toMatchObject({ ok: false, choices: ["replace", "keep-both"] });
    expect(new Uint8Array(readFileSync(join(dir, "fox.png")))).toEqual(MARKED);
    const both = await drop(base, "fox.png", pngBytes(4, 4), { dir, onTaken: "keep-both" });
    expect(await both.json()).toEqual({ ok: true, path: join(dir, "fox 2.png") });
    expect(new Uint8Array(readFileSync(join(dir, "fox.png")))).toEqual(MARKED);
  });

  test("replacing sends the old file to the Trash and keeps the name; no version is made", async () => {
    const { base, s, t } = await start();
    const fox = join(world, "images", "fox.png");
    s.send({ op: "open", path: fox });
    await waitUntil("open", () => s.state.openImage?.path === fox);
    const before = s.state.openImage?.stamp;
    const next = pngBytes(32, 32, [200, 0, 0], [0, 0, 200]);
    const res = await drop(base, "fox.png", next, {
      dir: join(world, "images"),
      onTaken: "replace",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: fox, replaced: true });
    expect(trashed).toEqual([fox]);
    expect(new Uint8Array(readFileSync(join(bin, "1-fox.png")))).toEqual(MARKED);
    expect(new Uint8Array(readFileSync(fox))).toEqual(next);
    // Still open, under its name, with a new stamp, so the viewer shows the new one.
    await waitUntil("restamped", () => s.state.openImage?.stamp !== before);
    expect(s.state.openImage?.path).toBe(fox);
    expect(s.state.docs).toEqual([]);
    // Nothing staged is left beside it.
    expect(readdirSync(join(world, "images")).filter((n) => n.startsWith("."))).toEqual([]);
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "image.replace");
    expect(String(said.text)).toContain("the old file is in the Trash");
  });

  test("a failed Trash leaves the old file where it was", async () => {
    // This test's own daemon, with a Trash that fails.
    daemon = fixtureDaemon({
      tmp: join(root, "tmp"),
      workspace: join(root, "ws"),
      platform: "darwin",
      trash: async () => {
        throw new Error("the Trash is full");
      },
    });
    await daemon.start();
    await cmd(daemon.url, { op: "context.add", paths: [world] });
    const fox = join(world, "images", "fox.png");
    const res = await drop(daemon.url, "fox.png", pngBytes(4, 4), {
      dir: join(world, "images"),
      onTaken: "replace",
    });
    expect(res.status).toBe(409);
    expect(new Uint8Array(readFileSync(fox))).toEqual(MARKED);
    expect(readdirSync(join(world, "images")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("an SVG, a non-image, a page named .png, a folder outside a set and another site are refused", async () => {
    const { base } = await start();
    const dir = join(world, "images");
    const svg = await drop(base, "logo.svg", "<svg/>", { dir });
    expect(svg.status).toBe(400);
    expect(((await svg.json()) as { error: string }).error).toBe(SVG_REFUSED);
    const zip = await drop(base, "a.zip", "PK", { dir });
    expect(zip.status).toBe(400);
    expect(((await zip.json()) as { error: string }).error).toContain("not an image");
    const page = await drop(base, "page.png", "<html></html>", { dir });
    expect(page.status).toBe(400);
    expect(existsSync(join(dir, "page.png"))).toBe(false);
    const nowhere = await drop(base, "x.png", pngBytes(2, 2), { dir: outside });
    expect(nowhere.status).toBe(400);
    expect(existsSync(join(outside, "x.png"))).toBe(false);
    const foreign = await drop(base, "x.png", pngBytes(2, 2), { dir }, { Origin: "https://e.x" });
    expect(foreign.status).toBe(403);
    const crossSite = await drop(
      base,
      "x.png",
      pngBytes(2, 2),
      { dir },
      {
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(crossSite.status).toBe(403);
    expect(existsSync(join(dir, "x.png"))).toBe(false);
  });

  test("bytes cut short, an image's header with its pixels gone, are refused and nothing is written", async () => {
    const { base } = await start();
    const dir = join(world, "images");
    const whole = pngBytes(64, 64);
    const cut = whole.slice(0, Math.floor(whole.length * 0.6));
    const res = await drop(base, "cut.png", cut, { dir });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("is cut short");
    expect(existsSync(join(dir, "cut.png"))).toBe(false);
    // A JPEG cut short, the same.
    const jpeg = await jpegBytes(64, 64);
    const cutJpeg = await drop(base, "cut.jpg", jpeg.slice(0, Math.floor(jpeg.length * 0.8)), {
      dir,
    });
    expect(cutJpeg.status).toBe(400);
    expect(existsSync(join(dir, "cut.jpg"))).toBe(false);
    // Beside a document (a paste into its editor), the same.
    const beside = await drop(base, "cut.png", cut, { doc: join(world, "story.md"), how: "paste" });
    expect(beside.status).toBe(400);
    expect(readdirSync(world).some((n) => n.startsWith("cut"))).toBe(false);
  });

  test("a CMYK JPEG, which Bun cannot decode but a browser shows, comes in whole but for its EXIF", async () => {
    const { base } = await start();
    const dir = join(world, "images");
    const res = await drop(base, "print.jpg", CMYK_JPEG, { dir });
    expect(res.status).toBe(200);
    const written = new Uint8Array(readFileSync(join(dir, "print.jpg")));
    // Its EXIF block went (every import loses its metadata); the rest is as it came.
    expect(Buffer.from(CMYK_JPEG).includes("Exif")).toBe(true);
    expect(Buffer.from(written).includes("Exif")).toBe(false);
    expect(Buffer.from(written).includes("Photoshop 3.0")).toBe(false);
    // Its APP0 and APP14 (Adobe's colour transform, which CMYK needs) stay, and
    // everything from the first table on is byte for byte what came in.
    expect(Buffer.from(written).includes("Adobe")).toBe(true);
    const from = (b: Uint8Array) => Buffer.from(b).subarray(Buffer.from(b).indexOf("Adobe") - 4);
    expect(from(written).equals(from(CMYK_JPEG))).toBe(true);
    expect(written.length).toBeLessThan(CMYK_JPEG.length);
    // Cut short, it is refused like any other.
    const cut = await drop(base, "print-cut.jpg", CMYK_JPEG.slice(0, 500), { dir });
    expect(cut.status).toBe(400);
    expect(existsSync(join(dir, "print-cut.jpg"))).toBe(false);
  });

  test("cutShort reads each checkable format's end marker, and has no verdict on the rest", async () => {
    const png = pngBytes(16, 16);
    const jpeg = await jpegBytes(16, 16);
    const webp = await webpBytes(16, 16);
    expect(cutShort(png)).toBe(false);
    expect(cutShort(png.slice(0, png.length - 12))).toBe(true);
    expect(cutShort(jpeg)).toBe(false);
    // Padding after the end marker is still a whole JPEG.
    expect(cutShort(new Uint8Array([...jpeg, 0, 0, 0, 0]))).toBe(false);
    expect(cutShort(jpeg.slice(0, jpeg.length - 2))).toBe(true);
    expect(cutShort(CMYK_JPEG)).toBe(false);
    expect(cutShort(GIF_1PX)).toBe(false);
    expect(cutShort(GIF_1PX.slice(0, GIF_1PX.length - 1))).toBe(true);
    expect(cutShort(webp)).toBe(false);
    expect(cutShort(webp.slice(0, webp.length - 4))).toBe(true);
    expect(cutShort(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBeNull();
  });

  test("a body shorter than its declared Content-Length is refused, never written truncated", async () => {
    const { d } = await start();
    const dir = join(world, "images");
    const whole = pngBytes(64, 64);
    const sent = whole.slice(0, 200);
    const target = `/fs/image?${new URLSearchParams({ name: "short.png", dir })}`;
    // A raw request, since fetch will not send fewer bytes than it declares: the
    // header promises the whole PNG, 200 bytes arrive, and the sender hangs up.
    let reply = "";
    const closed = Promise.withResolvers<void>();
    const sock = await Bun.connect({
      hostname: "127.0.0.1",
      port: d.port,
      socket: {
        data(_s, chunk) {
          reply += new TextDecoder().decode(chunk);
        },
        close() {
          closed.resolve();
        },
        error() {
          closed.resolve();
        },
      },
    });
    sock.write(
      `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${d.port}\r\nContent-Type: image/png\r\nContent-Length: ${whole.length}\r\nConnection: close\r\n\r\n`,
    );
    sock.write(sent);
    sock.shutdown();
    await Promise.race([closed.promise, Bun.sleep(3000)]);
    sock.end();
    // Any answer that reaches a sender who hung up is a refusal, and the file
    // is never written, whole or cut.
    if (reply) expect(reply).toMatch(/^HTTP\/1\.1 4\d\d/);
    await Bun.sleep(100);
    expect(existsSync(join(dir, "short.png"))).toBe(false);
    expect(readdirSync(dir).some((n) => n.includes("short"))).toBe(false);
  });

  test("a HEIC photo comes in as a JPEG where the machine reads HEIC, and is refused in words where not", async () => {
    const { base } = await start();
    const heic = await heicBytes(24, 16);
    const res = await drop(base, "IMG_0001.HEIC", heic ?? new Uint8Array([0, 0, 0, 24]), {
      dir: join(world, "images"),
    });
    if (heic) {
      expect(res.status).toBe(200);
      const path = join(world, "images", "IMG_0001.jpg");
      expect(await res.json()).toEqual({
        ok: true,
        path,
        converted: true,
        note: expect.stringMatching(/^converted from HEIC to JPEG at quality 90: /),
      });
      const meta = await new Bun.Image(path).metadata();
      expect(meta).toMatchObject({ format: "jpeg", width: 24, height: 16 });
    } else {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("HEIC");
    }
  });
});

describe("the text tools never read an image as text", () => {
  test("search, backlinks, link check, the map and profiles pass over every image", async () => {
    const { base, s } = await start();
    // Open everything a tool could reach, the image included.
    s.send({ op: "open", path: join(world, "images", "fox.png") });
    await waitUntil("open", () => s.state.openImage !== null);
    const search = await cmd(base, { op: "search", query: "ZEBRAQUILL" });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain("fox.png");
    const back = await cmd(base, { op: "backlinks", doc: join(world, "target.md") });
    expect(back.status).toBe(200);
    expect(JSON.stringify(back.body)).toContain("story.md");
    expect(JSON.stringify(back.body)).not.toContain(".png");
    const check = await cmd(base, { op: "link.check" });
    expect(check.status).toBe(200);
    // Images are listed by NAME where nothing links to or embeds them (kit-image-paste);
    // every section read from text names none, so none was read as a document.
    const { unusedImages: _byName, ...fromText } = check.body as Record<string, unknown>;
    expect(JSON.stringify(fromText)).not.toMatch(/\.(png|jpg|webp|gif)/);
    const graph = await cmd(base, { op: "graph" });
    expect(graph.status).toBe(200);
    expect(JSON.stringify(graph.body)).not.toMatch(/\.(png|jpg|webp|gif)/);
    const profiles = await cmd(base, { op: "profile.check" });
    expect(profiles.status).toBe(200);
    expect(JSON.stringify(profiles.body)).not.toMatch(/\.(png|jpg|webp|gif)/);
    // An image is not a document to the agent's verbs either.
    const asDoc = await cmd(base, { op: "version.new", doc: join(world, "images", "fox.png") });
    expect(asDoc.status).toBe(400);
    expect(s.state.docs).toEqual([]);
  });
});

// Images as link targets (the kit-image-embeds item): an embed (`![alt](x.png)`)
// and a link to an image both count as links, so the image's backlinks say
// where it is used, the agent's `backlinks` answers for an image, and the link
// check reports an embed or a link to a missing image as it does a document's.
// The text tools still read markdown only: an image is a target, never a source.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

/** A real PNG with links after its end: what a text tool would find if it read the bytes. */
const MARKED = (() => {
  const png = pngBytes(8, 8);
  const tail = new TextEncoder().encode(
    "\n[the gate](gate.md?rel=ghostrel) ![x](images/ghost.png) [[gate]]\n---\ntype: location\n---\n",
  );
  const out = new Uint8Array(png.length + tail.length);
  out.set(png);
  out.set(tail, png.length);
  return out;
})();

beforeEach(() => {
  root = tempRoot("workspace-image-links");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "images"), { recursive: true });
  mkdirSync(join(world, "places"), { recursive: true });
  writeFileSync(join(world, "images", "fox.png"), MARKED);
  writeFileSync(join(world, "images", "moon.png"), pngBytes(4, 4));
  // Named as an image, but a page inside; and an SVG: never drawn.
  writeFileSync(join(world, "images", "fake.png"), "<html><script>alert(1)</script></html>");
  writeFileSync(join(world, "images", "logo.svg"), "<svg/>");
  writeFileSync(join(world, "gate.md"), "# The gate\n");
  writeFileSync(
    join(world, "places", "glade.md"),
    [
      "# The glade",
      "",
      "![The fox before the archway](../images/fox.png?rel=sourced-from)",
      "",
      "See [the fox](../images/fox.png) and [the gate](../gate.md).",
      "",
      "![A missing picture](../images/nowhere.png)",
      "",
      "![Far away](https://example.com/far.png)",
      "",
    ].join("\n"),
  );
  writeFileSync(join(world, "story.md"), "# Story\n\n![](images/fox.png)\n\n[lost](lost.png)\n");
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
  return { base: daemon.url, s: surface };
}

type Back = {
  path: string;
  count: number;
  backlinks: { shown: string; raw: string; rel: string[]; label?: string; embed?: true }[];
};

describe("an image's backlinks", () => {
  test("list every embed and link that lands on it, embeds marked", async () => {
    const { base } = await start();
    const fox = join(world, "images", "fox.png");
    const r = await cmd(base, { op: "backlinks", doc: fox });
    expect(r.status).toBe(200);
    const body = r.body as unknown as Back;
    expect(body.path).toBe(fox);
    expect(body.count).toBe(3);
    expect(body.backlinks.map((b) => [b.shown, b.raw, b.rel, b.label, b.embed])).toEqual([
      [
        "places/glade.md",
        "../images/fox.png?rel=sourced-from",
        ["sourced-from"],
        "The fox before the archway",
        true,
      ],
      ["places/glade.md", "../images/fox.png", [], "the fox", undefined],
      ["story.md", "images/fox.png", [], undefined, true],
    ]);
  });

  test("an image nothing uses has none; one outside the context is refused", async () => {
    const { base } = await start();
    const moon = await cmd(base, { op: "backlinks", doc: join(world, "images", "moon.png") });
    expect(moon.status).toBe(200);
    expect((moon.body as unknown as Back).count).toBe(0);
    writeFileSync(join(root, "stray.png"), pngBytes(2, 2));
    const stray = await cmd(base, { op: "backlinks", doc: join(root, "stray.png") });
    expect(stray.status).toBeGreaterThanOrEqual(400);
  });

  test("the surface's Linked from asks by path too", async () => {
    const { s } = await start();
    const fox = join(world, "images", "fox.png");
    s.send({ op: "link.backlinks", doc: fox });
    const said = await s.waitFor((f) => f.op === "link.backlinks");
    expect((said as unknown as Back).count).toBe(3);
  });
});

describe("the link check and images", () => {
  test("an embed or a link to a missing image is dangling, with where it looked", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "link.check" });
    expect(r.status).toBe(200);
    const dangling = (
      r.body as {
        dangling: {
          links: { shown: string; raw: string; embed?: true; tried: string[] }[];
        };
      }
    ).dangling.links;
    expect(dangling.map((d) => [d.shown, d.raw, d.embed])).toEqual([
      ["places/glade.md", "../images/nowhere.png", true],
      ["story.md", "lost.png", undefined],
    ]);
    expect(dangling[0]?.tried).toEqual([join(world, "images", "nowhere.png")]);
    // A remote embed is not a dangling link: it names no file here.
    expect(JSON.stringify(r.body)).not.toContain("example.com");
  });
});

describe("following a link to an image", () => {
  test("lands in the context and opens the viewer; Close brings the document back", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "places", "glade.md") });
    await waitUntil("the document", () => s.state.openDoc === "glade");
    s.send({ op: "link.open", target: "../images/fox.png?rel=sourced-from", doc: "glade" });
    const said = await s.waitFor((f) => f.op === "link.target");
    expect(said).toMatchObject({ state: "in-context", path: join(world, "images", "fox.png") });
    await waitUntil("the viewer", () => s.state.openImage?.name === "fox.png");
    expect(s.state.openDoc).toBeNull();
    s.send({ op: "image.close" });
    await waitUntil("the document back", () => s.state.openDoc === "glade");
    expect(s.state.openImage ?? null).toBeNull();
  });
});

describe("what an embed shows", () => {
  test("resolved as a link from the document is; each refusal says why", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "places", "glade.md") });
    await waitUntil("the document", () => s.state.openDoc === "glade");
    s.send({
      op: "link.embeds",
      doc: "glade",
      targets: [
        "../images/fox.png?rel=sourced-from",
        "../images/fox.png?rel=sourced-from",
        "../images/nowhere.png",
        "https://example.com/far.png",
        "../images/logo.svg",
        "../images/fake.png",
        "../gate.md",
        "../images",
      ],
    });
    const said = (await s.waitFor((f) => f.op === "link.embeds")) as unknown as {
      doc: string;
      embeds: { target: string; state: string; path?: string; stamp?: string; reason?: string }[];
    };
    expect(said.doc).toBe("glade");
    // Distinct targets, in order.
    expect(said.embeds.map((e) => [e.target, e.state])).toEqual([
      ["../images/fox.png?rel=sourced-from", "shown"],
      ["../images/nowhere.png", "not-shown"],
      ["https://example.com/far.png", "not-shown"],
      ["../images/logo.svg", "not-shown"],
      ["../images/fake.png", "not-shown"],
      ["../gate.md", "not-shown"],
      ["../images", "not-shown"],
    ]);
    const [fox, nowhere, far, svg, fake, gate, folder] = said.embeds;
    expect(fox?.path).toBe(join(world, "images", "fox.png"));
    expect(fox?.stamp).toBeString();
    // Its size from the header, for the page to reserve before it loads.
    expect(fox).toMatchObject({ width: 8, height: 8 });
    expect(nowhere?.reason).toContain("Image not found: nothing at");
    expect(far?.reason).toContain("Remote image, not loaded");
    expect(svg?.reason).toContain("SVG image, not shown");
    expect(fake?.reason).toContain("is not a PNG, JPEG, WebP, GIF or AVIF");
    expect(gate?.reason).toContain("is a document, not an image");
    expect(folder?.reason).toContain("is a folder, not an image");
  });
});

describe("an embed of an image outside every entry", () => {
  test("names the folder to add once, not the full path twice", async () => {
    const { s } = await start();
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "far.png"), pngBytes(4, 4));
    s.send({ op: "open", path: join(world, "places", "glade.md") });
    await waitUntil("the document", () => s.state.openDoc === "glade");
    s.send({ op: "link.embeds", doc: "glade", targets: ["../../elsewhere/far.png"] });
    const said = (await s.waitFor((f) => f.op === "link.embeds")) as unknown as {
      embeds: { reason?: string }[];
    };
    const reason = said.embeds[0]?.reason ?? "";
    expect(reason).toStartWith("far.png is an image no set in this session shows");
    expect(reason.split(join(root, "elsewhere")).length - 1).toBeLessThanOrEqual(1);
  });
});

describe("images stay targets, never sources", () => {
  test("no text tool reads an image's bytes, and the graph holds documents only", async () => {
    const { base } = await start();
    // The PNG's tail links to gate.md and to a ghost image: read as text, the
    // gate would gain a backlink from fox.png and the ghost would dangle.
    const gate = await cmd(base, { op: "backlinks", doc: join(world, "gate.md") });
    const sources = (gate.body as unknown as Back).backlinks.map((b) => b.shown);
    expect(sources).toEqual(["places/glade.md"]);
    const check = await cmd(base, { op: "link.check" });
    expect(JSON.stringify(check.body)).not.toContain("ghost");
    const graph = await cmd(base, { op: "graph" });
    expect(graph.status).toBe(200);
    expect(JSON.stringify(graph.body)).not.toMatch(/\.png/);
  });

  test("the link picker offers images by name, never reading them for relations", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "places", "glade.md") });
    await waitUntil("the document", () => s.state.openDoc === "glade");
    s.send({ op: "link.targets", doc: "glade" });
    const said = (await s.waitFor((f) => f.op === "link.targets")) as unknown as {
      targets: { name: string; href: string; shown: string; image?: true }[];
      relations: { rel: string }[];
    };
    const images = said.targets.filter((t) => t.image);
    expect(images.map((t) => [t.shown, t.href])).toEqual([
      ["images/fake.png", "../images/fake.png"],
      ["images/fox.png", "../images/fox.png"],
      ["images/moon.png", "../images/moon.png"],
    ]);
    expect(said.targets.find((t) => t.name === "gate.md")?.image).toBeUndefined();
    expect(said.relations.map((r) => r.rel)).toEqual(["sourced-from"]);
  });
});

// Images pasted or dropped into a document's editor (the kit-image-paste item):
// `POST /fs/image?doc=` writes each into the `images/` folder beside the
// document, made when it is not there, under a free name and never with a
// question; a paste takes the extension its bytes say; the answer carries the
// embed's path relative to the document; and the agent is told once per burst
// with an `image.pasted` fact. Refusals (SVG, too large, not an image, a JSON
// document, a document outside the session's folders) write nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { jpegBytes, pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import { IMAGE_MAX_BYTES } from "./images";
import type { ContextEntry, ContextNode } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { fitName, NAME_MAX_BYTES } from "./session";
import { tempRoot } from "./testing";

let root: string;
let ws: string;
let world: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-images-paste");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  world = join(root, "world");
  mkdirSync(join(world, "places", "town"), { recursive: true });
  writeFileSync(join(world, "story.md"), "# Story\n");
  writeFileSync(join(world, "places", "town", "inn.md"), "# The inn\n");
  writeFileSync(join(world, "data.json"), "{}\n");
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws, imageArrivalMs: 60 });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await cmd(daemon.url, { op: "context.add", paths: [world] });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { base: daemon.url, s: surface };
}

type Answer = { ok: boolean; path?: string; href?: string; error?: string };

const into = async (
  base: string,
  doc: string,
  name: string,
  body: Uint8Array<ArrayBuffer>,
  how: "paste" | "drop" = "paste",
): Promise<{ status: number; body: Answer }> => {
  const res = await fetch(`${base}/fs/image?${new URLSearchParams({ name, doc, how })}`, {
    method: "POST",
    body,
  });
  return { status: res.status, body: (await res.json()) as Answer };
};

/** The node at `rel` in a set's tree, at any depth. */
const nodeAt = (nodes: readonly ContextNode[], rel: string): ContextNode | undefined => {
  for (const n of nodes) {
    if (n.rel === rel) return n;
    if (n.kind === "group") {
      const hit = nodeAt(n.children ?? [], rel);
      if (hit) return hit;
    }
  }
  return undefined;
};

const setOf = (s: FakeSurface): ContextEntry =>
  s.state.context.find((e) => e.root === world) as ContextEntry;

describe("an image pasted into a document", () => {
  test("is written to images/ beside it, the folder made, under its dated name, with the embed's path", async () => {
    const { base, s } = await start();
    const doc = join(world, "story.md");
    expect(existsSync(join(world, "images"))).toBe(false);
    const bytes = pngBytes(8, 8);
    const r = await into(base, doc, "pasted-2026-10-05-153210.png", bytes);
    expect(r.status).toBe(200);
    const path = join(world, "images", "pasted-2026-10-05-153210.png");
    expect(r.body).toEqual({ ok: true, path, href: "./images/pasted-2026-10-05-153210.png" });
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
    // The tree shows it at once: the embed resolves through the guarded route.
    await waitUntil("in the tree", () =>
      nodeAt(setOf(s).nodes, "images/pasted-2026-10-05-153210.png"),
    );
    expect(nodeAt(setOf(s).nodes, "images")?.kind).toBe("group");
    // Never in the undo history: undo in the editor leaves the file.
    expect(s.state.history.canUndo).toBe(false);
  });

  test("takes the extension its bytes say, whatever the clipboard's type guessed", async () => {
    const { base } = await start();
    const r = await into(
      base,
      join(world, "story.md"),
      "pasted-2026-10-05-153210.png",
      await jpegBytes(4, 4),
    );
    expect(r.body.path).toBe(join(world, "images", "pasted-2026-10-05-153210.jpg"));
    expect(r.body.href).toBe("./images/pasted-2026-10-05-153210.jpg");
  });

  test("a second paste in the same second gets a free name, never a question", async () => {
    const { base } = await start();
    const doc = join(world, "story.md");
    await into(base, doc, "pasted-2026-10-05-153210.png", pngBytes(4, 4));
    const r = await into(base, doc, "pasted-2026-10-05-153210.png", pngBytes(5, 5));
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(join(world, "images", "pasted-2026-10-05-153210 2.png"));
    expect(r.body.href).toBe("./images/pasted-2026-10-05-153210%202.png");
  });

  test("from a nested document, lands beside it and the path is relative to it", async () => {
    const { base, s } = await start();
    const inn = join(world, "places", "town", "inn.md");
    const r = await into(base, inn, "pasted-2026-10-05-090000.png", pngBytes(4, 4));
    const path = join(world, "places", "town", "images", "pasted-2026-10-05-090000.png");
    expect(r.body).toEqual({ ok: true, path, href: "./images/pasted-2026-10-05-090000.png" });
    // And an embed written with that path resolves from the document.
    s.send({ op: "open", path: inn });
    await waitUntil("the document", () => s.state.openDoc === "inn");
    s.send({ op: "link.embeds", doc: "inn", targets: [r.body.href as string] });
    const said = (await s.waitFor((f) => f.op === "link.embeds")) as unknown as {
      embeds: { state: string; path?: string }[];
    };
    expect(said.embeds[0]).toMatchObject({ state: "shown", path });
  });
});

describe("an image dropped into a document", () => {
  test("keeps its name, made unique when taken, with no Replace question", async () => {
    const { base } = await start();
    const doc = join(world, "story.md");
    const first = await into(base, doc, "Fox at dusk.png", pngBytes(4, 4), "drop");
    expect(first.body.path).toBe(join(world, "images", "Fox at dusk.png"));
    expect(first.body.href).toBe("./images/Fox%20at%20dusk.png");
    const again = await into(base, doc, "Fox at dusk.png", pngBytes(6, 6), "drop");
    expect(again.status).toBe(200);
    expect(again.body.path).toBe(join(world, "images", "Fox at dusk 2.png"));
    expect(readdirSync(join(world, "images")).sort()).toEqual([
      "Fox at dusk 2.png",
      "Fox at dusk.png",
    ]);
  });
});

describe("the agent is told", () => {
  test("once per burst: several images are one image.pasted fact naming the document and each image", async () => {
    const { base } = await start();
    const tail = collectEvents(base);
    try {
      const doc = join(world, "story.md");
      const a = await into(base, doc, "a.png", pngBytes(4, 4), "drop");
      const b = await into(base, doc, "b.png", pngBytes(4, 4), "drop");
      const c = await into(base, doc, "c.png", pngBytes(4, 4), "drop");
      const fact = await tail.waitFor((e) => e.type === "system" && e.fact === "image.pasted");
      expect(fact).toMatchObject({
        by: "human",
        doc,
        how: "drop",
        images: [a.body.path, b.body.path, c.body.path],
      });
      expect(String(fact.text)).toContain("3 images dropped into");
      // Settled: no second fact for the same burst, and no chat line.
      await Bun.sleep(150);
      expect(tail.events.filter((e) => e.fact === "image.pasted")).toHaveLength(1);
      expect(tail.events.filter((e) => e.type === "message")).toHaveLength(0);
    } finally {
      await tail.stop();
    }
  });
});

describe("the fact's words", () => {
  test("a burst of a paste and a drop says both, and names each image from the document's folder", async () => {
    const { base } = await start();
    const tail = collectEvents(base);
    try {
      const doc = join(world, "story.md");
      await into(base, doc, "pasted-2026-10-05-120000.png", pngBytes(4, 4), "paste");
      await into(base, doc, "fox.png", pngBytes(4, 4), "drop");
      const fact = await tail.waitFor((e) => e.type === "system" && e.fact === "image.pasted");
      expect(fact.how).toBe("both");
      expect(String(fact.text)).toEndWith(
        "2 images pasted and dropped into world/story.md: images/pasted-2026-10-05-120000.png, images/fox.png.",
      );
    } finally {
      await tail.stop();
    }
  });
});

describe("names at the limit", () => {
  test("a free name is shortened to fit 255 bytes, counting bytes, and keeps its extension", () => {
    const long = "a".repeat(251);
    expect(fitName(long, " 2.png")).toBe(`${"a".repeat(249)} 2.png`);
    // Two bytes a character: whole characters go, never half of one.
    const wide = "é".repeat(125);
    const fitted = fitName(wide, " 2.png");
    expect(Buffer.byteLength(fitted)).toBeLessThanOrEqual(NAME_MAX_BYTES);
    expect(fitted).toBe(`${"é".repeat(124)} 2.png`);
    expect(fitName("short", " 2.png")).toBe("short 2.png");
  });

  test("a taken 255-byte name gets a free name that fits, not ENAMETOOLONG", async () => {
    const { base } = await start();
    const doc = join(world, "story.md");
    const name = `${"b".repeat(251)}.png`;
    const first = await into(base, doc, name, pngBytes(4, 4), "drop");
    expect(first.status).toBe(200);
    const again = await into(base, doc, name, pngBytes(4, 4), "drop");
    expect(again.status).toBe(200);
    expect(again.body.path).toBe(join(world, "images", `${"b".repeat(249)} 2.png`));
  });
});

describe("a loose document in the workspace folder", () => {
  test("gets images/ in the workspace folder, each image listed as its own entry", async () => {
    const { base, s } = await start();
    const notes = join(ws, "notes.md");
    writeFileSync(notes, "# Notes\n");
    await cmd(base, { op: "context.add", paths: [notes] });
    await waitUntil("listed", () => s.state.context.length === 2);
    const r = await into(base, notes, "pasted-2026-10-05-100000.png", pngBytes(4, 4));
    const path = join(ws, "images", "pasted-2026-10-05-100000.png");
    expect(r.body).toEqual({ ok: true, path, href: "./images/pasted-2026-10-05-100000.png" });
    const tail = collectEvents(base);
    const fact = await tail.waitFor((e) => e.type === "system" && e.fact === "image.pasted");
    await tail.stop();
    expect(String(fact.text)).toEndWith("notes.md: images/pasted-2026-10-05-100000.png.");
    await waitUntil("the image listed", () =>
      s.state.context.find(
        (e) => e.membership === "listed" && join(e.root, e.nodes[0]?.rel ?? "") === path,
      ),
    );
  });

  test("a document outside every set and the workspace is refused, and nothing is written", async () => {
    const { base, s } = await start();
    const far = join(root, "far");
    mkdirSync(far);
    writeFileSync(join(far, "letter.md"), "# Letter\n");
    await cmd(base, { op: "context.add", paths: [join(far, "letter.md")] });
    await waitUntil("listed", () => s.state.context.length === 2);
    const r = await into(base, join(far, "letter.md"), "pasted-x.png", pngBytes(4, 4));
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not in a set or in the workspace folder");
    expect(existsSync(join(far, "images"))).toBe(false);
  });
});

describe("an image nothing links to or embeds", () => {
  test("is listed by the link check once its embed is gone, and only in an images folder", async () => {
    const { base } = await start();
    const doc = join(world, "story.md");
    const r = await into(base, doc, "pasted-2026-10-05-110000.png", pngBytes(4, 4));
    // A picture kept elsewhere (a mood board) needs no embed to belong.
    writeFileSync(join(world, "board.png"), pngBytes(4, 4));
    writeFileSync(doc, `# Story\n\n![pasted](${r.body.href})\n`);
    type Check = {
      count: number;
      unusedImages: { count: number; images: { path: string; shown: string }[] };
    };
    const check = async () => (await cmd(base, { op: "link.check" })).body as unknown as Check;
    expect((await check()).unusedImages).toEqual({ count: 0, images: [] });
    // The embed undone: the file stays on disk, and the check says so.
    writeFileSync(doc, "# Story\n");
    const after = await check();
    expect(after.unusedImages).toEqual({
      count: 1,
      images: [{ path: r.body.path as string, shown: "images/pasted-2026-10-05-110000.png" }],
    });
    // Counted apart: an unused image is not a broken link.
    expect(after.count).toBe(0);
    expect(existsSync(r.body.path as string)).toBe(true);
    // A plain link to it counts as a use, as backlinks counts it.
    writeFileSync(doc, `# Story\n\nSee [the picture](${r.body.href}).\n`);
    expect((await check()).unusedImages.count).toBe(0);
  });
});

describe("refusals write nothing", () => {
  test("SVG, too large, and not an image inside", async () => {
    const { base } = await start();
    const doc = join(world, "story.md");
    const svg = await into(
      base,
      doc,
      "logo.svg",
      new TextEncoder().encode(
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
      ) as Uint8Array<ArrayBuffer>,
      "drop",
    );
    expect(svg.status).toBe(400);
    expect(svg.body.error).toContain("SVG is not brought in");
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(pngBytes(4, 4));
    const large = await into(base, doc, "pasted-big.png", big);
    expect(large.status).toBe(400);
    expect(large.body.error).toContain("larger than 20 MB");
    const fake = await into(
      base,
      doc,
      "pasted-fake.png",
      new TextEncoder().encode("not an image at all") as Uint8Array<ArrayBuffer>,
    );
    expect(fake.status).toBe(400);
    expect(fake.body.error).toContain("not a PNG, JPEG, WebP, GIF or AVIF image inside");
    expect(existsSync(join(world, "images"))).toBe(false);
  });

  test("a document in a linked folder leading out of the set makes nothing outside it", async () => {
    const out = join(root, "out", "realsub");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "r.md"), "# R\n");
    symlinkSync(out, join(world, "linkedsub"));
    const { base } = await start();
    const r = await into(base, join(world, "linkedsub", "r.md"), "pasted-x.png", pngBytes(4, 4));
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("leads outside");
    expect(existsSync(join(out, "images"))).toBe(false);
  });

  test("a JSON document takes no embed", async () => {
    const { base } = await start();
    const r = await into(base, join(world, "data.json"), "pasted-x.png", pngBytes(4, 4));
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("not a markdown document");
    expect(existsSync(join(world, "images"))).toBe(false);
  });

  test("an images name held by a file is refused rather than written around", async () => {
    const { base } = await start();
    writeFileSync(join(world, "images"), "a file, not a folder");
    const r = await into(base, join(world, "story.md"), "pasted-x.png", pngBytes(4, 4));
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("is not a folder");
  });
});

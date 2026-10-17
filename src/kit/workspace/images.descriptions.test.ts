// Image descriptions through the daemon (the kit-image-descriptions item): an
// image's sidecar (`fox.png.md`, an ordinary document of `type: image`) is read
// into the viewer's snapshot with its origin, found by search as its image,
// offered by the link picker on the image, carried by rename, move and Trash
// (undo bringing both back), kept on Replace, edited by the agent as a
// version, started by `describe-image`, and checked by a world's image profile.
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
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { ContextNode, LinkTarget, ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let bin: string;
let trashed: string[];
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

const FOX_MD = `---
type: image
title: The fox before the archway
description: A small fox at the edge of a forest, looking through an archway of trees.
source: web
url: https://commons.example.org/wiki/File:Fox.png
image-url: https://upload.example.org/fox.png
credit: A. Photographer
licence: unknown
fetched-at: 2026-10-04
---

Pixel art. A small fox, seen from behind, stands at the forest's edge; through
the archway the interior is bright, pale green and gold.
`;

const SPARK_MD = `---
type: image
title: A first try at the keeper
description: A tall figure in a grey cloak holding a lantern.
source: generated
provider: media-forge
model: flux-dev
prompt: a lighthouse keeper in a grey cloak, lantern raised
seed: 42
cost-usd: 0.03
generated-at: 2026-10-04
---

A tall figure in a grey cloak holds a lantern up against the dark.
`;

beforeEach(() => {
  root = tempRoot("workspace-image-descriptions");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "images"), { recursive: true });
  mkdirSync(join(world, "archive"), { recursive: true });
  writeFileSync(join(world, "story.md"), "# Story\n\nThe keeper waits.\n");
  writeFileSync(join(world, "images", "fox.png"), pngBytes(8, 8));
  writeFileSync(join(world, "images", "fox.png.md"), FOX_MD);
  writeFileSync(join(world, "images", "spark.png"), pngBytes(8, 8));
  writeFileSync(join(world, "images", "spark.png.md"), SPARK_MD);
  writeFileSync(join(world, "images", "plain.png"), pngBytes(8, 8));
  // A description whose image is gone: an ordinary document.
  writeFileSync(join(world, "ghost.png.md"), "---\ntype: image\ntitle: Ghost\n---\n\nA lantern.\n");
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
  return { base: daemon.url, s: surface, t: tail };
}

const nodesOf = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) => (n.kind === "group" ? [n, ...nodesOf(n.children)] : [n]));
const rels = (s: FakeSurface) => nodesOf(s.state.context[0]?.nodes ?? []).map((n) => n.rel);

const fox = () => join(world, "images", "fox.png");
const foxMd = () => join(world, "images", "fox.png.md");

describe("the viewer's description", () => {
  test("an image's sidecar rides on the open image: title, words, origin, provenance", async () => {
    const { s } = await start();
    s.send({ op: "open", path: fox() });
    await waitUntil("open", () => s.state.openImage?.path === fox());
    const d = s.state.openImage?.description;
    expect(d).toMatchObject({
      path: foxMd(),
      title: "The fox before the archway",
      summary: "A small fox at the edge of a forest, looking through an archway of trees.",
      source: "web",
      page: "https://commons.example.org/wiki/File:Fox.png",
      licenceUnknown: true,
    });
    expect(d?.body).toStartWith("Pixel art. A small fox");
    expect(d?.provenance.map((p) => p.field)).toEqual([
      "url",
      "image-url",
      "credit",
      "licence",
      "fetched-at",
    ]);
  });

  test("an origin the kit does not know is kept as written, with no fields; an image with no sidecar has none", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "images", "spark.png") });
    await waitUntil("open", () => s.state.openImage?.name === "spark.png");
    // Image generation's provenance is not the kit's: `generated` is shown as
    // written, and none of its fields are listed.
    expect(s.state.openImage?.description?.source).toBeNull();
    expect(s.state.openImage?.description?.sourceWritten).toBe("generated");
    expect(s.state.openImage?.description?.provenance).toEqual([]);
    expect(s.state.openImage?.description?.licenceUnknown).toBeUndefined();
    s.send({ op: "open", path: join(world, "images", "plain.png") });
    await waitUntil("plain", () => s.state.openImage?.name === "plain.png");
    expect(s.state.openImage?.description).toBeUndefined();
  });

  test("the sidecar stays a document node beside its image; an orphan is an ordinary document", async () => {
    const { s } = await start();
    expect(rels(s)).toContain("images/fox.png.md");
    expect(rels(s)).toContain("ghost.png.md");
    // The orphan opens as the document it is, and search finds it as one.
    s.send({ op: "open", path: join(world, "ghost.png.md") });
    await waitUntil("opened", () => s.state.docs.some((d) => d.name === "ghost.png.md"));
    const r = await cmd(daemon?.url as string, { op: "search", query: "lantern" });
    const hit = (r.body.results as { path: string; image?: string }[]).find(
      (x) => x.path === join(world, "ghost.png.md"),
    );
    expect(hit).toBeDefined();
    expect(hit?.image).toBeUndefined();
  });
});

describe("search and the link picker", () => {
  test("a word in a description is a hit on its image", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "search", query: "archway" });
    const hits = r.body.results as { kind: string; path: string; image?: string }[];
    const text = hits.find((h) => h.kind === "text");
    expect(text).toMatchObject({ path: foxMd(), image: fox() });
    // By name too: the image's own name finds its description, which names it.
    const named = await cmd(base, { op: "search", query: "spark" });
    expect((named.body.results as { image?: string }[])[0]?.image).toBe(
      join(world, "images", "spark.png"),
    );
  });

  test("the picker offers an image with its description, never its sidecar as a document", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "story.md") });
    await waitUntil("story", () => s.state.docs.some((d) => d.name === "story.md"));
    s.send({ op: "link.targets", doc: "story" });
    const said = (await s.waitFor((f) => f.op === "link.targets")) as unknown as {
      targets: LinkTarget[];
    };
    const byName = new Map(said.targets.map((t) => [t.name, t]));
    expect(byName.get("fox.png")?.description).toBe(
      "The fox before the archway: A small fox at the edge of a forest, looking through an archway of trees.",
    );
    expect(byName.has("fox.png.md")).toBe(false);
    expect(byName.get("plain.png")?.description).toBeUndefined();
    // An orphan is a document like any other, and is offered.
    expect(byName.has("ghost.png.md")).toBe(true);
  });
});

describe("rename, move and the Trash carry the sidecar", () => {
  test("a rename carries it, and undo brings both back", async () => {
    const { s, t } = await start();
    s.send({ op: "rename", path: fox(), name: "vixen" });
    const vixen = join(world, "images", "vixen.png");
    await waitUntil("renamed", () => existsSync(vixen));
    expect(existsSync(`${vixen}.md`)).toBe(true);
    expect(existsSync(foxMd())).toBe(false);
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "rename");
    expect(String(said.text)).toContain("with its description");
    expect(said.sidecar).toBe(`${vixen}.md`);
    await waitUntil("tree", () => rels(s).includes("images/vixen.png.md"));
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => existsSync(fox()));
    expect(existsSync(foxMd())).toBe(true);
    expect(existsSync(`${vixen}.md`)).toBe(false);
  });

  test("a move carries it, the open description follows, and undo brings both back", async () => {
    const { s } = await start();
    s.send({ op: "open", path: foxMd() });
    await waitUntil("held", () => s.state.docs.some((d) => d.name === "fox.png.md"));
    s.send({ op: "move", path: fox(), into: join(world, "archive") });
    const moved = join(world, "archive", "fox.png");
    await waitUntil("moved", () => existsSync(moved) && existsSync(`${moved}.md`));
    await waitUntil("followed", () =>
      s.state.docs.some((d) => d.original === `${moved}.md` && d.name === "fox.png.md"),
    );
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => existsSync(fox()) && existsSync(foxMd()));
    expect(existsSync(`${moved}.md`)).toBe(false);
  });

  test("the agent's rename and move carry it too", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "rename", path: fox(), name: "vixen.png" });
    expect(r.status).toBe(200);
    const vixen = join(world, "images", "vixen.png");
    expect(existsSync(`${vixen}.md`)).toBe(true);
    const m = await cmd(base, { op: "move", path: vixen, into: join(world, "archive") });
    expect(m.status).toBe(200);
    expect(existsSync(join(world, "archive", "vixen.png.md"))).toBe(true);
    expect(readFileSync(join(world, "archive", "vixen.png.md"), "utf8")).toBe(FOX_MD);
  });

  test("a sidecar name already taken refuses the whole rename, and nothing moves", async () => {
    const { base } = await start();
    writeFileSync(join(world, "images", "vixen.png.md"), "someone else's\n");
    const r = await cmd(base, { op: "rename", path: fox(), name: "vixen.png" });
    expect(r.status).toBe(409);
    expect(existsSync(fox())).toBe(true);
    expect(existsSync(foxMd())).toBe(true);
    expect(existsSync(join(world, "images", "vixen.png"))).toBe(false);
  });

  test("the Trash preview names the description, and both go", async () => {
    const { s, t } = await start();
    s.send({ op: "trash.preview", path: fox() });
    const pre = (await s.waitFor((f) => f.op === "trash.preview")) as unknown as {
      files: number;
      sidecar?: string;
    };
    expect(pre.sidecar).toBe(foxMd());
    expect(pre.files).toBe(2);
    s.send({ op: "trash", path: fox() });
    await s.waitFor((f) => f.op === "trash.done");
    expect(trashed).toEqual([fox(), foxMd()]);
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "trash");
    expect(String(said.text)).toContain("and its description");
    await waitUntil("gone from the tree", () => !rels(s).includes("images/fox.png.md"));
  });

  test("Replace keeps the description, and says to check it still fits", async () => {
    const { base, t } = await start();
    const res = await fetch(
      `${base}/fs/image?${new URLSearchParams({ name: "fox.png", dir: join(world, "images"), onTaken: "replace" })}`,
      { method: "POST", body: pngBytes(16, 16) },
    );
    expect(await res.json()).toEqual({
      ok: true,
      path: fox(),
      replaced: true,
      sidecarKept: true,
    });
    expect(trashed).toEqual([fox()]);
    expect(readFileSync(foxMd(), "utf8")).toBe(FOX_MD);
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "image.replace");
    expect(String(said.text)).toContain("was kept: check that it still fits");
  });
});

describe("the agent writes descriptions", () => {
  test("an existing description is edited as a version, and the viewer shows it once active", async () => {
    const { base, s } = await start();
    const v = await cmd(base, { op: "version.new", doc: foxMd(), label: "closer look" });
    expect(v.status).toBe(200);
    const path = v.body.path as string;
    writeFileSync(path, FOX_MD.replace("The fox before the archway", "The fox at the threshold"));
    s.send({ op: "open", path: fox() });
    await waitUntil("open", () => s.state.openImage?.path === fox());
    // Still the human's choice: the active version says what it said.
    expect(s.state.openImage?.description?.title).toBe("The fox before the archway");
    s.send({ op: "activate", doc: v.body.doc as string, version: v.body.version as number });
    s.send({ op: "open", path: fox() });
    await waitUntil(
      "shows the new words",
      () => s.state.openImage?.description?.title === "The fox at the threshold",
    );
  });

  test("describe-image writes the skeleton beside the image and a version to write into", async () => {
    const { base, s, t } = await start();
    const plain = join(world, "images", "plain.png");
    const r = await cmd(base, { op: "image.describe", image: plain, source: "web" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ image: plain, sidecar: `${plain}.md`, version: 2, from: 1 });
    const skeleton = readFileSync(`${plain}.md`, "utf8");
    expect(skeleton).toContain("type: image\n");
    expect(skeleton).toContain("source: web\n");
    expect(skeleton).toContain('licence: "unknown"\n');
    expect(readFileSync(r.body.path as string, "utf8")).toBe(skeleton);
    await t.waitFor((e) => e.type === "system" && e.fact === "image.describe");
    await waitUntil("in the tree", () => rels(s).includes("images/plain.png.md"));
    // Undone like any creation: it asks first, because it deletes.
    expect(s.state.history.undoDeletes).toEqual({ path: `${plain}.md`, dir: false });
  });

  test("describe-image refuses an image that already has one, and a path that is no image", async () => {
    const { base } = await start();
    const again = await cmd(base, { op: "image.describe", image: fox() });
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toContain("version-new --doc");
    const notImage = await cmd(base, { op: "image.describe", image: join(world, "story.md") });
    expect(notImage.status).toBe(400);
    const bad = await cmd(base, { op: "image.describe", image: fox(), source: "dream" });
    expect(bad.status).toBe(400);
  });

  test("a message about an image points at the image itself", async () => {
    const { s } = await start();
    s.send({
      op: "say",
      text: "Please describe it",
      withSelection: false,
      about: { path: join(world, "images", "plain.png") },
    });
    await waitUntil("said", () => s.state.chat.some((m) => m.text === "Please describe it"));
    const m = s.state.chat.find((x) => x.text === "Please describe it");
    // The image is the subject, whatever document is open.
    expect(m?.about).toEqual({ path: join(world, "images", "plain.png") });
  });
});

describe("a loose image", () => {
  test("added by path, it brings its description; describe-image lists a new one beside it", async () => {
    const { base, s } = await start();
    const loose = join(root, "loose");
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(loose, "moth.png"), pngBytes(4, 4));
    writeFileSync(join(loose, "moth.png.md"), "---\ntype: image\ntitle: A moth\n---\n");
    writeFileSync(join(loose, "owl.png"), pngBytes(4, 4));
    await cmd(base, {
      op: "context.add",
      paths: [join(loose, "moth.png"), join(loose, "owl.png")],
    });
    await waitUntil("listed", () => s.state.context.length === 4);
    const listed = s.state.context.map((e) => e.nodes[0]?.rel);
    expect(listed).toContain("moth.png.md");
    s.send({ op: "open", path: join(loose, "moth.png") });
    await waitUntil("described", () => s.state.openImage?.description?.title === "A moth");
    const r = await cmd(base, { op: "image.describe", image: join(loose, "owl.png") });
    expect(r.status).toBe(200);
    await waitUntil("owl's listed", () =>
      s.state.context.some((e) => e.nodes[0]?.rel === "owl.png.md"),
    );
  });
});

describe("what is a description, and what is carried", () => {
  test("a document only named like one (type: location) is not folded, carried or trashed", async () => {
    writeFileSync(join(world, "images", "loc.png"), pngBytes(4, 4));
    const loc = join(world, "images", "loc.png.md");
    writeFileSync(loc, "---\ntype: location\ntitle: The ruin\n---\n\nA place.\n");
    const { base, s } = await start();
    const node = (rel: string) =>
      nodesOf(s.state.context[0]?.nodes ?? []).find((n) => n.rel === rel) as
        | { sidecar?: true }
        | undefined;
    expect(node("images/loc.png.md")).toBeDefined();
    expect(node("images/loc.png.md")?.sidecar).toBeUndefined();
    expect(node("images/fox.png.md")?.sidecar).toBe(true);
    s.send({ op: "open", path: join(world, "images", "loc.png") });
    await waitUntil("open", () => s.state.openImage?.name === "loc.png");
    expect(s.state.openImage?.description).toBeUndefined();
    // Renaming the image leaves the document where it is.
    const r = await cmd(base, {
      op: "rename",
      path: join(world, "images", "loc.png"),
      name: "ruin",
    });
    expect(r.status).toBe(200);
    expect(existsSync(loc)).toBe(true);
    expect(existsSync(join(world, "images", "ruin.png.md"))).toBe(false);
    // And the Trash takes only the image.
    s.send({ op: "trash.preview", path: join(world, "images", "ruin.png") });
    const pre = (await s.waitFor((f) => f.op === "trash.preview")) as unknown as {
      sidecar?: string;
    };
    expect(pre.sidecar).toBeUndefined();
    s.send({ op: "trash", path: join(world, "images", "ruin.png") });
    await s.waitFor((f) => f.op === "trash.done");
    expect(trashed).toEqual([join(world, "images", "ruin.png")]);
    expect(existsSync(loc)).toBe(true);
  });

  test("a description cased otherwise than its image is not folded or carried", async () => {
    writeFileSync(join(world, "images", "CASE.PNG"), pngBytes(4, 4));
    const lower = join(world, "images", "case.png.md");
    writeFileSync(lower, "---\ntype: image\ntitle: Lower\n---\n");
    const { base, s } = await start();
    const node = nodesOf(s.state.context[0]?.nodes ?? []).find(
      (n) => n.rel === "images/case.png.md",
    ) as { sidecar?: true } | undefined;
    expect(node?.sidecar).toBeUndefined();
    const r = await cmd(base, {
      op: "rename",
      path: join(world, "images", "CASE.PNG"),
      name: "other.png",
    });
    expect(r.status).toBe(200);
    expect(readdirSync(join(world, "images"))).toContain("case.png.md");
    expect(readdirSync(join(world, "images"))).not.toContain("other.png.md");
  });

  test("the agent cannot rename or move a description away from its image", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "rename", path: foxMd(), name: "notes.md" });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("fox.png's description: rename the image instead");
    const m = await cmd(base, { op: "move", path: foxMd(), into: join(world, "archive") });
    expect(m.status).toBe(409);
    expect(String(m.body.error)).toContain("move the image instead");
    expect(existsSync(foxMd())).toBe(true);
    // An orphan is an ordinary document, and renames as one.
    const o = await cmd(base, {
      op: "rename",
      path: join(world, "ghost.png.md"),
      name: "ghost.md",
    });
    expect(o.body).toMatchObject({ ok: true });
  });

  test("the Trash names a loose image's description as the list does, with its comma", async () => {
    const { base, s, t } = await start();
    const loose = join(root, "loose");
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(loose, "moth.png"), pngBytes(4, 4));
    writeFileSync(join(loose, "moth.png.md"), "---\ntype: image\ntitle: A moth\n---\n");
    await cmd(base, { op: "context.add", paths: [join(loose, "moth.png")] });
    await waitUntil("listed", () => s.state.context.length === 3);
    s.send({ op: "trash", path: join(loose, "moth.png") });
    await s.waitFor((f) => f.op === "trash.done");
    const said = await t.waitFor((e) => e.type === "system" && e.fact === "trash");
    expect(said.text).toBe("You moved moth.png and its description, moth.png.md, to the Trash.");
  });
});

describe("describe-image, undone and refused", () => {
  test("undo sends an untouched skeleton to the Trash; a written one is refused and kept", async () => {
    const { base, s } = await start();
    const plain = join(world, "images", "plain.png");
    await cmd(base, { op: "image.describe", image: plain });
    await waitUntil("listed", () => rels(s).includes("images/plain.png.md"));
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("trashed", () => trashed.includes(`${plain}.md`));
    expect(existsSync(`${plain}.md`)).toBe(false);
    expect(readdirSync(bin).some((n) => n.endsWith("plain.png.md"))).toBe(true);

    // Again, and this time the description is written before the undo.
    await cmd(base, { op: "image.describe", image: plain });
    await waitUntil("listed again", () => rels(s).includes("images/plain.png.md"));
    writeFileSync(`${plain}.md`, "---\ntype: image\ntitle: A lantern\n---\n\nA brass lantern.\n");
    s.send({ op: "history.undo", confirmDelete: true });
    const refused = (await s.waitFor((f) => f.op === "error")) as unknown as { message: string };
    expect(refused.message).toContain("has been written into since it was started");
    expect(readFileSync(`${plain}.md`, "utf8")).toContain("A brass lantern.");
    expect(trashed.filter((p) => p === `${plain}.md`)).toHaveLength(1);
  });

  test("a dangling link where the description would go is refused like one already there", async () => {
    const { base } = await start();
    const plain = join(world, "images", "plain.png");
    symlinkSync(join(root, "nowhere.md"), `${plain}.md`);
    const r = await cmd(base, { op: "image.describe", image: plain });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("already has a description");
  });

  test("a message cannot point at an image that is a link out of its set", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.png"), pngBytes(4, 4));
    symlinkSync(join(outside, "secret.png"), join(world, "images", "escape.png"));
    const { s } = await start();
    s.send({
      op: "say",
      text: "Look at this",
      withSelection: false,
      about: {
        path: join(world, "images", "escape.png"),
        refs: [
          { path: join(world, "images", "escape.png") },
          { path: join(world, "images", "plain.png") },
        ],
      },
    });
    await waitUntil("said", () => s.state.chat.some((m) => m.text === "Look at this"));
    const m = s.state.chat.find((x) => x.text === "Look at this");
    // Neither as the subject nor as a ref.
    expect(m?.about).toEqual({ refs: [{ path: join(world, "images", "plain.png") }] });
  });
});

describe("profiles", () => {
  test("a world's image profile checks a sidecar like any kind", async () => {
    mkdirSync(join(world, "_meta", "profiles"), { recursive: true });
    writeFileSync(
      join(world, "_meta", "profiles", "image.json"),
      JSON.stringify({
        kind: "image",
        title: "Image",
        type: "object",
        properties: { credit: { type: "string", minLength: 1 } },
        required: ["type", "title", "description", "credit"],
      }),
    );
    const { s } = await start();
    s.send({ op: "open", path: join(world, "images", "spark.png.md") });
    await waitUntil("held", () => s.state.docs.some((d) => d.name === "spark.png.md"));
    s.send({ op: "profile", doc: join(world, "images", "spark.png.md") });
    const r = (await s.waitFor((f) => f.op === "profile")) as Extract<ServerOp, { op: "profile" }>;
    expect(r).toMatchObject({ match: "matched", type: "image", kind: "image" });
    expect(r.warnings.map((w) => [w.field, w.rule])).toEqual([["credit", "required"]]);
  });
});

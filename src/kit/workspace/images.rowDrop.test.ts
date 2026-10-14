// A sidebar row dropped onto a document (kit-tree-drag-into-document): the
// daemon says what each row writes. An image the document's own set holds is
// embedded relative to the document, encoded as the link picker writes it, its
// sidecar title (else its file name) as the alt. An image in another set is
// refused in words. A document is linked by its title (the user's choice,
// 2026-10-06); a folder, a sidecar and the document itself write nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { DroppedLink } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let other: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-row-drop");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  other = join(root, "other");
  mkdirSync(join(world, "places", "images"), { recursive: true });
  mkdirSync(join(world, "art"), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(world, "places", "glade.md"), "# The glade\n\nA clearing.\n");
  writeFileSync(join(world, "gate.md"), "# The gate\n");
  writeFileSync(join(world, "lore.md"), "---\ntitle: Lore of the wood\n---\n\n# Ignored heading\n");
  writeFileSync(join(world, "notes.md"), "No title and no heading.\n");
  writeFileSync(join(world, "the old (mill).md"), "# The mill [old]\n");
  writeFileSync(join(other, "far.md"), "# Far\n");
  writeFileSync(join(world, "multi.md"), "---\ntitle: |\n  Line one\n\n  # Line two\n---\n");
  // Beside the document, below it, above it, and one whose name needs encoding.
  writeFileSync(join(world, "places", "fox.png"), pngBytes(4, 4));
  writeFileSync(join(world, "places", "images", "moon.png"), pngBytes(4, 4));
  writeFileSync(join(world, "map.png"), pngBytes(4, 4));
  writeFileSync(join(world, "art", "the old (mill) #2.png"), pngBytes(4, 4));
  writeFileSync(
    join(world, "places", "fox.png.md"),
    "---\ntype: image\ntitle: The fox [before] the archway\n---\n\nA fox.\n",
  );
  writeFileSync(join(other, "stray.png"), pngBytes(4, 4));
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
  await cmd(daemon.url, { op: "context.add", paths: [world, other] });
  await waitUntil("context", () => surface?.state.context.length === 2);
  const s = surface;
  s.send({ op: "open", path: join(world, "places", "glade.md") });
  await waitUntil("the document", () => s.state.openDoc === "glade");
  return s;
}

async function drop(s: FakeSurface, paths: string[]): Promise<DroppedLink[]> {
  s.send({ op: "link.drop", doc: "glade", paths });
  const said = (await s.waitFor((f) => f.op === "link.drop")) as unknown as {
    links: DroppedLink[];
  };
  return said.links;
}

describe("a sidebar row dropped onto a document", () => {
  test("an image is written relative to the document, beside, below and above it", async () => {
    const s = await start();
    const links = await drop(s, [
      join(world, "places", "images", "moon.png"),
      join(world, "map.png"),
      join(world, "places", "fox.png"),
    ]);
    expect(links).toEqual([
      {
        path: join(world, "places", "images", "moon.png"),
        image: true,
        href: "./images/moon.png",
        text: "moon",
      },
      { path: join(world, "map.png"), image: true, href: "../map.png", text: "map" },
      // Its sidecar's title is the alt.
      {
        path: join(world, "places", "fox.png"),
        image: true,
        href: "./fox.png",
        text: "The fox [before] the archway",
      },
    ]);
  });

  test("a name that needs it is percent-encoded", async () => {
    const s = await start();
    const [link] = await drop(s, [join(world, "art", "the old (mill) #2.png")]);
    expect(link).toEqual({
      path: join(world, "art", "the old (mill) #2.png"),
      image: true,
      href: "../art/the%20old%20%28mill%29%20%232.png",
      text: "the old (mill) #2",
    });
  });

  test("an image in another set is refused in words, never linked by a path out of the set", async () => {
    const s = await start();
    const links = await drop(s, [join(other, "stray.png")]);
    expect(links).toHaveLength(1);
    const [only] = links;
    expect(only && "refused" in only ? only.refused : "").toContain("stray.png");
    expect(only && "href" in only).toBe(false);
  });

  test("a document is linked relative to the document, its title as the text", async () => {
    const s = await start();
    const links = await drop(s, [
      join(world, "gate.md"),
      join(world, "lore.md"),
      join(world, "notes.md"),
      join(world, "the old (mill).md"),
    ]);
    expect(links).toEqual([
      // The first heading, when there is no frontmatter title.
      { path: join(world, "gate.md"), image: false, href: "../gate.md", text: "The gate" },
      // The frontmatter title wins over a heading.
      { path: join(world, "lore.md"), image: false, href: "../lore.md", text: "Lore of the wood" },
      // Neither: the file name.
      { path: join(world, "notes.md"), image: false, href: "../notes.md", text: "notes" },
      {
        path: join(world, "the old (mill).md"),
        image: false,
        href: "../the%20old%20%28mill%29.md",
        text: "The mill [old]",
      },
    ]);
  });

  test("a title over several lines is written on one line, so it cannot split the link", async () => {
    const s = await start();
    const [link] = await drop(s, [join(world, "multi.md")]);
    expect(link).toEqual({
      path: join(world, "multi.md"),
      image: false,
      href: "../multi.md",
      text: "Line one # Line two",
    });
  });

  test("a document's title is read from its active version, unsaved edits included", async () => {
    const s = await start();
    s.send({ op: "open", path: join(world, "gate.md") });
    await waitUntil("gate open", () => s.state.openDoc === "gate");
    s.send({ op: "edit", doc: "gate", version: 1, text: "# The new gate\n" });
    await waitUntil("the edit", () =>
      s.frames.some((f) => f.op === "state" || f.op === "version.text"),
    );
    s.send({ op: "open", path: join(world, "places", "glade.md") });
    await waitUntil("glade open", () => s.state.openDoc === "glade");
    const [link] = await drop(s, [join(world, "gate.md")]);
    expect(link && "text" in link ? link.text : "").toBe("The new gate");
  });

  test("a document in another set is refused in words", async () => {
    const s = await start();
    const links = await drop(s, [join(other, "far.md")]);
    expect(links).toHaveLength(1);
    const [only] = links;
    expect(only && "refused" in only ? only.refused : "").toContain("far.md");
  });

  test("a folder, an image's description and the document itself write nothing", async () => {
    const s = await start();
    const links = await drop(s, [
      join(world, "places"),
      join(world, "places", "fox.png.md"),
      join(world, "places", "glade.md"),
    ]);
    expect(links).toEqual([]);
  });
});

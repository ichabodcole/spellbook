// Expandable bundles through the daemon, at the wire: a held document in a
// member folder changed on disk is reloaded as any document is AND reported
// as a change to its bundle; a file dropped into the type's own folder is
// refused over the socket; and `--doc <bundle folder>/` reaches the main
// file's document through `POST /cmd`. No test here touches the real Trash.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import type { ContextNode, ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { SHELF_BUNDLE, tempRoot, writeShelf } from "./testing";

let root: string;
let set: string;
let shelf: string;
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;
let tail: ReturnType<typeof collectEvents> | null = null;

beforeAll(() => registerBundleType(SHELF_BUNDLE));
afterAll(() => unregisterBundleType(SHELF_BUNDLE.extension));

beforeEach(() => {
  root = tempRoot("workspace-bundles-expand-daemon");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "set");
  mkdirSync(set, { recursive: true });
  shelf = writeShelf(set, "The lighthouse");
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
    trash: async () => {
      throw new Error("no Trash in this test");
    },
  });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: set });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { s: surface, t: tail, url: daemon.url };
}

const flat = (nodes: readonly ContextNode[]): ContextNode[] =>
  nodes.flatMap((n) =>
    n.kind === "group"
      ? [n, ...flat(n.children)]
      : n.kind === "bundle" && n.contents
        ? [n, ...flat(n.contents)]
        : [n],
  );
const rowsOf = (s: FakeSurface) => flat(s.state.context[0]?.nodes ?? []);
const R = "The lighthouse.shelfbundle";

describe("a member's document, watched", () => {
  test("changed on disk, it is reloaded as a document and reported as a change to its bundle", async () => {
    const { s, t } = await start();
    const file = join(shelf, "docs", "01-arrival.md");
    s.send({ op: "open", path: file });
    await waitUntil("open", () => s.state.openDoc === "01-arrival");
    const text = "# Arrival\n\nThe boat came in at noon.\n";
    // The daemon's answer, not a mirror: the reload's text, then the bundle's frame.
    await writeUntilSeen(
      "the reload",
      () => writeFileSync(file, text),
      () =>
        s.frames.find((m) => m.op === "version.text" && m.doc === "01-arrival" && m.text === text),
    );
    const changed = await s.waitFor((m) => m.op === "bundle.changed" && m.file === file);
    expect(changed).toEqual({ op: "bundle.changed", path: shelf, file });
    await t.waitFor((e) => e.type === "system" && e.fact === "original.reloaded");
  });

  test("a document made in a member folder by another program reaches the tree", async () => {
    const { s } = await start();
    const file = join(shelf, "docs", "03-the-light.md");
    await writeUntilSeen(
      "the new row",
      () => writeFileSync(file, "# The light\n"),
      () => rowsOf(s).some((n) => n.rel === `${R}/docs/03-the-light.md`),
    );
    expect(rowsOf(s).find((n) => n.rel === `${R}/docs/03-the-light.md`)?.kind).toBe("doc");
  });
});

describe("writing inside, over the socket", () => {
  test("a document dropped into a member folder lands; one dropped into the type's own folder is refused", async () => {
    const { s } = await start();
    const at = s.frames.length;
    s.send({ op: "import", name: "04-coda.md", text: "# Coda\n", dir: join(shelf, "docs") });
    await s.waitFor(
      (m) => m.op === "structure.done" && m.of === "import" && s.frames.indexOf(m) >= at,
    );
    expect(existsSync(join(shelf, "docs", "04-coda.md"))).toBe(true);
    await waitUntil("the row", () => rowsOf(s).some((n) => n.rel === `${R}/docs/04-coda.md`));

    const errAt = s.frames.length;
    s.send({ op: "import", name: "stray.md", text: "# Stray\n", dir: join(shelf, "audio") });
    const err = (await s.waitFor(
      (m) => m.op === "error" && s.frames.indexOf(m) >= errAt,
    )) as Extract<ServerOp, { op: "error" }>;
    expect(err.message).toContain("only its docs/ folder can be written into from here");
    expect(existsSync(join(shelf, "audio", "stray.md"))).toBe(false);
  });
});

describe("--doc names a bundle by its folder, at the wire", () => {
  test("version-new and note-add take the folder, with a trailing slash too", async () => {
    const { s, url } = await start();
    s.send({ op: "open", path: shelf });
    await waitUntil("open", () => s.state.openDoc === "the-lighthouse");
    const made = await cmd(url, { op: "version.new", doc: `${shelf}/` });
    expect(made.status).toBe(200);
    expect(made.body.doc ?? made.body.slug).toBe("the-lighthouse");
    const noted = await cmd(url, {
      op: "note.add",
      doc: shelf,
      body: "the order",
      quote: "order",
    });
    expect(noted.status).toBe(200);
  });

  test("the agent opens a bundle not yet held by its folder", async () => {
    const { url } = await start();
    const made = await cmd(url, { op: "version.new", doc: `${shelf}/` });
    expect(made.status).toBe(200);
    const st = (await (await fetch(`${url}/state`)).json()) as {
      docs: { slug: string; original: string }[];
    };
    expect(st.docs.find((d) => d.slug === "the-lighthouse")?.original).toBe(
      join(shelf, "shelf.json"),
    );
  });
});

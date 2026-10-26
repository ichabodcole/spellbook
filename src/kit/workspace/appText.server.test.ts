// An app that holds an open document's text itself (Atlas's live board) and
// writes it back: `ctx.edit` is the editor's own path, `hooks.beforeKitAct`
// lets it write what is pending before any kit act reads the file, and
// `hooks.beforeClose` before the daemon closes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-app-text");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  mkdirSync(join(root, "tmp"), { recursive: true });
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(hooks: Parameters<typeof fixtureDaemon>[0]) {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: root, drainGraceMs: 10, ...hooks });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  const path = join(docs, "solo.md");
  surface.send({ op: "context.add", path });
  surface.send({ op: "open", path });
  await surface.waitFor((f) => f.op === "version.text");
  const state = await surface.waitFor((f) => f.op === "state" && f.state.docs.length === 1);
  const slug = (state as { state: { docs: { slug: string }[] } }).state.docs[0]?.slug as string;
  return { d: daemon, s: surface, slug, path };
}

test("ctx.edit writes the active version as the editor does, keeping an outside write", async () => {
  const { d, slug } = await start({});
  const tail = collectEvents(d.url);
  d.context.edit(slug, 1, "# Solo\n\nmine\n");
  const active = d.session.activePath(slug) as string;
  expect(readFileSync(active, "utf8")).toBe("# Solo\n\nmine\n");
  expect(d.session.doc(slug).dirty).toBe(true);
  // Someone else writes the active version; the next edit keeps it as a version first.
  writeFileSync(active, "# Solo\n\ntheirs\n");
  d.context.edit(slug, 1, "# Solo\n\nmine again\n");
  expect(readFileSync(active, "utf8")).toBe("# Solo\n\nmine again\n");
  const made = await tail.waitFor((e) => e.type === "version.created" && e.preserved === true);
  expect(readFileSync(made.path as string, "utf8")).toBe("# Solo\n\ntheirs\n");
  await tail.stop();
});

test("beforeKitAct runs before a kit op, so what it writes is what Save saves", async () => {
  const seen: string[] = [];
  let held: string | null = null;
  const { d, s, slug, path } = await start({
    hooks: {
      beforeKitAct: (op, ctx) => {
        seen.push(op);
        if (held === null) return;
        ctx.edit(slug, 1, held);
        held = null;
      },
    },
  });
  held = "# Solo\n\nheld in memory\n";
  s.send({ op: "save", doc: slug });
  await waitUntil("the save", () => readFileSync(path, "utf8") === "# Solo\n\nheld in memory\n");
  expect(seen).toContain("save");
  // From the agent's `/cmd` too: a new version copies the active one as held.
  held = "# Solo\n\nagain\n";
  const r = await fetch(`${d.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "version.new", doc: slug }),
  });
  const body = (await r.json()) as { path: string };
  expect(r.status).toBe(200);
  expect(readFileSync(body.path, "utf8")).toBe("# Solo\n\nagain\n");
  expect(seen).toContain("version.new");
});

test("beforeClose runs as the daemon stops, while the session still takes a write", async () => {
  let slug = "";
  const { d, slug: s0 } = await start({
    hooks: { beforeClose: (ctx) => ctx.edit(slug, 1, "# Solo\n\nlast words\n") },
  });
  slug = s0;
  const active = d.session.activePath(slug) as string;
  await d.stop();
  daemon = null;
  expect(readFileSync(active, "utf8")).toBe("# Solo\n\nlast words\n");
});

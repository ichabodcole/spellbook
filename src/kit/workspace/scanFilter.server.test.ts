// The scan filter in a running daemon: an app verb that changes what the
// filter reads and calls `refilter`, and the watcher's rescan of an outside
// change going through the same filter.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureApp, fixtureDaemon } from "./fixtures/app";
import type { ContextNode } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let daemon: WorkspaceDaemon | null;

beforeEach(() => {
  root = tempRoot("scan-filter-server");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(join(world, "drafts"), { recursive: true });
  writeFileSync(join(world, "a.md"), "# A\n");
  writeFileSync(join(world, "drafts", "rough.md"), "# Rough\n");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  daemon = null;
});
afterEach(async () => {
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Write `file` until the tree shows `rel`: a watcher armed a moment ago on
 * macOS can miss the first event, so the write is repeated, never the wait
 * lengthened alone.
 */
async function writeUntilShown(file: string, rel: string, tree: () => string[]) {
  for (let i = 0; i < 100; i++) {
    writeFileSync(file, `# ${i}\n`);
    for (let j = 0; j < 10; j++) {
      if (tree().includes(rel)) return;
      await Bun.sleep(10);
    }
  }
  throw new Error(`the watcher never rescanned ${rel}; the tree is ${tree().join(", ")}`);
}

const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => [n.rel, ...(n.kind === "group" ? rels(n.children) : [])]);

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: join(root, "ws"),
    app: {
      ...fixtureApp,
      scan: ({ slot }) => {
        const skipped = (slot.skipped as string[] | undefined) ?? [];
        return skipped.length ? { skip: (rel) => skipped.includes(rel) } : undefined;
      },
    },
    verbs: {
      "kit-fixture.adopt": (ctx, args) => {
        const { entry } = ctx.session.addContext(String(args.path));
        ctx.broadcast();
        return { entry: entry.id };
      },
      "kit-fixture.skip": (ctx, args) => {
        ctx.session.updateApp((slot) => {
          slot.skipped = args.rels;
        });
        ctx.session.refilter();
        ctx.broadcast();
        return {};
      },
    },
  });
  await daemon.start();
  const d = daemon;
  const cmd = async (body: Record<string, unknown>) => {
    const r = await fetch(`${d.url}/cmd`, { method: "POST", body: JSON.stringify(body) });
    expect(r.status).toBe(200);
    return (await r.json()) as Record<string, unknown>;
  };
  const tree = () => rels(d.session.context[0]?.nodes ?? []);
  return { d, cmd, tree };
}

test("the watcher's rescan goes through the filter", async () => {
  const { cmd, tree } = await start();
  await cmd({ op: "kit-fixture.adopt", path: world });
  await cmd({ op: "kit-fixture.skip", rels: ["drafts"] });
  expect(tree()).toEqual(["a.md"]);
  writeFileSync(join(world, "drafts", "new.md"), "# New\n");
  await writeUntilShown(join(world, "fresh.md"), "fresh.md", tree);
  expect(tree()).toEqual(["a.md", "fresh.md"]);
  await cmd({ op: "kit-fixture.skip", rels: [] });
  expect(tree()).toContain("drafts/new.md");
});

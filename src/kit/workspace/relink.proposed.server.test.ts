// A move's relink rewrites only a document's ACTIVE version (Cole's ruling,
// 2026-10-22: reported, not rewritten). A version the agent proposed and the
// human never had active keeps the old target; `link-check` names it in
// `proposed`, with the document, the version, the line, the target as written,
// where the target went when a move explains it (`suggest`), and the act that
// fixes it (kit-relink-misses-proposed-versions). A version the human has had
// active is history, never reported.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, writeUntilSeen } from "./fixtures/harness";
import type { LinkCheck } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let set: string;
let daemon: WorkspaceDaemon | null;

const KEEPER = "# Keeper\n\nLives by [the Glade](./places/glade.md).\n\nSee [the gap](./gap.md).\n";
// The agent's proposal: the same links, a link labelled the same before the
// moved one (to a page never written), and a paragraph more.
const PROPOSED = [
  "# Keeper",
  "",
  "Once by [the Glade](./nowhere.md).",
  "",
  "Lives by [the Glade](./places/glade.md).",
  "",
  "See [the gap](./gap.md).",
  "",
].join("\n");

beforeEach(() => {
  root = tempRoot("workspace-relink-proposed");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "world");
  mkdirSync(join(set, "places"), { recursive: true });
  mkdirSync(join(set, "wilds"), { recursive: true });
  mkdirSync(join(set, "deep"), { recursive: true });
  writeFileSync(join(set, "places", "glade.md"), "# The Glade\n");
  writeFileSync(join(set, "keeper.md"), KEEPER);
  daemon = null;
});
afterEach(async () => {
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

const at = (rel: string) => join(set, rel);

async function start() {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  daemon = fixtureDaemon({ tmp, workspace: root, platform: "darwin" });
  await daemon.start();
  const base = daemon.url;
  expect((await cmd(base, { op: "context.add", paths: [set] })).status).toBe(200);
  return base;
}

const check = async (base: string) => {
  const r = await cmd(base, { op: "link.check" });
  expect(r.status).toBe(200);
  return r.body as unknown as LinkCheck;
};

const ok = async (base: string, body: { op: string; [key: string]: unknown }) => {
  const r = await cmd(base, body);
  expect([body.op, r.status]).toEqual([body.op, 200]);
  return r.body;
};

const propose = async (base: string, body: string) => {
  const made = await ok(base, { op: "version.new", doc: at("keeper.md"), body });
  return { slug: String(made.doc), version: Number(made.version), path: String(made.path) };
};

const moveGlade = (base: string) =>
  ok(base, { op: "move", path: at("places/glade.md"), into: at("wilds"), updateLinks: true });

const rows = (c: LinkCheck) =>
  (c.proposed?.links ?? []).map((l) => [l.version, l.line, l.raw, l.suggest ?? null]);

describe("a proposal a move left behind", () => {
  test("is reported with where its target went, and relink leaves it as written", async () => {
    const base = await start();
    const v2 = await propose(base, PROPOSED);
    // Proposed, not activated: the human still edits v1.
    expect(v2.version).toBe(2);
    // Before the move: the never-written page is broken in the proposal only;
    // the gap is broken in v1 too, and said there once.
    const before = await check(base);
    expect(rows(before)).toEqual([[2, 3, "./nowhere.md", null]]);
    expect(before.dangling.links.map((l) => l.raw)).toEqual(["./gap.md"]);

    await moveGlade(base);
    // The active version (v1) followed the move.
    expect(readFileSync(at("keeper.md"), "utf8")).toContain("](./wilds/glade.md)");

    const c = await check(base);
    expect(c.dangling.links.map((l) => l.raw)).toEqual(["./gap.md"]);
    // The same-labelled link before the moved one gets no `suggest`: no move
    // explains it. The moved one gets where its target went.
    expect(rows(c)).toEqual([
      [2, 3, "./nowhere.md", null],
      [2, 5, "./places/glade.md", "./wilds/glade.md"],
    ]);
    const moved = c.proposed?.links[1];
    expect(moved?.doc).toBe(v2.slug);
    expect(moved && PROPOSED.slice(moved.from, moved.to)).toBe("[the Glade](./places/glade.md)");
    expect(moved?.act).toContain(`version-new --doc ${v2.slug} --from v2 --stdin`);
    expect(moved?.act).toContain(`version-delete v2 --doc ${v2.slug}`);
    expect(moved?.act).toContain("moved to `./wilds/glade.md`");
    expect(c.proposed?.links[0]?.act).toContain("which is missing");
    // Two broken links in v2, one fix: each act names the whole of it, so
    // following the first does not leave the second naming a deleted version.
    for (const l of c.proposed?.links ?? []) {
      expect(l.act).toContain("one of 2 broken links in v2");
      expect(l.act).toContain("Fix all 2 of its broken links in ONE new version");
    }
    // Counted: activated, each is a broken link. And in its set's whole.
    expect(c.count).toBe(1 + 2);
    expect(c.sets?.[0]?.total).toBe(3);
    // Relink rewrote the active version only: v2 is as the agent wrote it.
    expect(readFileSync(v2.path, "utf8")).toBe(PROPOSED);

    // The edge filter that keeps no body links keeps none of these either.
    const edgeOnly = await cmd(base, { op: "link.check", edge: ["frontmatter"] });
    expect((edgeOnly.body as unknown as LinkCheck).proposed?.count).toBe(0);

    // Doctor says so too, with the verb that lists them.
    const doctor = await ok(base, { op: "doctor" });
    const finding = (doctor.findings as { kind: string; count?: number; fix: string }[]).find(
      (f) => f.kind === "links.proposed",
    );
    expect(finding?.count).toBe(2);
    expect(finding?.fix).toContain("version-delete vN");
  });

  test("running the act clears it: the fixed proposal is not reported, the old one is gone", async () => {
    const base = await start();
    const v2 = await propose(base, PROPOSED);
    await moveGlade(base);
    expect((await check(base)).proposed?.count).toBe(2);
    // The act, as it says: propose v2 again with the links fixed, then delete v2.
    const fixed = PROPOSED.replace("./places/glade.md", "./wilds/glade.md").replace(
      "./nowhere.md",
      "./wilds/glade.md",
    );
    const v3 = await ok(base, {
      op: "version.new",
      doc: v2.slug,
      from: 2,
      body: fixed,
    });
    expect(v3.version).toBe(3);
    await ok(base, { op: "version.delete", doc: v2.slug, version: 2 });
    const c = await check(base);
    expect(c.proposed?.count).toBe(0);
  });

  test("a move of the document itself: the proposal's relative link is rewritten from where it is now", async () => {
    const base = await start();
    await propose(base, "# Keeper\n\nLives by [the Glade](./places/glade.md).\n");
    await ok(base, { op: "move", path: at("keeper.md"), into: at("wilds"), updateLinks: true });
    expect(rows(await check(base))).toEqual([[2, 3, "./places/glade.md", "../places/glade.md"]]);
  });

  test("a proposal broken with no move behind it is reported with no guess", async () => {
    const base = await start();
    await propose(base, "# Keeper\n\nLives by [the Glade](./places/glaed.md).\n");
    // A move elsewhere explains nothing about it.
    await ok(base, { op: "move", path: at("places/glade.md"), into: at("wilds") });
    expect(rows(await check(base))).toEqual([[2, 3, "./places/glaed.md", null]]);
  });
});

describe("where the target went", () => {
  const ONE = "# Keeper\n\nLives by [the Glade](./places/glade.md).\n";

  test("moves chain: moved twice, the suggest is where it is now", async () => {
    const base = await start();
    await propose(base, ONE);
    await moveGlade(base);
    await ok(base, { op: "move", path: at("wilds/glade.md"), into: at("deep") });
    expect(rows(await check(base))).toEqual([[2, 3, "./places/glade.md", "./deep/glade.md"]]);
  });

  test("a folder moved carries what is in it", async () => {
    const base = await start();
    await propose(base, ONE);
    await ok(base, { op: "move", path: at("places"), into: at("wilds"), updateLinks: true });
    expect(rows(await check(base))).toEqual([
      [2, 3, "./places/glade.md", "./wilds/places/glade.md"],
    ]);
  });

  test("a link to a file is never offered a folder in the file's place", async () => {
    const base = await start();
    await propose(base, ONE);
    await moveGlade(base);
    // The moved file gone, and a folder of the same name made where it went.
    // Once the daemon has seen the file go (its watcher), there is no suggest:
    // the place the link names is a folder now.
    //
    // ⚠ The context's watch was armed by `context.add` moments before, and a
    // macOS watch is not live at once: under a parallel run the change was
    // lost, not late (1 in 100 beside a looping suite, still unseen 15 s on,
    // 2026-10-24). A removal is not repeatable as it stands, so each retry puts
    // the file back and makes the change again, which a daemon that missed the
    // first reads the same way.
    const want = JSON.stringify([[2, 3, "./places/glade.md", null]]);
    const moved = at("wilds/glade.md");
    let tries = 0;
    await writeUntilSeen(
      "the file gone and a folder in its place",
      () => {
        if (tries++ > 0) {
          rmSync(moved, { recursive: true, force: true });
          writeFileSync(moved, "# The Glade\n");
        }
        unlinkSync(moved);
        mkdirSync(moved);
      },
      async () => JSON.stringify(rows(await check(base))) === want,
    );
  });

  test("the act keeps the proposal's label on the version that replaces it", async () => {
    const base = await start();
    const made = await ok(base, {
      op: "version.new",
      doc: at("keeper.md"),
      body: ONE,
      label: "tighter opening",
    });
    expect(made.version).toBe(2);
    await moveGlade(base);
    const act = (await check(base)).proposed?.links[0]?.act ?? "";
    expect(act).toContain('--from v2 --label "tighter opening" --stdin');
    expect(act).toContain("Fix its broken link in ONE new version");
  });
});

describe("a version the human has had active is history, not a proposal", () => {
  test("the agent's version activated, then a move: the human's earlier v1 is not reported", async () => {
    const base = await start();
    const v2 = await propose(base, "# Keeper\n\nLives by [the Glade](./places/glade.md).\n");
    await ok(base, { op: "activate", doc: v2.slug, version: 2 });
    await moveGlade(base);
    // v2 is active and followed the move; v1 still links the old place, and
    // is the human's own earlier text: not a proposal.
    const c = await check(base);
    expect(c.proposed?.count).toBe(0);
    expect(c.dangling.links.map((l) => l.raw)).toEqual([]);
  });

  test("an agent version once active, then left: not reported either", async () => {
    const base = await start();
    const v2 = await propose(base, "# Keeper\n\nLives by [the Glade](./places/glade.md).\n");
    await ok(base, { op: "activate", doc: v2.slug, version: 2 });
    await ok(base, { op: "activate", doc: v2.slug, version: 1 });
    await moveGlade(base);
    expect((await check(base)).proposed?.count).toBe(0);
  });
});

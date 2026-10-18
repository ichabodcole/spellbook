// The wiki verbs on the kit path (scriptorium-kit-wiki-verbs), driven through
// Scriptorium's own LAUNCHERS with `SCRIPTORIUM_KIT=1` (build first:
// `scripts/server.ts` runs the built `dist/server.js`). Ported from the
// shipped suites: `frontmatter.test.ts` (find's filters, the line edit),
// `session.test.ts` ("forget", E61) and `structure.test.ts` ("movePlan", E26),
// adapted to the CLI on the kit path; the answers were compared with the
// shipped CLI's side by side over the same world (the item says how).
// Everything runs under a temp SCRIPTORIUM_HOME and TMPDIR; every daemon this
// file starts it stops, by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSurface, pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { PublicState } from "../../../kit/workspace/protocol";
import type { DocSummary } from "../protocol";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  KIT_DIR,
  "..",
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
  "scripts",
  "cli.ts",
);

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-wiki-")));
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SCRIPTORIUM_KIT: "1",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const set = join(root, "docs", "set");
mkdirSync(join(set, "part"), { recursive: true });
mkdirSync(join(set, "lore"), { recursive: true });
const A = [
  "---",
  "type: note",
  "title: A",
  "status: draft",
  "tags: [x, y]",
  "# a comment the line edit keeps",
  "verified:",
  "  - by: human:cole",
  "    at: 2026-01-01",
  "stale_after: 2020-01-01",
  "generated: { by: claude, at: 2026-01-02 }",
  "owner: |",
  "  two",
  "  lines",
  "---",
  "# A",
  "",
  "See [c](./part/c.md) and [[glade]].",
  "",
].join("\n");
writeFileSync(join(set, "a.md"), A);
writeFileSync(join(set, "b.md"), "# Bee\n\nNo block.\n");
writeFileSync(
  join(set, "part", "c.md"),
  "---\ntype: note\nverified: { by: ci }\n---\n# C\n\nBack to [a](../a.md).\n",
);
writeFileSync(join(set, "part", "glade.md"), "# Glade\n");
const solo = join(root, "docs", "solo.md");
writeFileSync(solo, "# Solo\n\nplain\n");

type Run = { code: number; out: string; err: string };
async function cli(...args: string[]): Promise<Run> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    cwd: root,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}
const json = <T = Record<string, unknown>>(r: Run): T => {
  if (r.out.trim() === "") throw new Error(`no output (exit ${r.code}); stderr: ${r.err}`);
  return JSON.parse(r.out) as T;
};
const pointer = (id: string) => join(root, "tmp", `scriptorium.${id}.json`);

let sessionId = "";
let entry = "";
const run = (...args: string[]) => cli(...args, "--session", sessionId);
const state = async () => json<PublicState>(await run("state"));
type AppState = { hidden: Record<string, string[]>; docMeta: Record<string, DocSummary> };
const appState = async () => (await state()).appState as AppState;
const docOf = async (path: string) => (await state()).docs.find((d) => d.original === path);

/** Every file under the root but the daemon's pointers and logs, with its bytes: what "writes nothing" is held to. */
function files(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p === join(root, "tmp") || name === "logs") continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

async function until(f: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  const r = await cli("open", "--no-open", set, solo);
  expect(r.code).toBe(0);
  sessionId = json<{ session_id: string }>(r).session_id;
  entry = (await state()).context.find((e) => e.label === "set")?.id ?? "";
  expect(entry).not.toBe("");
}, 60_000);

afterAll(async () => {
  const pid = pointerPid(pointer(sessionId));
  if (pid !== null) {
    await cli("close", "--session", sessionId);
    await waitForExit(pid);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("meta and find: the shipped reader, over the kit's context", () => {
  test("meta <path>: every key survives, trust and stale derived; a document without a block is a note, not an error", async () => {
    const a = json<{ path: string; meta: Record<string, unknown> }>(
      await run("meta", join(set, "a.md")),
    );
    expect(a.path).toBe(join(set, "a.md"));
    expect(a.meta).toMatchObject({
      type: "note",
      status: "draft",
      tags: ["x", "y"],
      trust: "human-reviewed",
      stale: true,
      date: "2026-01-02",
      fields: { owner: "two\nlines\n" },
    });
    expect(json(await run("meta", join(set, "b.md")))).toMatchObject({
      meta: null,
      note: "no frontmatter block",
    });
    const c = json<{ meta: { trust: string } }>(await run("meta", join(set, "part", "c.md")));
    expect(c.meta.trust).toBe("machine-confirmed");
  });

  test("meta with no path: every document the context shows", async () => {
    const all = json<{ documents: { path: string }[]; count: number }>(await run("meta"));
    expect(all.documents.map((d) => d.path).sort()).toEqual(
      [
        join(set, "a.md"),
        join(set, "b.md"),
        join(set, "part", "c.md"),
        join(set, "part", "glade.md"),
        solo,
      ].sort(),
    );
    expect(all.count).toBe(5);
  });

  test("meta <a path nothing shows> is refused in the shipped words", async () => {
    const r = await run("meta", "/etc/passwd");
    expect(r.code).toBe(2);
    expect(r.err).toContain("/etc/passwd is not shown in this session");
  });

  test("find: filters AND, each narrows, and an empty result is an answer", async () => {
    const paths = async (...f: string[]) =>
      json<{ matches: { path: string; entry: string }[]; count: number }>(await run("find", ...f));
    expect((await paths()).count).toBe(5);
    const notes = await paths("--type", "note");
    expect(notes.matches.map((m) => m.path).sort()).toEqual(
      [join(set, "a.md"), join(set, "part", "c.md")].sort(),
    );
    expect(notes.matches.every((m) => m.entry === entry)).toBe(true);
    expect((await paths("--type", "note", "--tag", "x")).matches.map((m) => m.path)).toEqual([
      join(set, "a.md"),
    ]);
    // A document with no frontmatter says nothing, so it is not "stable".
    expect((await paths("--status", "stable")).matches.map((m) => m.path)).toEqual([
      join(set, "part", "c.md"),
    ]);
    expect((await paths("--since", "2026-01-01")).count).toBe(1);
    expect(await paths("--type", "nothing-like-this")).toEqual({
      ok: true,
      matches: [],
      count: 0,
    } as never);
  });

  test("find --since that is not a date is a usage error, before any daemon is asked", async () => {
    const r = await run("find", "--since", "yesterday");
    expect(r.code).toBe(2);
    expect(r.err).toContain("is not a date — write it as YYYY-MM-DD");
  });
});

describe("docMeta: the agent reads each document's frontmatter, trust and stale in appState", () => {
  test("every document with a block, by path, with the shipped summary", async () => {
    const meta = (await appState()).docMeta;
    expect(meta[join(set, "a.md")]).toEqual({
      type: "note",
      title: "A",
      status: "draft",
      tags: ["x", "y"],
      trust: "human-reviewed",
      stale: true,
    });
    expect(meta[join(set, "part", "c.md")]).toMatchObject({
      trust: "machine-confirmed",
      stale: false,
    });
    // No block, no entry: a normal document, not a defect.
    expect(meta[join(set, "b.md")]).toBeUndefined();
  });

  test("a hidden document leaves docMeta with the tree, and comes back with it", async () => {
    expect((await run("hide", join(set, "part"))).code).toBe(0);
    expect((await appState()).docMeta[join(set, "part", "c.md")]).toBeUndefined();
    expect((await run("unhide", entry)).code).toBe(0);
    expect((await appState()).docMeta[join(set, "part", "c.md")]).toBeDefined();
  });
});

describe("meta-init and meta-set: the shipped text edits, and what the open document does", () => {
  test("meta-init: the type is guessed from the neighbours, the title from the H1; the body is untouched", async () => {
    const r = await run("meta-init", join(set, "b.md"));
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, path: join(set, "b.md"), type: "note", added: true });
    const text = readFileSync(join(set, "b.md"), "utf8");
    expect(text.startsWith("---\ntype: note\ntitle: Bee\n")).toBe(true);
    expect(text.endsWith("---\n# Bee\n\nNo block.\n")).toBe(true);
    expect((await state()).chat.at(-1)?.text).toBe("Agent added frontmatter to set/b.md.");
    await until(
      async () => (await appState()).docMeta[join(set, "b.md")]?.type === "note",
      "docMeta to read the new block",
    );
  });

  test("meta-init --type --by writes what it is told; a document that has a block is refused", async () => {
    expect(json(await run("meta-init", "--type", "memo", "--by", "me", solo))).toMatchObject({
      type: "memo",
      added: true,
    });
    expect(readFileSync(solo, "utf8")).toContain("generated: { by: me, at: ");
    const again = await run("meta-init", join(set, "a.md"));
    expect(again.code).toBe(6);
    expect(again.err).toContain("a.md already has frontmatter");
  });

  test("meta-set: one line edit each, an unknown key appended, everything else byte for byte", async () => {
    const r = await run("meta-set", join(set, "a.md"), "status=stable", "owner=me", "new=1");
    expect(json(r)).toMatchObject({
      ok: true,
      path: join(set, "a.md"),
      set: ["status", "owner", "new"],
    });
    expect(readFileSync(join(set, "a.md"), "utf8")).toBe(
      A.replace("status: draft", "status: stable").replace(
        "owner: |\n  two\n  lines\n",
        "owner: me\nnew: 1\n",
      ),
    );
    expect((await state()).chat.at(-1)?.text).toBe("Agent set status, owner, new on set/a.md.");
  });

  test("meta-set refuses a pair that is not key=value, a key that is not a key, and a document without a block", async () => {
    const pair = await run("meta-set", join(set, "a.md"), "nope");
    expect(pair.code).toBe(2);
    expect(pair.err).toContain('\\"nope\\" is not key=value');
    const key = await run("meta-set", join(set, "a.md"), "9x=1");
    expect(key.code).toBe(2);
    expect(key.err).toContain("is not a frontmatter key");
    writeFileSync(join(set, "e.md"), "# E\n");
    await until(
      async () => (await run("meta", join(set, "e.md"))).code === 0,
      "e.md to be in the tree",
    );
    const none = await run("meta-set", join(set, "e.md"), "status=x");
    expect(none.code).toBe(6);
    expect(none.err).toContain("e.md has no frontmatter — add it first (meta-init)");
  });

  test("an open document with no unsaved edits takes the new text as its active version", async () => {
    const c = join(set, "part", "c.md");
    writeFileSync(join(root, "v2.md"), "# C, the agent's\n");
    expect((await run("version-new", "--doc", c, "--body-file", join(root, "v2.md"))).code).toBe(0);
    expect(json(await run("meta-set", c, "status=final"))).toMatchObject({ set: ["status"] });
    await until(async () => {
      const d = await docOf(c);
      const v = d?.versions.find((x) => x.n === d.active);
      return v ? readFileSync(v.path, "utf8").includes("status: final") : false;
    }, "the active version to reload");
    expect(await docOf(c)).toMatchObject({ active: 1, dirty: false, outsideChanged: false });
  });

  test("an open document whose active version differs from the file keeps it, and is marked changed outside", async () => {
    const a = join(set, "a.md");
    writeFileSync(join(root, "v2.md"), "# A, the agent's\n");
    expect((await run("version-new", "--doc", a, "--body-file", join(root, "v2.md"))).code).toBe(0);
    expect((await run("activate", "v2", "--doc", a)).code).toBe(0);
    expect((await run("meta-set", a, "status=final")).code).toBe(0);
    await until(async () => (await docOf(a))?.outsideChanged === true, "the conflict mark");
    const d = await docOf(a);
    expect(d).toMatchObject({ active: 2, dirty: true });
    const v2 = d?.versions.find((x) => x.n === 2)?.path as string;
    expect(readFileSync(v2, "utf8")).toBe("# A, the agent's\n");
  });
});

describe("forget: the answer to 'gone from disk' (ported from the shipped E61 tests)", () => {
  test("refused while the file exists, in the shipped words, naming the right verb", async () => {
    const r = await run("forget", "--doc", join(set, "a.md"));
    expect(r.code).toBe(6);
    expect(r.err).toContain(
      "set/a.md is still on disk — forget is for a document whose file is gone. To take it out of the context, remove it from Scriptorium instead.",
    );
    expect((await state()).docs.map((d) => d.original)).toContain(join(set, "a.md"));
  });

  test("forgets a document whose file is gone, says how many versions go, and leaves their files", async () => {
    writeFileSync(join(root, "v2.md"), "# Solo, the agent's\n");
    expect((await run("version-new", "--doc", solo, "--body-file", join(root, "v2.md"))).code).toBe(
      0,
    );
    const v1 = (await docOf(solo))?.versions[0]?.path as string;
    rmSync(solo);
    const r = await run("forget", "--doc", solo);
    expect(json(r)).toMatchObject({
      ok: true,
      slug: "solo",
      name: "solo.md",
      original: solo,
      versions: 2,
    });
    expect(await docOf(solo)).toBeUndefined();
    expect(readFileSync(v1, "utf8")).toContain("# Solo");
    expect((await state()).chat.at(-1)?.text).toBe(
      "Agent forgot solo.md — its file was gone, and 2 versions in this session are no longer reachable.",
    );
  });

  test("an unknown document is a refusal that lists what there is", async () => {
    const r = await run("forget", "--doc", "nothing-like-this");
    expect(r.code).toBe(5);
    expect(r.err).toContain('no document \\"nothing-like-this\\" in this session');
  });
});

describe("move-plan: what a move would do, before it does it (E26)", () => {
  test("a folder's plan counts what moves, finds the links it would break, and writes nothing", async () => {
    writeFileSync(join(set, "index.md"), "[C](./part/c.md) and [[glade]]\n");
    await until(
      async () => (await run("meta", join(set, "index.md"))).code === 0,
      "index.md to be in the tree",
    );
    const before = files();
    const r = await run("move-plan", join(set, "part"), join(set, "lore"));
    expect(r.err).toBe("");
    const plan = json<{
      links: { path: string; fixes: { from: string; to: string }[] }[];
      wiki: unknown[];
      checked: number;
    }>(r);
    expect(plan).toMatchObject({
      ok: true,
      from: join(set, "part"),
      to: join(set, "lore", "part"),
      into: join(set, "lore"),
      name: "part",
      folder: true,
      docs: 2,
      repo: null,
      leavesRepo: false,
    });
    const fixes = Object.fromEntries(
      plan.links.map((d) => [d.path, d.fixes.map((f) => [f.from, f.to])]),
    );
    expect(fixes[join(set, "index.md")]).toEqual([["./part/c.md", "./lore/part/c.md"]]);
    // a.md links to c.md on disk, but its active version (the agent's v2,
    // activated above) does not: links are read from what the human has.
    expect(fixes[join(set, "a.md")]).toBeUndefined();
    // c.md's own link out, from where it would be.
    expect(fixes[join(set, "lore", "part", "c.md")]).toEqual([["../a.md", "../../a.md"]]);
    expect(Object.keys(fixes).sort()).toEqual(
      [join(set, "index.md"), join(set, "lore", "part", "c.md")].sort(),
    );
    // `[[glade]]` lands now, by the app's resolver (a bare name), so it is
    // checked; it names a page, which the resolver still finds after the
    // move: nothing to say about it.
    const back = await run("backlinks", "--doc", join(set, "part", "glade.md"));
    expect(back.out).toContain(join(set, "index.md"));
    expect(plan.wiki).toEqual([]);
    expect(plan.checked).toBeGreaterThanOrEqual(3);
    expect(files()).toEqual(before);
  });

  test("the plan is the move's: a confirmed move breaks exactly those links", async () => {
    const plan = json<{ links: unknown[] }>(
      await run("move-plan", join(set, "part", "glade.md"), set),
    );
    const moved = json<{ links?: unknown[] }>(
      await run("move", "--update-links", join(set, "part", "glade.md"), set),
    );
    expect(moved.links ?? []).toEqual(plan.links);
    // Put back for the tests after.
    expect((await run("move", join(set, "glade.md"), join(set, "part"))).code).toBe(0);
  });

  test("a frontmatter reference the move would break is in the plan's edges, and in the move's answer", async () => {
    writeFileSync(join(set, "fm-a.md"), "---\ntype: note\nrelated: ./fm-b.md\n---\n# FM A\n");
    writeFileSync(join(set, "fm-b.md"), "# FM B\n");
    await until(
      async () => (await run("meta", join(set, "fm-b.md"))).code === 0,
      "fm-b.md to be in the tree",
    );
    try {
      const plan = json<{ edges: unknown[]; checked: number }>(
        await run("move-plan", join(set, "fm-b.md"), join(set, "lore")),
      );
      expect(plan.edges).toEqual([
        { kind: "frontmatter", source: join(set, "fm-a.md"), key: "related", raw: "./fm-b.md" },
      ]);
      expect(plan.checked).toBe(1);
      const moved = json<{ edges?: unknown[] }>(
        await run("move", "--update-links", join(set, "fm-b.md"), join(set, "lore")),
      );
      expect(moved.edges).toEqual(plan.edges);
      // Reported, never rewritten.
      expect(readFileSync(join(set, "fm-a.md"), "utf8")).toContain("related: ./fm-b.md");
    } finally {
      rmSync(join(set, "fm-a.md"), { force: true });
      rmSync(join(set, "fm-b.md"), { force: true });
      rmSync(join(set, "lore", "fm-b.md"), { force: true });
    }
  });

  test("a move out of a git working tree says so, and one inside it does not", async () => {
    mkdirSync(join(set, ".git"));
    try {
      const out = join(root, "docs", "out");
      mkdirSync(out);
      expect((await run("add", out)).code).toBe(0);
      expect(json(await run("move-plan", join(set, "part"), out))).toMatchObject({
        leavesRepo: true,
        repo: "set",
      });
      expect(json(await run("move-plan", join(set, "part"), join(set, "lore")))).toMatchObject({
        leavesRepo: false,
        repo: "set",
      });
    } finally {
      rmSync(join(set, ".git"), { recursive: true, force: true });
    }
  });

  test("it refuses what a move refuses", async () => {
    const notShown = await run("move-plan", join(root, "nowhere.md"), set);
    expect(notShown.code).toBe(5);
    const nowhere = await run("move-plan", join(set, "a.md"), join(root, "nowhere"));
    expect(nowhere.code).toBe(2);
    const there = await run("move-plan", join(set, "a.md"), set);
    expect(there.code).toBe(2);
    expect(there.err).toContain("is already in that folder");
  });

  test("a surface asks for it as a daemon op and is answered with the plan", async () => {
    const port = (JSON.parse(readFileSync(pointer(sessionId), "utf8")) as { port: number }).port;
    const surface = new FakeSurface();
    await surface.connect(port);
    try {
      surface.send({
        op: "scriptorium.move.plan",
        path: join(set, "part"),
        into: join(set, "lore"),
      });
      // An app's own frame: its op is not in the kit's union.
      const frame = (await surface.waitFor(
        (m) => (m.op as string) === "scriptorium.move.plan",
      )) as unknown as {
        plan: { docs: number; to: string };
      };
      expect(frame.plan).toMatchObject({ docs: 2, to: join(set, "lore", "part") });
    } finally {
      surface.close();
    }
  });
});

describe("the remove verbs, and info", () => {
  test("note-remove deletes a note and says so in the shipped words; a second is not found", async () => {
    const c = join(set, "part", "c.md");
    const n = json<{ note: string }>(await run("note", "--doc", c, "--quote", "Back", "a", "note"));
    const r = await run("note-remove", n.note, "--doc", c);
    expect(json(r)).toMatchObject({ ok: true, doc: "c", note: n.note });
    expect((await state()).chat.at(-1)?.text).toBe("Agent removed a note on c: “Back”.");
    const again = await run("note-remove", n.note, "--doc", c);
    expect(again.code).toBe(5);
  });

  test("task-remove forgets a finished task; an unfinished one is cancelled first", async () => {
    const t = json<{ task: string }>(await run("task", "a mistake")).task;
    const open = await run("task-remove", t);
    expect(open.code).toBe(6);
    expect(open.err).toContain("cancel it before removing it");
    expect(open.err).toContain(`task-cancel ${t}, then task-remove ${t}`);
    expect((await run("task-cancel", t)).code).toBe(0);
    expect(json(await run("task-remove", t))).toMatchObject({ task: t, removed: true });
    expect((await state()).tasks.map((x) => x.id)).not.toContain(t);
  });

  test("tasks-clear forgets the finished tasks and leaves the outstanding ones", async () => {
    const done = json<{ task: string }>(await run("task", "done one")).task;
    expect((await run("task-done", done)).code).toBe(0);
    const going = json<{ task: string }>(await run("task", "still going")).task;
    expect(json(await run("tasks-clear"))).toMatchObject({ cleared: 1 });
    expect((await state()).tasks.map((x) => x.id)).toEqual([going]);
  });

  test("info prints the resolved session pointer", async () => {
    const r = await run("info");
    expect(json(r)).toMatchObject({ session_id: sessionId });
  });
});

describe("docMeta on the wire: a pause in typing does not resend it (kit-docmeta-push-cost)", () => {
  test("typing sends no state; a chat line marks docMeta unchanged; a saved frontmatter edit sends it fresh, and the agent reads it", async () => {
    const t = join(set, "typing.md");
    writeFileSync(t, "---\ntype: note\nstatus: draft\n---\n# Typing\n\nbody\n");
    await until(
      async () => (await appState()).docMeta[t]?.status === "draft",
      "typing.md in docMeta",
    );
    const port = (JSON.parse(readFileSync(pointer(sessionId), "utf8")) as { port: number }).port;
    const surface = new FakeSurface();
    await surface.connect(port);
    try {
      surface.send({ op: "open", path: t });
      await surface.waitFor((m) => m.op === "version.text");
      const doc = surface.state.openDoc ?? "";
      const head = "---\ntype: note\nstatus: draft\n---\n# Typing\n\n";
      surface.send({ op: "edit", doc, version: 1, text: `${head}one\n` });
      await until(async () => surface.state.docs.some((d) => d.dirty), "the dirty flip");
      // Quiet first: the flip's own broadcast and its pause, and the daemon's
      // once-a-second attention sweep (whose first tick broadcasts), settle.
      const stateFrames = () => surface.frames.filter((f) => f.op === "state");
      for (let seen = -1; seen !== stateFrames().length; ) {
        seen = stateFrames().length;
        await Bun.sleep(1200);
      }
      const before = stateFrames().length;
      surface.send({ op: "edit", doc, version: 1, text: `${head}two\n` });
      await Bun.sleep(400);
      surface.send({ op: "edit", doc, version: 1, text: `${head}three\n` });
      await Bun.sleep(400); // two pauses in typing
      expect(stateFrames().length).toBe(before);

      // A chat line is a broadcast that leaves docMeta alone: it is marked
      // unchanged, not resent, and the surface keeps the docMeta it holds.
      surface.send({ op: "say", text: "a line, not a frontmatter edit", withSelection: false });
      await until(async () => stateFrames().length > before, "the chat line's broadcast");
      const line = stateFrames().at(-1) as { state: Record<string, unknown> };
      expect(line.state.appStateUnchanged).toBe(true);
      expect(JSON.stringify(line)).not.toContain("docMeta");
      expect((surface.state.appState as AppState).docMeta[t]?.status).toBe("draft");

      // The frontmatter edit, saved: the surface hears the new docMeta.
      surface.send({
        op: "edit",
        doc,
        version: 1,
        text: "---\ntype: note\nstatus: stable\n---\n# Typing\n\nthree\n",
      });
      surface.send({ op: "save", doc });
      await until(
        async () => (surface.state.appState as AppState).docMeta[t]?.status === "stable",
        "the surface to hear the fresh docMeta",
      );
      expect(
        stateFrames().some(
          (f) => JSON.stringify(f).includes("docMeta") && JSON.stringify(f).includes("stable"),
        ),
      ).toBe(true);
      // And the agent reads it too.
      expect((await appState()).docMeta[t]?.status).toBe("stable");
    } finally {
      surface.close();
    }
  }, 20_000);
});

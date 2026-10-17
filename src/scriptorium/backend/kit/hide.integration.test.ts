// `hide` and `unhide` on the kit path, driven through Scriptorium's own
// LAUNCHERS with `SCRIPTORIUM_KIT=1` (build first: `scripts/server.ts` runs the
// built `dist/server.js`). A hidden folder is out of the tree, search, the
// graph and backlinks; it stays hidden across an outside change the watcher
// rescans and across a close and restore. Everything runs under a temp
// SCRIPTORIUM_HOME and TMPDIR; every daemon this file starts it stops, by its
// own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSurface, pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { ContextNode, PublicState } from "../../../kit/workspace/protocol";

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

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-hide-")));
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SCRIPTORIUM_KIT: "1",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const set = join(root, "docs", "set");
mkdirSync(join(set, "drafts", "old"), { recursive: true });
writeFileSync(join(set, "a.md"), "# A\n\nThe lighthouse.\n");
writeFileSync(join(set, "drafts", "rough.md"), "# Rough\n\nlighthouse, see [a](../a.md).\n");
writeFileSync(join(set, "drafts", "old", "older.md"), "# Older\n\nlighthouse.\n");
const solo = join(root, "docs", "solo.md");
writeFileSync(solo, "# Solo\n");

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
const rels = (nodes: readonly ContextNode[]): string[] =>
  nodes.flatMap((n) => [n.rel, ...(n.kind === "group" ? rels(n.children) : [])]);

let sessionId = "";
let entry = "";

async function close() {
  const pid = pointerPid(pointer(sessionId));
  if (pid === null) return;
  await cli("close", "--session", sessionId);
  await waitForExit(pid);
}

const state = async () => json<PublicState>(await cli("state", "--session", sessionId));
const tree = async () => rels((await state()).context.find((e) => e.id === entry)?.nodes ?? []);
const found = async () =>
  json<{ results: { path: string }[] }>(
    await cli("search", "--session", sessionId, "lighthouse"),
  ).results.map((r) => r.path);

beforeAll(async () => {
  const r = await cli("open", "--no-open", set, solo);
  expect(r.code).toBe(0);
  sessionId = json<{ session_id: string }>(r).session_id;
  entry = (await state()).context.find((e) => e.label === "set")?.id ?? "";
  expect(entry).not.toBe("");
}, 60_000);

afterAll(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

describe("hide and unhide on the kit path", () => {
  test("hide <folder>: out of the tree, search, the graph and backlinks; still on disk", async () => {
    expect(await found()).toContain(join(set, "drafts", "rough.md"));
    const r = await cli("hide", "--session", sessionId, join(set, "drafts"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({
      ok: true,
      path: join(set, "drafts"),
      entry,
      removedEntry: false,
    });
    expect(await tree()).toEqual(["a.md"]);
    // The agent reads what is hidden where the shipped state had it per entry.
    expect((await state()).appState).toEqual({ hidden: { [entry]: ["drafts"] } });
    expect(await found()).toEqual([join(set, "a.md")]);
    const graph = json<{ nodes: { path: string }[] }>(await cli("graph", "--session", sessionId));
    expect(graph.nodes.map((n) => n.path)).not.toContain(join(set, "drafts", "rough.md"));
    const back = json<{ count: number }>(
      await cli("backlinks", "--session", sessionId, "--doc", join(set, "a.md")),
    );
    expect(back.count).toBe(0);
    expect(existsSync(join(set, "drafts", "rough.md"))).toBe(true);
    const chat = (await state()).chat.at(-1);
    expect(chat?.text).toContain("from Scriptorium (the folder is still on disk)");
  });

  test("an outside change rescans through the filter: a new file shows, the hidden one does not", async () => {
    writeFileSync(join(set, "drafts", "new.md"), "# New\n");
    // Written again until it shows: a watcher on macOS can miss a first event.
    let now: string[] = [];
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(set, "fresh.md"), `# Fresh ${i}\n`);
      await Bun.sleep(50);
      now = await tree();
      if (now.includes("fresh.md")) break;
    }
    expect(now).toEqual(["a.md", "fresh.md"]);
  });

  test("a close and a restore keep it hidden", async () => {
    await close();
    const r = await cli("open", "--no-open", "--restore", sessionId);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(await tree()).toEqual(["a.md", "fresh.md"]);
    expect(await found()).not.toContain(join(set, "drafts", "rough.md"));
  }, 60_000);

  test("unhide <entry> brings back everything hidden in the set", async () => {
    const r = await cli("unhide", "--session", sessionId, entry);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, entry, restored: 1 });
    expect(await tree()).toContain("drafts/new.md");
    expect(await found()).toContain(join(set, "drafts", "rough.md"));
  });

  test("unhide names the entries when the one given is not there", async () => {
    const r = await cli("unhide", "--session", sessionId, "c-nope");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no context entry c-nope");
    expect(r.err).toContain(entry);
  });

  test("the context's undo puts a hide back, and redo hides it again", async () => {
    // The restore above started a new daemon on a new port: its pointer says which.
    const port = (JSON.parse(readFileSync(pointer(sessionId), "utf8")) as { port: number }).port;
    const surface = new FakeSurface();
    await surface.connect(port);
    try {
      const r = await cli("hide", "--session", sessionId, join(set, "drafts", "old"));
      expect(r.code).toBe(0);
      expect(await tree()).not.toContain("drafts/old");
      const settle = async (want: boolean) => {
        for (let i = 0; i < 100 && (await tree()).includes("drafts/old") !== want; i++)
          await Bun.sleep(20);
        expect((await tree()).includes("drafts/old")).toBe(want);
      };
      surface.send({ op: "history.undo" });
      await settle(true);
      surface.send({ op: "history.redo" });
      await settle(false);
      // Left as the next test expects it: nothing hidden.
      expect(json(await cli("unhide", "--session", sessionId, entry))).toMatchObject({
        restored: 1,
      });
    } finally {
      surface.close();
    }
  });

  test("hide <a listed document> takes its entry out of the context; the file stays", async () => {
    const r = await cli("hide", "--session", sessionId, solo);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ removedEntry: true });
    expect((await state()).context.map((e) => e.label)).toEqual(["set"]);
    expect(existsSync(solo)).toBe(true);
  });

  test("hide <a path nothing shows> is refused as not found", async () => {
    const r = await cli("hide", "--session", sessionId, join(root, "nowhere.md"));
    expect(r.code).toBe(5);
    expect(r.err).toContain("not shown");
  });
});

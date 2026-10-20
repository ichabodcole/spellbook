// `.mdx` documents on the kit path (kit-mdx-documents; the shell cycle's ruling
// 1): a text document at the level the shipped Scriptorium has always had. It
// shows in the tree, `meta`, `find`, search and the link check, and versions
// and compares as any document does. Its imports and components are text: the
// file is never compiled or run, so nothing here needs it to be valid MDX.
// Driven through Scriptorium's own launcher (build
// first: `scripts/server.ts` runs the built `dist/server.js`), under a temp
// SCRIPTORIUM_HOME and TMPDIR; the daemon this file starts it stops, by its own
// session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
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

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-mdx-")));
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const set = join(root, "docs", "set");
mkdirSync(set, { recursive: true });
const PAGE = [
  "---",
  "type: guide",
  "title: The page",
  "---",
  'import { Chart } from "./chart";',
  "export const meta = { draft: true };",
  "",
  "# The page",
  "",
  "<Chart data={[1, 2, 3]} />",
  "",
  "Back to [the index](./index.md).",
  "",
].join("\n");
const page = join(set, "page.mdx");
writeFileSync(page, PAGE);
writeFileSync(join(set, "index.md"), "# Index\n\nSee [the page](./page.mdx).\n");
// Not a document either path shows: the kit's kinds are not widened past `.mdx`.
writeFileSync(join(set, "chart.tsx"), "export const Chart = () => null;\n");
// No title and no heading: its title is its name without `.mdx`, as shipped gives it.
writeFileSync(join(set, "bare.mdx"), "Just text, <Note /> and nothing else.\n");

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
const run = (...args: string[]) => cli(...args, "--session", sessionId);
const state = async () => json<PublicState>(await run("state"));

const rels = (nodes: ContextNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "group" ? rels(n.children) : [`${n.kind}:${n.rel}`]));

beforeAll(async () => {
  const r = await cli("open", "--no-open", set);
  if (r.code !== 0) throw new Error(`open failed (${r.code}): ${r.err}`);
  sessionId = json<{ session_id: string }>(r).session_id;
}, 60_000);

afterAll(async () => {
  const pid = pointerPid(pointer(sessionId));
  if (pid !== null) {
    await cli("close", "--session", sessionId);
    await waitForExit(pid);
  }
  rmSync(root, { recursive: true, force: true });
});

describe(".mdx is a document on the kit path", () => {
  test("the tree shows it as a document, beside the markdown, and still not a .tsx", async () => {
    const entry = (await state()).context.find((e) => e.label === "set");
    expect(rels(entry?.nodes ?? []).sort()).toEqual([
      "doc:bare.mdx",
      "doc:index.md",
      "doc:page.mdx",
    ]);
  });

  test("meta reads its frontmatter; find and search find it", async () => {
    const m = json<{ path: string; meta: Record<string, unknown> }>(await run("meta", page));
    expect(m.path).toBe(page);
    expect(m.meta).toMatchObject({ type: "guide", title: "The page" });
    const found = json<{ matches: { path: string }[] }>(await run("find", "--type", "guide"));
    expect(found.matches.map((x) => x.path)).toEqual([page]);
    const hits = json<{ results: { path: string }[] }>(await run("search", "Chart"));
    expect(hits.results.map((x) => x.path)).toContain(page);
  });

  test("its links are read and checked as a markdown document's; a link to it lands", async () => {
    const check = json<{ count: number }>(await run("link-check"));
    expect(check.count).toBe(0);
    const back = json<{ backlinks: { source: string }[] }>(await run("backlinks", "--doc", page));
    expect(back.backlinks.map((b) => b.source)).toEqual([join(set, "index.md")]);
  });

  test("it versions and compares as text, and the file on disk is untouched", async () => {
    const body = join(root, "tmp", "next.mdx");
    writeFileSync(body, PAGE.replace("<Chart data={[1, 2, 3]} />", "<Chart data={[4]} />"));
    const v = await run("version-new", "--doc", page, "--body-file", body);
    expect(v.code).toBe(0);
    expect(json<{ path: string }>(v).path).toEndWith(".mdx");
    // The new version against the active one (v1, the file's text): one change.
    const d = json<{ hunks: unknown[]; unified: string }>(await run("diff", "v2", "--doc", page));
    expect(d.hunks.length).toBe(1);
    expect(d.unified).toContain("+<Chart data={[4]} />");
    expect(readFileSync(page, "utf8")).toBe(PAGE);
  });

  test("a heading-less .mdx is titled by its name without the extension, in the graph", async () => {
    const g = json<{ nodes: { name: string; title: string }[] }>(await run("graph"));
    expect(g.nodes.find((n) => n.name === "bare.mdx")?.title).toBe("bare");
    expect(g.nodes.find((n) => n.name === "page.mdx")?.title).toBe("The page");
  });
});

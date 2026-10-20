// The kit path's frontmatter references and wiki forms (kit-link-edges-slot),
// end to end through Scriptorium's own launchers (`scripts/cli.ts` →
// `dist/server.js`; build first), as `kit.integration.test.ts` drives them:
// a temp SCRIPTORIUM_HOME and TMPDIR, and the one session this file starts,
// closed in afterAll by its own id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { Backlinks, LinkCheck, LinkGraph } from "../../../kit/workspace/protocol";

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

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-links-")));
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SCRIPTORIUM_KIT: "1",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const set = join(root, "wiki");
mkdirSync(join(set, "concepts"), { recursive: true });
mkdirSync(join(set, "decisions"), { recursive: true });
writeFileSync(join(set, "concepts", "exit-codes.md"), "---\ntype: concept\n---\n# Exit codes\n");
const stay = join(set, "decisions", "stay.md");
writeFileSync(
  stay,
  "---\ntype: decision\nrelated: [concept/exit-codes, ./gone.md]\n---\n# Stay\n\nSee [[exit-codes]].\n",
);

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
// A function, not a generic arrow: `<T>(` reads as JSX to the import-boundary ward's tsx parser.
function json<T>(r: Run): T {
  if (r.out.trim() === "") throw new Error(`no output (exit ${r.code}); stderr: ${r.err}`);
  return JSON.parse(r.out) as T;
}

let sessionId = "";
beforeAll(async () => {
  const r = await cli("open", "--no-open", set);
  expect(r.code).toBe(0);
  sessionId = json<{ session_id: string }>(r).session_id;
}, 60_000);
afterAll(async () => {
  const pid = pointerPid(join(root, "tmp", `scriptorium.${sessionId}.json`));
  if (pid !== null) {
    await cli("close", "--session", sessionId);
    await waitForExit(pid);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("frontmatter references on the kit path", () => {
  const exitCodes = join(set, "concepts", "exit-codes.md");

  test("backlinks: the wiki link lands by bare name; the reference is under edges, by key", async () => {
    const b = json<Backlinks>(await cli("backlinks", "--session", sessionId, "--doc", exitCodes));
    expect(b.backlinks.map((l) => [l.raw, l.kind])).toEqual([["exit-codes", "wiki"]]);
    expect(b.edges?.map((e) => [e.edge, e.raw, e.key])).toEqual([
      ["frontmatter", "concept/exit-codes", "related"],
    ]);
    const only = json<Backlinks>(
      await cli("backlinks", "--session", sessionId, "--doc", exitCodes, "--edge", "link"),
    );
    expect(only.edges).toEqual([]);
    expect(only.count).toBe(1);
  });

  test("graph --edge frontmatter draws the reference alone", async () => {
    const g = json<LinkGraph>(await cli("graph", "--session", sessionId, "--edge", "frontmatter"));
    expect(g.edges).toEqual([
      { from: stay, to: exitCodes, rel: [], count: 1, edge: "frontmatter" },
    ]);
    expect(g.edgeKinds).toEqual([
      { kind: "frontmatter", count: 1 },
      { kind: "link", count: 1 },
    ]);
  });

  test("link-check reports the reference nothing answers, and --edge narrows it", async () => {
    const c = json<LinkCheck>(await cli("link-check", "--session", sessionId));
    expect(c.edges?.links.map((e) => [e.raw, e.key])).toEqual([["./gone.md", "related"]]);
    expect(c.dangling.count).toBe(0);
    // Scriptorium asks for the links leaving a set, in its word (kit-broken-links-visible).
    expect(c.noun).toBe("set");
    expect(c.leaving).toEqual({ count: 0, links: [] });
    expect(c.count).toBe(1);
    const links = json<LinkCheck>(
      await cli("link-check", "--session", sessionId, "--edge", "link"),
    );
    expect(links.count).toBe(0);
  });

  test("a reference edited on disk is read again", async () => {
    writeFileSync(
      stay,
      "---\ntype: decision\nrelated: [concept/exit-codes]\n---\n# Stay\n\nSee [[exit-codes]].\n",
    );
    const c = json<LinkCheck>(await cli("link-check", "--session", sessionId));
    expect(c.edges?.count).toBe(0);
  });

  test("--edge with no kind is a usage error", async () => {
    const r = await cli("graph", "--session", sessionId, "--edge", ",");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--edge");
  });
});

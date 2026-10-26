// A set restored from an older manifest, or one with a link inside it, never
// shows the sessions or Scriptorium's home on the kit path
// (kit-legacy-sets-show-sessions). Driven through Scriptorium's own launcher
// (build first: `scripts/server.ts` runs the built
// `dist/server.js`), under a temp SCRIPTORIUM_HOME and TMPDIR; every daemon
// this file starts it stops, by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

// The root holds Scriptorium's home in plain sight, as a scratch home does.
const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-legacy-")));
const home = join(root, "home");
const sessions = join(home, "sessions");
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: home,
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const notes = join(root, "notes");
mkdirSync(notes, { recursive: true });
writeFileSync(join(notes, "n.md"), "# N\n");

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
  nodes.flatMap((n) => (n.kind === "group" ? [n.rel, ...rels(n.children)] : [n.rel]));

async function open(...args: string[]): Promise<string> {
  const r = await cli("open", "--no-open", ...args);
  if (r.code !== 0) throw new Error(`open failed (${r.code}): ${r.err}`);
  return json<{ session_id: string }>(r).session_id;
}
async function close(id: string): Promise<void> {
  const pid = pointerPid(pointer(id));
  if (pid === null) return;
  await cli("close", "--session", id);
  await waitForExit(pid);
}

let other = "";
let id = "";
const state = async () => json<PublicState>(await cli("state", "--session", id));

beforeAll(async () => {
  other = await open(notes);
  await close(other);
  // A link inside the set into the sessions, there before the set is scanned.
  symlinkSync(sessions, join(notes, "peek"));
  id = await open(notes);
}, 60_000);

afterAll(async () => {
  await close(id);
  await close(other);
  rmSync(root, { recursive: true, force: true });
});

describe("the sessions stay out of every set on the kit path", () => {
  test("a link inside a set into the sessions shows nothing, and meta through it is refused", async () => {
    const s = await state();
    const set = s.context.find((e) => e.root === notes);
    expect(rels(set?.nodes ?? [])).toEqual(["n.md"]);
    const meta = await cli("meta", join(notes, "peek", other, "manifest.json"), "--session", id);
    expect(meta.code).toBe(2);
  });

  test("restore drops a set among the sessions and narrows one holding them in plain sight, each with a chat line", async () => {
    await close(id);
    const path = join(sessions, id, "manifest.json");
    const m = JSON.parse(readFileSync(path, "utf8"));
    m.context.push(
      {
        id: "c-old201",
        label: "theirs",
        root: join(sessions, other),
        membership: "mirrored",
        nodes: [],
      },
      { id: "c-old202", label: "everything", root, membership: "mirrored", nodes: [] },
    );
    writeFileSync(path, JSON.stringify(m, null, 2));
    const r = await cli("open", "--no-open", "--restore", id);
    expect(r.code).toBe(0);
    const s = await state();
    expect(s.context.map((e) => e.label)).not.toContain("theirs");
    const everything = s.context.find((e) => e.label === "everything");
    const shown = rels(everything?.nodes ?? []);
    expect(shown).toContain("notes/n.md");
    expect(shown.some((x) => x === "home" || x.startsWith("home/"))).toBe(false);
    const lines = s.chat.map((c) => c.text);
    expect(lines.some((t) => t.startsWith("theirs is no longer in the context"))).toBe(true);
    expect(
      lines.some(
        (t) =>
          t ===
          `everything stays a set, but scriptorium's own folder inside it (${home}), where its sessions live, is left out of its tree, search and links.`,
      ),
    ).toBe(true);
  });
});

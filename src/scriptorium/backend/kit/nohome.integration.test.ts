// No default workspace on the kit path (`scriptorium-no-default-workspace`),
// through Scriptorium's own launchers (build first): `open` with no paths adds
// the folder it ran in as an ordinary set; the agent's create verbs go where
// they point and refuse cleanly without a place; there is no `workspace` verb.
// Everything runs under a temp SCRIPTORIUM_HOME and TMPDIR, with the preload's
// scratch HOME; each session this file opens, it closes by its own id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { PublicState } from "../../../kit/workspace/protocol";

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

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-nohome-")));
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SCRIPTORIUM_KIT: "1",
};
delete env.SCRIPTORIUM_KIT_MIGRATE;
mkdirSync(join(root, "tmp"), { recursive: true });
/** The folder the agent runs `open` in: a project with one document. */
const project = join(root, "project");
mkdirSync(join(project, "notes"), { recursive: true });
writeFileSync(join(project, "notes", "a.md"), "# A\n");
/** A folder outside every set, and a document to import. */
const outside = join(root, "outside");
mkdirSync(outside);
const incoming = join(root, "incoming.md");
writeFileSync(incoming, "# Incoming\n");

type Run = { code: number; out: string; err: string };
async function cli(cwd: string, ...args: string[]): Promise<Run> {
  const p = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
    cwd,
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
const envelope = (r: Run) =>
  (JSON.parse(r.err) as { error: { kind: string; message: string; hint?: string } }).error;
const pointer = (id: string) => join(root, "tmp", `scriptorium.${id}.json`);

const opened: string[] = [];
async function closeAll() {
  for (const id of opened) {
    const pid = pointerPid(pointer(id));
    if (pid === null) continue;
    await cli(root, "close", "--session", id);
    await waitForExit(pid);
  }
}

afterAll(async () => {
  await closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("open with no paths", () => {
  let id = "";
  let hs: { session_id: string; workspace?: string; entries?: { root: string }[] };

  beforeAll(async () => {
    const r = await cli(project, "open", "--no-open");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    hs = json(r);
    id = hs.session_id;
    opened.push(id);
  }, 60_000);

  const s = (...args: string[]) => cli(project, ...args, "--session", id);
  const state = async () => json<PublicState>(await s("state"));

  test("the folder it ran in is an ordinary set in the tree, and no workspace is named", async () => {
    expect("workspace" in hs).toBe(false);
    expect(hs.entries?.map((e) => e.root)).toEqual([project]);
    const st = await state();
    expect("workspace" in st).toBe(false);
    const e = st.context.find((x) => x.root === project);
    expect(e?.membership).toBe("mirrored");
    expect(JSON.stringify(e?.nodes)).toContain("a.md");
  });

  test("there is no `workspace` verb", async () => {
    const r = await s("workspace");
    expect(r.code).toBe(2);
    expect(envelope(r).kind).toBe("usage");
    const help = await cli(project, "help");
    expect(help.out).not.toMatch(/^ {2}workspace\b/m);
  });

  test("new-doc and new-folder go where they point, inside a set", async () => {
    const doc = await s("new-doc", join(project, "notes", "b.md"));
    expect(doc.code).toBe(0);
    expect(existsSync(join(project, "notes", "b.md"))).toBe(true);
    // A relative path is the caller's: here, inside the set it ran in.
    const folder = await s("new-folder", "drafts");
    expect(folder.code).toBe(0);
    expect(existsSync(join(project, "drafts"))).toBe(true);
  });

  test("new-doc and new-folder outside every set are refused, saying how to name a place", async () => {
    for (const r of [
      await s("new-doc", join(outside, "x.md")),
      await s("new-folder", join(outside, "x")),
    ]) {
      expect(r.code).toBe(2);
      const e = envelope(r);
      expect(e.kind).toBe("usage");
      expect(e.message).toContain("is not a folder in this session");
      expect(e.hint).toContain("add-folder <path>");
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  test("import takes --into, and is refused without it", async () => {
    const none = await s("import", incoming);
    expect(none.code).toBe(2);
    expect(envelope(none).message).toContain("--into <folder>");
    expect(envelope(none).hint).toContain("add-folder <path>");
    const away = await s("import", incoming, "--into", outside);
    expect(away.code).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
    const ok = await s("import", incoming, "--into", join(project, "notes"));
    expect(ok.code).toBe(0);
    expect(readFileSync(join(project, "notes", "incoming.md"), "utf8")).toBe("# Incoming\n");
  });

  test("version-new names its document; one outside the session is refused and nothing is written", async () => {
    const ok = await s("version-new", "--doc", join(project, "notes", "a.md"));
    expect(ok.code).toBe(0);
    const away = join(outside, "never.md");
    const r = await s("version-new", "--doc", away);
    expect(r.code).not.toBe(0);
    expect(existsSync(away)).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("add-folder makes a new place anywhere, as a set, and new-doc can then go there", async () => {
    const place = join(outside, "place");
    expect((await s("add-folder", place)).code).toBe(0);
    expect((await s("new-doc", join(place, "first.md"))).code).toBe(0);
    expect(existsSync(join(place, "first.md"))).toBe(true);
  });
});

describe("open in the app's own folders", () => {
  test("$SCRIPTORIUM_HOME, its kit/ and its sessions/ are never added as a set", async () => {
    const home = env.SCRIPTORIUM_HOME as string;
    for (const d of [join(home, "kit", "sessions"), join(home, "sessions")])
      mkdirSync(d, { recursive: true });
    for (const cwd of [
      home,
      join(home, "kit"),
      join(home, "kit", "sessions"),
      join(home, "sessions"),
    ]) {
      const r = await cli(cwd, "open", "--no-open");
      expect(r.code, cwd).toBe(0);
      const hs = json<{ session_id: string; entries?: unknown[]; note?: string }>(r);
      opened.push(hs.session_id);
      expect(hs.entries ?? [], cwd).toEqual([]);
      expect(hs.note, cwd).toContain("nothing was added");
    }
  }, 120_000);
});

describe("a relative path is the agent's, never the daemon's", () => {
  test("new-doc run in a folder of the set resolves there, not where open ran", async () => {
    const r = await cli(project, "open", "--no-open");
    const id = json<{ session_id: string }>(r).session_id;
    opened.push(id);
    const made = await cli(join(project, "notes"), "new-doc", "rel.md", "--session", id);
    expect(made.code).toBe(0);
    expect(existsSync(join(project, "notes", "rel.md"))).toBe(true);
    expect(existsSync(join(project, "rel.md"))).toBe(false);
  }, 60_000);
});

describe("open with paths", () => {
  test("the paths are the session: the folder it ran in is not added", async () => {
    const r = await cli(project, "open", "--no-open", join(project, "notes", "a.md"));
    expect(r.code).toBe(0);
    const hs = json<{ session_id: string; entries: { root: string }[] }>(r);
    opened.push(hs.session_id);
    expect(hs.entries.map((e) => e.root)).toEqual([join(project, "notes")]);
  }, 60_000);
});

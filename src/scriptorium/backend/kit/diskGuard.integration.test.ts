// The re-verifier's holes, through Scriptorium's own LAUNCHERS (build first:
// `scripts/server.ts` runs the built `dist/server.js`): a session whose set shows the sessions (restored from an
// old manifest, or `add ~` with a link in it to the sessions) wrote into
// ANOTHER live session's folder through `meta-set`, `meta-init`,
// `image.describe` and `relink`, and `version-delete` followed a version
// folder swapped for a link. Every disk write now goes through the kit's one
// guard (`src/kit/workspace/disk.ts`). Then the same verbs on a normal
// document, which still work, and an app verb's `~/` path, which the kit's
// own ops already took. Everything runs under a temp SCRIPTORIUM_HOME and
// TMPDIR, with the preload's scratch HOME; every daemon this file starts it
// stops, by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { PublicState } from "../../../kit/workspace/protocol";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILLS = join(KIT_DIR, "..", "..", "..", "..", "plugins", "spellbook", "skills");
const SCRIPT = join(SKILLS, "scriptorium", "scripts", "cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-disk-guard-")));
const SH = join(root, "shome");
const HOME = process.env.HOME as string;
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: SH,
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const W = join(root, "world");
mkdirSync(join(W, "sub"), { recursive: true });
writeFileSync(join(W, "a.md"), "---\ntype: note\n---\n# A\n");
writeFileSync(join(W, "c.md"), "# C\n");
writeFileSync(join(W, "b.md"), "# B\n");
const outside = join(root, "outside");
mkdirSync(outside);
const kitSessions = join(SH, "sessions");
/** A folder in the scratch home, with a link in it to the sessions (`add ~`, then `~/peek`). */
const homeDocs = join(HOME, `disk-guard-${process.pid}`);
mkdirSync(homeDocs, { recursive: true });
writeFileSync(join(homeDocs, "h.md"), "---\ntype: note\n---\n# H\n");
const peek = join(HOME, `peek-${process.pid}`);

/** A one-pixel PNG. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d00000000049454e44ae426082",
  "hex",
);

type Run = { code: number; out: string; err: string };
async function cli(...args: string[]): Promise<Run> {
  const p = Bun.spawn(["bun", SCRIPT, ...args], {
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
const urlOf = (id: string) =>
  (JSON.parse(readFileSync(pointer(id), "utf8")) as { url: string }).url.replace(/\/$/, "");
const opened: string[] = [];
async function open(...args: string[]): Promise<string> {
  const r = await cli("open", "--no-open", ...args);
  expect(r.code, r.err).toBe(0);
  const id = json<{ session_id: string }>(r).session_id;
  if (!opened.includes(id)) opened.push(id);
  return id;
}
async function stop(id: string): Promise<void> {
  const pid = pointerPid(pointer(id));
  if (pid === null) return;
  await cli("close", "--session", id);
  await waitForExit(pid);
}
const state = async (id: string) => json<PublicState>(await cli("state", "--session", id));
const post = async (id: string, body: Record<string, unknown>) => {
  const res = await fetch(`${urlOf(id)}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
};

let V = ""; // the victim: a live session with version files
let X = ""; // the attacker: a set that shows the sessions, from an old manifest
let aV1 = "";
let cV1 = "";
let vDocs = "";

beforeAll(async () => {
  V = await open(W);
  for (const doc of ["a.md", "c.md"])
    expect((await cli("version-new", "--session", V, "--doc", join(W, doc))).code).toBe(0);
  const st = await state(V);
  const slug = (f: string) => st.docs.find((d) => d.original === join(W, f))?.slug as string;
  vDocs = join(kitSessions, V, "docs");
  aV1 = join(vDocs, slug("a.md"), "v1.md");
  cV1 = join(vDocs, slug("c.md"), "v1.md");
  writeFileSync(join(vDocs, slug("a.md"), "pic.png"), PNG);
  writeFileSync(
    join(vDocs, slug("a.md"), "planted.md"),
    `# planted\n[b](${relative(join(vDocs, slug("a.md")), join(W, "b.md"))})\n`,
  );
  // X: opened, closed, its manifest given an old set rooted at $SH, restored.
  X = await open(W);
  await stop(X);
  const at = join(kitSessions, X, "manifest.json");
  const m = JSON.parse(readFileSync(at, "utf8"));
  m.context.push({ id: "c-legacy", label: "sh", root: SH, membership: "mirrored", nodes: [] });
  writeFileSync(at, JSON.stringify(m));
  await open("--restore", X);
  // Since kit-legacy-sets-show-sessions, the restore drops that set (its root
  // is the app home) and says so, so X no longer shows V's files. Each hole
  // below is now closed twice (not shown, then the write guard); every one
  // still writes nothing.
  const restored = await state(X);
  expect(restored.context.map((e) => e.label)).not.toContain("sh");
  expect(JSON.stringify(restored.context)).not.toContain(V);
  expect(restored.chat.some((c) => c.text.startsWith("sh is no longer in the context"))).toBe(true);
}, 60_000);

afterAll(async () => {
  for (const id of opened) await stop(id);
  rmSync(peek, { force: true });
  rmSync(homeDocs, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("hole 1: meta-set and meta-init write nothing in another session", () => {
  test("through a set from an old manifest", async () => {
    const a = readFileSync(aV1, "utf8");
    const c = readFileSync(cV1, "utf8");
    const set = await cli("meta-set", "--session", X, aV1, "status=PWNED");
    expect(set.code).not.toBe(0);
    expect(set.err).toMatch(/among the sessions' own folders|not shown in this session/);
    const init = await cli("meta-init", "--session", X, cV1);
    expect(init.code).not.toBe(0);
    expect(readFileSync(aV1, "utf8")).toBe(a);
    expect(readFileSync(cV1, "utf8")).toBe(c);
  });

  test("through `add ~` with a link in it to the sessions", async () => {
    symlinkSync(kitSessions, peek);
    const Z = await open(W);
    const added = await cli("add", "--session", Z, HOME);
    expect(added.code, added.err).toBe(0);
    const a = readFileSync(aV1, "utf8");
    const viaPeek = join(peek, V, relative(join(kitSessions, V), aV1));
    const r = await cli("meta-set", "--session", Z, viaPeek, "status=PEEKED");
    expect(r.code).not.toBe(0);
    expect(readFileSync(aV1, "utf8")).toBe(a);
    // Normal use beside it: `add ~` stands, and meta-set on a document in it lands.
    const ok = await cli("meta-set", "--session", Z, join(homeDocs, "h.md"), "status=draft");
    expect(ok.code, ok.err).toBe(0);
    expect(readFileSync(join(homeDocs, "h.md"), "utf8")).toContain("status: draft");
    await stop(Z);
  }, 30_000);
});

describe("after the scan: only the write guard stands between a shown path and another session", () => {
  // The scan hides the sessions now (kit-legacy-sets-show-sessions), so the
  // holes above are refused before any write. A link the scan saw leading
  // elsewhere, retargeted afterwards, is the write guard's alone. The chain
  // runs through a folder no set shows (`outside`), so no watcher sees the
  // retarget and rescans first: the cell is deterministic.
  test("meta-set and image.describe through a link retargeted into another session are refused by the write guard", async () => {
    const set = join(root, "linked");
    mkdirSync(set, { recursive: true });
    const hop = join(outside, "hop.md");
    const picHop = join(outside, "hop-pics");
    writeFileSync(join(outside, "real.md"), "---\ntype: note\n---\n# Real\n");
    mkdirSync(join(outside, "real-pics"));
    writeFileSync(join(outside, "real-pics", "pic.png"), PNG);
    symlinkSync(join(outside, "real.md"), hop);
    symlinkSync(join(outside, "real-pics"), picHop);
    symlinkSync(hop, join(set, "t.md"));
    symlinkSync(picHop, join(set, "pics"));
    const Q = await open(set);
    const shown = JSON.stringify((await state(Q)).context);
    expect(shown).toContain('"t.md"');
    expect(shown).toContain('"pics/pic.png"');
    const a = readFileSync(aV1, "utf8");
    const pic = join(dirname(aV1), "pic.png");
    rmSync(hop);
    symlinkSync(aV1, hop);
    rmSync(picHop);
    symlinkSync(dirname(aV1), picHop);
    const set1 = await cli("meta-set", "--session", Q, join(set, "t.md"), "status=PWNED");
    expect(set1.code).not.toBe(0);
    expect(set1.err).toContain("among the sessions' own folders");
    expect(readFileSync(aV1, "utf8")).toBe(a);
    const d = await post(Q, { op: "image.describe", image: join(set, "pics", "pic.png") });
    expect(d.status).toBe(409);
    expect(String(d.body.error)).toContain("among the sessions' own folders");
    expect(existsSync(`${pic}.md`)).toBe(false);
    await stop(Q);
  }, 30_000);
});

describe("hole 2: image.describe writes no sidecar in another session", () => {
  test("refused on /cmd, and no sidecar is made", async () => {
    const pic = join(dirname(aV1), "pic.png");
    const r = await post(X, { op: "image.describe", image: pic });
    expect([400, 404, 409]).toContain(r.status);
    expect(existsSync(`${pic}.md`)).toBe(false);
  });
});

describe("hole 3: relink rewrites nothing in another session", () => {
  test("the move offers the planted link; relink leaves it, and says so", async () => {
    const planted = join(dirname(aV1), "planted.md");
    const before = readFileSync(planted, "utf8");
    const mv = await cli("move", "--session", X, join(W, "b.md"), join(W, "sub"));
    expect(mv.code, mv.err).toBe(0);
    const r = await post(X, { op: "relink" });
    expect(readFileSync(planted, "utf8")).toBe(before);
    expect(JSON.stringify(r.body)).not.toContain('planted.md","links');
  });
});

describe("hole 4: version-delete follows no linked version folder", () => {
  test("a version folder swapped for a link to elsewhere deletes nothing there", async () => {
    const Y = await open(W);
    await cli("version-new", "--session", Y, "--doc", join(W, "a.md"));
    const st = await state(Y);
    const slug = st.docs[0]?.slug as string;
    expect((await cli("activate", "--session", Y, "v2", "--doc", slug)).code).toBe(0);
    writeFileSync(join(outside, "v1.md"), "OUTSIDE v1\n");
    const folder = join(kitSessions, Y, "docs", slug);
    renameSync(folder, `${folder}.real`);
    symlinkSync(outside, folder);
    const r = await cli("version-delete", "--session", Y, "v1", "--doc", slug);
    expect(r.code).not.toBe(0);
    expect(readFileSync(join(outside, "v1.md"), "utf8")).toBe("OUTSIDE v1\n");
    rmSync(folder);
    renameSync(`${folder}.real`, folder);
    // Normal use: the same delete, with the folder back, removes v1.
    const ok = await cli("version-delete", "--session", Y, "v1", "--doc", slug);
    expect(ok.code, ok.err).toBe(0);
    expect(existsSync(join(folder, "v1.md"))).toBe(false);
    await stop(Y);
  }, 30_000);
});

describe("normal use, and a `~/` path on an app verb", () => {
  test("meta-init and meta-set on a document of the world land", async () => {
    expect((await cli("meta-init", "--session", V, join(W, "c.md"))).code).toBe(0);
    expect(readFileSync(join(W, "c.md"), "utf8")).toStartWith("---\n");
    expect((await cli("meta-set", "--session", V, join(W, "a.md"), "status=ok")).code).toBe(0);
    expect(readFileSync(join(W, "a.md"), "utf8")).toContain("status: ok");
  });

  test("an app verb on /cmd takes a `~/` path, as the kit's own ops do", async () => {
    expect((await cli("add", "--session", V, homeDocs)).code).toBe(0);
    const rel = `~/${relative(HOME, join(homeDocs, "h.md"))}`;
    const r = await post(V, { op: "scriptorium.meta.set", path: rel, fields: { tag: "home" } });
    expect([r.status, r.body.error]).toEqual([200, undefined]);
    expect(readFileSync(join(homeDocs, "h.md"), "utf8")).toContain("tag: home");
    const meta = await post(V, { op: "scriptorium.meta", path: rel });
    expect(meta.status).toBe(200);
  });
});

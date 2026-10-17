// The cycle security review's routes, driven through Scriptorium's own
// LAUNCHERS with `SCRIPTORIUM_KIT=1` (build first: `scripts/server.ts` runs the
// built `dist/server.js`): no `add` (CLI, `/cmd` or the socket) makes a set of
// the sessions or the app home, the undo of a hide checks where the folder
// leads now, and the app's own verbs refuse a relative path rather than read
// it against the daemon's working directory. Everything runs under a temp
// SCRIPTORIUM_HOME and TMPDIR; every daemon this file starts it stops, by its
// own session id.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeSurface, pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { PublicState } from "../../../kit/workspace/protocol";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(KIT_DIR, "..", "..", "..", "..", "plugins", "spellbook", "skills");
const SCRIPT = join(CLI, "scriptorium", "scripts", "cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-security-")));
const SH = join(root, "shome");
const env: Record<string, string | undefined> = {
  ...process.env,
  SCRIPTORIUM_HOME: SH,
  TMPDIR: `${join(root, "tmp")}/`,
  NODE_ENV: "test",
  SCRIPTORIUM_KIT: "1",
};
mkdirSync(join(root, "tmp"), { recursive: true });
const set = join(root, "docs", "set");
mkdirSync(set, { recursive: true });
writeFileSync(join(set, "a.md"), "# A\n");
const proj = join(root, "docs", "proj");
mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "p.md"), "# P\n");

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

let sessionId = "";
let url = "";
let surface: FakeSurface | null = null;
const kitSessions = join(SH, "kit", "sessions");

const state = async () => json<PublicState>(await cli("state", "--session", sessionId));
const roots = async () => (await state()).context.map((e) => e.root);
const post = async (body: Record<string, unknown>) => {
  const res = await fetch(`${url}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
};

beforeAll(async () => {
  const r = await cli("open", "--no-open", set, proj);
  expect(r.code).toBe(0);
  sessionId = json<{ session_id: string }>(r).session_id;
  const p = JSON.parse(readFileSync(pointer(sessionId), "utf8")) as { url: string; port: number };
  url = p.url.replace(/\/$/, "");
  surface = new FakeSurface();
  await surface.connect(p.port);
}, 60_000);

afterAll(async () => {
  surface?.close();
  const pid = pointerPid(pointer(sessionId));
  if (pid !== null) {
    await cli("close", "--session", sessionId);
    await waitForExit(pid);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("no add makes a set of the sessions or the app home", () => {
  test("add of $SH/kit/sessions, $SH, a session folder, and a link to either is refused on the CLI and /cmd", async () => {
    symlinkSync(kitSessions, join(root, "to-sessions"));
    symlinkSync(SH, join(root, "to-shome"));
    const before = await roots();
    for (const p of [
      kitSessions,
      SH,
      join(kitSessions, sessionId),
      join(root, "to-sessions"),
      join(root, "to-shome"),
    ]) {
      const r = await cli("add", "--session", sessionId, p);
      expect([p, r.code]).not.toEqual([p, 0]);
      expect(r.err).toMatch(/sessions' own folders|app's own folder/);
      const c = await post({ op: "context.add", paths: [p] });
      expect([p, c.status]).toEqual([p, 409]);
    }
    expect(await roots()).toEqual(before);
  });

  test("rpa-s2: a document among the sessions cannot be added, so it never becomes a set", async () => {
    const stray = join(kitSessions, sessionId, "imported", "stray.md");
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(stray, "# stray\n");
    const r = await cli("add", "--session", sessionId, stray);
    expect(r.code).not.toBe(0);
    const m = await cli("make-set", "--session", sessionId, stray);
    expect(m.code).not.toBe(0);
    expect(existsSync(join(dirname(stray), "stray"))).toBe(false);
  });

  test("context.add on the socket is refused too", async () => {
    const s = surface as FakeSurface;
    const n = s.frames.length;
    s.send({ op: "context.add", path: kitSessions });
    const err = await s.waitFor((f) => f.op === "error" && s.frames.indexOf(f) >= n);
    expect(err.op === "error" && err.message).toContain("sessions' own folders");
  });
});

describe("the undo of a hide checks where the folder leads now (scenB)", () => {
  test("a hidden set's folder swapped for a link to the sessions does not come back", async () => {
    const h = await cli("hide", "--session", sessionId, proj);
    expect(h.code).toBe(0);
    renameSync(proj, `${proj}.real`);
    symlinkSync(kitSessions, proj);
    const s = surface as FakeSurface;
    s.send({ op: "history.undo" });
    await Bun.sleep(500);
    expect(await roots()).not.toContain(proj);
    // Nothing can be written into the sessions through it.
    const w = await cli(
      "new-doc",
      "--session",
      sessionId,
      join(proj, sessionId, "docs", "evil.md"),
    );
    expect(w.code).not.toBe(0);
    expect(existsSync(join(kitSessions, sessionId, "docs", "evil.md"))).toBe(false);
  });
});

describe("the app's own verbs refuse a relative path on /cmd and the socket", () => {
  test("hide, meta, meta-init, meta-set and move-plan", async () => {
    const rel = "docs/set/a.md";
    for (const body of [
      { op: "scriptorium.hide", path: rel },
      { op: "scriptorium.meta", path: rel },
      { op: "scriptorium.meta.init", path: rel },
      { op: "scriptorium.meta.set", path: rel, fields: { status: "draft" } },
      { op: "scriptorium.move.plan", path: rel, into: "docs" },
      { op: "scriptorium.move.plan", path: join(set, "a.md"), into: "docs" },
    ]) {
      const r = await post(body);
      expect([body.op, r.status]).toEqual([body.op, 400]);
      expect(r.body.error).toContain("is not a full path");
    }
    const s = surface as FakeSurface;
    const n = s.frames.length;
    s.send({ op: "scriptorium.hide", path: rel });
    const err = await s.waitFor((f) => f.op === "error" && s.frames.indexOf(f) >= n);
    expect(err.op === "error" && err.message).toContain("is not a full path");
    // Still shown, and its file untouched.
    expect((await state()).context.some((e) => e.root === set)).toBe(true);
    expect(readFileSync(join(set, "a.md"), "utf8")).toBe("# A\n");
  });
});

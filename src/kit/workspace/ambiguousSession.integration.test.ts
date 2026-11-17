// #137, over two real daemons: a write with no --session while two sessions
// of the app are live is refused (`ambiguous_session`, the live ids as
// `choices`), never sent to the newest; a read stays lenient; a write names the
// session it went to; with one live session, or a dead pointer beside it, a
// write goes through as before.
//
// `fixtures/cli.ts open` spawns `fixtures/server.ts` against a temp
// KIT_FIXTURE_HOME and a temp TMPDIR, so no real session pointer is read or
// written. Every daemon this file starts, it stops, by its own session id.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pointerPid, waitForExit } from "./fixtures/harness";
import { writesSession } from "./verbs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-ambiguous-")));
const tmp = join(root, "tmp");
const env = { ...process.env, KIT_FIXTURE_HOME: join(root, "home"), TMPDIR: `${tmp}/` };
mkdirSync(tmp, { recursive: true });
const alpha = join(root, "alpha");
const beta = join(root, "beta");
mkdirSync(alpha, { recursive: true });
mkdirSync(beta, { recursive: true });
writeFileSync(join(alpha, "a.md"), "# Alpha\n");
writeFileSync(join(beta, "b.md"), "# Beta\n");

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
  if (r.out.trim() === "")
    throw new Error(`the CLI printed nothing (exit ${r.code}); stderr: ${r.err || "(empty)"}`);
  return JSON.parse(r.out) as T;
};
type Envelope = {
  ok: false;
  error: { kind: string; exit_code: number; token?: string; hint?: string; choices?: string[] };
  meta: { command: string | null };
};
const pointerFile = (id: string) => join(tmp, `kit-fixture.${id}.json`);
type Chat = { chat: { from: string; text: string }[] };
const agentSaid = async (id: string): Promise<string[]> =>
  json<Chat>(await cli("state", "--session", id))
    .chat.filter((m) => m.from === "agent")
    .map((m) => m.text);

/** Open a session over `folder`; its idle timeout is a backstop should afterAll not run. */
async function open(folder: string): Promise<string> {
  const r = await cli("open", "--no-open", "--timeout", "300", folder);
  expect(r.code).toBe(0);
  return json<{ session_id: string }>(r).session_id;
}

/** Close a session of ours by its own id, and wait for its daemon (found by its own pointer) to go. */
async function closeOurs(id: string): Promise<void> {
  const pid = pointerPid(pointerFile(id));
  if (pid === null) return;
  await cli("close", "--session", id);
  await waitForExit(pid);
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("two live sessions, then one", () => {
  // A is opened first, B second: B is the newest, the one an unpinned verb used to reach.
  let a = "";
  let b = "";

  beforeAll(async () => {
    a = await open(alpha);
    b = await open(beta);
    expect(a).not.toBe(b);
  }, 90_000);

  afterAll(async () => {
    for (const id of [a, b]) if (id) await closeOurs(id);
  }, 30_000);

  test("a write with no --session is refused: usage/2, ambiguous_session, both live ids as choices, and nothing lands", async () => {
    // A kit write, an app's own verb (unclassified, so a write) and close.
    for (const args of [["say", "hello from A's agent"], ["ping"], ["close"]]) {
      const r = await cli(...args);
      expect(r.out).toBe("");
      expect(r.code).toBe(2);
      const doc = JSON.parse(r.err) as Envelope;
      expect(doc.ok).toBe(false);
      expect(doc.error.kind).toBe("usage");
      expect(doc.error.exit_code).toBe(2);
      expect(doc.error.token).toBe("ambiguous_session");
      // Newest first.
      expect(doc.error.choices).toEqual([b, a]);
      expect(doc.error.hint).toContain("--session");
      // Each live session is told apart by the folders it shows.
      expect(doc.error.hint).toContain(`${a} (${alpha})`);
      expect(doc.error.hint).toContain(`${b} (${beta})`);
      expect(doc.meta.command).toBe(args[0] as string);
    }
    // Neither session heard it, and both are still running.
    expect(await agentSaid(a)).toEqual([]);
    expect(await agentSaid(b)).toEqual([]);
  }, 60_000);

  test("a write with --session goes to that session, and its reply names it", async () => {
    const r = await cli("say", "--session", a, "for A only");
    expect(r.code).toBe(0);
    expect(json(r).session).toBe(a);
    expect(await agentSaid(a)).toEqual(["for A only"]);
    expect(await agentSaid(b)).toEqual([]);
  }, 60_000);

  test("a read with no --session stays lenient: it reads the newest, with no session added to its reply", async () => {
    const st = await cli("state");
    expect(st.code).toBe(0);
    expect(json<{ sessionId: string }>(st).sessionId).toBe(b);
    const doctor = await cli("doctor");
    expect(doctor.code).toBe(0);
    expect(json(doctor).session).toBeUndefined();
    const notes = await cli("notes", "--doc", join(beta, "b.md"));
    // Read or refused by the daemon for its own reasons, never ambiguous_session.
    if (notes.code !== 0) expect((JSON.parse(notes.err) as Envelope).error.token).toBeUndefined();
  }, 60_000);

  test("with one live session, an unpinned write works as before and names the session; a dead pointer does not count", async () => {
    await closeOurs(a);
    const r = await cli("say", "now B is the only one");
    expect(r.code).toBe(0);
    expect(json(r).session).toBe(b);
    expect(await agentSaid(b)).toEqual(["now B is the only one"]);

    // A's pointer put back with a pid that is certainly dead (a crash): not live.
    const dead = Bun.spawnSync(["true"], { env: process.env }).pid;
    writeFileSync(
      pointerFile(a),
      JSON.stringify({ url: "http://127.0.0.1:1", port: 1, session_id: a, dir: "/x", pid: dead }),
    );
    const again = await cli("say", "still B");
    expect(again.code).toBe(0);
    expect(json(again).session).toBe(b);
    rmSync(pointerFile(a));
    a = "";
  }, 60_000);
});

test("writesSession: the read ops stay lenient; every other op is a write, unless the app names it a read", () => {
  for (const op of [
    "diff",
    "notes",
    "search",
    "backlinks",
    "link.check",
    "graph",
    "profiles",
    "profile",
    "profile.check",
    "relations",
    "doctor",
  ])
    expect(writesSession({ op })).toBe(false);
  for (const op of [
    "say",
    "working",
    "version.new",
    "activate",
    "merge",
    "show",
    "version.delete",
    "note",
    "note.reply",
    "note.resolve",
    "task",
    "task.done",
    "doc.create",
    "relink",
    "reveal",
    "close",
    "context.add",
    "import",
    "workspace.set",
    "scriptorium.hide",
    "kit-fixture.ping",
  ])
    expect(writesSession({ op })).toBe(true);
  // An app names its own reads; the rest of its ops stay writes.
  expect(writesSession({ op: "scriptorium.find" }, ["scriptorium.find"])).toBe(false);
  expect(writesSession({ op: "scriptorium.hide" }, ["scriptorium.find"])).toBe(true);
  expect(writesSession({ op: "image.settings" })).toBe(false);
  expect(writesSession({ op: "image.settings", quality: "80" })).toBe(true);
});

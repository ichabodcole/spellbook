// The kit path (`SCRIPTORIUM_KIT=1`), driven through Scriptorium's own
// LAUNCHERS: `scripts/cli.ts open` spawns `scripts/server.ts` (→ the BUILT
// `dist/server.js`; build first), each of which hands off to `./cli.ts` and
// `./server.ts` because the flag is set. Everything runs under a temp
// SCRIPTORIUM_HOME and a temp TMPDIR, with the preload's scratch HOME passed on
// in `env`, so no real session or pointer is ever read or written.
//
// One flagged session per describe block, closed in afterAll by its own
// session id: every daemon this file starts, it stops.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
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
import { FakeSurface, pointerPid, waitForExit } from "../../../kit/workspace/fixtures/harness";
import type { PublicState } from "../../../kit/workspace/protocol";

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(
  KIT_DIR,
  "..",
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
);
const CLI = join(SKILL_ROOT, "scripts", "cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-kit-")));
const home = join(root, "home");
const base = {
  ...process.env,
  SCRIPTORIUM_HOME: home,
  TMPDIR: `${join(root, "tmp")}/`,
};
delete (base as Record<string, string | undefined>).SCRIPTORIUM_KIT;
/** The flagged environment, and the shipped one (no flag at all). */
const kitEnv = { ...base, SCRIPTORIUM_KIT: "1" };
const shippedEnv = base;
mkdirSync(join(root, "tmp"), { recursive: true });
const docs = join(root, "docs");
mkdirSync(join(docs, "set", "part"), { recursive: true });
writeFileSync(join(docs, "set", "a.md"), "# A\n\nline two\nline three\n");
writeFileSync(join(docs, "set", "part", "b.md"), "# B\n");
writeFileSync(join(docs, "solo.md"), "# Solo\n");

type Run = { code: number; out: string; err: string };
async function run(env: Record<string, string | undefined>, ...args: string[]): Promise<Run> {
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
const cli = (...args: string[]) => run(kitEnv, ...args);
const shipped = (...args: string[]) => run(shippedEnv, ...args);
const json = <T = Record<string, unknown>>(r: Run): T => {
  if (r.out.trim() === "")
    throw new Error(`the CLI printed nothing (exit ${r.code}); stderr: ${r.err || "(empty)"}`);
  return JSON.parse(r.out) as T;
};
const envelope = (r: Run) =>
  (JSON.parse(r.err) as { error: { kind: string; message: string; hint?: string } }).error;
/** The kit names its pointers `<app>.<id>.json`; the shipped Scriptorium `scriptorium-<id>.json`. */
const kitPointer = (id: string) => join(root, "tmp", `scriptorium.${id}.json`);
const shippedPointer = (id: string) => join(root, "tmp", `scriptorium-${id}.json`);

/** Close one session by its own id, and wait for the pid its pointer names to exit. */
async function closeById(env: Record<string, string | undefined>, id: string, pointer: string) {
  const pid = pointerPid(pointer);
  if (pid === null) return;
  await run(env, "close", "--session", id);
  await waitForExit(pid);
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the kit path, end to end through Scriptorium's launchers", () => {
  let port = 0;
  let sessionId = "";
  const surface = new FakeSurface();
  let tail: ReturnType<typeof Bun.spawn> | null = null;
  let tailOut = "";

  beforeAll(async () => {
    const r = await cli("open", "--no-open", join(docs, "set"), join(docs, "solo.md"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const hs = json<{ port: number; session_id: string }>(r);
    port = hs.port;
    sessionId = hs.session_id;
    await surface.connect(port);
    const proc = Bun.spawn(["bun", CLI, "tail", "--session", sessionId], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: kitEnv,
      cwd: root,
    });
    tail = proc;
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tailOut += new TextDecoder().decode(value);
      }
    })();
  }, 60_000);

  afterAll(async () => {
    surface.close();
    await closeById(kitEnv, sessionId, kitPointer(sessionId));
    tail?.kill();
    await tail?.exited;
  });

  const tailLines = () =>
    tailOut
      .slice(0, tailOut.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitTail = async (pred: (l: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const hit = tailLines().find(pred);
      if (hit) return hit;
      await Bun.sleep(20);
    }
    throw new Error(`tail never printed the line; got ${tailOut}`);
  };
  const state = async () => json<PublicState>(await cli("state", "--session", sessionId));

  test("open: the kit's daemon, named scriptorium, with its sessions under kit/sessions", async () => {
    const st = await state();
    expect(st.app).toBe("scriptorium");
    expect(st.context.map((e) => [e.label, e.membership])).toEqual([
      ["set", "mirrored"],
      ["solo.md", "listed"],
    ]);
    // Its own root, apart from the shipped Scriptorium's `sessions/`.
    const manifest = join(home, "kit", "sessions", sessionId, "manifest.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({ appName: "scriptorium" });
    expect(existsSync(join(home, "sessions"))).toBe(false);
    // The pointer is the kit's, never the shipped one's name.
    expect(existsSync(kitPointer(sessionId))).toBe(true);
    expect(existsSync(shippedPointer(sessionId))).toBe(false);
    const grounding = await waitTail((l) => l.type === "grounding");
    expect(grounding).toMatchObject({ spell: "scriptorium", session_id: sessionId });
    await waitTail((l) => l.type === "ready");
  });

  test("with no surface, the session's URL answers with a page that says so", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("no\nsurface yet");
  });

  test("add puts a folder on the context list", async () => {
    const extra = join(docs, "extra");
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, "e.md"), "# E\n");
    const r = await cli("add", "--session", sessionId, extra);
    expect(r.code).toBe(0);
    expect(json<{ entries: { label: string; added: boolean }[] }>(r).entries).toMatchObject([
      { label: "extra", added: true },
    ]);
  });

  test("say posts the agent's line to the chat", async () => {
    const r = await cli("say", "--session", sessionId, "hello", "there");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const chat = (await state()).chat;
    expect(chat.at(-1)).toMatchObject({ from: "agent", text: "hello there" });
  });

  test("version-new opens the document and makes v2; note notes a passage of it", async () => {
    const a = join(docs, "set", "a.md");
    const v = await cli("version-new", "--session", sessionId, "--doc", a, "--label", "draft");
    expect(v.err).toBe("");
    expect(v.code).toBe(0);
    const made = json<{ doc: string; version: number; path: string }>(v);
    expect(made).toMatchObject({ doc: "a", version: 2 });
    expect(made.path.startsWith(join(home, "kit", "sessions", sessionId))).toBe(true);
    // The original is never written by a new version.
    expect(readFileSync(a, "utf8")).toBe("# A\n\nline two\nline three\n");

    const n = await cli(
      "note",
      "--session",
      sessionId,
      "--doc",
      "a",
      "--quote",
      "line two",
      "check",
    );
    expect(n.err).toBe("");
    expect(n.code).toBe(0);
    const st = await state();
    const doc = st.docs.find((d) => d.slug === "a");
    expect(doc?.versions.map((x) => x.n)).toEqual([1, 2]);
    expect(doc?.notes.some((x) => x.quote === "line two" && x.body === "check")).toBe(true);
  });

  test("the tail's message carries about: the selection and the active path", async () => {
    surface.send({ op: "open", path: join(docs, "set", "a.md") });
    const st = await state();
    const doc = st.docs.find((d) => d.slug === "a");
    const active = doc?.versions.find((x) => x.n === doc.active);
    const path = active?.path ?? "";
    surface.send({
      op: "select",
      selection: {
        doc: "a",
        version: doc?.active ?? 2,
        path,
        fromLine: 3,
        toLine: 4,
        text: "line two\nline three",
      },
    });
    surface.send({ op: "say", text: "tighten this", withSelection: true });
    const line = await waitTail((l) => l.type === "message" && l.text === "tighten this");
    expect(line.about).toMatchObject({
      doc: "a",
      version: doc?.active ?? 2,
      path,
      fromLine: 3,
      toLine: 4,
    });
  });

  test("the one-ask marker: a marked ask about the human's note reaches the tail once, with its noteId", async () => {
    // The human notes "line two" (offsets 5..13 of the active text).
    surface.send({ op: "note.add", doc: "a", from: 5, to: 13, body: "stuck here?" });
    const added = await waitTail((l) => l.type === "note.added" && l.body === "stuck here?");
    const noteId = String(added.note);
    const ask = (rid: string) => ({
      op: "say",
      text: "see my note",
      withSelection: false,
      about: { noteId, ask: true },
      rid,
    });
    surface.send(ask("r1"));
    surface.send(ask("r2"));
    // A plain marker after both: once it is on the tail, both asks have landed.
    surface.send({ op: "say", text: "marker", withSelection: false });
    await waitTail((l) => l.type === "message" && l.text === "marker");
    const asks = tailLines().filter((l) => l.type === "message" && l.text === "see my note");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.about).toMatchObject({ noteId });
    // The marker is the daemon's to keep; the agent's tail never carries it.
    expect((asks[0]?.about as Record<string, unknown>).ask).toBeUndefined();
    // The second ask is refused to its sender alone, by its request id.
    const refused = await surface.waitFor(
      (f) => f.op === "error" && (f as { requestId?: unknown }).requestId === "r2",
    );
    expect(refused).toMatchObject({ op: "error" });
  });

  test("under test, the built daemon refuses the real Trash: a human delete leaves the file", async () => {
    // The sentinel: a file of our own in the scratch docs, on the context list
    // through `add`. Were the refusal compiled out, this would reach the real
    // Trash, so the assertion is that it is refused and the file is still here.
    const doomed = join(docs, "extra", "e.md");
    expect(existsSync(doomed)).toBe(true);
    surface.send({ op: "trash", path: doomed, rid: "t1" } as never);
    const refused = await surface.waitFor(
      (f) => f.op === "error" && (f as { requestId?: unknown }).requestId === "t1",
    );
    expect((refused as { message?: string }).message).toContain(
      "the real Trash is not used under test",
    );
    expect(surface.frames.some((f) => f.op === "trash.done")).toBe(false);
    expect(readFileSync(doomed, "utf8")).toBe("# E\n");
  });

  test("doctor answers with findings, each saying what to do", async () => {
    const r = await cli("doctor", "--session", sessionId);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(Array.isArray(json<{ findings: unknown[] }>(r).findings)).toBe(true);
  });

  test("--version names the kit path", async () => {
    const r = await cli("--version");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ name: "scriptorium", path: "kit" });
  });

  test("close ends the session: the tail closes, the daemon exits, the manifest stays", async () => {
    const pid = pointerPid(kitPointer(sessionId));
    if (pid === null) throw new Error("no pointer for the session");
    const r = await cli("close", "--session", sessionId);
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ ok: true, sent: "close" });
    await waitForExit(pid);
    await waitTail((l) => l.type === "tail.closed");
    expect(existsSync(kitPointer(sessionId))).toBe(false);
    expect(existsSync(join(home, "kit", "sessions", sessionId, "manifest.json"))).toBe(true);
  });
});

describe("neither Scriptorium reads the other's sessions", () => {
  let shippedId = "";
  let kitId = "";

  beforeAll(async () => {
    // A shipped session, made by the shipped Scriptorium's own writer, then closed.
    const s = await shipped("open", "--no-open", join(docs, "solo.md"));
    expect(s.code).toBe(0);
    shippedId = json<{ session_id: string }>(s).session_id;
    await closeById(shippedEnv, shippedId, shippedPointer(shippedId));
    // A kit session, closed.
    const k = await cli("open", "--no-open", join(docs, "solo.md"));
    expect(k.code).toBe(0);
    kitId = json<{ session_id: string }>(k).session_id;
    await closeById(kitEnv, kitId, kitPointer(kitId));
  }, 60_000);

  test("each lists and restores only its own root", async () => {
    expect(readdirSync(join(home, "sessions"))).toContain(shippedId);
    expect(readdirSync(join(home, "sessions"))).not.toContain(kitId);
    expect(readdirSync(join(home, "kit", "sessions"))).toContain(kitId);
    expect(readdirSync(join(home, "kit", "sessions"))).not.toContain(shippedId);

    const kitAsksShipped = await cli("open", "--no-open", "--restore", shippedId);
    expect(kitAsksShipped.code).toBe(5);
    expect(envelope(kitAsksShipped).kind).toBe("not_found");

    const shippedAsksKit = await shipped("open", "--no-open", "--restore", kitId);
    expect(shippedAsksKit.code).toBe(5);
    expect(envelope(shippedAsksKit).kind).toBe("not_found");
  });

  test("the kit refuses a shipped manifest put in its root, and leaves the file as it was", async () => {
    const into = join(home, "kit", "sessions", shippedId);
    cpSync(join(home, "sessions", shippedId), into, { recursive: true });
    const manifest = join(into, "manifest.json");
    const before = readFileSync(manifest);
    const r = await cli("open", "--no-open", "--restore", shippedId);
    expect(r.code).toBe(6);
    const err = envelope(r);
    expect(err.kind).toBe("conflict");
    expect(typeof err.hint).toBe("string");
    expect(readFileSync(manifest).equals(before)).toBe(true);
    rmSync(into, { recursive: true, force: true });
  });

  test("the shipped Scriptorium refuses a kit manifest put in its root, and leaves the file as it was", async () => {
    const into = join(home, "sessions", kitId);
    cpSync(join(home, "kit", "sessions", kitId), into, { recursive: true });
    const manifest = join(into, "manifest.json");
    const before = readFileSync(manifest);
    const r = await shipped("open", "--no-open", "--restore", kitId);
    expect(r.code).toBe(6);
    const err = envelope(r);
    expect(err.kind).toBe("conflict");
    expect(err.message).toContain("SCRIPTORIUM_KIT=1");
    // The refusal's hint survives the boot handshake into the envelope.
    expect(err.hint).toContain("$SCRIPTORIUM_HOME/kit/sessions");
    expect(readFileSync(manifest).equals(before)).toBe(true);
    // Refused at the restore, so no daemon and no pointer were left behind.
    expect(existsSync(shippedPointer(kitId))).toBe(false);
    rmSync(into, { recursive: true, force: true });
  });
});

// The daemon, driven through its LAUNCHERS — `scripts/cli.ts open` spawns
// `scripts/server.ts` (→ the BUILT `dist/server.js`; build first, T23) against
// a temp SCRIPTORIUM_HOME, a temp TMPDIR (so no real session pointer is ever
// read or written) and temp originals. The surface's half is played by a
// WebSocket client speaking the same `ClientMsg`s the page will.
//
// One session per describe block, torn down in afterAll — every daemon this
// file starts, it stops.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientMsg, PublicState, ServerMsg } from "./protocol";

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(
  BACKEND_DIR,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
);
const CLI = join(SKILL_ROOT, "scripts", "cli.ts");

const root = mkdtempSync(join(tmpdir(), "scriptorium-daemon-"));
const env = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
};
mkdirSync(join(root, "tmp"), { recursive: true });
const docs = join(root, "docs");
mkdirSync(join(docs, "set", "part"), { recursive: true });
writeFileSync(join(docs, "set", "a.md"), "# A\n\nline two\nline three\n");
writeFileSync(join(docs, "set", "part", "b.md"), "# B\n");
writeFileSync(join(docs, "solo.md"), "# Solo\n");

async function cliIn(
  cwd: string,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
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
const cli = (...args: string[]) => cliIn(root, ...args);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A minimal stand-in for the surface: every frame it receives, and a way to wait for one. */
class FakeSurface {
  frames: ServerMsg[] = [];
  private ws!: WebSocket;
  async connect(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.onmessage = (ev) => this.frames.push(JSON.parse(String(ev.data)) as ServerMsg);
    await new Promise((r) => {
      this.ws.onopen = r;
    });
  }
  send(msg: ClientMsg) {
    this.ws.send(JSON.stringify(msg));
  }
  async waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 5000): Promise<ServerMsg> {
    const start = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for a frame");
      await Bun.sleep(20);
    }
  }
  close() {
    this.ws.close();
  }
}

describe("a session, end to end through the launchers", () => {
  let port = 0;
  let sessionId = "";
  const surface = new FakeSurface();
  let tail: ReturnType<typeof Bun.spawn> | null = null;
  let tailOut = "";

  beforeAll(async () => {
    const r = await cli("open", "--no-open", join(docs, "set"), join(docs, "solo.md"));
    expect(r.code).toBe(0);
    const hs = JSON.parse(r.out) as { port: number; session_id: string; mode: string };
    port = hs.port;
    sessionId = hs.session_id;
    await surface.connect(port);
    tail = Bun.spawn(["bun", CLI, "tail"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    });
    void (async () => {
      const reader = (tail?.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tailOut += new TextDecoder().decode(value);
      }
    })();
  }, 60_000);

  afterAll(async () => {
    surface.close();
    if (existsSync(join(root, "tmp", `scriptorium-${sessionId}.json`))) await cli("close");
    tail?.kill();
  });

  const tailLines = () =>
    tailOut
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitTail = async (pred: (l: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 250; i++) {
      const hit = tailLines().find(pred);
      if (hit) return hit;
      await Bun.sleep(20);
    }
    throw new Error(`tail never printed the line; got ${tailOut}`);
  };

  test("open serves the built surface (release mode) and knows both entries (E15)", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>scriptorium</title>");
    const st = JSON.parse((await cli("state")).out) as PublicState;
    expect(st.mode).toBe("release");
    expect(st.context.map((e) => [e.label, e.membership])).toEqual([
      ["set", "mirrored"],
      ["solo.md", "listed"],
    ]);
  });

  test("the surface opens a file; v1 is written; an edit reaches it and never the original", async () => {
    surface.send({ type: "open", path: join(docs, "set", "a.md") });
    const st = await surface.waitFor((m) => m.type === "state" && m.state.openDoc === "a");
    if (st.type !== "state") throw new Error("unreachable");
    const v1 = st.state.docs[0]?.versions[0]?.path ?? "";
    expect(readFileSync(v1, "utf8")).toBe("# A\n\nline two\nline three\n");
    surface.send({
      type: "edit",
      doc: "a",
      version: 1,
      text: "# A\n\nline two, edited\nline three\n",
    });
    await surface.waitFor((m) => m.type === "state" && !!m.state.docs[0]?.dirty);
    expect(readFileSync(v1, "utf8")).toContain("edited");
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).not.toContain("edited");
  });

  test("the opener gets the active version's text; a later `read` asks for any version (sidebar slice)", async () => {
    // `open` answered the surface with v1's text straight away (the snapshot carries no texts).
    const loaded = surface.frames.find(
      (m) => m.type === "version.text" && m.doc === "a" && m.version === 1 && m.origin === "load",
    );
    expect(loaded?.type === "version.text" && loaded.text.startsWith("# A")).toBe(true);
    surface.send({ type: "read", doc: "a", version: 1 });
    const again = await surface.waitFor(
      (m) => m.type === "version.text" && m.doc === "a" && m.origin === "load" && m !== loaded,
    );
    expect(again.type === "version.text" && again.text).toContain("edited");
  });

  test("prefs.set persists in the HOME (not the browser) and rides the state; a bad key is refused", async () => {
    surface.send({ type: "prefs.set", key: "panes:test", value: '{"context":40}' });
    const st = await surface.waitFor(
      (m) => m.type === "state" && m.state.prefs["panes:test"] === '{"context":40}',
    );
    expect(st.type === "state" && typeof st.state.userHome).toBe("string");
    const onDisk = JSON.parse(readFileSync(join(root, "home", "prefs.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(onDisk["panes:test"]).toBe('{"context":40}');
    // Another session sharing this home wrote a key since this daemon booted:
    // a write must not erase it (prefs are read fresh — verify pass).
    const file = join(root, "home", "prefs.json");
    writeFileSync(file, JSON.stringify({ ...onDisk, "other:session": "kept" }));
    surface.send({ type: "prefs.set", key: "theme", value: "light" });
    await surface.waitFor((m) => m.type === "state" && m.state.prefs.theme === "light");
    const merged = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(merged["other:session"]).toBe("kept");
    expect(merged["panes:test"]).toBe('{"context":40}');
    surface.send({ type: "prefs.set", key: "../../etc/passwd", value: "x" });
    const err = await surface.waitFor(
      (m) => m.type === "error" && m.message.includes("refused pref"),
    );
    expect(err.type).toBe("error");
  });

  test("Save writes the original — and only then", async () => {
    surface.send({ type: "save", doc: "a" });
    await waitTail((l) => l.type === "saved");
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toContain("edited");
  });

  test("a message carries the selection and the active path to the tail", async () => {
    const path =
      (JSON.parse((await cli("state")).out) as PublicState).docs[0]?.versions[0]?.path ?? "";
    surface.send({
      type: "select",
      selection: {
        doc: "a",
        version: 1,
        path,
        fromLine: 3,
        toLine: 4,
        text: "line two, edited\nline three",
      },
    });
    surface.send({ type: "say", text: "tighten this", withSelection: true });
    const line = await waitTail((l) => l.type === "message");
    expect(line.text).toBe("tighten this");
    expect(line.selection).toMatchObject({ doc: "a", fromLine: 3, toLine: 4 });
    expect(line.active).toMatchObject({ doc: "a", version: 1, path });
    expect(typeof line.epoch).toBe("string");
  });

  test("version-new → the agent edits that file → the surface receives the text", async () => {
    const r = await cli("version-new", "--label", "tighter");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as { doc: string; version: number; path: string };
    expect(v).toMatchObject({ doc: "a", version: 2, from: 1 });
    writeFileSync(v.path, "# A\n\ntight.\n");
    const pushed = await surface.waitFor(
      (m) => m.type === "version.text" && m.version === 2 && m.text === "# A\n\ntight.\n",
    );
    expect(pushed).toMatchObject({ origin: "remote" });
  });

  test("activate makes v2 the active version; Revert restores the saved file over it", async () => {
    const r = await cli("activate", "v2");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ doc: "a", version: 2, previous: 1 });
    surface.send({ type: "revert", doc: "a" });
    await waitTail((l) => l.type === "reverted");
    const st = JSON.parse((await cli("state")).out) as PublicState;
    expect(st.docs[0]?.active).toBe(2);
    expect(readFileSync(st.docs[0]?.versions[1]?.path ?? "", "utf8")).toContain("edited");
  });

  test("a write to the ACTIVE version from outside is announced AND kept as a new version (E2)", async () => {
    const st = JSON.parse((await cli("state")).out) as PublicState;
    const activePath = st.docs[0]?.versions[1]?.path ?? "";
    const before = readFileSync(activePath, "utf8");
    writeFileSync(activePath, "the agent broke the rule\n");
    const line = await waitTail((l) => l.type === "system" && l.fact === "active.outside");
    expect(String(line.text)).toContain("ACTIVE version");
    expect(line.preservedAs).toBe(3);
    expect(readFileSync(String(line.preservedPath), "utf8")).toBe("the agent broke the rule\n");
    // The active version keeps the human's text.
    expect(readFileSync(activePath, "utf8")).toBe(before);
    const s2 = JSON.parse((await cli("state", "--full")).out) as PublicState;
    expect(s2.chat.some((m) => m.who === "system" && m.text.includes("ACTIVE version"))).toBe(true);
  });

  test("an unknown doc is not_found with the docs in hand as choices", async () => {
    const r = await cli("version-new", "--doc", "nope");
    expect(r.code).toBe(5);
    expect(JSON.parse(r.err).error.choices).toEqual(["a"]);
  });

  test("say reaches the chat; close ends the tail at 0, unlinks discovery, and the manifest stays", async () => {
    const body = join(root, "say.txt");
    writeFileSync(body, "Done — v2 is `tighter`.\n");
    expect((await cli("say", "--body-file", body)).code).toBe(0);
    expect((await cli("close")).code).toBe(0);
    const code = await tail?.exited;
    expect(code).toBe(0);
    expect(tailLines().at(-1)?.type).toBe("closed");
    expect(existsSync(join(root, "tmp", `scriptorium-${sessionId}.json`))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(root, "home", "sessions", sessionId, "manifest.json"), "utf8"),
    );
    expect(manifest.chat.some((m: { who: string }) => m.who === "agent")).toBe(true);
  });

  test("open --restore brings the session back, with a new epoch", async () => {
    const r = await cli("open", "--no-open", "--restore", sessionId);
    expect(r.code).toBe(0);
    const st = JSON.parse((await cli("state")).out) as PublicState & { epoch: string };
    expect(st.sessionId).toBe(sessionId);
    expect(st.docs[0]?.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(st.docs[0]?.active).toBe(2);
    expect(st.docs[0]?.outsideChanged).toBe(false);
    expect((await cli("close")).code).toBe(0);
  }, 60_000);

  test("an original changed WHILE CLOSED is flagged and announced on restore (verify-pass fix 2)", async () => {
    writeFileSync(join(docs, "set", "a.md"), "# changed while the session was closed\n");
    expect((await cli("open", "--no-open", "--restore", sessionId)).code).toBe(0);
    const st = JSON.parse((await cli("state", "--full")).out) as PublicState;
    expect(st.docs[0]?.outsideChanged).toBe(true);
    expect(
      st.chat.some((m) => m.who === "system" && m.text.includes("while this session was closed")),
    ).toBe(true);
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toBe(
      "# changed while the session was closed\n",
    );
    expect((await cli("close")).code).toBe(0);
  }, 60_000);
});

describe("verify-pass fixes, through the launchers", () => {
  let port = 0;
  let sid0 = "";
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  const victim = join(outside, "victim.rc");
  const stray = join(outside, "stray.md");

  beforeAll(async () => {
    writeFileSync(victim, "export SAFE=1\n");
    writeFileSync(stray, "# not in the context\n");
    const r = await cli("open", "--no-open", join(docs, "set"));
    expect(r.code).toBe(0);
    const hs = JSON.parse(r.out) as { port: number; session_id: string };
    port = hs.port;
    sid0 = hs.session_id;
  }, 60_000);

  afterAll(async () => {
    await cli("close", "--session", sid0);
  });

  const upgrade = (origin?: string) =>
    fetch(`http://127.0.0.1:${port}/ws`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin ? { Origin: origin } : {}),
      },
    });

  test("fix 1a — a WebSocket upgrade from a FOREIGN origin is refused (403)", async () => {
    expect((await upgrade("https://evil.example")).status).toBe(403);
    expect((await upgrade(`http://localhost:${port + 1}`)).status).toBe(403);
  });

  test("fix 1a — the daemon's own page may still connect", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      // @ts-expect-error Bun's WebSocket accepts headers
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const opened = await new Promise<boolean>((r) => {
      ws.onopen = () => r(true);
      ws.onerror = () => r(false);
    });
    ws.close();
    expect(opened).toBe(true);
  });

  test("fix 1a — a /cmd POST from a foreign origin is refused and changes nothing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ type: "say", text: "pwned" }),
    });
    expect(res.status).toBe(403);
    const st = JSON.parse((await cli("state", "--full")).out) as PublicState;
    expect(st.chat.some((m) => m.text === "pwned")).toBe(false);
  });

  test("fix 1b/1c — open and save of a path outside the context are refused; the file is untouched", async () => {
    const s = new FakeSurface();
    await s.connect(port);
    for (const path of [victim, stray]) {
      s.send({ type: "open", path });
      s.send({ type: "save", doc: "victim" });
      s.send({ type: "save", doc: "stray" });
    }
    await s.waitFor(
      (m) => m.type === "error" && m.message.includes("not in this session's context"),
    );
    await Bun.sleep(200);
    s.close();
    expect(readFileSync(victim, "utf8")).toBe("export SAFE=1\n");
    expect(readFileSync(stray, "utf8")).toBe("# not in the context\n");
    const st = JSON.parse((await cli("state")).out) as PublicState;
    expect(st.docs.map((d) => d.original)).toEqual([]);
  });

  test("fix 7/8 — version-new --doc <relative path> opens a context doc implicitly, resolved against the CLI's cwd", async () => {
    const r = await cliIn(join(docs, "set"), "version-new", "--doc", "part/b.md");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out) as { doc: string; version: number; path: string };
    expect(v).toMatchObject({ doc: "b", version: 2 });
    const st = JSON.parse((await cli("state")).out) as PublicState;
    expect(st.openDoc).toBeNull(); // the human's open document did not move
    // ...and a path outside the context is still refused through the same door.
    const bad = await cliIn(outside, "version-new", "--doc", "stray.md");
    expect(bad.code).toBe(2);
  });

  test("fix 6 — open prunes the daemon logs to ten, and a clean close deletes its empty log", async () => {
    const logs = join(root, "home", "logs");
    for (let i = 0; i < 14; i++) writeFileSync(join(logs, `daemon-${1000 + i}-1.log`), "old\n");
    const r = await cli("open", "--no-open");
    const sid = (JSON.parse(r.out) as { session_id: string }).session_id;
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(logs).filter((n) => n.startsWith("daemon-")).length).toBeLessThanOrEqual(10);
    const before = readdirSync(logs).length;
    expect((await cli("close", "--session", sid)).code).toBe(0);
    await Bun.sleep(600);
    expect(readdirSync(logs).length).toBe(before - 1);
  }, 60_000);
});

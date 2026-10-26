// The daemon, driven through real launchers: `fixtures/cli.ts open` spawns
// `fixtures/server.ts` (a detached `bun` process) against a temp
// KIT_FIXTURE_HOME and a temp TMPDIR (so no real session pointer is ever read or
// written) and temp originals. The surface's half is played by a WebSocket client
// speaking the same ops the page will; the agent's by the fixture app's CLI.
//
// One session per describe block, torn down in afterAll: every daemon this file
// starts, it stops.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
import { FakeSurface, pointerPid, waitForExit, waitUntil } from "./fixtures/harness";
import type { LinkCheck, PublicState } from "./protocol";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli.ts");

const root = realpathSync(mkdtempSync(join(tmpdir(), "workspace-daemon-")));
const env = {
  ...process.env,
  KIT_FIXTURE_HOME: join(root, "home"),
  KIT_FIXTURE_STEP_MS: "150",
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
/**
 * A verb's stdout as JSON. Empty stdout is said as such, with the exit code and
 * stderr: a CLI killed mid-run (Bun kills a timed-out test's children) prints
 * nothing, and a bare `JSON.parse("")` reads only as "Unexpected EOF".
 */
const json = <T = Record<string, unknown>>(r: { code: number; out: string; err: string }) => {
  if (r.out.trim() === "")
    throw new Error(`the CLI printed nothing (exit ${r.code}); stderr: ${r.err || "(empty)"}`);
  return JSON.parse(r.out) as T;
};
const pointerFile = (id: string) => join(root, "tmp", `kit-fixture.${id}.json`);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a session, end to end through the launchers", () => {
  let port = 0;
  let sessionId = "";
  const surface = new FakeSurface();
  let tail: ReturnType<typeof Bun.spawn> | null = null;
  let tailOut = "";

  beforeAll(async () => {
    const r = await cli("open", "--no-open", join(docs, "set"), join(docs, "solo.md"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const hs = json<{ port: number; session_id: string; mode: string }>(r);
    port = hs.port;
    sessionId = hs.session_id;
    await surface.connect(port);
    startTail();
  }, 60_000);

  /** The agent's tail, read into `tailOut` for as long as it runs. */
  let tailReading = false;
  const startTail = () => {
    const proc = Bun.spawn(["bun", CLI, "tail"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    });
    tail = proc;
    tailReading = true;
    void (async () => {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        tailOut += new TextDecoder().decode(value);
      }
      if (tail === proc) tailReading = false;
    })();
  };
  // ONE TIMEOUT MUST NOT TAKE THE REST WITH IT. Every test below reads the one
  // tail; when a test runs out of time mid-call and the tail has gone, the next
  // test starts a new one rather than waiting on a tail that is not there
  // (kit-note-guard-lazy: one slow test failed seven).
  beforeEach(() => {
    if (sessionId && !tailReading) startTail();
  });

  afterAll(async () => {
    surface.close();
    const pid = pointerPid(pointerFile(sessionId));
    if (pid !== null) {
      await cli("close");
      await waitForExit(pid);
    }
    tail?.kill();
    await tail?.exited;
  });

  // Only whole lines: a read can end partway through one, and the rest is still
  // on its way.
  const tailLines = () =>
    tailOut
      .slice(0, tailOut.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const waitTail = async (pred: (l: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const hit = tailLines().find(pred);
      if (hit) return hit;
      await Bun.sleep(20);
    }
    throw new Error(`tail never printed the line; got ${tailOut}`);
  };
  const state = async (full = false) =>
    json<PublicState>(await cli("state", ...(full ? ["--full"] : [])));

  test("open knows both entries, and the tail grounds itself and sees ready", async () => {
    const st = await state();
    expect(st.mode).toBe("dev");
    expect(st.app).toBe("kit-fixture");
    expect(st.context.map((e) => [e.label, e.membership])).toEqual([
      ["set", "mirrored"],
      ["solo.md", "listed"],
    ]);
    const grounding = await waitTail((l) => l.type === "grounding");
    expect(grounding).toMatchObject({ spell: "kit-fixture", session_id: sessionId });
    await waitTail((l) => l.type === "ready");
    // The kit's `tail` marks itself as the agent's: the surface can say one is listening.
    expect((await state()).agentListening).toBe(true);
  });

  test("add puts more on the context list, and refuses what it cannot open before asking the daemon", async () => {
    const extra = join(docs, "extra");
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, "e.md"), "# E\n");
    const r = await cli("add", extra);
    expect(r.code).toBe(0);
    expect(json<{ entries: { label: string; added: boolean }[] }>(r).entries).toMatchObject([
      { label: "extra", added: true },
    ]);
    // Adding it again changes nothing.
    expect(json<{ entries: { added: boolean }[] }>(await cli("add", extra)).entries[0]?.added).toBe(
      false,
    );
    await surface.waitFor(
      (m) => m.op === "state" && m.state.context.some((e) => e.label === "extra"),
    );
    surface.send({
      op: "context.remove",
      id: surface.state.context.find((e) => e.label === "extra")?.id ?? "",
    });
    await surface.waitFor(
      (m) => m.op === "state" && !m.state.context.some((e) => e.label === "extra"),
    );
    const zip = join(docs, "notes.zip");
    writeFileSync(zip, "x");
    expect((await cli("add", zip)).code).toBe(2);
  });

  test("the surface opens a file; v1 is written; an edit reaches it and never the original", async () => {
    surface.send({ op: "open", path: join(docs, "set", "a.md") });
    await surface.waitFor((m) => m.op === "state" && m.state.openDoc === "a");
    const v1 = surface.state.docs[0]?.versions[0]?.path ?? "";
    expect(readFileSync(v1, "utf8")).toBe("# A\n\nline two\nline three\n");
    // The human opening a document is quiet: on the log, off the agent's tail
    // (checked below, once a message has been through it).
    surface.send({
      op: "edit",
      doc: "a",
      version: 1,
      text: "# A\n\nline two, edited\nline three\n",
    });
    await surface.waitFor((m) => m.op === "state" && !!m.state.docs[0]?.dirty);
    expect(readFileSync(v1, "utf8")).toContain("edited");
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).not.toContain("edited");
  });

  test("search finds the unsaved active version (grep on disk cannot), as JSON through the CLI", async () => {
    const r = await cli("search", "--session", sessionId, "line", "two,", "edited");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const report = json<{ results: Record<string, unknown>[]; count: number }>(r);
    expect(report.count).toBe(1);
    expect(report.results[0]).toMatchObject({
      kind: "text",
      slug: "a",
      name: "a.md",
      version: 1,
      line: 3,
      column: 1,
      snippet: "line two, edited",
    });
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).not.toContain("edited");

    const capped = json<{ count: number; truncated: boolean }>(
      await cli("search", "--session", sessionId, "line", "--limit", "1"),
    );
    expect(capped).toMatchObject({ count: 1, truncated: true });

    const blank = await cli("search", "--session", sessionId, " ");
    expect(blank.code).toBe(2);
    expect(JSON.parse(blank.err).error.kind).toBe("usage");
  });

  test("backlinks reads the unsaved active version, as JSON through the CLI", async () => {
    surface.send({
      op: "edit",
      doc: "a",
      version: 1,
      text: "# A\n\nline two, edited\nline three\n\nsee [B](./part/b.md?rel=sister-of,extends)\n",
    });
    // The edit has no reply; it has landed when the active version holds it.
    const v1 = surface.state.docs[0]?.versions[0]?.path ?? "";
    for (let i = 0; i < 200 && !readFileSync(v1, "utf8").includes("part/b.md"); i++)
      await Bun.sleep(10);
    // `--doc` as a path the session does not hold yet: the agent may ask about
    // any document in the context.
    const r = await cli("backlinks", "--session", sessionId, "--doc", join(docs, "set/part/b.md"));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const report = json<{
      doc: string | null;
      count: number;
      backlinks: Record<string, unknown>[];
      relations: { rel: string; count: number }[];
      bare: number;
    }>(r);
    expect(report).toMatchObject({ doc: null, count: 1, bare: 0 });
    expect(report.backlinks[0]).toMatchObject({
      source: join(docs, "set", "a.md"),
      name: "a.md",
      shown: "a.md",
      line: 6,
      raw: "./part/b.md?rel=sister-of,extends",
      rel: ["sister-of", "extends"],
      kind: "markdown",
      label: "B",
    });
    expect(report.relations).toEqual([
      { rel: "extends", count: 1 },
      { rel: "sister-of", count: 1 },
    ]);
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).not.toContain("part/b.md");
    // Without --doc it is the open document's, and a.md has none.
    expect(json<{ count: number }>(await cli("backlinks", "--session", sessionId)).count).toBe(0);
    const unknown = await cli("backlinks", "--session", sessionId, "--doc", "nope.md");
    expect(unknown.code).toBe(5);
  });

  test("graph answers nodes and typed edges as JSON, with its filters, through the CLI", async () => {
    // Runs after the backlinks test: a's active version links to b with two relations.
    const all = json<{
      nodes: { path: string; title: string; linksIn: number }[];
      edges: { from: string; to: string; rel: string[]; count: number }[];
      relations: { rel: string; count: number }[];
    }>(await cli("graph", "--session", sessionId));
    expect(all.edges).toContainEqual({
      from: join(docs, "set", "a.md"),
      to: join(docs, "set", "part", "b.md"),
      rel: ["extends", "sister-of"],
      count: 1,
    });
    expect(all.nodes.find((n) => n.path.endsWith("b.md"))).toMatchObject({
      title: "B",
      linksIn: 1,
    });
    const focused = await cli(
      "graph",
      "--session",
      sessionId,
      "--focus",
      join(docs, "set/part/b.md"),
      "--rel",
      "extends",
      "--hops",
      "1",
    );
    expect(focused.err).toBe("");
    const f = json<{ focus: string; nodes: { path: string; hop: number }[] }>(focused);
    expect(f.focus).toBe(join(docs, "set", "part", "b.md"));
    expect(f.nodes.map((n) => [n.path, n.hop])).toEqual([
      [join(docs, "set", "part", "b.md"), 0],
      [join(docs, "set", "a.md"), 1],
    ]);
    // Relations are read case-folded, and so is `--rel`: `EXTENDS` is the
    // `extends` in view, kept and never warned about as matching nothing.
    const shouted = await cli("graph", "--session", sessionId, "--rel", "EXTENDS,Sister-Of");
    expect(shouted.err).toBe("");
    const s = json<{ edges: { rel: string[] }[]; warnings?: string[] }>(shouted);
    expect(s.edges.map((e) => e.rel)).toContainEqual(["extends", "sister-of"]);
    expect((s.warnings ?? []).filter((w) => w.startsWith("rel:"))).toEqual([]);
    const bad = await cli("graph", "--session", sessionId, "--hops", "9");
    expect(bad.code).toBe(2);
    const gone = await cli("graph", "--session", sessionId, "--focus", "nope.md");
    expect(gone.code).toBe(5);
  });

  test("link-check reports its sections as JSON, exits 0, and the doctor names it", async () => {
    // solo.md is listed, not held: read from disk. A second solo.md in the
    // mirrored set shares its name.
    writeFileSync(
      join(docs, "solo.md"),
      "---\ntitle: Solo\n---\n# Solo\n\n[Maren](op:doc/0193-maren) and [gone](./gone.md?rel=x)\n",
    );
    writeFileSync(join(docs, "set", "part", "solo.md"), "# Another solo\n");
    try {
      for (let i = 0; i < 200; i++) {
        if (JSON.stringify((await state(true)).context).includes("part/solo.md")) break;
        await Bun.sleep(20);
      }
      const r = await cli("link-check", "--session", sessionId);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const report = json<LinkCheck>(r);
      expect(report.count).toBe(3);
      expect(report.dangling.links).toEqual([
        expect.objectContaining({
          source: join(docs, "solo.md"),
          line: 6,
          raw: "./gone.md?rel=x",
          tried: [join(docs, "gone.md")],
        }),
      ]);
      expect(report.unsupported.links).toEqual([
        expect.objectContaining({ line: 6, raw: "op:doc/0193-maren", scheme: "op" }),
      ]);
      expect(report.duplicates.names).toEqual([
        {
          name: "solo.md",
          files: [
            expect.objectContaining({
              path: join(docs, "set", "part", "solo.md"),
              suggest: "part-solo.md",
            }),
            expect.objectContaining({ path: join(docs, "solo.md"), suggest: "docs-solo.md" }),
          ],
        },
      ]);
      const doctor = json<{ findings: { kind: string; fix: string }[] }>(
        await cli("doctor", "--session", sessionId),
      );
      const linkFindings = doctor.findings.filter((f) => f.fix.includes("`link-check`"));
      expect(linkFindings.map((f) => f.kind)).toEqual([
        "names.shared",
        "links.dangling",
        "links.unsupported",
      ]);
    } finally {
      writeFileSync(join(docs, "solo.md"), "# Solo\n");
      rmSync(join(docs, "set", "part", "solo.md"));
    }
  });

  test("profiles, profile and profile-check answer as JSON through the CLI, and the doctor names the check", async () => {
    const meta = join(docs, "set", "_meta", "profiles");
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      join(meta, "note.json"),
      JSON.stringify({
        kind: "note",
        label: "Note",
        properties: { status: { enum: ["draft", "stable"] } },
        required: ["status"],
      }),
    );
    writeFileSync(join(meta, "_relations.json"), "not a kind");
    const note = join(docs, "set", "part", "note.md");
    writeFileSync(note, "---\ntype: note\nstatus: final\n---\n# A note\n");
    try {
      for (let i = 0; i < 200; i++) {
        if (JSON.stringify((await state(true)).context).includes("part/note.md")) break;
        await Bun.sleep(20);
      }
      const all = await cli("profiles", "--session", sessionId);
      expect(all.err).toBe("");
      expect(all.code).toBe(0);
      expect(
        json<{ kinds: { kind: string; shown: string; documents: number }[] }>(all).kinds,
      ).toEqual([
        expect.objectContaining({
          kind: "note",
          shown: "_meta/profiles/note.json",
          documents: 1,
          withWarnings: 1,
        }),
      ]);
      // A path relative to where the agent stands, as the other verbs take one.
      const one = await cliIn(
        join(docs, "set"),
        "profile",
        "--session",
        sessionId,
        "--doc",
        "part/note.md",
      );
      expect(one.err).toBe("");
      expect(json(one)).toMatchObject({
        path: note,
        kind: "note",
        label: "Note",
        match: "matched",
        sourceShown: "_meta/profiles/note.json",
        warnings: [expect.objectContaining({ field: "status", rule: "enum" })],
      });
      const check = await cli("profile-check", "--session", sessionId);
      expect(check.code).toBe(0);
      expect(json<{ count: number; warnings: { list: { fix: string }[] } }>(check)).toMatchObject({
        count: 1,
        warnings: {
          list: [expect.objectContaining({ fix: "set `status` to one of draft, stable" })],
        },
      });
      const doctor = json<{ findings: { kind: string; fix: string }[] }>(
        await cli("doctor", "--session", sessionId),
      );
      expect(
        doctor.findings.filter((f) => f.fix.includes("`profile-check`")).map((f) => f.kind),
      ).toEqual(["profiles.warnings"]);
      const gone = await cli("profile", "--session", sessionId, "--doc", "nope.md");
      expect(gone.code).toBe(5);
      // The document is named with --doc, as backlinks, notes and diff name one.
      const positional = await cli("profile", "--session", sessionId, "part/note.md");
      expect(positional.code).toBe(2);
    } finally {
      rmSync(join(docs, "set", "_meta"), { recursive: true, force: true });
      rmSync(note, { force: true });
    }
  });

  test("Save writes the original, and only then", async () => {
    surface.send({ op: "save", doc: "a" });
    // The human's own work with nothing of the agent's in flight: quiet.
    await waitUntil("the save", () =>
      readFileSync(join(docs, "set", "a.md"), "utf8").includes("edited"),
    );
  });

  test("a message carries about (selection and active path) to the tail", async () => {
    const path = (await state()).docs[0]?.versions[0]?.path ?? "";
    surface.send({
      op: "select",
      selection: {
        doc: "a",
        version: 1,
        path,
        fromLine: 3,
        toLine: 4,
        text: "line two, edited\nline three",
      },
    });
    surface.send({ op: "say", text: "tighten this", withSelection: true });
    const line = await waitTail((l) => l.type === "message");
    expect(line.text).toBe("tighten this");
    expect(line.about).toMatchObject({ doc: "a", version: 1, path, fromLine: 3, toLine: 4 });
    expect(typeof line.epoch).toBe("string");
    // What the human opened and saved earlier asked nothing of the agent.
    const seen = tailLines().map((l) => l.type);
    expect(seen).not.toContain("doc.opened");
    expect(seen).not.toContain("saved");
  });

  test("a note reaches the tail with its text and lines; the agent resolves it by id", async () => {
    const path = (await state()).docs[0]?.versions[0]?.path ?? "";
    const at = readFileSync(path, "utf8").indexOf("line three");
    surface.send({ op: "note.add", doc: "a", from: at, to: at + 10, body: "cut this?" });
    const added = await waitTail((l) => l.type === "note.added" && l.by === "human");
    expect(added).toMatchObject({
      doc: "a",
      quote: "line three",
      body: "cut this?",
      lines: { from: 4, to: 4 },
    });
    expect(String(added.hint)).toContain(
      `note-resolve ${added.note} --session ${sessionId} --doc a`,
    );
    // The answer that keeps the human's words is named where the agent first
    // meets the note (note-reply-cannot-overwrite).
    expect(String(added.hint)).toContain(
      `note-reply ${added.note} --session ${sessionId} --doc a "<answer>"`,
    );
    expect(String(added.hint)).not.toContain("note-edit");
    const notes = json<{ notes: { id: string }[] }>(await cli("notes", "--doc", "a"));
    expect(notes.notes.map((n) => n.id)).toEqual([String(added.note)]);
    expect((await cli("note-resolve", String(added.note), "--doc", "a")).code).toBe(0);
    // The agent's own resolve is on the log, not its tail: the verb's answer says it.
    expect(json<{ notes: unknown[] }>(await cli("notes", "--doc", "a")).notes).toEqual([]);
    const quoted = await cli("note", "--doc", "a", "--quote", "# A", "a title");
    expect(quoted.code).toBe(0);
    expect(json<{ quote: string }>(quoted).quote).toBe("# A");
  });

  // Per-note waiting: a note the human leaves is owed an
  // answer until it is resolved, the agent speaks after it, or the agent
  // rewrites it. The agent hears nothing new about it.
  const owed = async () => (await state()).notesWaiting ?? [];
  const S = () => ["--session", sessionId];

  test("a note is owed an answer, and a reply or a resolve closes it; a human reopen asks again", async () => {
    const path = (await state()).docs[0]?.versions[0]?.path ?? "";
    const at = readFileSync(path, "utf8").indexOf("line three");
    surface.send({ op: "note.add", doc: "a", from: at, to: at + 10, body: "owed one" });
    const first = await waitTail((l) => l.type === "note.added" && l.body === "owed one");
    expect(await owed()).toEqual([
      expect.objectContaining({ doc: "a", noteId: first.note, badge: "working" }),
    ]);
    // A system line is not an answer: the agent noting something posts one.
    expect((await cli("note", ...S(), "--doc", "a", "--quote", "# A", "narrated")).code).toBe(0);
    expect((await owed()).map((n) => n.noteId)).toEqual([String(first.note)]);
    expect((await cli("say", ...S(), "on it")).code).toBe(0);
    expect(await owed()).toEqual([]);

    // A second note, closed by resolving it, with nothing said.
    surface.send({ op: "note.add", doc: "a", from: at, to: at + 4, body: "and this" });
    const second = await waitTail((l) => l.type === "note.added" && l.body === "and this");
    expect((await owed()).map((n) => n.noteId)).toEqual([String(second.note)]);
    expect((await cli("note-resolve", ...S(), String(second.note), "--doc", "a")).code).toBe(0);
    expect(await owed()).toEqual([]);

    // Reopened by the human, it is owed again, timed from the reopen.
    const reopenedAfter = Date.now();
    surface.send({ op: "note.resolve", doc: "a", id: String(second.note), resolved: false });
    const reopened = await waitTail(
      (l) => l.type === "note.resolved" && l.note === second.note && l.resolved === false,
    );
    expect(reopened).toMatchObject({ body: "and this", lines: { from: 4, to: 4 } });
    expect(String(reopened.hint)).toContain(
      `note-reply ${second.note} --session ${sessionId} --doc a "<answer>"`,
    );
    const again = await owed();
    expect(again.map((n) => n.noteId)).toEqual([String(second.note)]);
    expect(Date.parse(again[0]?.since ?? "")).toBeGreaterThanOrEqual(reopenedAfter);
    expect((await cli("say", ...S(), "seen")).code).toBe(0);
    expect(await owed()).toEqual([]);
  });

  // About 21 CLI spawns in a row: measured at 1.0 s alone, 1.1 s in the parallel
  // suite and 3.0 s with 84 CPU burners beside it (kit-note-guard-lazy), so the
  // default 5 s was a coin toss under load. 20 s is over six times the worst.
  test("who rewrote or reopened a note is recorded, and decides whether it is owed", async () => {
    const note = (await state()).docs[0]?.notes.find((n) => n.body === "and this");
    if (!note) throw new Error("the previous test's note is missing");
    expect(await owed()).toEqual([]);

    // The human rewrites it: owed again, timed from the rewrite, and the tail
    // is told what it now says.
    const rewroteAfter = Date.now();
    surface.send({ op: "note.edit", doc: "a", id: note.id, body: "and this, rewritten" });
    const edited = await waitTail(
      (l) => l.type === "system" && l.fact === "note.edited" && l.by === "human",
    );
    expect(edited).toMatchObject({ note: note.id, body: "and this, rewritten", quote: "line" });
    expect(String(edited.hint)).toContain(
      `note-reply ${note.id} --session ${sessionId} --doc a "<answer>"`,
    );
    const again = await owed();
    expect(again.map((n) => n.noteId)).toEqual([note.id]);
    expect(Date.parse(again[0]?.since ?? "")).toBeGreaterThanOrEqual(rewroteAfter);

    // The agent may not rewrite the human's words (note-reply-cannot-overwrite):
    // refused in the house envelope, naming the reply, and the note is as it was.
    const refused = await cli("note-edit", ...S(), note.id, "--doc", "a", "agreed: cut");
    expect(refused.code).toBe(6);
    expect(refused.out).toBe("");
    const envelope = JSON.parse(refused.err) as {
      ok: boolean;
      error: { kind: string; choices?: string[]; hint?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.kind).toBe("conflict");
    expect(envelope.error.choices).toEqual(["note-reply", "note-resolve"]);
    expect(envelope.error.hint).toContain(`note-reply ${note.id} --doc a`);
    expect((await state()).docs[0]?.notes.find((n) => n.id === note.id)).toMatchObject({
      body: "and this, rewritten",
      editedBy: "human",
    });
    expect(await owed()).toHaveLength(1);

    // The reply answers it beside the note: the note keeps the human's words.
    const r = await cli("note-reply", ...S(), note.id, "--doc", "a", "agreed: cut");
    expect(r.code).toBe(0);
    const replied = json<{ id: string; doc: string; note: string }>(r);
    expect(replied).toMatchObject({ doc: "a", note: note.id });
    expect(await owed()).toEqual([]);
    const st = await state(true);
    const kept = st.docs[0]?.notes.find((n) => n.id === note.id);
    expect(kept).toMatchObject({ body: "and this, rewritten", editedBy: "human" });
    expect(kept).not.toHaveProperty("replacedBody");
    expect(st.chat.at(-1)).toMatchObject({
      id: replied.id,
      from: "agent",
      text: "agreed: cut",
      about: { noteId: note.id },
    });
    // A reply to a note that is not there is refused with the notes there are.
    const noNote = await cli("note-reply", ...S(), "n-nope", "--doc", "a", "x");
    expect(noNote.code).not.toBe(0);
    expect(JSON.parse(noNote.err).error.choices).toContain(note.id);

    // The agent still rewrites its own note.
    const own = json<{ note: string }>(
      await cli("note", ...S(), "--doc", "a", "--quote", "line", "mine"),
    );
    const ownEdit = await cli("note-edit", ...S(), own.note, "--doc", "a", "mine, better");
    expect(ownEdit.code).toBe(0);
    expect(json(ownEdit)).toMatchObject({ note: own.note, body: "mine, better" });
    expect((await cli("note-resolve", ...S(), own.note, "--doc", "a")).code).toBe(0);

    // A Save with nothing changed is not a rewrite: still answered, and nothing sent.
    surface.send({ op: "note.edit", doc: "a", id: note.id, body: "and this, rewritten" });
    surface.send({ op: "say", text: "marker three", withSelection: false });
    await waitTail((l) => l.type === "message" && l.text === "marker three");
    expect(await owed()).toEqual([]);
    expect(
      tailLines().filter((l) => l.fact === "note.edited" && l.note === note.id && l.by === "human"),
    ).toHaveLength(1);
    expect((await cli("say", ...S(), "marker seen")).code).toBe(0);

    // The agent resolving and then reopening it is an act on it, not a new ask.
    expect((await cli("note-resolve", ...S(), note.id, "--doc", "a")).code).toBe(0);
    expect((await cli("note-resolve", ...S(), note.id, "--doc", "a", "--reopen")).code).toBe(0);
    expect(await owed()).toEqual([]);
    expect((await state()).docs[0]?.notes.find((n) => n.id === note.id)?.reopenedBy).toBe("agent");

    // An unknown note is refused with the notes there are.
    const missing = await cli("note-edit", ...S(), "n-nope", "--doc", "a", "x");
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain("n-nope");
    // Put away, so later tests start with nothing owed.
    expect((await cli("note-resolve", ...S(), note.id, "--doc", "a")).code).toBe(0);
  }, 20_000);

  test("version-new by a fake agent: the agent edits that file and the surface receives the text", async () => {
    const r = await cli("version-new", "--label", "tighter");
    expect(r.code).toBe(0);
    const v = json<{ doc: string; version: number; path: string; from: number }>(r);
    expect(v).toMatchObject({ doc: "a", version: 2, from: 1 });
    await waitTail((l) => l.type === "version.created" && l.by === "agent" && l.version === 2);
    writeFileSync(v.path, "# A\n\ntight.\n");
    const pushed = await surface.waitFor(
      (m) => m.op === "version.text" && m.version === 2 && m.text === "# A\n\ntight.\n",
    );
    expect(pushed).toMatchObject({ origin: "remote" });
    // It never activated itself: the human chooses.
    expect((await state()).docs[0]?.active).toBe(1);
  });

  test("activate makes v2 the active version; Revert restores the saved file over it", async () => {
    const r = await cli("activate", "v2");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ doc: "a", version: 2, previous: 1 });
    surface.send({ op: "revert", doc: "a" });
    await waitTail((l) => l.type === "reverted");
    const st = await state();
    expect(st.docs[0]?.active).toBe(2);
    expect(readFileSync(st.docs[0]?.versions[1]?.path ?? "", "utf8")).toContain("edited");
  });

  test("a write to the active version from outside is preserved as a new version and announced", async () => {
    const st = await state();
    const activePath = st.docs[0]?.versions[1]?.path ?? "";
    const before = readFileSync(activePath, "utf8");
    writeFileSync(activePath, "the agent broke the rule\n");
    const line = await waitTail((l) => l.type === "system" && l.fact === "active.outside");
    expect(String(line.text)).toContain("active version");
    expect(line.preservedAs).toBe(3);
    expect(readFileSync(String(line.preservedPath), "utf8")).toBe("the agent broke the rule\n");
    // The active version keeps the human's text, and the new version is the agent's.
    expect(readFileSync(activePath, "utf8")).toBe(before);
    await waitTail((l) => l.type === "version.created" && l.preserved === true && l.version === 3);
    const s2 = await state(true);
    expect(s2.chat.some((m) => m.from === "system" && m.text.includes("active version"))).toBe(
      true,
    );
    expect(s2.docs[0]?.versions.map((v) => [v.n, v.by])).toEqual([
      [1, "human"],
      [2, "agent"],
      [3, "agent"],
    ]);
  });

  test("the agent's structure verbs and the surface's ops are one path: same change, announced to both", async () => {
    expect((await cli("new-folder", join(docs, "set", "drafts"))).code).toBe(0);
    expect((await cli("new-doc", join(docs, "set", "idea.md"))).code).toBe(0);
    expect(
      (await cli("move", join(docs, "set", "idea.md"), join(docs, "set", "drafts"))).code,
    ).toBe(0);
    expect(existsSync(join(docs, "set", "drafts", "idea.md"))).toBe(true);
    await waitTail((l) => l.fact === "move" && l.by === "agent");
    await surface.waitFor(
      (m) =>
        m.op === "state" &&
        m.state.chat.some((c) =>
          c.text.startsWith("Agent moved set/idea.md to set/drafts/idea.md"),
        ),
    );
    surface.send({ op: "doc.create", dir: join(docs, "set", "drafts") });
    const done = await surface.waitFor((m) => m.op === "structure.done");
    expect(done.op === "structure.done" && done.path).toBe(
      join(docs, "set", "drafts", "Untitled.md"),
    );
    await waitTail((l) => l.fact === "doc.create" && l.by === "human");
    const renamed = await cli("rename", join(docs, "set", "drafts", "idea.md"), "idea two");
    expect(json<{ path: string }>(renamed).path).toBe(join(docs, "set", "drafts", "idea two.md"));
    // Outside every mirrored entry: refused through the CLI's envelope.
    const bad = await cli("new-doc", join(root, "home", "stray.md"));
    expect(bad.code).toBe(2);
    expect(existsSync(join(root, "home", "stray.md"))).toBe(false);
  });

  test("a new session opened over several entries has the folder `open` ran in as its workspace", async () => {
    expect((await state()).workspace).toBe(root);
    const r = await cli("workspace");
    expect(r.code).toBe(0);
    expect(json<{ workspace: string }>(r)).toEqual({ workspace: root });
  });

  test("import copies a document into the workspace folder", async () => {
    const r = await cli("import", join(docs, "solo.md"));
    expect(r.code).toBe(0);
    const path = json<{ path: string }>(r).path;
    expect(path).toBe(join(root, "solo.md"));
    expect(readFileSync(path, "utf8")).toBe("# Solo\n");
    const st = await state();
    expect(st.context.map((e) => e.label)).toContain("solo.md");
    const folder = await cli("import", join(docs, "set"));
    expect(folder.code).toBe(2);
    expect(JSON.parse(folder.err).error.hint).toContain("add <folder>");
  });

  test("workspace <dir> sets it, relative to the caller's cwd, and an import then lands there", async () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    const r = await cliIn(root, "workspace", "elsewhere");
    expect(r.code).toBe(0);
    expect(json<{ path: string; from: string }>(r)).toMatchObject({
      path: join(root, "elsewhere"),
      from: root,
    });
    expect((await state()).workspace).toBe(join(root, "elsewhere"));
    expect(json<{ workspace: string }>(await cli("workspace")).workspace).toBe(
      join(root, "elsewhere"),
    );
    const made = json<{ path: string }>(await cli("new-doc", join(root, "elsewhere", "made.md")));
    expect(made.path).toBe(join(root, "elsewhere", "made.md"));
  });

  test("workspace refuses a missing folder (exit 5) and a file (exit 2), and keeps what it had", async () => {
    const gone = await cli("workspace", "no-such-folder");
    expect(gone.code).toBe(5);
    expect(JSON.parse(gone.err).error.kind).toBe("not_found");
    const file = await cli("workspace", join(docs, "solo.md"));
    expect(file.code).toBe(2);
    expect((await state()).workspace).toBe(join(root, "elsewhere"));
    // Put it back for the tests that follow.
    expect((await cli("workspace", root)).code).toBe(0);
  });

  test("reveal accepts only what the session knows: anything else is not_found (exit 5)", async () => {
    const bad = await cli("reveal", "/etc/passwd");
    expect(bad.code).toBe(5);
    expect(JSON.parse(bad.err).error.kind).toBe("not_found");
    const sibling = await cli("reveal", join(docs, "sibling.md"));
    expect(sibling.code).toBe(5);
  });

  test("tasks: an agent task, a human task it picks up, a cancel, and the app's own runner", async () => {
    const t = await cli("task", "Reworking section two");
    expect(t.code).toBe(0);
    const id = json<{ task: string; message_id: string }>(t);
    await waitTail((l) => l.type === "task.created" && l.task === id.task);
    expect((await state()).tasks.find((x) => x.id === id.task)).toMatchObject({
      by: "agent",
      status: "running",
      messageId: id.message_id,
    });
    const child = await cli("task", "--parent", id.task, "Check the timeline");
    expect(child.code).toBe(0);
    expect((await state()).tasks.find((x) => x.parent === id.task)).toBeDefined();

    surface.send({ op: "task.create", title: "render all sections" });
    const human = await waitTail((l) => l.type === "task.created" && l.by === "human");
    const hid = String(human.task);
    expect((await cli("task-status", hid, "reading the sections")).code).toBe(0);
    const done = await cli("task-done", hid, "all rendered");
    expect(json(done)).toMatchObject({ status: "done", already: false });
    await waitTail((l) => l.type === "task.done" && l.task === hid);

    surface.send({ op: "task.cancel", id: id.task });
    await waitTail((l) => l.type === "task.cancelled" && l.task === id.task && l.by === "human");
    expect((await cli("task-done", id.task)).code).toBe(6);

    const failed = await cli("task", "Something that will not work");
    await cli("task-done", json<{ task: string }>(failed).task, "--failed", "the file was gone");
    await waitTail((l) => l.type === "task.failed" && l.message === "the file was gone");

    // The fixture app's own verb queues a daemon job; its progress reaches the tail.
    const demo = json<{ task: string }>(await cli("demo", "Render intro"));
    await waitTail((l) => l.type === "task.progress" && l.task === demo.task && l.progress === 0.5);
    await waitTail((l) => l.type === "task.done" && l.task === demo.task);
    // The jobs cancelled below hold until they are: a demo's steps could end first.
    const hold = async (title: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
        method: "POST",
        body: JSON.stringify({ op: "kit-fixture.demo", title, hold: true }),
      });
      return (await res.json()) as { task: string };
    };
    const second = await hold("Render outro");
    await waitTail((l) => l.type === "task.progress" && l.task === second.task);
    surface.send({ op: "task.cancel", id: second.task });
    await waitTail((l) => l.type === "task.cancelled" && l.task === second.task);
    expect(tailLines().some((l) => l.type === "task.done" && l.task === second.task)).toBe(false);

    // The agent cancels a running job with the verb: the same abort, the same event.
    const third = await hold("Render coda");
    await waitTail((l) => l.type === "task.progress" && l.task === third.task);
    const cancelled = await cli("task-cancel", third.task);
    expect(json(cancelled)).toMatchObject({ status: "cancelled", already: false });
    await waitTail((l) => l.type === "task.cancelled" && l.task === third.task && l.by === "agent");
    expect(tailLines().some((l) => l.type === "task.done" && l.task === third.task)).toBe(false);

    // An app event, namespaced.
    expect((await cli("ping")).code).toBe(0);
    await waitTail((l) => l.type === "kit-fixture.pinged");
    // Twelve CLI runs, each a cold `bun` process, and three daemon jobs: about
    // 2.6 s on a quiet machine, past Bun's 5 s default with two gates running at
    // once. Every wait inside is on a condition; this is the budget for the whole
    // sequence, sized as the other launcher tests here are.
  }, 60_000);

  test("an unknown doc is not_found with the docs in hand as choices", async () => {
    const r = await cli("version-new", "--doc", "nope");
    expect(r.code).toBe(5);
    expect(JSON.parse(r.err).error.choices).toEqual(["a"]);
  });

  test("a held selection is dropped when another document comes on screen", async () => {
    const a = (await state()).docs[0];
    const onA = {
      doc: "a",
      version: a?.active ?? 0,
      path: a?.original ?? "",
      fromLine: 3,
      toLine: 3,
      text: "line two, edited",
    };
    surface.send({ op: "select", selection: onA });
    await Bun.sleep(100);
    expect((await state()).selection).toEqual(onA);
    expect((await cli("activate", "v1")).code).toBe(0);
    expect((await state()).selection).toBeNull();
    expect((await cli("activate", `v${onA.version}`)).code).toBe(0);
  });

  test("say reaches the chat; close ends the tail at 0, unlinks discovery, and the manifest stays", async () => {
    const body = join(root, "say.txt");
    writeFileSync(body, "Done: v2 is `tighter`.\n");
    expect((await cli("say", "--body-file", body)).code).toBe(0);
    expect((await cli("close")).code).toBe(0);
    const code = await tail?.exited;
    expect(code).toBe(0);
    // The `closed` frame, then the handoff line naming the way back.
    expect(
      tailLines()
        .map((l) => l.type)
        .slice(-2),
    ).toEqual(["closed", "tail.closed"]);
    expect(tailLines().at(-1)?.command).toBe(`open --restore ${sessionId} --no-open`);
    expect(existsSync(pointerFile(sessionId))).toBe(false);
    const manifest = JSON.parse(
      readFileSync(join(root, "home", "sessions", sessionId, "manifest.json"), "utf8"),
    );
    expect(manifest.chat.some((m: { from: string }) => m.from === "agent")).toBe(true);
    expect(manifest.format).toBe(1);
    expect(manifest.app).toEqual({ renders: [], version: 1 });
  });

  test("open --restore brings the session back, with a new epoch, and settles what the old daemon left", async () => {
    // Opened from another folder: a restored session keeps its own workspace.
    const r = await cliIn(join(root, "elsewhere"), "open", "--no-open", "--restore", sessionId);
    expect(r.code).toBe(0);
    const st = json<PublicState & { epoch: string }>(await cli("state"));
    expect(st.sessionId).toBe(sessionId);
    expect(st.workspace).toBe(root);
    expect(st.docs[0]?.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(st.docs[0]?.active).toBe(2);
    expect(st.docs[0]?.outsideChanged).toBe(false);
    // The agent's task that was still running stands as it was; the cancelled and failed ones too.
    expect(st.tasks.some((t) => t.by === "agent" && t.status === "running")).toBe(true);
    expect((await cli("close")).code).toBe(0);
  }, 60_000);

  test("an original changed while closed is flagged and announced on restore", async () => {
    writeFileSync(join(docs, "set", "a.md"), "# changed while the session was closed\n");
    expect((await cli("open", "--no-open", "--restore", sessionId)).code).toBe(0);
    const st = await state(true);
    expect(st.docs[0]?.outsideChanged).toBe(true);
    expect(
      st.chat.some((m) => m.from === "system" && m.text.includes("while this session was closed")),
    ).toBe(true);
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toBe(
      "# changed while the session was closed\n",
    );
    expect((await cli("close")).code).toBe(0);
  }, 60_000);
});

describe("agent presence, through the launchers", () => {
  test("open's own context.add is not presence: a fresh session reads no agent until a tail", async () => {
    const r = await cli("open", "--no-open", join(docs, "set"));
    expect(r.code).toBe(0);
    const sid = json<{ session_id: string }>(r).session_id;
    const pid = pointerPid(pointerFile(sid));
    expect(json<PublicState>(await cli("state", "--session", sid)).agentListening).toBe(false);
    // A verb the agent runs is presence.
    expect((await cli("say", "--session", sid, "here")).code).toBe(0);
    expect(json<PublicState>(await cli("state", "--session", sid)).agentListening).toBe(true);
    expect((await cli("close", "--session", sid)).code).toBe(0);
    if (pid !== null) await waitForExit(pid, 5000);
  }, 60_000);

  test("close with an agent tail attached exits promptly: draining the tail arms no hold", async () => {
    const r = await cli("open", "--no-open", join(docs, "set"));
    const sid = json<{ session_id: string }>(r).session_id;
    const pid = pointerPid(pointerFile(sid));
    expect(pid).not.toBeNull();
    const tail = Bun.spawn(["bun", CLI, "tail", "--session", sid], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    });
    for (let i = 0; i < 300; i++) {
      if (json<PublicState>(await cli("state", "--session", sid)).agentListening) break;
      await Bun.sleep(20);
    }
    expect(json<PublicState>(await cli("state", "--session", sid)).agentListening).toBe(true);
    expect((await cli("close", "--session", sid)).code).toBe(0);
    // A hold armed by the drain kept this process up for a minute (five after a --once).
    await waitForExit(pid as number, 5000);
    await tail.exited;
  }, 60_000);
});

describe("open over one folder, from another directory", () => {
  test("the folder holding it becomes the workspace (never the set's own folder), and open names it", async () => {
    const elsewhere = join(root, "elsewhere-cwd");
    mkdirSync(elsewhere, { recursive: true });
    const r = await cliIn(elsewhere, "open", "--no-open", join(docs, "set"));
    expect(r.code).toBe(0);
    const hs = json<{ session_id: string; workspace: string; entries: { root: string }[] }>(r);
    expect(hs.workspace).toBe(docs);
    // The folder itself is the set, so the two do not overlap.
    expect(hs.entries.map((e) => e.root)).toEqual([join(docs, "set")]);
    const st = json<PublicState>(await cli("state", "--session", hs.session_id));
    expect(st.workspace).toBe(docs);
    expect((await cli("close", "--session", hs.session_id)).code).toBe(0);
  }, 60_000);

  test("one file is not a folder: the workspace stays where open ran, and open names it", async () => {
    const elsewhere = join(root, "elsewhere-cwd");
    mkdirSync(elsewhere, { recursive: true });
    const r = await cliIn(elsewhere, "open", "--no-open", join(docs, "solo.md"));
    expect(r.code).toBe(0);
    const hs = json<{ session_id: string; workspace: string }>(r);
    expect(hs.workspace).toBe(elsewhere);
    expect((await cli("close", "--session", hs.session_id)).code).toBe(0);
  }, 60_000);
});

describe("hardening, through the launchers", () => {
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
    const hs = json<{ port: number; session_id: string }>(r);
    port = hs.port;
    sid0 = hs.session_id;
  }, 60_000);

  afterAll(async () => {
    const pid = pointerPid(pointerFile(sid0));
    await cli("close", "--session", sid0);
    if (pid !== null) await waitForExit(pid);
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

  test("a WebSocket upgrade from a foreign origin is refused (403)", async () => {
    expect((await upgrade("https://evil.example")).status).toBe(403);
    expect((await upgrade(`http://localhost:${port + 1}`)).status).toBe(403);
  });

  test("a /cmd POST from a foreign origin is refused and changes nothing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ op: "say", text: "pwned" }),
    });
    expect(res.status).toBe(403);
    const st = json<PublicState>(await cli("state", "--full"));
    expect(st.chat.some((m) => m.text === "pwned")).toBe(false);
  });

  test("open and save of a path outside the context are refused; the file is untouched", async () => {
    const s = new FakeSurface();
    await s.connect(port);
    for (const path of [victim, stray]) {
      s.send({ op: "open", path });
      s.send({ op: "save", doc: "victim" });
      s.send({ op: "save", doc: "stray" });
    }
    await s.waitFor((m) => m.op === "error" && m.message.includes("not in this session's context"));
    await Bun.sleep(200);
    s.close();
    expect(readFileSync(victim, "utf8")).toBe("export SAFE=1\n");
    expect(readFileSync(stray, "utf8")).toBe("# not in the context\n");
    expect(json<PublicState>(await cli("state")).docs.map((d) => d.original)).toEqual([]);
  });

  test("version-new --doc <relative path> opens a context doc implicitly, resolved against the CLI's cwd", async () => {
    const r = await cliIn(join(docs, "set"), "version-new", "--doc", "part/b.md");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(json(r)).toMatchObject({ doc: "b", version: 2 });
    expect(json<PublicState>(await cli("state")).openDoc).toBeNull(); // the human's open document did not move
    // ...and a path outside the context is still refused through the same door.
    expect((await cliIn(outside, "version-new", "--doc", "stray.md")).code).toBe(2);
  });

  test("open prunes the daemon logs to ten, and a clean close deletes its empty log", async () => {
    const logs = join(root, "home", "logs");
    for (let i = 0; i < 14; i++) writeFileSync(join(logs, `daemon-${1000 + i}-1.log`), "old\n");
    const r = await cli("open", "--no-open");
    const sid = json<{ session_id: string }>(r).session_id;
    expect(readdirSync(logs).filter((n) => n.startsWith("daemon-")).length).toBeLessThanOrEqual(10);
    const before = readdirSync(logs).length;
    expect((await cli("close", "--session", sid)).code).toBe(0);
    await Bun.sleep(600);
    expect(readdirSync(logs).length).toBe(before - 1);
  }, 60_000);

  test("open records the session it started as the newest: its id, and when", async () => {
    const record = join(root, "home", "last-opened.json");
    rmSync(record, { force: true });
    const r = await cli("open", "--no-open");
    const sid = json<{ session_id: string }>(r).session_id;
    // Written by its daemon at start, for every verb with no --session.
    const last = JSON.parse(readFileSync(record, "utf8")) as { session_id: string; at: string };
    expect(last.session_id).toBe(sid);
    expect(Date.now() - Date.parse(last.at)).toBeLessThan(60_000);
    expect((await cli("close", "--session", sid)).code).toBe(0);
  }, 60_000);

  test("open --restore of a session that does not exist is not_found with the saved ones as choices", async () => {
    const r = await cli("open", "--no-open", "--restore", "nope");
    expect(r.code).toBe(5);
    expect(JSON.parse(r.err).error.choices).toContain(sid0);
  });

  test("a verb naming a session that is not saved here says so, with the saved ones as choices", async () => {
    const r = await cli("state", "--session", "no-such-id");
    expect(r.code).toBe(5);
    const err = JSON.parse(r.err).error;
    expect(err.message).toContain("no kit-fixture session no-such-id is saved here");
    expect(err.hint).not.toContain("open --restore");
    expect(err.choices).toContain(sid0);
  });
});

describe("version-new with a body, through the launchers", () => {
  let sid = "";
  const folder = join(root, "bodies");
  mkdirSync(folder, { recursive: true });
  const doc = join(folder, "c.md");
  writeFileSync(doc, "# C\n\nfirst draft\n");
  writeFileSync(join(folder, "d.md"), "# D\n");
  const bodyFile = join(root, "body.txt");

  beforeAll(async () => {
    const r = await cli("open", "--no-open", folder);
    expect(r.code).toBe(0);
    sid = json<{ session_id: string }>(r).session_id;
  }, 60_000);

  afterAll(async () => {
    const pid = pointerPid(pointerFile(sid));
    await cli("close", "--session", sid);
    if (pid !== null) await waitForExit(pid);
  });

  /** The fixture CLI with stdin as given: text piped and closed, or a pipe held open and idle. */
  async function cliStdin(
    stdin: string,
    ...args: string[]
  ): Promise<{ code: number; out: string; err: string; ms: number }> {
    const t = Date.now();
    const idle = stdin === "<idle>";
    const p = Bun.spawn(["bun", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: idle ? "pipe" : new TextEncoder().encode(stdin),
      env,
      cwd: root,
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (idle) (p.stdin as { end(): void }).end();
    return { code, out, err, ms: Date.now() - t };
  }
  const vn = (...args: string[]) => ["version-new", "--session", sid, "--doc", doc, ...args];
  const versionsOf = async () =>
    json<PublicState>(await cli("state", "--session", sid)).docs.find((d) => d.slug === "c")
      ?.versions ?? [];
  const made = (r: { code: number; out: string; err: string }) =>
    json<{ doc: string; version: number; from: number; path: string; written: boolean }>(r);

  test("with no body it copies, as before", async () => {
    const r = await cli(...vn());
    expect(r.err).toBe("");
    const v = made(r);
    expect(v).toMatchObject({ doc: "c", version: 2, from: 1, written: false });
    // /dev/null is a character device: never looked at, never noted.
    expect("stdin" in json(r)).toBe(false);
    expect(readFileSync(v.path, "utf8")).toBe("# C\n\nfirst draft\n");
  });

  test("--stdin is the new version's text, written in the same act", async () => {
    const r = await cliStdin(
      "# C\n\npiped\n",
      ...vn("--from", "v1", "--label", "piped", "--stdin"),
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const v = made(r);
    expect(v).toMatchObject({ version: 3, from: 1, written: true });
    expect(readFileSync(v.path, "utf8")).toBe("# C\n\npiped\n");
    expect((await versionsOf()).find((x) => x.n === 3)?.label).toBe("piped");
  });

  test("--body-file is the new version's text", async () => {
    writeFileSync(bodyFile, "# C\n\nfrom a file\n");
    const a = await cli(...vn("--body-file", bodyFile));
    expect(a.err).toBe("");
    expect(readFileSync(made(a).path, "utf8")).toBe("# C\n\nfrom a file\n");
  });

  test("a pipe that closes with nothing on it copies", async () => {
    const r = await cliStdin("", ...vn());
    expect(r.err).toBe("");
    expect(made(r).written).toBe(false);
    expect("stdin" in json(r)).toBe(false);
  });

  test("text piped in without --stdin is refused, never dropped and never used", async () => {
    const before = (await versionsOf()).length;
    const r = await cliStdin("# C\n\npiped\n", ...vn());
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    const err = JSON.parse(r.err).error;
    expect(err.message).toContain("piped in");
    expect(err.hint).toContain("pass --stdin");
    expect((await versionsOf()).length).toBe(before);
  });

  test("beside --body-file, blank, or with both flags, it refuses and makes nothing", async () => {
    writeFileSync(bodyFile, "# C\n\nfrom a file\n");
    const before = (await versionsOf()).length;
    const both = await cliStdin("piped\n", ...vn("--body-file", bodyFile));
    expect(both.code).toBe(2);
    expect(both.out).toBe("");
    expect(JSON.parse(both.err).error.message).toContain("piped in and --body-file");
    const blank = await cliStdin("  \n", ...vn("--stdin"));
    expect(blank.code).toBe(2);
    expect(JSON.parse(blank.err).error.message).toContain("the text is empty");
    expect((await cli(...vn("--stdin", "--body-file", bodyFile))).code).toBe(2);
    expect((await cli(...vn("--body-file", join(folder, "nope.txt")))).code).toBe(5);
    expect((await versionsOf()).length).toBe(before);
  });

  test("an idle stdin its parent holds open copies at once, and --body-file is not delayed", async () => {
    const t0 = Date.now();
    const base = await cli(...vn());
    const baseMs = Date.now() - t0;
    expect(base.code).toBe(0);
    const t = Date.now();
    const r = await cliStdin("<idle>", ...vn());
    const ms = Date.now() - t;
    expect(r.err).toBe("");
    expect(made(r).written).toBe(false);
    // Copied, but not without a word: a slow writer's text would be lost silently.
    expect(json(r).stdin).toBe("open but silent: not read (pass --stdin to wait for text)");
    writeFileSync(bodyFile, "# C\n\nfrom a file\n");
    const f = await cliStdin("<idle>", ...vn("--body-file", bodyFile));
    expect(f.err).toBe("");
    expect(made(f).written).toBe(true);
    // The look lasts a tenth of a second at most: beside the same call with no
    // stdin at all, well under the second the old rule waited.
    expect(ms - baseMs).toBeLessThan(600);
  }, 20_000);

  test("in a while-read loop, the loop keeps its input: the first call refuses, the next copies", async () => {
    const other = join(folder, "d.md");
    const cBefore = (await versionsOf()).length;
    const script = `printf 'c.md\\nd.md\\n' | while read f; do bun "${CLI}" version-new --session ${sid} --doc "${folder}/$f" >/dev/null 2>&1; echo "$f:$?"; done`;
    const p = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe", env, cwd: root });
    const out = (await new Response(p.stdout).text()).trim().split("\n");
    await p.exited;
    // Both names reached the loop: version-new took none of its input.
    expect(out).toEqual(["c.md:2", "d.md:0"]);
    expect((await versionsOf()).length).toBe(cBefore);
    const d = json<PublicState>(await cli("state", "--session", sid)).docs.find(
      (x) => x.slug === "d",
    );
    expect(d?.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(readFileSync(d?.versions[1]?.path ?? "", "utf8")).toBe(readFileSync(other, "utf8"));
  }, 20_000);
});

describe("open --restore of a session the kit did not write", () => {
  test("a Scriptorium-shaped manifest is a conflict envelope with a hint, not a crash", async () => {
    // Scriptorium's shape (src/scriptorium/backend/session.ts): format 1, no
    // `app`, no `tasks`, times in milliseconds, chat by `who`.
    const id = "scr-shaped";
    const dir = join(root, "home", "sessions", id);
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.stringify({
      format: 1,
      sessionId: id,
      createdAt: 1_760_000_000_000,
      context: [],
      docs: [],
      openDoc: null,
      chat: [{ id: "m1", who: "human", text: "hello", ts: 1_760_000_000_000 }],
    });
    writeFileSync(join(dir, "manifest.json"), manifest);
    const r = await cli("open", "--no-open", "--restore", id);
    expect(r.out).toBe("");
    expect(r.code).toBe(6);
    const err = JSON.parse(r.err).error;
    expect(err.kind).toBe("conflict");
    expect(err.message).toContain("Scriptorium's shape");
    expect(err.hint).toContain("a Scriptorium session");
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(manifest);
    expect(existsSync(pointerFile(id))).toBe(false);
  }, 30_000);
});

describe("a daemon whose start fails after binding", () => {
  test("stops listening, leaves no pointer, and exits", async () => {
    // A port known to be free a moment ago, so the test can knock on it after.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    probe.stop(true);
    const tmp = join(root, "tmp-failed-start");
    mkdirSync(tmp, { recursive: true });
    const server = join(dirname(CLI), "server.ts");
    const preload = join(dirname(CLI), "failAfterBind.ts");
    const p = Bun.spawn(["bun", "--preload", preload, server, "--port", String(port)], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...env, TMPDIR: `${tmp}/` },
      cwd: root,
    });
    // Our own child, by its own pid: a daemon that never exits is killed here.
    const exited = await Promise.race([p.exited, Bun.sleep(10_000).then(() => null)]);
    if (exited === null) p.kill();
    const out = await new Response(p.stdout).text();
    expect(exited).toBe(1);
    expect(JSON.parse(out.trim())).toMatchObject({ ok: false, status: 500 });
    expect(out).toContain("planted");
    await expect(fetch(`http://127.0.0.1:${port}/state`)).rejects.toThrow();
    expect(readdirSync(tmp).filter((n) => n.startsWith("kit-fixture."))).toEqual([]);
  }, 30_000);
});

describe("open's timeouts reach the daemon", () => {
  /** Open with these flags; the session's id and pid, for the caller to close. */
  const openWith = async (...flags: string[]) => {
    const r = await cli("open", "--no-open", ...flags, join(docs, "solo.md"));
    const sid = r.code === 0 ? json<{ session_id: string }>(r).session_id : null;
    return { r, sid, pid: sid ? pointerPid(pointerFile(sid)) : null };
  };
  const closeIt = async (sid: string | null, pid: number | null) => {
    if (sid === null || pid === null || pointerPid(pointerFile(sid)) === null) return;
    await cli("close", "--session", sid);
    await waitForExit(pid);
  };

  test("--timeout is handed on: a one-second session closes on its own", async () => {
    const { r, sid, pid } = await openWith("--timeout", "1");
    expect(r.code).toBe(0);
    expect(pid).not.toBeNull();
    try {
      // Nobody connected: it idle-closes about a second after open's own add.
      await waitForExit(pid as number, 10_000);
    } finally {
      await closeIt(sid, pid);
    }
  }, 30_000);

  test("the token goes on as given: a 24-place count is not re-printed as 1e+23", async () => {
    const { r, sid, pid } = await openWith("--timeout", "100000000000000000000000");
    try {
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    } finally {
      await closeIt(sid, pid);
    }
  }, 30_000);

  test("--start-timeout keeps its 5 s floor, and its ceiling is accepted", async () => {
    for (const s of ["0", "2147483"]) {
      const { r, sid, pid } = await openWith("--start-timeout", s);
      try {
        expect(r.err, s).toBe("");
        expect(r.code, s).toBe(0);
      } finally {
        await closeIt(sid, pid);
      }
    }
  }, 60_000);
});

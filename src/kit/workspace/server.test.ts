// The composed daemon, in process: a real `Bun.serve` on loopback, the surface
// played by a WebSocket client, the agent by `fetch`. Launchers and the CLI are
// the integration tests' business; this file drives the daemon's own behaviour:
// routes, frames, events, tasks and runners, reveal, import, restore, waiting,
// teardown.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPointer } from "../wire/discovery";
import { KIT_EVENTS } from "./events";
import { fixtureDaemon } from "./fixtures/app";
import {
  cmd,
  collectEvents,
  type Ev,
  FakeSurface,
  waitUntil,
  writeUntilSeen,
} from "./fixtures/harness";
import { createWorkspaceDaemon, type WorkspaceDaemon } from "./server";
import { WorkspaceSession } from "./session";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let tmp: string;
let docs: string;
let ws: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;
let revealed: string[][];

beforeEach(() => {
  root = tempRoot("workspace-server");
  tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  process.env.KIT_FIXTURE_STEP_MS = "20";
  docs = seedDocs(root);
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  daemon = null;
  surface = null;
  tail = null;
  revealed = [];
});
afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

type Overrides = Parameters<typeof fixtureDaemon>[0];

/** Start a fixture daemon with a temp discovery dir and a reveal that only records. */
async function start(
  overrides: Overrides = {},
  opts: { connect?: boolean; listen?: boolean } = {},
) {
  daemon = fixtureDaemon({
    tmp,
    workspace: ws,
    platform: "darwin",
    reveal: (argv) => revealed.push(argv),
    ...overrides,
  });
  await daemon.start();
  const base = daemon.url;
  if (opts.listen !== false) tail = collectEvents(base);
  if (opts.connect !== false) {
    surface = new FakeSurface();
    await surface.connect(daemon.port);
  }
  return {
    d: daemon,
    base,
    s: surface as FakeSurface,
    t: tail as ReturnType<typeof collectEvents>,
  };
}

const inSet = (name: string) => join(docs, "set", name);

describe("the daemon's surface", () => {
  test("start gives url, port, session id and folder, and publishes the pointer", async () => {
    const { d } = await start({}, { connect: false, listen: false });
    expect(d.url).toBe(`http://127.0.0.1:${d.port}`);
    expect(d.dir).toBe(join(root, "home", "sessions", d.sessionId));
    expect(d.mode).toBe("dev");
    expect(existsSync(join(d.dir, "manifest.json"))).toBe(true);
    const pointer = readPointer("kit-fixture", d.sessionId, { tmp });
    expect(pointer).toMatchObject({
      url: d.url,
      port: d.port,
      session_id: d.sessionId,
      dir: d.dir,
    });
    expect(readPointer("kit-fixture", undefined, { tmp })?.session_id).toBe(d.sessionId);
  });

  test("it will not start twice, and its address is not available before it starts", async () => {
    const d = fixtureDaemon({ tmp });
    expect(() => d.url).toThrow(/not started/);
    await d.start();
    daemon = d;
    await expect(d.start()).rejects.toThrow(/already started/);
  });

  test("ready is the first event, and says what the idle timeout is", async () => {
    const { t, d } = await start({ timeoutS: 0 });
    const ready = await t.waitFor((e) => e.type === "ready");
    expect(ready).toMatchObject({
      app: "kit-fixture",
      session_id: d.sessionId,
      restored: false,
      idle_timeout_s: 0,
      mode: "dev",
    });
    expect(t.events[0]?.type).toBe("ready");
    expect(typeof ready.epoch).toBe("string");
  });

  test("GET /state is the snapshot derived from the entities", async () => {
    const { base } = await start();
    const st = (await (await fetch(`${base}/state`)).json()) as Record<string, unknown>;
    expect(Object.keys(st).sort()).toEqual(
      [
        "active",
        "agentListening",
        "app",
        "appState",
        "chat",
        "chatTotal",
        "context",
        "cursor",
        "dir",
        "docs",
        "epoch",
        "history",
        "launcher",
        "mode",
        "notesWaiting",
        "openDoc",
        "openImage",
        "prefs",
        "selection",
        "sessionId",
        "tasks",
        "userHome",
        "waiting",
        "workspace",
      ].sort(),
    );
    expect(st).toMatchObject({
      app: "kit-fixture",
      openDoc: null,
      selection: null,
      waiting: null,
      tasks: [],
      history: { canUndo: false, canRedo: false },
      appState: null,
    });
    expect(typeof st.cursor).toBe("number");
  });

  test("the WebSocket hello is the same snapshot, framed with op", async () => {
    const { s } = await start();
    const hello = await s.waitFor((m) => m.op === "state");
    expect(hello.op).toBe("state");
    expect(s.state.app).toBe("kit-fixture");
  });

  test("every frame the daemon sends has op, and none has a type at the top level", async () => {
    const { s } = await start();
    s.send({ op: "context.add", path: docs });
    await s.waitFor((m) => m.op === "state" && m.state.context.length === 1);
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "fs.list", path: docs });
    await s.waitFor((m) => m.op === "fs.list");
    for (const f of s.frames) {
      expect(typeof f.op).toBe("string");
      expect("type" in f).toBe(false);
    }
    expect(new Set(s.frames.map((f) => f.op))).toEqual(
      new Set(["state", "version.text", "fs.list"]),
    );
  });

  test("a message keeps type for display: a frame's discriminant is op", async () => {
    const { s } = await start();
    s.send({ op: "say", text: "hello", withSelection: false });
    await s.waitFor((m) => m.op === "state" && m.state.chat.length === 1);
    expect(s.state.chat[0]).toMatchObject({ from: "human", type: "message", text: "hello" });
    expect(typeof s.state.chat[0]?.id).toBe("string");
    expect(new Date(s.state.chat[0]?.ts ?? "").toISOString()).toBe(String(s.state.chat[0]?.ts));
  });

  test("the app's appState is part of the snapshot, built from its slot", async () => {
    const { s, d } = await start({
      appState: (ctx) => ({ renders: ctx.session.appSlot.renders }),
    });
    await s.waitFor((m) => m.op === "state");
    expect(s.state.appState).toEqual({ renders: [] });
    d.session.updateApp((slot) => {
      slot.renders = [{ id: "r1" }];
    });
    d.context.broadcast();
    await waitUntil("appState", () => JSON.stringify(s.state.appState).includes("r1"));
  });
});

describe("the origin guard", () => {
  test("a foreign Origin is refused on every path; the daemon's own page and a CLI are not", async () => {
    const { base, d } = await start({}, { connect: false, listen: false });
    const evil = { headers: { Origin: "https://evil.example" } };
    for (const path of ["/state", "/events?since=0", "/fs/list?path=~", "/ws"]) {
      const res = await fetch(`${base}${path}`, evil);
      expect(res.status, path).toBe(403);
    }
    const post = await fetch(`${base}/cmd`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ op: "close" }),
    });
    expect(post.status).toBe(403);
    // It did not close.
    expect((await fetch(`${base}/state`)).status).toBe(200);
    expect((await fetch(`${base}/state`, { headers: { Origin: base } })).status).toBe(200);
    expect(d.sessionId).toBeTruthy();
  });

  test("a foreign page cannot open a WebSocket to it", async () => {
    const { d } = await start({}, { connect: false, listen: false });
    const s = new FakeSurface();
    await expect(s.connect(d.port, "https://evil.example")).rejects.toThrow();
  });
});

describe("documents: open, edit, version, save", () => {
  test("opening v1, an edit that never reaches the original, and Save that does", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: inSet("a.md") });
    s.send({ op: "open", path: inSet("a.md") });
    const loaded = await s.waitFor((m) => m.op === "version.text" && m.origin === "load");
    expect(loaded.op === "version.text" && loaded.text).toBe("# A\n\none\n");
    expect(s.state.openDoc).toBe("a");
    const opened = await t.waitFor((e) => e.type === "doc.opened");
    expect(opened).toMatchObject({ doc: "a", by: "human" });

    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nedited\n" });
    await waitUntil("dirty", () => s.state.docs[0]?.dirty);
    expect(readFileSync(inSet("a.md"), "utf8")).toBe("# A\n\none\n");

    s.send({ op: "save", doc: "a" });
    const saved = await t.waitFor((e) => e.type === "saved");
    expect(saved).toMatchObject({ doc: "a", version: 1, by: "human" });
    expect(readFileSync(inSet("a.md"), "utf8")).toBe("# A\n\nedited\n");
  });

  test("a fake agent: version-new hands back a path, the write shows up as a version, and nothing is activated", async () => {
    const { s, t, base } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");

    const r = await cmd(base, { op: "version.new", doc: "a", label: "tighten" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, doc: "a", version: 2, from: 1 });
    const path = String(r.body.path);
    expect(path).toContain(join("docs", "a", "v2.md"));
    const created = await t.waitFor((e) => e.type === "version.created");
    expect(created).toMatchObject({
      doc: "a",
      version: 2,
      by: "agent",
      label: "tighten",
      fromVersion: 1,
    });

    // The docs folder's watch may have been armed just now.
    await writeUntilSeen(
      "v2 text pushed",
      () => writeFileSync(path, "# A\n\ntightened\n"),
      () =>
        s.frames.some((f) => f.op === "version.text" && f.version === 2 && f.origin === "remote"),
    );
    // The human still edits v1.
    expect(s.state.docs[0]?.active).toBe(1);
    expect(s.state.docs[0]?.versions.map((v) => [v.n, v.by])).toEqual([
      [1, "human"],
      [2, "agent"],
    ]);
    // A human chooses: activating is their act, and is announced.
    s.send({ op: "activate", doc: "a", version: 2 });
    const act = await t.waitFor((e) => e.type === "activated");
    expect(act).toMatchObject({ doc: "a", version: 2, previous: 1, by: "human" });
  });

  test("an outside write to the active version is preserved as a new version and announced", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "edit", doc: "a", version: 1, text: "what the human typed\n" });
    await waitUntil("dirty", () => s.state.docs[0]?.dirty);
    const active = s.state.docs[0]?.versions[0]?.path ?? "";

    // Open made the docs folder, whose watch is armed just now. The active
    // version is written back each time, so a repeat is one more kept version.
    const sys = await writeUntilSeen(
      "active.outside",
      () => writeFileSync(active, "the agent wrote here by mistake\n"),
      () => t.events.find((e) => e.type === "system" && e.fact === "active.outside"),
    );
    expect(sys).toMatchObject({ doc: "a", version: 1, preservedAs: 2 });
    expect(String(sys.text)).toContain("ACTIVE".toLowerCase());
    const created = await t.waitFor((e) => e.type === "version.created" && e.preserved === true);
    expect(created).toMatchObject({ doc: "a", version: 2, by: "agent" });
    // Nothing lost: the outside text is v2, the human's text is still v1.
    expect(readFileSync(join(active, "..", "v2.md"), "utf8")).toBe(
      "the agent wrote here by mistake\n",
    );
    expect(readFileSync(active, "utf8")).toBe("what the human typed\n");
    // And the chat said so, as a system line.
    await waitUntil("system line", () =>
      s.state.chat.some(
        (m) => m.from === "system" && m.type === "info" && m.text.includes("kept as v2"),
      ),
    );
  });

  test("a hand-written version file is adopted and announced", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const dir = join(s.state.docs[0]?.versions[0]?.path ?? "", "..");
    // Open made the docs folder, whose watch is armed just now.
    const created = await writeUntilSeen(
      "the adopted version",
      () => writeFileSync(join(dir, "v5.md"), "hand-made\n"),
      () => t.events.find((e) => e.type === "version.created" && e.adopted === true),
    );
    expect(created).toMatchObject({ doc: "a", version: 5, by: "agent" });
  });

  test("an outside change to the original reloads a clean buffer, and asks once about a dirty one", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    // The set's watch was armed a moment ago, by context.add.
    await writeUntilSeen(
      "original.reloaded",
      () => writeFileSync(inSet("a.md"), "# A changed elsewhere\n"),
      () => t.events.find((e) => e.type === "system" && e.fact === "original.reloaded"),
    );
    s.send({ op: "edit", doc: "a", version: 1, text: "my unsaved edit\n" });
    await waitUntil("dirty", () => s.state.docs[0]?.dirty);
    writeFileSync(inSet("a.md"), "# changed again\n");
    await t.waitFor((e) => e.type === "system" && e.fact === "original.conflict");
    await waitUntil("outsideChanged", () => s.state.docs[0]?.outsideChanged);
  });

  test("a version delete, revert and merge each say what they are", async () => {
    const { s, t, base } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const v2 = await cmd(base, { op: "version.new", doc: "a" });
    // Open made the docs folder, whose watch is armed just now.
    await writeUntilSeen(
      "v2's text",
      () => writeFileSync(String(v2.body.path), "# A\n\nmerged text\n"),
      () =>
        s.frames.some((f) => f.op === "version.text" && f.version === 2 && f.origin === "remote"),
    );

    const diff = await cmd(base, { op: "diff", doc: "a", against: 2 });
    expect(diff.body).toMatchObject({ same: false, active: 1, against: 2 });
    expect(String(diff.body.unified)).toContain("merged text");
    const hunks = (diff.body.hunks as { id: number }[]).map((h) => h.id);
    const merged = await cmd(base, { op: "merge", doc: "a", against: 2, hunks });
    expect(merged.body).toMatchObject({ applied: hunks.length, version: 1 });
    expect(await t.waitFor((e) => e.type === "merged")).toMatchObject({ by: "agent", against: 2 });

    s.send({ op: "revert", doc: "a" });
    expect(await t.waitFor((e) => e.type === "reverted")).toMatchObject({ doc: "a", by: "human" });

    s.send({ op: "version.delete", doc: "a", version: 2 });
    expect(await t.waitFor((e) => e.type === "version.deleted")).toMatchObject({
      doc: "a",
      version: 2,
      by: "human",
    });
    // The active version cannot be deleted: a refusal, not a crash.
    const refused = await cmd(base, { op: "version.delete", doc: "a", version: 1 });
    expect(refused.status).toBe(409);
  });
});

describe("messages and what they are about", () => {
  test("a message carries about: the selection, and the active path", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const path = s.state.docs[0]?.versions[0]?.path ?? "";
    s.send({
      op: "select",
      selection: { doc: "a", version: 1, path, fromLine: 3, toLine: 3, text: "one" },
    });
    s.send({ op: "say", text: "tighten this", withSelection: true });
    const ev = await t.waitFor((e) => e.type === "message");
    expect(ev.text).toBe("tighten this");
    expect(ev.about).toEqual({
      doc: "a",
      version: 1,
      path,
      fromLine: 3,
      toLine: 3,
      text: "one",
    });
    expect(typeof ev.message_id).toBe("string");
    expect(s.state.chat.at(-1)).toMatchObject({
      from: "human",
      type: "message",
      about: { doc: "a", fromLine: 3 },
    });
  });

  test("without the selection it still names the document on screen; with none open there is no about", async () => {
    const { s, t } = await start();
    s.send({ op: "say", text: "nothing open", withSelection: true });
    const first = await t.waitFor((e) => e.type === "message");
    expect("about" in first).toBe(false);
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "say", text: "now open", withSelection: false });
    const second = await t.waitFor((e) => e.type === "message" && e.text === "now open");
    expect(second.about).toMatchObject({ doc: "a", version: 1 });
    expect((second.about as Record<string, unknown>).text).toBeUndefined();
  });

  test("a selection from a document that is no longer on screen is dropped, not re-labelled", async () => {
    const { s, t } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const path = s.state.docs[0]?.versions[0]?.path ?? "";
    s.send({
      op: "select",
      selection: { doc: "a", version: 1, path, fromLine: 1, toLine: 1, text: "# A" },
    });
    s.send({ op: "open", path: join(docs, "solo.md") });
    await waitUntil("solo open", () => s.state.openDoc === "solo");
    s.send({ op: "say", text: "about what?", withSelection: true });
    const ev = await t.waitFor((e) => e.type === "message");
    expect((ev.about as Record<string, unknown>).text).toBeUndefined();
    expect(ev.about).toMatchObject({ doc: "solo" });
  });

  test("noteId rides about, the retired entryIds does not; an agent say is from agent and type message", async () => {
    const { s, t, base, d } = await start();
    s.send({
      op: "say",
      text: "what is in these?",
      withSelection: false,
      about: { entryIds: ["c-1", "c-2"] } as never,
    });
    const ev = await t.waitFor((e) => e.type === "message");
    // An old page's `entryIds` is not taken: nothing named a subject.
    expect(ev.about).toBeUndefined();
    // A message about a note names the commands to answer it, each with the session.
    s.send({ op: "say", text: "and this note?", withSelection: false, about: { noteId: "n-1" } });
    const onNote = await t.waitFor((e) => e.type === "message" && e.text === "and this note?");
    expect(String(onNote.hint)).toContain(`\`notes --session ${d.sessionId}\``);
    expect(String(onNote.hint)).toContain(`\`note-resolve n-1 --session ${d.sessionId}\``);
    const r = await cmd(base, { op: "say", text: "these are the two sets" });
    expect(r.status).toBe(200);
    await waitUntil("agent message", () => s.state.chat.some((m) => m.from === "agent"));
    expect(s.state.chat.at(-1)).toMatchObject({ from: "agent", type: "message" });
  });
});

describe("waiting", () => {
  test("an unanswered human message is reported to the agent once, with the text and the way out", async () => {
    const { s, t, d } = await start({ stallMs: 120, attentionMs: 40 });
    s.send({ op: "say", text: "are you there?", withSelection: false });
    const w = await t.waitFor((e) => e.type === "waiting");
    expect(w).toMatchObject({ text: "are you there?" });
    expect(String(w.hint)).toContain(`\`say "<reply>" --session ${d.sessionId}\``);
    expect(String(w.hint)).toContain(`\`working --session ${d.sessionId}\``);
    await waitUntil("badge", () => s.state.waiting?.badge === "stalled");
    await Bun.sleep(250);
    expect(t.of("waiting")).toHaveLength(1);
  });

  test("a reply clears it, and `working` silences the nudge for a message it is about", async () => {
    const { s, t, base } = await start({ stallMs: 150, attentionMs: 40 });
    s.send({ op: "say", text: "first", withSelection: false });
    await waitUntil("waiting state", () => s.state.waiting?.badge === "working");
    const snooze = await cmd(base, { op: "working", seconds: 30 });
    expect(snooze.status).toBe(200);
    expect(snooze.body.seconds).toBe(30);
    await Bun.sleep(400);
    expect(t.of("waiting")).toHaveLength(0);
    // Snoozed: still a pulse, not stalled.
    expect(s.state.waiting?.badge).toBe("working");
    await cmd(base, { op: "say", text: "on it" });
    await waitUntil("cleared", () => s.state.waiting === null);
  });
});

describe("agent presence", () => {
  test("no agent's tail: not listening, and another reader of the log does not count", async () => {
    const { s, base } = await start({ agentGraceMs: 80 });
    await s.waitFor((m) => m.op === "state");
    expect(s.state.agentListening).toBe(false);
    // `start` already attached a plain reader; a second one changes nothing.
    const other = collectEvents(base);
    await Bun.sleep(100);
    expect(s.state.agentListening).toBe(false);
    const snap = (await (await fetch(`${base}/state`)).json()) as { agentListening: boolean };
    expect(snap.agentListening).toBe(false);
    await other.stop();
  });

  test("an agent's tail attaching says listening at once; letting go says so after the grace", async () => {
    const { s, base } = await start({ agentGraceMs: 150 });
    await s.waitFor((m) => m.op === "state");
    const agent = collectEvents(base, -1, { agent: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    const snap = (await (await fetch(`${base}/state`)).json()) as { agentListening: boolean };
    expect(snap.agentListening).toBe(true);
    await agent.stop();
    // Within the grace a re-arm is the agent at work, not gone.
    await Bun.sleep(40);
    expect(s.state.agentListening).toBe(true);
    await waitUntil("not listening", () => s.state.agentListening === false, 2000);
  });

  test("a re-arm inside the grace never reads as gone, and two tails need both to let go", async () => {
    const { s, base } = await start({ agentGraceMs: 200 });
    await s.waitFor((m) => m.op === "state");
    const one = collectEvents(base, -1, { agent: true });
    const two = collectEvents(base, -1, { agent: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    await one.stop();
    await Bun.sleep(300);
    expect(s.state.agentListening).toBe(true);
    await two.stop();
    const rearm = collectEvents(base, -1, { agent: true });
    await Bun.sleep(300);
    expect(s.state.agentListening).toBe(true);
    await rearm.stop();
    await waitUntil("not listening", () => s.state.agentListening === false, 2000);
  });

  test("a call from the agent's CLI keeps it listening past the grace, and alone says it is there", async () => {
    const { s, base } = await start({ agentGraceMs: 200 });
    await s.waitFor((m) => m.op === "state");
    const agent = collectEvents(base, -1, { agent: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    await agent.stop();
    await Bun.sleep(120);
    // Mid-turn, no tail attached: a verb is the agent at work.
    expect((await cmd(base, { op: "working", seconds: 30 })).status).toBe(200);
    await Bun.sleep(160);
    // Past the tail's own grace, inside the call's.
    expect(s.state.agentListening).toBe(true);
    await waitUntil("not listening", () => s.state.agentListening === false, 2000);
    // A call with no tail ever attached is presence too.
    await cmd(base, { op: "say", text: "back" });
    await waitUntil("listening again", () => s.state.agentListening === true);
  });

  test("a --once that closes on a delivered frame holds presence through the turn; one that delivered nothing does not", async () => {
    const { s, base } = await start({ agentGraceMs: 100, agentOnceGraceMs: 700 });
    await s.waitFor((m) => m.op === "state");
    const cursor = ((await (await fetch(`${base}/state`)).json()) as { cursor: number }).cursor;
    const idle = collectEvents(base, cursor, { agent: true, once: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    // Stopped with nothing delivered: the short grace.
    await idle.stop();
    await waitUntil("not listening", () => s.state.agentListening === false, 2000);

    const once = collectEvents(base, cursor, { agent: true, once: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    s.send({ op: "say", text: "are you there?", withSelection: false });
    await once.waitFor((e) => e.type === "message");
    await once.stop();
    const woken = Date.now();
    await Bun.sleep(350);
    expect(s.state.agentListening).toBe(true);
    await waitUntil("not listening", () => s.state.agentListening === false, 3000);
    expect(Date.now() - woken).toBeGreaterThanOrEqual(550);
  });
});

describe("notes", () => {
  test("a human's note reaches the agent with its text and lines; resolving is announced", async () => {
    const { s, t, base, d } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "note.add", doc: "a", from: 5, to: 8, body: "cut this?" });
    const added = await t.waitFor((e) => e.type === "note.added");
    expect(added).toMatchObject({
      doc: "a",
      by: "human",
      quote: "one",
      body: "cut this?",
      lines: { from: 3, to: 3 },
    });
    expect(String(added.hint)).toContain(
      `note-resolve ${added.note} --session ${d.sessionId} --doc a`,
    );

    const notes = await cmd(base, { op: "notes", doc: "a" });
    expect((notes.body.notes as { id: string; fromLine: number; by: string }[])[0]).toMatchObject({
      id: added.note,
      fromLine: 3,
      by: "human",
    });

    const resolved = await cmd(base, {
      op: "note.resolve",
      doc: "a",
      id: String(added.note),
      resolved: true,
    });
    expect(resolved.body).toMatchObject({ resolved: true });
    expect(await t.waitFor((e) => e.type === "note.resolved")).toMatchObject({
      note: added.note,
      by: "agent",
      resolved: true,
    });

    // The agent notes a quote; the human sees it on the state.
    const a = await cmd(base, { op: "note.add", doc: "a", quote: "# A", body: "a title" });
    expect(a.status).toBe(200);
    await waitUntil("note on state", () => s.state.docs[0]?.notes.length === 2);
    expect(s.state.docs[0]?.notes.map((n) => n.by).sort()).toEqual(["agent", "human"]);
  });
});

describe("tasks", () => {
  test("a human task is visible on the agent's stream, and the agent picks it up and finishes it", async () => {
    const { s, t, base } = await start();
    s.send({ op: "task.create", title: "tighten the ending" });
    const created = await t.waitFor((e) => e.type === "task.created");
    expect(created).toMatchObject({ by: "human", title: "tighten the ending", status: "open" });
    expect("message_id" in created).toBe(false);
    expect(s.state.chat).toHaveLength(0); // no chat message: that is the point
    const id = String(created.task);

    const picked = await cmd(base, { op: "task.status", id, detail: "reading the ending" });
    expect(picked.body).toMatchObject({ status: "running", detail: "reading the ending" });
    expect((await t.waitFor((e) => e.type === "task.started")).by).toBe("agent");

    const done = await cmd(base, { op: "task.done", id, outcome: "cut two paragraphs" });
    expect(done.body).toMatchObject({ status: "done", already: false });
    expect(await t.waitFor((e) => e.type === "task.done")).toMatchObject({
      outcome: "cut two paragraphs",
    });
    await waitUntil("result line", () =>
      s.state.chat.some((m) => m.type === "result" && m.text.includes("cut two paragraphs")),
    );
  });

  test("a human task made from a chat message keeps that message's id; one from a message that is not there is refused", async () => {
    const { s, t } = await start();
    s.send({ op: "say", text: "please render all sections", withSelection: false });
    await waitUntil("said", () => s.state.chat.length === 1);
    const messageId = s.state.chat[0]?.id ?? "";
    s.send({ op: "task.create", title: "Render all sections", messageId });
    const created = await t.waitFor((e) => e.type === "task.created");
    expect(created).toMatchObject({ by: "human", message_id: messageId });
    expect(s.state.tasks[0]?.messageId).toBe(messageId);
    s.send({ op: "task.create", title: "From nowhere", messageId: "m-nope" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("no message m-nope");
    expect(t.of("task.created")).toHaveLength(1);
  });

  test("an agent task keeps the id of the message that announced it, and delegated work names its parent", async () => {
    const { s, t, base } = await start();
    const r = await cmd(base, { op: "task.create", title: "Reworking section two" });
    expect(r.body).toMatchObject({ status: "running" });
    const messageId = String(r.body.message_id);
    await waitUntil("announcement", () =>
      s.state.chat.some((m) => m.id === messageId && m.from === "agent"),
    );
    const view = s.state.tasks.find((x) => x.id === r.body.task);
    expect(view).toMatchObject({ by: "agent", status: "running", messageId });

    const child = await cmd(base, {
      op: "task.create",
      title: "Check the timeline",
      parent: String(r.body.task),
    });
    expect(child.status).toBe(200);
    expect(
      await t.waitFor((e) => e.type === "task.created" && e.parent === r.body.task),
    ).toMatchObject({
      by: "agent",
      title: "Check the timeline",
    });
    await waitUntil("child on state", () => s.state.tasks.some((x) => x.parent === r.body.task));
    const bad = await cmd(base, { op: "task.create", title: "orphan", parent: "t-nope" });
    expect(bad.status).toBe(404);
  });

  test("the human cancels an agent task: task.cancelled reaches the agent's stream", async () => {
    const { s, t, base } = await start();
    const r = await cmd(base, { op: "task.create", title: "Long job" });
    const id = String(r.body.task);
    s.send({ op: "task.cancel", id });
    const ev = await t.waitFor((e) => e.type === "task.cancelled");
    expect(ev).toMatchObject({ task: id, by: "human", was: "running" });
    await waitUntil(
      "cancelled on state",
      () => s.state.tasks.find((x) => x.id === id)?.status === "cancelled",
    );
    // The agent acknowledging a cancelled task gets a conflict, not a false "done".
    expect((await cmd(base, { op: "task.done", id })).status).toBe(409);
  });

  test("a failed task says why; cancel by the agent works; removing and clearing tidy the list", async () => {
    const { s, base } = await start();
    const a = await cmd(base, { op: "task.create", title: "A" });
    const b = await cmd(base, { op: "task.create", title: "B" });
    const failed = await cmd(base, {
      op: "task.done",
      id: String(a.body.task),
      outcome: "the file was gone",
      failed: true,
    });
    expect(failed.body).toMatchObject({ status: "failed" });
    await cmd(base, { op: "task.cancel", id: String(b.body.task) });
    await waitUntil("both finished", () => s.state.tasks.every((t) => t.status !== "running"));
    expect(s.state.tasks.find((t) => t.id === a.body.task)?.detail).toBe("the file was gone");
    s.send({ op: "task.remove", id: String(a.body.task) });
    await waitUntil("one removed", () => s.state.tasks.length === 1);
    s.send({ op: "tasks.clear" });
    await waitUntil("cleared", () => s.state.tasks.length === 0);
  });

  test("a runner task: progress reaches the stream and the snapshot, and settles done", async () => {
    const { s, t, base } = await start();
    const r = await cmd(base, { op: "kit-fixture.demo", title: "Render intro" });
    const id = String(r.body.task);
    expect(await t.waitFor((e) => e.type === "task.created")).toMatchObject({
      by: "daemon",
      kind: "demo",
    });
    const progress = await t.waitFor((e) => e.type === "task.progress" && e.progress === 0.5);
    expect(progress).toMatchObject({ task: id, detail: "step 2 of 4" });
    await t.waitFor((e) => e.type === "task.done");
    expect(t.of("task.progress").map((e) => e.progress)).toEqual([0.25, 0.5, 0.75, 1]);
    await waitUntil(
      "settled on state",
      () => s.state.tasks.find((x) => x.id === id)?.status === "done",
    );
    expect(s.state.tasks[0]).toMatchObject({ outcome: "4 steps", by: "daemon", kind: "demo" });
    // Progress is runtime-only: the stored task never carries it.
    const stored = JSON.parse(readFileSync(join(daemon?.dir ?? "", "manifest.json"), "utf8")) as {
      tasks: object[];
    };
    expect(stored.tasks[0]).not.toHaveProperty("progress");
  });

  test("cancelling a runner task aborts it: task.cancelled, no task.done, and the next queued job starts", async () => {
    process.env.KIT_FIXTURE_STEP_MS = "200";
    const { s, t, base } = await start();
    const first = await cmd(base, { op: "kit-fixture.demo", title: "First" });
    const second = await cmd(base, { op: "kit-fixture.demo", title: "Second" });
    await waitUntil(
      "first running",
      () => s.state.tasks.find((x) => x.id === first.body.task)?.status === "running",
    );
    // The state frame can trail the command's answer.
    await waitUntil("second listed", () => s.state.tasks.find((x) => x.id === second.body.task));
    expect(s.state.tasks.find((x) => x.id === second.body.task)?.status).toBe("open");
    s.send({ op: "task.cancel", id: String(first.body.task) });
    const ev = await t.waitFor((e) => e.type === "task.cancelled");
    expect(ev).toMatchObject({ task: first.body.task, by: "human" });
    await waitUntil(
      "second started",
      () => s.state.tasks.find((x) => x.id === second.body.task)?.status === "running",
    );
    expect(t.of("task.done")).toHaveLength(0);
    expect(s.state.tasks.find((x) => x.id === first.body.task)?.status).toBe("cancelled");
    s.send({ op: "task.cancel", id: String(second.body.task) });
    await waitUntil("both cancelled", () => s.state.tasks.every((x) => x.status === "cancelled"));
  });

  test("closing the daemon aborts a running job and records it cancelled", async () => {
    process.env.KIT_FIXTURE_STEP_MS = "500";
    const { s, base, d } = await start({}, { listen: false });
    const r = await cmd(base, { op: "kit-fixture.demo" });
    await waitUntil(
      "running",
      () => s.state.tasks.find((x) => x.id === r.body.task)?.status === "running",
    );
    const dir = d.dir;
    await d.stop();
    daemon = null;
    const stored = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      tasks: { status: string }[];
    };
    expect(stored.tasks[0]?.status).toBe("cancelled");
  });
});

describe("restore", () => {
  test("a restored session marks a daemon task that was running failed, and leaves the agent's alone", async () => {
    const first = await start({}, { connect: false, listen: false });
    const dir = first.d.dir;
    const id = first.d.sessionId;
    await first.d.stop();
    daemon = null;
    // A daemon that died mid-render leaves its manifest as it was: write that state.
    const s = WorkspaceSession.restore(
      join(root, "home", "sessions"),
      (await import("./fixtures/app")).fixtureApp,
      id,
    );
    const render = s.createTask({
      title: "Render one",
      by: "daemon",
      kind: "demo",
      status: "running",
    });
    const agent = s.createTask({ title: "Tighten", by: "agent", status: "running" });
    expect(existsSync(dir)).toBe(true);

    const { t, s: surf } = await start({ restore: id });
    const ready = await t.waitFor((e) => e.type === "ready");
    expect(ready).toMatchObject({ restored: true, session_id: id });
    const failed = await t.waitFor((e) => e.type === "task.failed");
    expect(failed).toMatchObject({ task: render.id, by: "daemon", restored: true });
    await waitUntil("state", () => surf.state.tasks.length === 2);
    const byId = Object.fromEntries(surf.state.tasks.map((x) => [x.id, x]));
    expect(byId[render.id]?.status).toBe("failed");
    expect(byId[agent.id]?.status).toBe("running");
    await waitUntil("restore line", () =>
      surf.state.chat.some((m) => m.text.includes("Render one") && m.text.includes("failed")),
    );
  });

  test("restoring a session that does not exist is a refusal the launcher can report", async () => {
    const d = fixtureDaemon({ tmp, restore: "nope" });
    await expect(d.start()).rejects.toMatchObject({ status: 404 });
  });

  test("the context, notes and chat come back; the event log starts fresh under a new epoch", async () => {
    const one = await start();
    one.s.send({ op: "context.add", path: docs });
    one.s.send({ op: "open", path: inSet("a.md") });
    await one.s.waitFor((m) => m.op === "version.text");
    one.s.send({ op: "say", text: "remember me", withSelection: false });
    await waitUntil("said", () => one.s.state.chat.length > 0);
    const epoch1 = (await one.t.waitFor((e) => e.type === "ready")).epoch;
    const id = one.d.sessionId;
    one.s.close();
    await one.t.stop();
    await one.d.stop();
    daemon = null;
    surface = null;
    tail = null;

    const two = await start({ restore: id });
    await waitUntil("restored chat", () => two.s.state.chat.some((m) => m.text === "remember me"));
    expect(two.s.state.context).toHaveLength(1);
    expect(two.s.state.docs.map((x) => x.slug)).toEqual(["a"]);
    const epoch2 = (await two.t.waitFor((e) => e.type === "ready")).epoch;
    expect(epoch2).not.toBe(epoch1);
    expect(two.t.events[0]?.id).toBe(1);
  });
});

describe("import and structure", () => {
  test("a dropped file is copied into the workspace, shown as an entry, and the surface is told where", async () => {
    const { s, t } = await start();
    s.send({ op: "import", name: "dropped.md", text: "# Dropped\n" });
    const done = await s.waitFor((m) => m.op === "structure.done");
    const path = join(ws, "dropped.md");
    expect(done).toEqual({ op: "structure.done", of: "import", path });
    expect(readFileSync(path, "utf8")).toBe("# Dropped\n");
    expect(s.state.context.map((e) => [e.label, e.membership])).toEqual([["dropped.md", "listed"]]);
    expect(await t.waitFor((e) => e.type === "system" && e.fact === "import")).toMatchObject({
      by: "human",
      path,
    });
    // It opens like any document.
    s.send({ op: "open", path });
    await waitUntil("opened", () => s.state.openDoc === "dropped");
  });

  test("the agent's import goes to the same place; a non-document is refused with the extensions", async () => {
    const { base } = await start({}, { connect: false, listen: false });
    const ok = await cmd(base, { op: "import", name: "from-agent.md", text: "x" });
    expect(ok.body.path).toBe(join(ws, "from-agent.md"));
    const bad = await cmd(base, { op: "import", name: "pic.png", text: "x" });
    expect(bad.status).toBe(400);
    expect(bad.body.choices).toContain(".md");
    expect(String(bad.body.hint)).toContain("picker");
  });

  test("new-doc, rename and move are announced under the name of whoever did them", async () => {
    const { s, t, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    // The set arrives over the socket; the create goes over HTTP and must not
    // overtake it (on CI it did, and the folder was not yet in the context).
    await waitUntil("the set", () => s.state.context.some((e) => e.root === join(docs, "set")));
    const made = await cmd(base, { op: "doc.create", dir: join(docs, "set"), name: "fresh.md" });
    expect(made.status).toBe(200);
    expect(await t.waitFor((e) => e.type === "system" && e.fact === "doc.create")).toMatchObject({
      by: "agent",
    });
    const renamed = await cmd(base, {
      op: "rename",
      path: String(made.body.path),
      name: "fresher",
    });
    expect(renamed.body.path).toBe(inSet("fresher.md"));
    const moved = await cmd(base, { op: "move", path: inSet("fresher.md"), into: inSet("part") });
    expect(moved.body.path).toBe(inSet(join("part", "fresher.md")));
    await waitUntil(
      "chat lines",
      () => s.state.chat.filter((m) => m.from === "system").length >= 3,
    );
  });

  test("a folder made in the workspace is announced as a set, one made in a set as a folder", async () => {
    const { s } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("the set", () => s.state.context.some((e) => e.root === join(docs, "set")));
    const lines = () => s.state.chat.filter((m) => m.text.startsWith("You created the "));
    // Unnamed, as the sidebar's New set button sends it: named as a set too.
    s.send({ op: "folder.create", dir: ws });
    await waitUntil("its chat line", () => lines().length === 1);
    expect(lines()[0]?.text).toStartWith("You created the set ");
    expect(lines()[0]?.text).toContain("New set");
    expect(s.state.context.some((e) => e.root === join(ws, "New set"))).toBe(true);
    await waitUntil("its undo", () => s.state.history.undoLabel !== undefined);
    expect(s.state.history.undoLabel).toBe("created the set New set");
    s.send({ op: "folder.create", dir: join(docs, "set") });
    await waitUntil("its chat line", () => lines().length === 2);
    expect(lines()[1]?.text).toStartWith("You created the folder ");
    expect(lines()[1]?.text).toContain("New folder");
    await waitUntil("its undo", () => s.state.history.undoLabel !== "created the set New set");
    expect(s.state.history.undoLabel).toBe("created the folder New folder");
  });

  test("the context's undo: a creation's undo needs the human's confirmation, and is then done", async () => {
    const { s, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    s.send({ op: "doc.create", dir: join(docs, "set"), name: "temp.md" });
    await waitUntil("undo available", () => s.state.history.canUndo);
    expect(s.state.history.undoDeletes).toEqual({ path: inSet("temp.md"), dir: false });
    s.send({ op: "history.undo" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("confirm");
    expect(existsSync(inSet("temp.md"))).toBe(true);
    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("deleted", () => !existsSync(inSet("temp.md")));
    await waitUntil("history cleared", () => !s.state.history.canUndo);
    expect(base).toBeTruthy();
  });

  test("a move can be undone and redone", async () => {
    const { s } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    s.send({ op: "move", path: inSet("a.md"), into: inSet("part") });
    await waitUntil("moved", () => existsSync(inSet(join("part", "a.md"))));
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => existsSync(inSet("a.md")));
    await waitUntil("redo available", () => s.state.history.canRedo);
    s.send({ op: "history.redo" });
    await waitUntil("redone", () => existsSync(inSet(join("part", "a.md"))));
  });

  test("an undo that can never succeed (its folder is gone) comes off the list, so older acts stay reachable", async () => {
    const { s, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "note.md"), "# Note\n");
    s.send({ op: "context.add", path: join(outside, "note.md") });
    await waitUntil("context", () => s.state.context.length === 2);
    // The older act, then the one whose way back will vanish.
    s.send({ op: "move", path: inSet("a.md"), into: inSet("part") });
    await waitUntil("older move", () => existsSync(inSet(join("part", "a.md"))));
    expect((await cmd(base, { op: "move", path: join(outside, "note.md"), into: ws })).status).toBe(
      200,
    );
    await waitUntil("moved", () => s.state.history.undoLabel === "moved note.md into ws");
    rmSync(outside, { recursive: true });
    s.send({ op: "history.undo" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("taken off the undo list");
    await waitUntil("off the list", () => s.state.history.undoLabel === "moved a.md into part");
    // The next undo reaches the older act.
    s.send({ op: "history.undo" });
    await waitUntil("older undone", () => existsSync(inSet("a.md")));
  });

  test("a redo that can never succeed comes off the redo list too", async () => {
    const { s } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    s.send({ op: "move", path: inSet("a.md"), into: inSet("part") });
    await waitUntil("moved", () => existsSync(inSet(join("part", "a.md"))));
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    // Its way forward goes: the folder it would move into is gone.
    rmSync(inSet("part"), { recursive: true });
    s.send({ op: "history.redo" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("taken off the redo list");
    await waitUntil("off the redo list", () => !s.state.history.canRedo);
  });

  test("a whole set moved into the workspace from elsewhere is undone back to where it was", async () => {
    const { s, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    const moved = await cmd(base, { op: "move", path: join(docs, "set"), into: ws });
    expect(moved.status).toBe(200);
    await waitUntil("moved", () => existsSync(join(ws, "set", "a.md")));
    // `docs` is no set and not the workspace: the undo still goes back there.
    s.send({ op: "history.undo" });
    await waitUntil("back", () => existsSync(inSet("a.md")));
    await waitUntil("followed", () => s.state.context[0]?.root === join(docs, "set"));
    expect(s.state.history.canUndo).toBe(false);
    s.send({ op: "history.redo" });
    await waitUntil("redone", () => existsSync(join(ws, "set", "a.md")));
  });

  test("a move out of a set to the workspace is one act for either party: announced, listed, one undo back", async () => {
    const { s, t, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    // The human, from the surface.
    s.send({ op: "move", path: inSet("a.md"), into: ws });
    expect(await s.waitFor((m) => m.op === "structure.done" && m.of === "move")).toMatchObject({
      path: join(ws, "a.md"),
    });
    expect(await t.waitFor((e) => e.type === "system" && e.fact === "move")).toMatchObject({
      by: "human",
      from: inSet("a.md"),
      path: join(ws, "a.md"),
    });
    await waitUntil("listed", () =>
      s.state.context.some((e) => e.membership === "listed" && e.root === ws),
    );
    await waitUntil("announced", () =>
      s.state.chat.some((m) => m.text === "You moved set/a.md to the workspace."),
    );
    // One entry on the undo stack, and the undo puts it back in the set.
    expect(s.state.history.undoLabel).toBe("moved a.md into ws");
    s.send({ op: "history.undo" });
    await waitUntil("back in the set", () => existsSync(inSet("a.md")));
    await waitUntil("not listed", () => s.state.context.length === 1);
    // The agent, through the same act.
    const moved = await cmd(base, { op: "move", path: inSet(join("part", "b.md")), into: ws });
    expect(moved.body).toMatchObject({ path: join(ws, "b.md"), from: inSet(join("part", "b.md")) });
    expect(
      await t.waitFor((e) => e.type === "system" && e.fact === "move" && e.by === "agent"),
    ).toMatchObject({ path: join(ws, "b.md") });
  });
});

describe("reveal", () => {
  test("a path the session knows is revealed with open -R, and announced", async () => {
    const { s, t, base, d } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    const r = await cmd(base, { op: "reveal", path: inSet("a.md") });
    expect(r.body).toMatchObject({ revealed: true, path: inSet("a.md") });
    expect(revealed).toEqual([["open", "-R", inSet("a.md")]]);
    expect(await t.waitFor((e) => e.type === "system" && e.fact === "reveal")).toMatchObject({
      by: "agent",
    });
    // The session folder and its contents too.
    s.send({ op: "reveal", path: d.dir });
    await waitUntil("surface reveal", () => revealed.length === 2);
    expect(revealed[1]).toEqual(["open", "-R", d.dir]);
  });

  test("anything else is refused as not found, and nothing is spawned", async () => {
    const { s, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    const r = await cmd(base, { op: "reveal", path: "/etc/passwd" });
    expect(r.status).toBe(404);
    const sibling = await cmd(base, { op: "reveal", path: join(docs, "solo.md") });
    expect(sibling.status).toBe(404);
    s.send({ op: "reveal", path: "/etc" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("not a path this session knows");
    // A version reveal is resolved by the daemon, never named by the surface.
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "reveal.version", doc: "a", version: 1 });
    await waitUntil("version reveal", () => revealed.length === 1);
    expect(revealed).toHaveLength(1);
    expect(String(revealed[0]?.[2])).toContain(join("docs", "a", "v1.md"));
  });

  test("on Linux it opens the parent folder", async () => {
    const { s, base } = await start({ platform: "linux" });
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    await cmd(base, { op: "reveal", path: inSet("a.md") });
    expect(revealed).toEqual([["xdg-open", join(docs, "set")]]);
  });
});

describe("files, prefs, and the native picker", () => {
  test("/fs/list lists directories, documents and images only; /fs/version reads a version", async () => {
    const { base, s } = await start();
    const listing = (await (
      await fetch(`${base}/fs/list?path=${encodeURIComponent(join(docs, "set"))}`)
    ).json()) as {
      entries: { name: string; dir: boolean }[];
    };
    expect(listing.entries.map((e) => [e.name, e.dir])).toEqual([
      ["part", true],
      ["a.md", false],
      ["skip.png", false],
    ]);
    const missing = await fetch(
      `${base}/fs/list?path=${encodeURIComponent(join(docs, "nowhere"))}`,
    );
    expect(missing.status).toBe(404);
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const v = (await (await fetch(`${base}/fs/version?doc=a&v=1`)).json()) as { text: string };
    expect(v.text).toBe("# A\n\none\n");
    expect((await fetch(`${base}/fs/version?doc=a&v=9`)).status).toBe(404);
  });

  test("fs.list over the WebSocket answers the asking surface", async () => {
    const { s } = await start();
    s.send({ op: "fs.list", path: join(docs, "set") });
    const r = await s.waitFor((m) => m.op === "fs.list");
    expect(r.op === "fs.list" && r.entries.map((e) => e.name)).toEqual([
      "part",
      "a.md",
      "skip.png",
    ]);
    s.send({ op: "fs.list", path: join(docs, "nowhere") });
    await waitUntil("error entry", () =>
      s.frames.some((f) => f.op === "fs.list" && f.error !== undefined),
    );
  });

  test("prefs persist beside the sessions, merge with another session's keys, and refuse a bad key", async () => {
    const { s, d } = await start();
    s.send({ op: "prefs.set", key: "panes:test", value: '{"context":40}' });
    await waitUntil("pref", () => s.state.prefs["panes:test"] === '{"context":40}');
    const file = join(d.dir, "..", "..", "prefs.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(onDisk["panes:test"]).toBe('{"context":40}');
    writeFileSync(file, JSON.stringify({ ...onDisk, "other:session": "kept" }));
    s.send({ op: "prefs.set", key: "theme", value: "light" });
    await waitUntil("theme", () => s.state.prefs.theme === "light");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      "other:session": "kept",
      theme: "light",
    });
    s.send({ op: "prefs.set", key: "../../etc/passwd", value: "x" });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("refused pref");
  });

  test("the native picker adds what it returns, says nothing for a cancelled dialog, and one is open at a time", async () => {
    let release: (r: { paths: string[]; cancelled: boolean }) => void = () => {};
    const { s } = await start({
      pick: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    s.send({ op: "pick", want: "context-folder" });
    await Bun.sleep(30);
    s.send({ op: "pick", want: "context-file" });
    const busy = await s.waitFor((m) => m.op === "error");
    expect(busy.op === "error" && busy.message).toContain("already open");
    release({ paths: [join(docs, "set")], cancelled: false });
    await waitUntil("added", () => s.state.context.length === 1);
    const before = s.frames.length;
    s.send({ op: "pick", want: "context-file" });
    await Bun.sleep(30);
    release({ paths: [], cancelled: true });
    await Bun.sleep(60);
    expect(s.frames.slice(before).filter((f) => f.op === "error")).toHaveLength(0);
    expect(s.state.context).toHaveLength(1);
  });
});

describe("the app's own verbs and events", () => {
  test("an app verb is reachable from /cmd, emits its own namespaced event, and returns its result", async () => {
    const { t, base } = await start();
    const r = await cmd(base, { op: "kit-fixture.ping", n: 7 });
    expect(r).toEqual({ status: 200, body: { ok: true, pinged: true } });
    expect(await t.waitFor((e) => e.type === "kit-fixture.pinged")).toMatchObject({ n: 7 });
  });

  test("an app verb is reachable from the WebSocket too, with a reply channel", async () => {
    const { s, t } = await start({
      verbs: {
        "kit-fixture.hello": (_ctx, args, call) => {
          call.reply({ op: "kit-fixture.hello.reply", got: args.n, from: call.from });
        },
      },
    });
    s.send({ op: "kit-fixture.hello", n: 3 });
    const f = await s.waitFor((m) => (m.op as string) === "kit-fixture.hello.reply");
    expect(f).toMatchObject({ got: 3, from: "surface" });
    // The tail reads too; its first event may not have arrived yet.
    await t.waitFor(() => true);
  });

  test("an app cannot emit an event it did not declare, or one in another app's namespace", async () => {
    const { d } = await start({}, { connect: false, listen: false });
    expect(() => d.context.emit("kit-fixture.unknown")).toThrow(/unknown event/);
    expect(() => d.context.emit("other.thing")).toThrow(/unknown event/);
    expect(() => d.context.emit("bogus")).toThrow(/unknown event/);
    expect(() => d.context.emit("kit-fixture.pinged")).not.toThrow();
    for (const kit of KIT_EVENTS) expect(() => d.context.emit(kit)).not.toThrow();
  });

  test("events and verbs are validated against the app's own namespace at construction", () => {
    expect(() => fixtureDaemon({ events: { "other.pinged": "wake" } })).toThrow(
      /must be named kit-fixture/,
    );
    expect(() => fixtureDaemon({ events: { "kit-fixture.": "wake" } })).toThrow(/must be named/);
    expect(() =>
      fixtureDaemon({ events: { "kit-fixture.pinged": "loud" as unknown as "wake" } }),
    ).toThrow(/"wake" or "quiet"/);
    expect(() => fixtureDaemon({ verbs: { render: () => {} } })).toThrow(
      /must be named kit-fixture/,
    );
    // A kit op name cannot be shadowed: it would have to start with the app's own prefix.
    expect(() => fixtureDaemon({ verbs: { say: () => {} } })).toThrow(/must be named/);
  });

  test("an unknown op is refused with the ops there are", async () => {
    const { base } = await start({}, { connect: false, listen: false });
    const r = await cmd(base, { op: "nonsense" });
    expect(r.status).toBe(400);
    expect(r.body.choices).toContain("version.new");
    expect(r.body.choices).toContain("kit-fixture.ping");
    const noBody = await fetch(`${base}/cmd`, { method: "POST", body: "not json" });
    expect(noBody.status).toBe(400);
  });

  test("a command that is not an object, or whose fields are of the wrong type, is refused before it runs", async () => {
    const { base, d } = await start({}, { connect: false, listen: false });
    const raw = (body: string) => fetch(`${base}/cmd`, { method: "POST", body });
    for (const body of ["null", "[]", "3", '"say"']) {
      const r = await raw(body);
      expect(r.status, body).toBe(400);
      expect(((await r.json()) as { error: string }).error).toContain("JSON object");
    }
    const before = d.session.messages().length;
    const cases: [Record<string, unknown> & { op: string }, RegExp][] = [
      [{ op: "say" }, /say: text must be non-empty text/],
      [{ op: "say", text: { x: 1 } }, /say: text must be non-empty text/],
      [{ op: "say", text: 123 }, /say: text must be non-empty text/],
      [{ op: "say", text: "  " }, /say: text must be non-empty text/],
      [{ op: "reveal", path: null }, /reveal: path must be a string/],
      [{ op: "reveal" }, /reveal: path must be a string/],
      [{ op: "context.add", paths: "a" }, /context.add: paths must be a list of strings/],
      [{ op: "context.add", paths: [1] }, /context.add: paths must be a list of strings/],
      [{ op: "note.add", quote: 1, body: "b" }, /note.add: quote must be a string/],
      [{ op: "note.resolve", id: "n", resolved: "yes" }, /note.resolve: resolved must be true/],
      [{ op: "task.create", title: 5 }, /task.create: title must be a string/],
      [{ op: "activate", version: "2" }, /activate: version must be a number/],
      [{ op: "version.new", label: 7 }, /version.new: label must be a string when given/],
      [{ op: "rename", path: "/x", name: null }, /rename: name must be a string/],
      [{ op: "workspace.set", path: 1 }, /workspace.set: path must be a string/],
      [{ op: "image.describe", image: null }, /image.describe: image must be a string/],
    ];
    for (const [body, said] of cases) {
      const r = await cmd(base, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(String(r.body.error), JSON.stringify(body)).toMatch(said);
    }
    // Nothing reached the conversation, and nothing was revealed.
    expect(d.session.messages().length).toBe(before);
    expect(revealed).toEqual([]);
    // An optional field may be left out or null, and a good say still goes.
    expect((await cmd(base, { op: "say", text: "fine", about: null })).status).toBe(200);
    expect((await cmd(base, { op: "notes", doc: null })).status).not.toBe(500);
  });

  test("the app's own http hook answers first, and falls through when it has nothing to say", async () => {
    const { base } = await start(
      {
        http: (_req, url) =>
          url.pathname === "/audio/x" ? new Response("audio", { status: 200 }) : undefined,
      },
      { connect: false, listen: false },
    );
    expect(await (await fetch(`${base}/audio/x`)).text()).toBe("audio");
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});

describe("doctor and the startup check", () => {
  test("a clean session says nothing at startup; a ghost is reported once, in chat and on the tail", async () => {
    const one = await start({}, { connect: false, listen: false });
    const clean = await (await fetch(`${one.base}/state?full=1`)).json();
    expect((clean as { chat: unknown[] }).chat).toHaveLength(0);
    one.s = undefined as never;
    const id = one.d.sessionId;
    // Put a ghost in the manifest: an entry whose file is gone.
    writeFileSync(join(docs, "ghost.md"), "x");
    const r = await cmd(one.base, { op: "context.add", paths: [join(docs, "ghost.md")] });
    expect(r.status).toBe(200);
    await one.d.stop();
    daemon = null;
    rmSync(join(docs, "ghost.md"));

    const two = await start({ restore: id });
    const ev = await two.t.waitFor((e) => e.type === "doctor");
    expect(ev.count).toBe(1);
    expect((ev.findings as { kind: string }[])[0]?.kind).toBe("context.ghost");
    await waitUntil("startup line", () =>
      two.s.state.chat.some((m) => m.text.startsWith("Startup check")),
    );
    const report = await cmd(two.base, { op: "doctor" });
    expect(report.body.count).toBe(1);
  });
});

describe("teardown", () => {
  test("close: discovery is gone before `closed` is seen, the manifest is written, and the daemon exits 0", async () => {
    const { base, d } = await start({}, { connect: false, listen: false });
    const seenPointerAtClosed: boolean[] = [];
    const t = collectEvents(base);
    await t.waitFor((e) => e.type === "ready");
    const closed = t
      .waitFor((e) => e.type === "closed")
      .then((e) => {
        seenPointerAtClosed.push(readPointer("kit-fixture", d.sessionId, { tmp }) !== null);
        return e;
      });
    await cmd(base, { op: "close" });
    await closed;
    expect(seenPointerAtClosed).toEqual([false]);
    expect(await d.done).toEqual({ code: 0, reason: "close", by: "agent" });
    await d.shutdown;
    expect(readPointer("kit-fixture", undefined, { tmp })).toBeNull();
    expect(existsSync(join(d.dir, "manifest.json"))).toBe(true);
    daemon = null;
    await t.stop();
  });

  test("the surface's close ends the session: closed carries by human, the page is told, and the daemon exits 0", async () => {
    const { base, d, s } = await start({}, { listen: false });
    const t = collectEvents(base);
    await t.waitFor((e) => e.type === "ready");
    const closed = t.waitFor((e) => e.type === "closed");
    s.send({ op: "close" });
    expect((await closed).by).toBe("human");
    expect(await d.done).toEqual({ code: 0, reason: "close", by: "human" });
    expect(await s.waitFor((f) => f.op === "closed")).toEqual({ op: "closed", by: "human" });
    await d.shutdown;
    daemon = null;
    await t.stop();
  });

  test("a CLI close is recorded as by agent", async () => {
    const { base, d } = await start({}, { connect: false, listen: false });
    const t = collectEvents(base);
    await t.waitFor((e) => e.type === "ready");
    const closed = t.waitFor((e) => e.type === "closed");
    await cmd(base, { op: "close" });
    expect((await closed).by).toBe("agent");
    await d.shutdown;
    daemon = null;
    await t.stop();
  });

  test("a stop with nothing connected does not wait out the drain grace", async () => {
    const { d } = await start({ drainGraceMs: 5_000 }, { connect: false, listen: false });
    const t0 = performance.now();
    await d.stop();
    expect(performance.now() - t0).toBeLessThan(2_000);
    daemon = null;
  });

  test("a stop with a tail connected still waits the grace and the tail still hears `closed`", async () => {
    const { base, d } = await start({ drainGraceMs: 300 }, { connect: false, listen: false });
    const t = collectEvents(base);
    await t.waitFor((e) => e.type === "ready");
    const closed = t.waitFor((e) => e.type === "closed");
    const t0 = performance.now();
    await d.stop();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    expect((await closed).type).toBe("closed");
    daemon = null;
    await t.stop();
  });

  test("a close sent over HTTP is answered: its own request keeps the grace open", async () => {
    const { base, d } = await start({ drainGraceMs: 300 }, { connect: false, listen: false });
    const t0 = performance.now();
    const res = await cmd(base, { op: "close" });
    expect(res.status).toBe(200);
    await d.shutdown;
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
    daemon = null;
  });

  // The idle timeout is 30 minutes in production; these pass 0.6 s. The sweep
  // that notices runs every 250 ms, so a close that fired at once would land
  // near 250 ms, a full sweep and more under the 600 ms bound, and the right
  // close lands within a sweep or two after it.
  test("idle with no surface and no tail closes the daemon with code 124", async () => {
    const t0 = performance.now();
    const { d } = await start({ timeoutS: 0.6 }, { connect: false, listen: false });
    const res = await d.done;
    const took = performance.now() - t0;
    expect(res).toEqual({ code: 124, reason: "timeout", by: "timeout" });
    // Not before the timeout, and not long after it.
    expect(took).toBeGreaterThanOrEqual(600);
    expect(took).toBeLessThan(3000);
    await d.shutdown;
    daemon = null;
  }, 10_000);

  test("a connected surface keeps it open however long the clock says", async () => {
    const { d, s } = await start({ timeoutS: 0.6 }, { listen: false });
    // The timeout and four sweeps past it.
    const raced = await Promise.race([
      d.done.then(() => "closed"),
      Bun.sleep(1600).then(() => "open"),
    ]);
    expect(raced).toBe("open");
    s.close();
    surface = null;
  }, 10_000);

  test("every kit event the daemon can emit is in the contract's list", () => {
    expect([...KIT_EVENTS].sort() as string[]).toEqual(
      [
        "ready",
        "message",
        "waiting",
        "doc.opened",
        "version.created",
        "version.deleted",
        "activated",
        "saved",
        "reverted",
        "merged",
        "note.added",
        "note.resolved",
        "task.created",
        "task.started",
        "task.progress",
        "task.done",
        "task.failed",
        "task.cancelled",
        "system",
        "doctor",
        "closed",
      ].sort(),
    );
  });
});

describe("a daemon without an app's extras", () => {
  test("createWorkspaceDaemon needs only an app and a sessions root", async () => {
    const d = createWorkspaceDaemon({
      app: { name: "bare", slot: { version: 1, migrate: () => ({}) } },
      sessionsRoot: join(root, "bare", "sessions"),
      tmp,
    });
    await d.start();
    const st = (await (await fetch(`${d.url}/state`)).json()) as { app: string; appState: unknown };
    expect(st).toMatchObject({ app: "bare", appState: null });
    await d.stop();
    const events: Ev[] = [];
    expect(events).toHaveLength(0);
  });
});

describe("guards the review asked for", () => {
  test("an agent cannot settle or detail a daemon's render; the render keeps running and the queue moves", async () => {
    process.env.KIT_FIXTURE_STEP_MS = "120";
    const { s, t, base } = await start();
    const first = await cmd(base, { op: "kit-fixture.demo", title: "First" });
    const second = await cmd(base, { op: "kit-fixture.demo", title: "Second" });
    const done = await cmd(base, { op: "task.done", id: String(first.body.task), outcome: "lies" });
    expect(done.status).toBe(409);
    expect(String(done.body.hint)).toContain("only cancel is allowed");
    const detail = await cmd(base, {
      op: "task.status",
      id: String(second.body.task),
      detail: "on it",
    });
    expect(detail.status).toBe(409);
    expect(s.state.tasks.find((x) => x.id === second.body.task)?.status).toBe("open");
    await waitUntil("first done by its runner", () =>
      t.events.find((e) => e.type === "task.done" && e.task === first.body.task),
    );
    expect(
      t.events.find((e) => e.type === "task.done" && e.task === first.body.task),
    ).toMatchObject({
      by: "daemon",
      outcome: "4 steps",
    });
    await waitUntil("second started", () =>
      t.events.find((e) => e.type === "task.started" && e.task === second.body.task),
    );
    await waitUntil("both done", () => s.state.tasks.every((x) => x.status === "done"));
  });

  test("an agent task with an unknown parent is a 404 and leaves no orphan chat line", async () => {
    const { base } = await start({}, { connect: false, listen: false });
    const r = await cmd(base, { op: "task.create", title: "orphan", parent: "t-nope" });
    expect(r.status).toBe(404);
    const st = (await (await fetch(`${base}/state?full=1`)).json()) as {
      chat: unknown[];
      tasks: unknown[];
    };
    expect(st.chat).toHaveLength(0);
    expect(st.tasks).toHaveLength(0);
  });

  test("a daemon task whose kind has no runner is refused with the kind named", async () => {
    const { d } = await start({}, { connect: false, listen: false });
    expect(() => d.context.tasks.create({ title: "x", by: "daemon", kind: "mystery" })).toThrow(
      /"mystery"/,
    );
    expect(d.session.tasks()).toHaveLength(0);
  });

  test("an unknown WebSocket op is answered with an error frame naming it and the ops there are", async () => {
    const { s } = await start();
    s.send({ op: "frobnicate", rid: "r-9" });
    const err = await s.waitFor((m) => m.op === "error");
    if (err.op !== "error") throw new Error("unreachable");
    expect(err.message).toContain('"frobnicate"');
    expect(err.requestId).toBe("r-9");
    expect(err.choices).toContain("version.delete");
    expect(err.choices).toContain("import");
    expect(err.choices).toContain("kit-fixture.ping");
    s.send({ text: "no op at all" } as never);
    await waitUntil("second error", () => s.frames.filter((f) => f.op === "error").length === 2);
  });

  test("an error frame echoes the id of the frame that caused it, and only when there was one", async () => {
    const { s } = await start();
    s.send({ op: "version.delete", doc: "nope", version: 1, rid: 42 } as never);
    const first = await s.waitFor((m) => m.op === "error");
    expect(first.op === "error" && first.requestId).toBe(42);
    s.send({ op: "version.delete", doc: "nope", version: 1 });
    await waitUntil("second error", () => s.frames.filter((f) => f.op === "error").length === 2);
    const second = s.frames.filter((f) => f.op === "error")[1];
    expect(second && "requestId" in second).toBe(false);
  });

  test("beforeVersionDelete is asked on every path, and a refusal is a conflict with its reason", async () => {
    const asked: [string, number][] = [];
    const { s, base, t } = await start({
      hooks: {
        beforeVersionDelete: async (doc, version, ctx) => {
          // The hook is handed the running daemon's context, so an app reads the session from it.
          expect(typeof ctx.session.appSlot).toBe("object");
          asked.push([doc, version]);
          return version === 2
            ? { allow: false, reason: "v2 has 1 render: its audio would go too" }
            : { allow: true };
        },
      },
    });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    await cmd(base, { op: "version.new", doc: "a" }); // v2
    await cmd(base, { op: "version.new", doc: "a" }); // v3
    await waitUntil("three versions", () => s.state.docs[0]?.versions.length === 3);

    const refused = await cmd(base, { op: "version.delete", doc: "a", version: 2 });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("1 render");
    s.send({ op: "version.delete", doc: "a", version: 2, rid: "x1" } as never);
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("1 render");
    expect(s.state.docs[0]?.versions.map((v) => v.n)).toEqual([1, 2, 3]);
    expect(t.of("version.deleted")).toHaveLength(0);

    // Allowed: a doc-less agent verb resolves the slug the way the session does.
    const ok = await cmd(base, { op: "version.delete", version: 3 });
    expect(ok.status).toBe(200);
    // The active version never reaches the hook: the kit refuses it first.
    s.send({ op: "version.delete", doc: "a", version: 1 });
    await s.waitFor((m) => m.op === "error" && m.message.includes("active version"));
    expect(asked).toEqual([
      ["a", 2],
      ["a", 2],
      ["a", 3],
    ]);
  });

  test("the hook is told who asked, and afterVersionDelete runs once the version is gone, from either side", async () => {
    const before: string[] = [];
    const after: string[] = [];
    const { s, base } = await start({
      hooks: {
        beforeVersionDelete: async (doc, version, _ctx, call) => {
          before.push(`${doc}${version}:${call.by}`);
          return { allow: true };
        },
        afterVersionDelete: async (doc, version, ctx, call) => {
          // The version is already out of the session when the hook runs.
          expect(ctx.session.findDoc(doc)?.versions.some((v) => v.n === version)).toBe(false);
          after.push(`${doc}${version}:${call.by}`);
        },
      },
    });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    await cmd(base, { op: "version.new", doc: "a" }); // v2
    await cmd(base, { op: "version.new", doc: "a" }); // v3
    await waitUntil("three versions", () => s.state.docs[0]?.versions.length === 3);
    expect((await cmd(base, { op: "version.delete", doc: "a", version: 3 })).status).toBe(200);
    s.send({ op: "version.delete", doc: "a", version: 2 });
    await waitUntil("human delete landed", () => s.state.docs[0]?.versions.length === 1);
    expect(before).toEqual(["a3:agent", "a2:human"]);
    expect(after).toEqual(["a3:agent", "a2:human"]);
  });

  test("a hook that throws after a delete does not skip the delete's chat line and event; it is reported as a system line", async () => {
    const { s, base, t } = await start({
      hooks: {
        afterVersionDelete: async () => {
          throw new Error("disk full");
        },
      },
    });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    await cmd(base, { op: "version.new", doc: "a" });
    await cmd(base, { op: "version.new", doc: "a" });
    await waitUntil("three versions", () => s.state.docs[0]?.versions.length === 3);
    expect((await cmd(base, { op: "version.delete", doc: "a", version: 3 })).status).toBe(200);
    s.send({ op: "version.delete", doc: "a", version: 2 });
    await waitUntil("both gone", () => s.state.docs[0]?.versions.length === 1);
    expect(t.of("version.deleted")).toHaveLength(2);
    const lines = s.state.chat.map((m) => m.text);
    expect(lines.filter((l) => /deleted v\d/i.test(l))).toHaveLength(4); // two deletes, two failed tidy-ups
    expect(lines.some((l) => l.includes("tidying up after it failed: disk full"))).toBe(true);
  });

  test("an app that has an appState hook gets a state broadcast after every applied edit, not only the first", async () => {
    let calls = 0;
    const { s } = await start({ appState: () => ({ calls: ++calls }) });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "edit", doc: "a", version: 1, text: "first\n" });
    await waitUntil("dirty flip", () => s.state.docs[0]?.dirty === true);
    const seen = (s.state.appState as { calls: number }).calls;
    s.send({ op: "edit", doc: "a", version: 1, text: "second\n" });
    await waitUntil(
      "a broadcast after the second edit",
      () => (s.state.appState as { calls: number }).calls > seen,
    );
    s.send({ op: "edit", doc: "a", version: 1, text: "third\n" });
    s.send({ op: "edit", doc: "a", version: 1, text: "fourth\n" });
    const before = (s.state.appState as { calls: number }).calls;
    await waitUntil(
      "a debounced broadcast",
      () => (s.state.appState as { calls: number }).calls > before,
    );
  });

  test("an app can ask for a save dialog through the context, one at a time", async () => {
    let release: (r: { paths: string[]; cancelled: boolean }) => void = () => {};
    const asked: unknown[][] = [];
    const { s, d } = await start({
      pick: (...args) => {
        asked.push(args);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    void s;
    const first = d.context.pick("save", "Save audio as", "night.mp3");
    await Bun.sleep(20);
    await expect(d.context.pick("save", "Save again")).rejects.toThrow("already open");
    release({ paths: ["/tmp/night.mp3"], cancelled: false });
    expect(await first).toEqual({ paths: ["/tmp/night.mp3"], cancelled: false });
    expect(asked).toEqual([["save", "Save audio as", "night.mp3"]]);
    // The dialog is free again.
    const next = d.context.pick("file", "Open");
    release({ paths: [], cancelled: true });
    expect(await next).toEqual({ paths: [], cancelled: true });
  });

  test("a hand-written file that reuses a deleted number is renumbered, and the chat and log say so", async () => {
    const { s, t, base } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    await cmd(base, { op: "version.new", doc: "a" });
    await cmd(base, { op: "version.delete", doc: "a", version: 2 });
    const dir = join(s.state.docs[0]?.versions[0]?.path ?? "", "..");
    // Open made the docs folder, whose watch is armed just now. Each write
    // that is seen is renumbered, so a repeat is one more version; the first is v3.
    const ev = await writeUntilSeen(
      "the renumbered version",
      () => writeFileSync(join(dir, "v2.md"), "hand-made\n"),
      () => t.events.find((e) => e.type === "version.created" && e.adopted === true),
    );
    expect(ev).toMatchObject({ version: 3, renamedFrom: 2 });
    await waitUntil("chat line", () =>
      s.state.chat.some((m) => m.text.includes("reused a number") && m.text.includes("v3")),
    );
  });
});

describe("requestId is bound per request, and the delete hook waits for the kit's checks", () => {
  test("a slow app verb's reply carries its own id, whatever arrives meanwhile, on any socket", async () => {
    let release: () => void = () => {};
    const { s, d } = await start({
      verbs: {
        "kit-fixture.slow": async (_ctx, _args, call) => {
          await new Promise<void>((r) => {
            release = r;
          });
          call.reply({ op: "kit-fixture.slow.done" });
        },
      },
    });
    const other = new FakeSurface();
    await other.connect(d.port);
    s.send({ op: "kit-fixture.slow", rid: "slow-1" } as never);
    await Bun.sleep(30);
    // Meanwhile: another frame on the same socket, and one on a second socket.
    s.send({ op: "fs.list", path: join(docs, "set"), rid: "mid-2" } as never);
    other.send({ op: "fs.list", path: join(docs, "set"), rid: "other-3" } as never);
    const mid = await s.waitFor((m) => m.op === "fs.list");
    const theirs = await other.waitFor((m) => m.op === "fs.list");
    expect((mid as { requestId?: string }).requestId).toBe("mid-2");
    expect((theirs as { requestId?: string }).requestId).toBe("other-3");
    release();
    const done = await s.waitFor((m) => (m.op as string) === "kit-fixture.slow.done");
    expect((done as unknown as { requestId?: string }).requestId).toBe("slow-1");
    other.close();
  });

  test("success frames echo the id too, and a frame without one gets none", async () => {
    const { s } = await start();
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md"), rid: 7 } as never);
    const text = await s.waitFor((m) => m.op === "version.text");
    expect((text as { requestId?: number }).requestId).toBe(7);
    s.send({ op: "doc.create", dir: join(docs, "set"), name: "n.md", rid: "c1" } as never);
    const done = await s.waitFor((m) => m.op === "structure.done");
    expect((done as { requestId?: string }).requestId).toBe("c1");
    s.send({ op: "read", doc: "a", version: 1 });
    await waitUntil(
      "a second text",
      () => s.frames.filter((f) => f.op === "version.text").length === 2,
    );
    expect("requestId" in (s.frames.filter((f) => f.op === "version.text")[1] as object)).toBe(
      false,
    );
    // Broadcast state frames belong to no request.
    expect(s.frames.filter((f) => f.op === "state").every((f) => !("requestId" in f))).toBe(true);
  });

  test("an op's own id is its subject, never read as a request id", async () => {
    const { s } = await start();
    s.send({ op: "note.edit", doc: "nope", id: "n-1", body: "x" } as never);
    const refused = await s.waitFor((m) => m.op === "error");
    expect("requestId" in refused).toBe(false);
    s.send({ op: "note.edit", doc: "nope", id: "n-1", body: "x", rid: "r-1" } as never);
    const second = await s.waitFor((m) => m.op === "error" && m.requestId === "r-1");
    expect(second.op === "error" && second.requestId).toBe("r-1");
  });

  test("the hook is not asked about the active version or a missing one, and the kit's message wins", async () => {
    const asked: number[] = [];
    const { s, base } = await start({
      hooks: {
        beforeVersionDelete: async (_doc, version) => {
          asked.push(version);
          return { allow: false, reason: "the app says no" };
        },
      },
    });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: inSet("a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const active = await cmd(base, { op: "version.delete", doc: "a", version: 1 });
    expect(active.status).toBe(409);
    expect(String(active.body.error)).toContain("active version");
    const missing = await cmd(base, { op: "version.delete", doc: "a", version: 9 });
    expect(missing.status).toBe(404);
    expect(String(missing.body.error)).toContain("no v9");
    const nodoc = await cmd(base, { op: "version.delete", doc: "nope", version: 1 });
    expect(nodoc.status).toBe(404);
    expect(asked).toEqual([]);
    // A real candidate reaches the hook, whose reason then wins.
    await cmd(base, { op: "version.new", doc: "a" });
    const hook = await cmd(base, { op: "version.delete", doc: "a", version: 2 });
    expect(String(hook.body.error)).toBe("the app says no");
    expect(asked).toEqual([2]);
  });
});

describe("the workspace", () => {
  test("a new session's workspace is the folder it was started with, in the snapshot", async () => {
    const { s, base } = await start();
    expect(s.state.workspace).toBe(ws);
    const st = (await (await fetch(`${base}/state`)).json()) as { workspace: string };
    expect(st.workspace).toBe(ws);
  });

  test("the agent sets it, the surface is told, the chat and the log say who", async () => {
    const { s, t, base } = await start();
    const r = await cmd(base, { op: "workspace.set", path: docs });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: docs, from: ws });
    await waitUntil("surface told", () => s.state.workspace === docs);
    expect(await t.waitFor((e) => e.type === "system" && e.fact === "workspace.set")).toMatchObject(
      { by: "agent", path: docs, from: ws },
    );
  });

  test("the surface sets it, with a ~ path read against the home folder", async () => {
    const { s } = await start();
    s.send({ op: "workspace.set", path: docs });
    await waitUntil("set", () => s.state.workspace === docs);
  });

  test("a missing path is not_found and a file is a usage refusal; the workspace is unchanged", async () => {
    const { s, base } = await start();
    const gone = await cmd(base, { op: "workspace.set", path: join(root, "nope") });
    expect(gone.status).toBe(404);
    const file = await cmd(base, { op: "workspace.set", path: join(docs, "solo.md") });
    expect(file.status).toBe(400);
    expect(s.state.workspace).toBe(ws);
  });

  test("a restore keeps the workspace it was left with, and ignores the one it is started with", async () => {
    const one = await start({}, { connect: false, listen: false });
    await cmd(one.base, { op: "workspace.set", path: docs });
    const id = one.d.sessionId;
    await one.d.stop();
    daemon = null;
    const two = await start({ restore: id, workspace: root }, { listen: false });
    await waitUntil("restored", () => two.s.state.sessionId === id);
    expect(two.s.state.workspace).toBe(docs);
  });

  test("drops and new top-level documents and folders land in it", async () => {
    const { s, base } = await start();
    await cmd(base, { op: "workspace.set", path: docs });
    s.send({ op: "import", name: "dropped.md", text: "# Dropped\n" });
    const dropped = await s.waitFor((m) => m.op === "structure.done" && m.of === "import");
    expect(dropped).toMatchObject({ path: join(docs, "dropped.md") });
    const doc = await cmd(base, { op: "doc.create", dir: docs, name: "fresh.md" });
    expect(doc.body.path).toBe(join(docs, "fresh.md"));
    const folder = await cmd(base, { op: "folder.create", dir: docs });
    expect(folder.body.path).toBe(join(docs, "New set"));
    expect(existsSync(join(docs, "New set"))).toBe(true);
    // Not undoable with the arrows: setting a workspace is not a change to the context's shape.
    await waitUntil("entries shown", () => s.state.context.length >= 3);
  });

  test("the workspace may not be a set's folder or inside one, and a set may not hold it: refused naming the set", async () => {
    const { s, base } = await start();
    s.send({ op: "context.add", path: join(docs, "set") });
    await waitUntil("context", () => s.state.context.length === 1);
    const agent = await cmd(base, { op: "workspace.set", path: inSet("part") });
    expect(agent.status).toBe(409);
    expect(String(agent.body.error)).toContain("inside the set set");
    s.send({ op: "workspace.set", path: join(docs, "set") });
    const err = await s.waitFor((m) => m.op === "error");
    expect(err.op === "error" && err.message).toContain("the folder of the set set");
    expect(s.state.workspace).toBe(ws);
    // A set holding the workspace, from either side.
    const holds = await cmd(base, { op: "context.add", paths: [root] });
    expect(holds.status).toBe(409);
    // This root also holds the sessions in plain sight: the one set guard
    // refuses it first, before any scan (the workspace overlap is the session
    // tests' to cover).
    expect(String(holds.body.error)).toContain("holds the sessions' own folders");
    expect(s.state.context).toHaveLength(1);
  });

  test("a session that already overlaps still opens, and says what to change in chat and on the log", async () => {
    const sessions = join(root, "home", "sessions");
    const old = WorkspaceSession.create(
      sessions,
      (await import("./fixtures/app")).fixtureApp,
      "old2",
      ws,
    );
    old.addContext(join(docs, "set"));
    const file = join(old.dir, "manifest.json");
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.workspace = inSet("part");
    writeFileSync(file, JSON.stringify(m));
    const { s, t } = await start({ restore: "old2" });
    expect(
      await t.waitFor((e) => e.type === "system" && e.fact === "workspace.overlap"),
    ).toMatchObject({ path: inSet("part"), set: join(docs, "set") });
    await waitUntil("announced", () =>
      s.state.chat.some(
        (x) => x.text.includes("inside the set set") && x.text.includes("pencil in the sidebar"),
      ),
    );
    expect(s.state.workspace).toBe(inSet("part"));
  });

  test("restoring a session saved before workspaces names the folder chosen for it, in chat and on the log", async () => {
    const sessions = join(root, "home", "sessions");
    const old = WorkspaceSession.create(
      sessions,
      (await import("./fixtures/app")).fixtureApp,
      "old1",
    );
    const file = join(old.dir, "manifest.json");
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.workspace = undefined;
    writeFileSync(file, JSON.stringify(m));
    const { s, t } = await start({ restore: "old1" });
    const chosen = join(old.dir, "imported");
    await waitUntil("announced", () =>
      s.state.chat.some((x) => x.text.includes("workspace") && x.text.includes(chosen)),
    );
    expect(
      await t.waitFor((e) => e.type === "system" && e.fact === "workspace.defaulted"),
    ).toMatchObject({ path: chosen });
    expect(s.state.workspace).toBe(chosen);
  });
});

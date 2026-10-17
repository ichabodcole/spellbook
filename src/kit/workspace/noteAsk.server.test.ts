// One ask at a time: the "Ask the agent" act for a note, driven through the
// daemon in process. A `say` with `via: "ask"` and `about.noteId` is sent once
// while that ask is owed an answer; a second is refused to its sender and never
// reaches the agent. A `say` that names a note through any other gesture is
// typed, and always delivered, and the agent's message is never an ask. This is
// Story Studio's bbc54fd test (the gesture is the mark), with our cells kept
// beside it: the agent's `via: "ask"`, and a message about the note with no
// `via`. The guard re-arms when the note is no longer owed, and, being derived
// from the stored note and conversation, survives a restore.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("note-ask");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
  surface = null;
  tail = null;
});
afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(overrides: Parameters<typeof fixtureDaemon>[0] = {}) {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  daemon = fixtureDaemon({ tmp, workspace: join(root, "ws"), ...overrides });
  await daemon.start();
  tail = collectEvents(daemon.url, -1, { agent: true });
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  return { d: daemon, s: surface, t: tail, base: daemon.url };
}

/** Stop the running daemon and forget it, so a second can restore its session. */
async function stop() {
  surface?.close();
  await tail?.stop();
  await daemon?.stop();
  daemon = null;
  surface = null;
  tail = null;
}

/** Open a.md ("# A\n\none\n") so notes can be made on it. */
async function openA(s: FakeSurface) {
  s.send({ op: "context.add", path: docs });
  s.send({ op: "open", path: join(docs, "set", "a.md") });
  await s.waitFor((m) => m.op === "version.text");
}

/** The human notes "one" (offsets 5..8); the id the tail reports. */
async function humanNote(
  s: FakeSurface,
  t: ReturnType<typeof collectEvents>,
  body: string,
): Promise<string> {
  s.send({ op: "note.add", doc: "a", from: 5, to: 8, body });
  const ev = await t.waitFor((e) => e.type === "note.added" && e.body === body);
  // Timestamps are milliseconds: what follows must not share this one.
  await Bun.sleep(3);
  return String(ev.note);
}

/** The "Ask the agent" act, with a request id to answer. */
const ask = (noteId: string, text: string, rid: string) => ({
  op: "say",
  text,
  withSelection: false,
  via: "ask",
  about: { noteId },
  rid,
});
/** A typed follow-up that names the note: the composer's gesture. */
const typed = (noteId: string, text: string) => ({
  op: "say",
  text,
  withSelection: false,
  via: "chat",
  about: { noteId },
});

/** Send a plain marker and wait for it on the tail: everything sent before it has landed. */
async function settle(s: FakeSurface, t: ReturnType<typeof collectEvents>, text: string) {
  s.send({ op: "say", text, withSelection: false });
  await t.waitFor((e) => e.type === "message" && e.text === text);
}

const messagesAbout = (t: ReturnType<typeof collectEvents>, noteId: string) =>
  t.events.filter(
    (e) => e.type === "message" && (e.about as { noteId?: string } | undefined)?.noteId === noteId,
  );

describe("one ask at a time", () => {
  test("a double ask sends one message, and the second is refused to its sender", async () => {
    const { s, t } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    s.send(ask(n, "About my note", "r1"));
    s.send(ask(n, "About my note", "r2"));
    await settle(s, t, "marker");
    expect(messagesAbout(t, n).map((e) => e.text)).toEqual(["About my note"]);
    expect(s.state.chat.filter((m) => m.about?.noteId === n)).toHaveLength(1);
    // The gesture is the mark, stored and on the tail.
    expect(s.state.chat.find((m) => m.about?.noteId === n)?.via).toBe("ask");
    expect(messagesAbout(t, n)[0]?.via).toBe("ask");
    expect(messagesAbout(t, n)[0]?.about).toEqual(expect.objectContaining({ noteId: n, doc: "a" }));
    // Nothing of the refused one was stored, broadcast or emitted.
    expect(s.state.chat.filter((m) => m.text === "About my note")).toHaveLength(1);
    // The first was not refused; the second was, and says it was not sent.
    expect(s.frames.some((f) => f.op === "error" && f.requestId === "r1")).toBe(false);
    const refused = s.frames.find((f) => f.op === "error" && f.requestId === "r2");
    expect(refused).toMatchObject({ op: "error" });
    expect((refused as { message: string }).message).toContain("not sent");
  });

  test("an ask and then a typed follow-up about the same note are both delivered", async () => {
    const { s, t } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    s.send(ask(n, "About my note", "r1"));
    s.send(typed(n, "and also the second line"));
    s.send(typed(n, "and the third"));
    await settle(s, t, "marker");
    expect(messagesAbout(t, n).map((e) => e.text)).toEqual([
      "About my note",
      "and also the second line",
      "and the third",
    ]);
    expect(s.frames.some((f) => f.op === "error")).toBe(false);
  });

  test("the agent's say with via ask about the note holds nothing: the human's first ask still goes", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    const r = await cmd(base, {
      op: "say",
      text: "a note from me",
      via: "ask",
      about: { noteId: n, docs: [join(docs, "set", "a.md")], text: "one", fromLine: 1 },
    });
    expect(r.status).toBe(200);
    expect(String(r.body.warning)).toContain('via "ask" is a button the human presses');
    const stored = await waitUntil("stored", () => s.state.chat.find((m) => m.id === r.body.id));
    // Stored as sent, with its warning; the human's parts are dropped.
    expect(stored.via).toBe("ask");
    expect(stored.about).toEqual({ noteId: n });
    await Bun.sleep(3);
    s.send(ask(n, "my first ask", "r1"));
    await settle(s, t, "marker");
    expect(messagesAbout(t, n).map((e) => e.text)).toContain("my first ask");
    expect(s.frames.some((f) => f.op === "error" && f.requestId === "r1")).toBe(false);
    // …and that ask is owed: a second is held back.
    s.send(ask(n, "my second ask", "r2"));
    await settle(s, t, "marker two");
    expect(messagesAbout(t, n).map((e) => e.text)).not.toContain("my second ask");
    expect(s.frames.some((f) => f.op === "error" && f.requestId === "r2")).toBe(true);
  });

  test("a message about the note with no via is typed: two go, neither refused", async () => {
    const { s, t } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    const plain = (text: string, rid: string) => ({
      op: "say",
      text,
      withSelection: false,
      about: { noteId: n },
      rid,
    });
    s.send(plain("plain one", "r1"));
    s.send(plain("plain two", "r2"));
    await settle(s, t, "marker");
    expect(messagesAbout(t, n).map((e) => e.text)).toEqual(["plain one", "plain two"]);
    expect(s.frames.some((f) => f.op === "error")).toBe(false);
    for (const e of messagesAbout(t, n)) expect(e.via).toBe("chat");
  });

  test("ask, the agent answers, ask again: two messages", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    s.send(ask(n, "first ask", "r1"));
    await t.waitFor((e) => e.type === "message" && e.text === "first ask");
    await Bun.sleep(3);
    expect((await cmd(base, { op: "say", text: "on it" })).status).toBe(200);
    await Bun.sleep(3);
    s.send(ask(n, "second ask", "r2"));
    await settle(s, t, "marker");
    expect(messagesAbout(t, n).map((e) => e.text)).toEqual(["first ask", "second ask"]);
    // Answered again, it is held again: the guard re-armed and is armed.
    s.send(ask(n, "third ask", "r3"));
    await settle(s, t, "marker two");
    expect(messagesAbout(t, n).map((e) => e.text)).toEqual(["first ask", "second ask"]);
    expect(s.frames.some((f) => f.op === "error" && f.requestId === "r3")).toBe(true);
  });

  test("a resolve, an agent rewrite and a human rewrite each re-arm it", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    const sent = () => messagesAbout(t, n).length;

    // Resolved by the agent, reopened by the human: a new ask goes.
    s.send(ask(n, "ask one", "r1"));
    await t.waitFor((e) => e.type === "message" && e.text === "ask one");
    await Bun.sleep(3);
    expect((await cmd(base, { op: "note.resolve", doc: "a", id: n, resolved: true })).status).toBe(
      200,
    );
    s.send({ op: "note.resolve", doc: "a", id: n, resolved: false });
    await t.waitFor((e) => e.type === "note.resolved" && e.by === "human");
    await Bun.sleep(3);
    s.send(ask(n, "ask two", "r2"));
    await t.waitFor((e) => e.type === "message" && e.text === "ask two");
    expect(sent()).toBe(2);

    // The agent rewrites the note: answered, so a new ask goes.
    await Bun.sleep(3);
    expect((await cmd(base, { op: "note.edit", doc: "a", id: n, body: "cut it" })).status).toBe(
      200,
    );
    await Bun.sleep(3);
    s.send(ask(n, "ask three", "r3"));
    await t.waitFor((e) => e.type === "message" && e.text === "ask three");

    // The human rewrites it: a new question, so a new ask goes.
    await Bun.sleep(3);
    s.send({ op: "note.edit", doc: "a", id: n, body: "no, keep it" });
    await t.waitFor((e) => e.fact === "note.edited" && e.by === "human");
    await Bun.sleep(3);
    s.send(ask(n, "ask four", "r4"));
    await t.waitFor((e) => e.type === "message" && e.text === "ask four");
    expect(sent()).toBe(4);
    expect(s.frames.some((f) => f.op === "error")).toBe(false);
  });

  test("an ask without a note is no ask, and an ask about an unknown note is delivered", async () => {
    const { s, t } = await start();
    s.send({ op: "say", text: "one", withSelection: false, via: "ask" });
    s.send({ op: "say", text: "one again", withSelection: false, via: "ask" });
    s.send(ask("n-gone", "two", "r1"));
    s.send(ask("n-gone", "three", "r2"));
    await settle(s, t, "marker");
    expect(t.events.filter((e) => e.type === "message").map((e) => e.text)).toEqual([
      "one",
      "one again",
      "two",
      "three",
      "marker",
    ]);
  });
});

describe("the guard survives a restore", () => {
  test("an owed ask is still held after a restart, and a typed follow-up still goes", async () => {
    const one = await start();
    await openA(one.s);
    const n = await humanNote(one.s, one.t, "asked about");
    one.s.send(ask(n, "About my note", "r1"));
    await one.t.waitFor((e) => e.type === "message" && e.text === "About my note");
    const id = one.d.sessionId;
    await stop();

    const two = await start({ restore: id });
    await two.s.waitFor((f) => f.op === "state" && f.state.sessionId === id);
    two.s.send(ask(n, "again", "r2"));
    two.s.send(typed(n, "typed after the restart"));
    await settle(two.s, two.t, "marker");
    const texts = two.t.events.filter((e) => e.type === "message").map((e) => e.text);
    expect(texts).not.toContain("again");
    expect(texts).toContain("typed after the restart");
    expect(two.s.frames.some((f) => f.op === "error" && f.requestId === "r2")).toBe(true);
  });
});

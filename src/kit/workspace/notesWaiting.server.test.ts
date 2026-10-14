// A note shows that it is with the agent: the daemon half, driven in process.
// A human's note is owed an answer until the agent answers it in a way the
// daemon can see, and `PublicState.notesWaiting` says so. Ported from
// Scriptorium's daemon integration cells for the same rule.
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
  root = tempRoot("notes-waiting");
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

/** The human notes "one" (offsets 5..8) and the id the tail reports. */
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

const owedIds = (s: FakeSurface) => s.state.notesWaiting.map((w) => w.noteId);

describe("what answers a note", () => {
  test("a human's note is owed; two notes and then one reply clears both", async () => {
    const { s, t, base } = await start();
    await openA(s);
    expect(s.state.notesWaiting).toEqual([]);
    const n1 = await humanNote(s, t, "first");
    const n2 = await humanNote(s, t, "second");
    await waitUntil("both owed", () => s.state.notesWaiting.length === 2);
    // Oldest first, each a pulse at first.
    expect(owedIds(s)).toEqual([n1, n2]);
    expect(s.state.notesWaiting.every((w) => w.badge === "working" && w.doc === "a")).toBe(true);

    expect((await cmd(base, { op: "say", text: "on both" })).status).toBe(200);
    await waitUntil("both answered", () => s.state.notesWaiting.length === 0);
    // Answered is not resolved: the notes stay open.
    expect(s.state.docs[0]?.notes.filter((n) => !n.resolved)).toHaveLength(2);

    // A note made after that reply is still owed.
    await Bun.sleep(3);
    const n3 = await humanNote(s, t, "third");
    await waitUntil("third owed", () => owedIds(s).join() === n3);
  });

  test("a system line is not a reply: the agent resolving one note leaves the other owed, and it goes stalled", async () => {
    const { s, t, base } = await start({ stallMs: 300, attentionMs: 30 });
    await openA(s);
    const a = await humanNote(s, t, "note a");
    const b = await humanNote(s, t, "note b");
    expect((await cmd(base, { op: "note.resolve", doc: "a", id: a, resolved: true })).status).toBe(
      200,
    );
    // The resolve is narrated as a system line in the chat...
    await waitUntil("the system line", () => s.state.chat.some((m) => m.from === "system"));
    // ...which closes A and says nothing about B.
    await waitUntil("only b owed", () => owedIds(s).join() === b);
    // The tick sees a note go stalled with nothing else changing.
    await waitUntil("b stalled", () => s.state.notesWaiting[0]?.badge === "stalled", 3000);
  });

  test("the agent's own note is owed nothing", async () => {
    const { s, base } = await start();
    await openA(s);
    expect((await cmd(base, { op: "note.add", doc: "a", quote: "one", body: "mine" })).status).toBe(
      200,
    );
    await waitUntil("note on state", () => s.state.docs[0]?.notes.length === 1);
    expect(s.state.notesWaiting).toEqual([]);
  });
});

describe("a human rewrite or reopen re-arms the mark", () => {
  test("a rewrite after an answer is owed again, from the rewrite, and the tail is told what it says", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "cut this?");
    await cmd(base, { op: "say", text: "maybe" });
    await waitUntil("answered", () => s.state.notesWaiting.length === 0);
    await Bun.sleep(3);

    const rewroteAfter = Date.now();
    s.send({ op: "note.edit", doc: "a", id: n, body: "cut this, really?" });
    const edited = await t.waitFor((e) => e.type === "note.edited");
    expect(edited).toMatchObject({
      doc: "a",
      note: n,
      by: "human",
      quote: "one",
      body: "cut this, really?",
      lines: { from: 3, to: 3 },
    });
    expect(String(edited.hint)).toContain(`note-resolve ${n}`);
    await waitUntil("owed again", () => owedIds(s).join() === n);
    expect(Date.parse(s.state.notesWaiting[0]?.since ?? "")).toBeGreaterThanOrEqual(rewroteAfter);
    const stored = s.state.docs[0]?.notes.find((x) => x.id === n);
    expect(stored?.editedBy).toBe("human");
    expect(typeof stored?.editedAt).toBe("string");
  });

  test("a human reopen is owed from the reopen and carries the note; the agent's reopen answers it", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "and this");
    s.send({ op: "note.resolve", doc: "a", id: n, resolved: true });
    expect(await t.waitFor((e) => e.type === "note.resolved" && e.by === "human")).toMatchObject({
      note: n,
      resolved: true,
    });
    await waitUntil("resolved is owed nothing", () => s.state.notesWaiting.length === 0);
    await Bun.sleep(3);

    const reopenedAfter = Date.now();
    s.send({ op: "note.resolve", doc: "a", id: n, resolved: false });
    const reopened = await t.waitFor((e) => e.type === "note.reopened" && e.by === "human");
    expect(reopened).toMatchObject({ note: n, body: "and this", lines: { from: 3, to: 3 } });
    await waitUntil("owed again", () => owedIds(s).join() === n);
    expect(Date.parse(s.state.notesWaiting[0]?.since ?? "")).toBeGreaterThanOrEqual(reopenedAfter);
    expect(s.state.docs[0]?.notes[0]?.reopenedBy).toBe("human");

    // The agent resolving and then reopening it is an act on it, not a new ask.
    await cmd(base, { op: "note.resolve", doc: "a", id: n, resolved: true });
    await Bun.sleep(3);
    await cmd(base, { op: "note.resolve", doc: "a", id: n, resolved: false });
    const agentReopen = await t.waitFor((e) => e.type === "note.reopened" && e.by === "agent");
    expect("body" in agentReopen).toBe(false);
    await waitUntil(
      "agent reopen recorded",
      () => s.state.docs[0]?.notes[0]?.reopenedBy === "agent",
    );
    expect(s.state.notesWaiting).toEqual([]);
  });
});

describe("asking the agent about a note", () => {
  test("the note waits on the ask, and a double ask sends one message", async () => {
    const { s, t, base } = await start();
    await openA(s);
    const n = await humanNote(s, t, "stuck?");
    const ask = { op: "say", text: "About my note", withSelection: false, about: { noteId: n } };
    s.send(ask);
    s.send(ask);
    s.send({ op: "say", text: "marker", withSelection: false });
    await t.waitFor((e) => e.type === "message" && e.text === "marker");
    const asks = t.events.filter(
      (e) => e.type === "message" && (e.about as { noteId?: string } | undefined)?.noteId === n,
    );
    expect(asks).toHaveLength(1);
    expect(s.state.chat.filter((m) => m.about?.noteId === n)).toHaveLength(1);

    // The note reads the conversation's badge, through the ask.
    await waitUntil("asked", () => s.state.notesWaiting[0]?.askedIn === asks[0]?.message_id);
    expect(s.state.notesWaiting[0]?.badge).toBe(s.state.waiting?.badge as "working" | "stalled");

    // The reply answers the ask and the note together.
    await cmd(base, { op: "say", text: "on it" });
    await waitUntil("answered", () => s.state.notesWaiting.length === 0);
  });

  test("an ask about a note that is not owed is not refused: the guard reads only `askedIn`", async () => {
    const { s, t } = await start();
    s.send({ op: "say", text: "one", withSelection: false, about: { noteId: "n-gone" } });
    s.send({ op: "say", text: "two", withSelection: false, about: { noteId: "n-gone" } });
    await t.waitFor((e) => e.type === "message" && e.text === "two");
    expect(t.events.filter((e) => e.type === "message")).toHaveLength(2);
  });
});

describe("the state survives a restore", () => {
  test("an owed note, its rewrite and its ask come back as they were left", async () => {
    const one = await start();
    await openA(one.s);
    const plain = await humanNote(one.s, one.t, "plain");
    const asked = await humanNote(one.s, one.t, "asked about");
    one.s.send({ op: "note.edit", doc: "a", id: asked, body: "asked about, rewritten" });
    await one.t.waitFor((e) => e.type === "note.edited");
    await Bun.sleep(3);
    one.s.send({
      op: "say",
      text: "About my note",
      withSelection: false,
      about: { noteId: asked },
    });
    await waitUntil("asked", () =>
      one.s.state.notesWaiting.some((w) => w.noteId === asked && w.askedIn),
    );
    const before = one.s.state.notesWaiting;
    expect(before.map((w) => w.noteId)).toEqual([plain, asked]);
    const id = one.d.sessionId;
    await stop();

    const two = await start({ restore: id });
    await waitUntil("restored", () => two.s.state.sessionId === id && two.s.state.docs.length > 0);
    expect(two.s.state.notesWaiting).toEqual(before);
    expect(two.s.state.docs[0]?.notes.find((n) => n.id === asked)?.editedBy).toBe("human");
    // And the guard still holds across the restart.
    two.s.send({ op: "say", text: "again", withSelection: false, about: { noteId: asked } });
    two.s.send({ op: "say", text: "marker", withSelection: false });
    await two.t.waitFor((e) => e.type === "message" && e.text === "marker");
    expect(two.t.events.some((e) => e.type === "message" && e.text === "again")).toBe(false);
  });
});

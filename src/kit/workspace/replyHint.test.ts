// Each human message on the agent's tail names the three honest answers: say
// now, start a task, or both (kit-message-reply-hint). A slot lets something
// smarter pick instead.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";
import { replyHint, waitingHint } from "./waiting";

/** Every backticked command in a hint, which must each name the session. */
const commands = (hint: string) => [...hint.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

describe("the fixed hints", () => {
  test("the reply hint names say, task and both, each command with the session, and stays short", () => {
    const h = replyHint("3e5c69f1");
    // Each runs as printed once its placeholder is filled.
    expect(commands(h)).toEqual([
      'say "<reply>" --session 3e5c69f1',
      'task "<what you are doing>" --session 3e5c69f1',
    ]);
    expect(h).toContain("both, say first and then task");
    // It rides every message.
    expect(h.length).toBeLessThan(270);
  });

  test("the waiting hint offers the same answers in the same words, and still on it", () => {
    const h = waitingHint("3e5c69f1");
    expect(commands(h)).toEqual([
      'say "<reply>" --session 3e5c69f1',
      'task "<what you are doing>" --session 3e5c69f1',
      "working --session 3e5c69f1",
    ]);
    expect(h).toContain("(it posts to the chat for you)");
    expect(replyHint("3e5c69f1")).toContain("(it posts to the chat for you)");
  });
});

let root: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("reply-hint");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
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
  return { d: daemon, s: surface, t: tail };
}

describe("a human message on the tail", () => {
  test("carries the reply hint for its session", async () => {
    const { d, s, t } = await start();
    s.send({ op: "say", text: "can you tidy the harbour notes?", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message");
    expect(ev.hint).toBe(replyHint(d.sessionId));
  });

  test("about a note, it names the note's commands with the note's document, then the three answers", async () => {
    const { d, s, t } = await start();
    const docs = seedDocs(root);
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: join(docs, "set", "a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "note.add", doc: "a", from: 5, to: 8, body: "cut this?" });
    const note = String((await t.waitFor((e) => e.type === "note.added")).note);
    // They move on to another document, then ask about the note on the first.
    s.send({ op: "open", path: join(docs, "set", "part", "b.md") });
    await waitUntil("b open", () => s.state.openDoc === "b");
    s.send({ op: "say", text: "and this?", withSelection: false, about: { noteId: note } });
    const ev = await t.waitFor((e) => e.type === "message");
    expect((ev.about as { doc?: string }).doc).toBe("b");
    const hint = String(ev.hint);
    expect(hint).toStartWith(`about note ${note}:`);
    expect(commands(hint).slice(0, 2)).toEqual([
      `notes --session ${d.sessionId} --doc a`,
      `note-resolve ${note} --session ${d.sessionId} --doc a`,
    ]);
    expect(hint).toEndWith(replyHint(d.sessionId));
    for (const c of commands(hint)) expect(c).toContain(`--session ${d.sessionId}`);
    // A note no document holds names no document.
    s.send({ op: "say", text: "and that?", withSelection: false, about: { noteId: "n-gone" } });
    const gone = await t.waitFor((e) => e.type === "message" && e.text === "and that?");
    expect(commands(String(gone.hint)).slice(0, 2)).toEqual([
      `notes --session ${d.sessionId}`,
      `note-resolve n-gone --session ${d.sessionId}`,
    ]);
  });

  test("a slot that throws costs only its pick: the message still goes out, with the fixed hint", async () => {
    const { d, s, t } = await start({
      messageHint: () => {
        throw new Error("the model is away");
      },
    });
    s.send({ op: "say", text: "still there?", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message");
    expect(ev.text).toBe("still there?");
    expect(ev.hint).toBe(replyHint(d.sessionId));
  });

  test("an app adds its own part to about from the sending page; a kit key and a throw are dropped", async () => {
    const asked: string[] = [];
    const { s, t } = await start({
      hooks: {
        messageAbout: (surface) => {
          asked.push(surface);
          if (asked.length === 2) throw new Error("no view");
          return { glance: { at: "the harbour" }, doc: "not-the-kit's" };
        },
      },
    });
    s.send({ op: "say", text: "one", withSelection: false });
    s.send({ op: "say", text: "two", withSelection: false });
    await t.waitFor((e) => e.type === "message" && e.text === "two");
    const [one, two] = t.of("message");
    expect(one?.about).toEqual({ glance: { at: "the harbour" } });
    expect(two?.about).toBeUndefined();
    expect(asked[0]).toBe(asked[1]);
    // The chat keeps what the tail got: the record shows what was sent.
    expect(s.state.chat.find((m) => m.text === "one")?.about).toEqual({
      glance: { at: "the harbour" },
    });
    expect(s.state.chat.find((m) => m.text === "two")?.about).toBeUndefined();
  });

  test("the slot replaces the fixed hint, and leaving it undefined keeps it", async () => {
    const seen: string[] = [];
    const { d, s, t } = await start({
      messageHint: ({ text, session }) => {
        seen.push(text);
        return text.includes("quick") ? `\`say --session ${session}\`: a reply will do` : undefined;
      },
    });
    s.send({ op: "say", text: "quick one", withSelection: false });
    s.send({ op: "say", text: "rewrite the world", withSelection: false });
    await t.waitFor((e) => e.type === "message" && e.text === "rewrite the world");
    const hints = t.of("message").map((e) => e.hint);
    expect(hints).toEqual([
      `\`say --session ${d.sessionId}\`: a reply will do`,
      replyHint(d.sessionId),
    ]);
    expect(seen).toEqual(["quick one", "rewrite the world"]);
  });
});

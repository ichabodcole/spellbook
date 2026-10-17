// An app's own parts of a message's `about` (what `hooks.messageAbout` adds from
// the sending page) are stored with the message, not only carried on the tail:
// the record shows what was sent. They survive a restore, and the chip names
// them through the app's labeller. The fixture app's part is a `glance`: where
// the human was looking. The retired `entryIds` is dropped from a page and from
// the agent, and an old stored message that carries it still restores.
// New kit code (`kit-chat-about-chip`), not a port.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aboutLabel } from "../chat/ChatMessageView.tsx";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { Message } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("app-about");
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

/** The fixture app's part: where the human was looking on its canvas. */
const glancing = { messageAbout: () => ({ glance: { at: "the harbour" } }) };
/** The fixture app's words for it. */
const glanceLabel = (part: string, value: unknown) =>
  part === "glance" ? `at ${(value as { at: string }).at}` : null;

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

/** Stop the running daemon and forget it, so a second can restore its session. */
async function stop() {
  surface?.close();
  await tail?.stop();
  await daemon?.stop();
  daemon = null;
  surface = null;
  tail = null;
}

const said = (s: FakeSurface, text: string): Message | undefined =>
  s.state.chat.find((m) => m.text === text);
const manifestAt = (id: string) => join(root, "home", "sessions", id, "manifest.json");

describe("an app's own about parts", () => {
  test("are stored with the message as the tail carries them, beside the kit's", async () => {
    const { s, t } = await start({ hooks: glancing });
    s.send({ op: "context.add", path: docs });
    s.send({ op: "open", path: join(docs, "set", "a.md") });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "say", text: "what is out there?", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "what is out there?");
    const stored = await waitUntil("stored", () => said(s, "what is out there?"));
    expect(ev.about).toMatchObject({ doc: "a", version: 1, glance: { at: "the harbour" } });
    expect(stored.about).toEqual(ev.about as Message["about"]);
    expect(aboutLabel(stored.about ?? {}, (x) => x, undefined, glanceLabel)).toBe(
      "a · v1 · at the harbour",
    );
  });

  test("survive a restore, and the chip still names them", async () => {
    const one = await start({ hooks: glancing });
    one.s.send({ op: "say", text: "remember this", withSelection: false });
    await one.t.waitFor((e) => e.type === "message" && e.text === "remember this");
    const id = one.d.sessionId;
    await stop();
    const onDisk = JSON.parse(readFileSync(manifestAt(id), "utf8")) as { chat: Message[] };
    expect(onDisk.chat.find((m) => m.text === "remember this")?.about).toEqual({
      glance: { at: "the harbour" },
    });

    // Restored by a daemon whose app adds nothing now: the stored part stays.
    const two = await start({ restore: id });
    await two.s.waitFor((f) => f.op === "state" && f.state.sessionId === id);
    const back = await waitUntil("restored", () => said(two.s, "remember this"));
    expect(back.about).toEqual({ glance: { at: "the harbour" } });
    expect(aboutLabel(back.about ?? {}, (x) => x, undefined, glanceLabel)).toBe("at the harbour");
  });
});

describe("entryIds is retired", () => {
  test("a page's entryIds is not stored, nor carried on the tail", async () => {
    const { s, t } = await start();
    s.send({
      op: "say",
      text: "these?",
      withSelection: false,
      about: { entryIds: ["c-1"], noteId: "n-1" } as never,
    });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "these?");
    expect(ev.about).toEqual({ noteId: "n-1" });
    expect((await waitUntil("stored", () => said(s, "these?"))).about).toEqual({ noteId: "n-1" });
  });

  test("the agent's entryIds is dropped", async () => {
    const { d, s } = await start();
    const r = await cmd(d.url, { op: "say", text: "two items", about: { entryIds: ["e1"] } });
    expect(r.status).toBe(200);
    expect((await waitUntil("stored", () => said(s, "two items"))).about).toBeUndefined();
  });

  test("an old stored message that carries it restores cleanly, and the chip leaves it off", async () => {
    const one = await start();
    one.s.send({ op: "say", text: "older", withSelection: false });
    await one.t.waitFor((e) => e.type === "message" && e.text === "older");
    const id = one.d.sessionId;
    await stop();
    // As a message from before the retirement would have been stored.
    const at = manifestAt(id);
    const m = JSON.parse(readFileSync(at, "utf8")) as { chat: Message[] };
    const old = m.chat.find((x) => x.text === "older") as Message;
    old.about = { entryIds: ["c-1", "c-2"], doc: "a", version: 1 } as never;
    writeFileSync(at, JSON.stringify(m, null, 2));

    const two = await start({ restore: id });
    await two.s.waitFor((f) => f.op === "state" && f.state.sessionId === id);
    const back = await waitUntil("restored", () => said(two.s, "older"));
    expect(back.about).toMatchObject({ entryIds: ["c-1", "c-2"] });
    // Never mistaken for an app's part: a labeller that names everything is not asked.
    expect(
      aboutLabel(
        back.about ?? {},
        (x) => x,
        undefined,
        (part) => part,
      ),
    ).toBe("a · v1");
    // The session goes on: a new message is said and stored.
    two.s.send({ op: "say", text: "newer", withSelection: false });
    await two.t.waitFor((e) => e.type === "message" && e.text === "newer");
  });
});

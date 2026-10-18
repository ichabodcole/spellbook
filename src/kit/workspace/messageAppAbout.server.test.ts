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
import {
  APP_ABOUT_PART_MAX,
  APP_ABOUT_PARTS_MAX,
  APP_ABOUT_TOTAL_MAX,
  cleanAppAbout,
  RESERVED_PART_NAMES,
} from "./messageParts";
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

describe("what an app's part may be", () => {
  test("a part JSON cannot carry costs only itself: the message is stored, the session goes on", async () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const { d, s, t } = await start({
      hooks: {
        messageAbout: () => ({ big: 10n, cyclic, fn: () => 1, glance: { at: "the harbour" } }),
      },
    });
    s.send({ op: "say", text: "odd parts", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "odd parts");
    expect(ev.about).toEqual({ glance: { at: "the harbour" } });
    expect(String(ev.warning)).toContain("3 app about parts were dropped: not JSON");
    expect((await waitUntil("stored", () => said(s, "odd parts"))).about).toEqual({
      glance: { at: "the harbour" },
    });
    // Persisted and still answering: the agent's say goes through, and the manifest holds both.
    const r = await cmd(d.url, { op: "say", text: "still here" });
    expect(r.status).toBe(200);
    await waitUntil("agent said", () => said(s, "still here"));
    const id = d.sessionId;
    await stop();
    const onDisk = JSON.parse(readFileSync(manifestAt(id), "utf8")) as { chat: Message[] };
    expect(onDisk.chat.map((m) => m.text)).toEqual(
      expect.arrayContaining(["odd parts", "still here"]),
    );
  });

  test("a part over APP_ABOUT_PART_MAX is dropped, and parts past APP_ABOUT_TOTAL_MAX in all", async () => {
    // A one-letter name and `x.repeat(n)` weigh `"a"` + `:` + n + 2 = n + 6 bytes:
    // four at the per-part cap fill the total exactly, and a fifth is over it.
    const fits = APP_ABOUT_PART_MAX - 6;
    const { s, t } = await start({
      hooks: {
        messageAbout: () => ({
          heavy: "x".repeat(APP_ABOUT_PART_MAX - 1),
          a: "a".repeat(fits),
          b: "b".repeat(fits),
          c: "c".repeat(fits),
          d: "d".repeat(fits),
          e: "e".repeat(fits),
        }),
      },
    });
    s.send({ op: "say", text: "heavy", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "heavy");
    expect(Object.keys(ev.about as object)).toEqual(["a", "b", "c", "d"]);
    const warning = String(ev.warning);
    expect(warning).toContain(
      `1 app about part was dropped: over ${APP_ABOUT_PART_MAX} bytes each.`,
    );
    expect(warning).toContain(
      `1 app about part was dropped past ${APP_ABOUT_TOTAL_MAX} bytes in all.`,
    );
    expect((await waitUntil("stored", () => said(s, "heavy"))).about).toEqual(ev.about as never);
  });

  test("a part under a reserved name is never stored", async () => {
    const given = JSON.parse(
      '{"__proto__":{"polluted":1},"constructor":1,"prototype":2,"toString":3,"hasOwnProperty":4,"ok":1}',
    );
    const { s, t } = await start({ hooks: { messageAbout: () => given } });
    s.send({ op: "say", text: "names", withSelection: false });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "names");
    expect(Object.keys(ev.about as object)).toEqual(["ok"]);
    const stored = await waitUntil("stored", () => said(s, "names"));
    expect(Object.keys(stored.about ?? {})).toEqual(["ok"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("a hook result that throws when read", () => {
  test("costs the app's parts with a warning, never the human's message", async () => {
    const shapes: Record<string, unknown> = {
      getter: {
        get glance(): unknown {
          throw new Error("getter says no");
        },
      },
      ownKeys: new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("ownKeys says no");
          },
        },
      ),
      getPrototypeOf: new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("getPrototypeOf says no");
          },
        },
      ),
    };
    let current = "getter";
    const { s, t } = await start({ hooks: { messageAbout: () => shapes[current] as never } });
    for (const shape of Object.keys(shapes)) {
      current = shape;
      s.send({ op: "say", text: `via ${shape}`, withSelection: false });
      const ev = await t.waitFor((e) => e.type === "message" && e.text === `via ${shape}`);
      expect(ev.about).toBeUndefined();
      expect(String(ev.warning)).toContain(
        "the app's about parts were dropped: they could not be read",
      );
      expect(await waitUntil(`stored ${shape}`, () => said(s, `via ${shape}`))).toBeDefined();
    }
  });
});

describe("what is stored is what a restore gives", () => {
  test("a toJSON value reads the same live and restored", async () => {
    const one = await start({ hooks: { messageAbout: () => ({ when: new Date(0) }) } });
    one.s.send({ op: "say", text: "dated", withSelection: false });
    const live = await waitUntil("stored", () => said(one.s, "dated"));
    expect(live.about).toEqual({ when: "1970-01-01T00:00:00.000Z" });
    const id = one.d.sessionId;
    await stop();
    const two = await start({ restore: id });
    await two.s.waitFor((f) => f.op === "state" && f.state.sessionId === id);
    const back = await waitUntil("restored", () => said(two.s, "dated"));
    expect(back.about).toEqual(live.about as never);
  });
});

describe("cleanAppAbout", () => {
  test("keeps the app's parts in order, drops kit keys, and takes nothing from a non-object", () => {
    expect(cleanAppAbout({ doc: "x", refs: [], b: 1, a: { n: 2 } }).parts).toEqual([
      ["b", 1],
      ["a", { n: 2 }],
    ]);
    for (const given of [undefined, null, "str", [1, 2], 7])
      expect(cleanAppAbout(given)).toEqual({ parts: [], advice: [] });
    expect(cleanAppAbout(Object.assign(Object.create(null), { ok: 1 })).parts).toEqual([["ok", 1]]);
  });
  test("a part at exactly the per-part cap is kept; one byte over is not", () => {
    // `"p"` + `:` is 4 bytes, the value's quotes 2.
    expect(cleanAppAbout({ p: "x".repeat(APP_ABOUT_PART_MAX - 6) }).parts).toHaveLength(1);
    expect(cleanAppAbout({ p: "x".repeat(APP_ABOUT_PART_MAX - 5) }).parts).toHaveLength(0);
    // Bytes, not characters: a two-byte character weighs two.
    expect(cleanAppAbout({ p: "é".repeat(APP_ABOUT_PART_MAX / 2 - 2) }).parts).toHaveLength(0);
  });
  test("a part's name weighs too: a huge name is over the per-part cap, many long names over the total", () => {
    const huge = { ["k".repeat(1024 * 1024)]: 1, small: 1 };
    const one = cleanAppAbout(huge);
    expect(one.parts).toEqual([["small", 1]]);
    expect(one.advice).toEqual([
      `1 app about part was dropped: over ${APP_ABOUT_PART_MAX} bytes each.`,
    ]);
    // 5,000 parts with ~1 KB names: each fits alone, the total and the count do not.
    const many = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [`${i}`.padStart(1000, "n"), i]),
    );
    const r = cleanAppAbout(many);
    const weight = r.parts.reduce(
      (w, [k, v]) => w + JSON.stringify(k).length + 1 + JSON.stringify(v).length,
      0,
    );
    expect(weight).toBeLessThanOrEqual(APP_ABOUT_TOTAL_MAX);
    expect(r.parts.length).toBe(16);
    expect(r.advice.join(" ")).toContain(`dropped past ${APP_ABOUT_TOTAL_MAX} bytes in all`);
  });
  test("past APP_ABOUT_PARTS_MAX parts, the rest are dropped", () => {
    const tiny = Object.fromEntries(
      Array.from({ length: APP_ABOUT_PARTS_MAX + 3 }, (_, i) => [`p${i}`, i]),
    );
    const r = cleanAppAbout(tiny);
    expect(r.parts).toHaveLength(APP_ABOUT_PARTS_MAX);
    expect(r.parts.at(-1)).toEqual([`p${APP_ABOUT_PARTS_MAX - 1}`, APP_ABOUT_PARTS_MAX - 1]);
    expect(r.advice).toEqual([
      `3 app about parts were dropped past the first ${APP_ABOUT_PARTS_MAX}.`,
    ]);
  });
  test("a result that throws when read costs its parts, with advice, and never throws", () => {
    const getter = {
      ok: 1,
      get bad(): number {
        throw new Error("getter says no");
      },
    };
    const keys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys says no");
        },
      },
    );
    const proto = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf says no");
        },
      },
    );
    for (const [given, why] of [
      [getter, "getter says no"],
      [keys, "ownKeys says no"],
      [proto, "getPrototypeOf says no"],
    ] as const) {
      const r = cleanAppAbout(given);
      expect(r.parts).toEqual([]);
      expect(r.advice).toEqual([
        `the app's about parts were dropped: they could not be read (${why}).`,
      ]);
    }
  });
  test("what is kept is what a restore gives: a toJSON value is kept as its JSON", () => {
    const r = cleanAppAbout({ when: new Date(0), at: { toJSON: () => "the harbour" } });
    expect(r.parts).toEqual([
      ["when", "1970-01-01T00:00:00.000Z"],
      ["at", "the harbour"],
    ]);
  });
  test("every reserved name is refused, Object.prototype's own and prototype", () => {
    for (const k of RESERVED_PART_NAMES)
      expect(cleanAppAbout(JSON.parse(`{"${k}":1}`)).parts).toEqual([]);
    expect(RESERVED_PART_NAMES.has("__proto__")).toBe(true);
    expect(RESERVED_PART_NAMES.has("prototype")).toBe(true);
  });
});

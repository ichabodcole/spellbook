// Events that ask nothing of the agent stay off its tail (`TailRule` in
// `events.ts`), and stay on the log for every other reader. The rule: an event
// belongs on the agent's tail only if it can change what the agent should do
// next. What the human only looked at is read from `state`, or rides their next
// message as `about`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_EVENT_TAIL, KIT_EVENTS } from "./events";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, type Ev, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
const tails: ReturnType<typeof collectEvents>[] = [];

beforeEach(() => {
  root = tempRoot("quiet-tail");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  for (const t of tails.splice(0)) await t.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(overrides: Parameters<typeof fixtureDaemon>[0] = {}) {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  daemon = fixtureDaemon({ tmp, workspace: join(root, "ws"), platform: "darwin", ...overrides });
  mkdirSync(join(root, "ws"), { recursive: true });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  await surface.waitFor((m) => m.op === "state");
  const base = daemon.url;
  const listen = (since = -1, o: { agent?: boolean; once?: boolean } = {}) => {
    const t = collectEvents(base, since, o);
    tails.push(t);
    return t;
  };
  return { d: daemon, s: surface, base, listen };
}

const inSet = (name: string) => join(docs, "set", name);
const types = (evs: Ev[]) => evs.map((e) => e.type);
const cursorOf = async (base: string) =>
  ((await (await fetch(`${base}/state`)).json()) as { cursor: number }).cursor;

/** Open a document as the human does, and wait for its text. */
async function humanOpens(s: FakeSurface, path: string) {
  const before = s.frames.length;
  s.send({ op: "open", path });
  await waitUntil("the opened text", () =>
    s.frames.slice(before).find((f) => f.op === "version.text"),
  );
}

describe("the rule, per event type", () => {
  test("every kit event names one, and the ones the human only looked at are quiet", () => {
    expect(Object.keys(KIT_EVENT_TAIL).sort()).toEqual([...KIT_EVENTS].sort());
    expect(KIT_EVENT_TAIL["doc.opened"]).toBe("quiet");
    expect(KIT_EVENT_TAIL.saved).toBe("quiet");
    for (const wakes of ["message", "waiting", "note.added", "version.created", "closed"] as const)
      expect(KIT_EVENT_TAIL[wakes]).toBe("wake");
  });
});

describe("the agent's tail", () => {
  test("a human opening documents wakes nothing; the next message still carries the open document", async () => {
    const { s, base, listen } = await start();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    await agent.waitFor((e) => e.type === "ready");
    s.send({ op: "context.add", path: docs });
    await humanOpens(s, inSet("a.md"));
    await humanOpens(s, inSet("part/b.md"));
    // On the log, for a reader that is not the agent's tail.
    await everyone.waitFor((e) => e.type === "doc.opened" && e.doc === "b");
    expect(everyone.of("doc.opened").map((e) => e.by)).toEqual(["human", "human"]);

    s.send({ op: "say", text: "what do you make of this?", withSelection: false });
    const msg = await agent.waitFor((e) => e.type === "message");
    expect(msg.about).toMatchObject({ doc: "b", version: 1, path: expect.any(String) });
    // What they have open is in the state too.
    const state = (await (await fetch(`${base}/state`)).json()) as {
      openDoc: string;
      active: { doc: string };
    };
    expect(state.openDoc).toBe("b");
    expect(state.active.doc).toBe("b");
    expect(types(agent.events)).not.toContain("doc.opened");
  });

  test("the agent's own open is quiet too; the version it made wakes", async () => {
    const { s, listen } = await start();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    s.send({ op: "context.add", path: docs });
    await waitUntil("the context", () => s.state.context.length === 1);
    const base = daemon?.url ?? "";
    const r = await cmd(base, { op: "version.new", doc: inSet("a.md"), body: "# A\n\ntwo\n" });
    expect(r.status).toBe(200);
    await agent.waitFor((e) => e.type === "version.created");
    await everyone.waitFor((e) => e.type === "doc.opened" && e.by === "agent");
    expect(types(agent.events)).not.toContain("doc.opened");
  });

  test("an app's quiet event is on the log and off the agent's tail, unless it asks for all", async () => {
    const { d, listen } = await start();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    d.context.emit("kit-fixture.glanced", { at: 1 });
    d.context.emit("kit-fixture.pinged", { n: 1 });
    await agent.waitFor((e) => e.type === "kit-fixture.pinged");
    await everyone.waitFor((e) => e.type === "kit-fixture.pinged");
    expect(types(agent.events)).not.toContain("kit-fixture.glanced");
    expect(types(everyone.events)).toContain("kit-fixture.glanced");
  });

  test("tail --all is sent the quiet events", async () => {
    const { d, base } = await start();
    const res = await fetch(`${base}/events?since=-1&agent=1&all=1`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    d.context.emit("kit-fixture.glanced", { at: 1 });
    let buf = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !buf.includes("kit-fixture.glanced")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(buf).toContain("kit-fixture.glanced");
  });

  test("an emit can wake for one frame of a quiet type, or quiet one frame of a waking type", async () => {
    const { d, listen } = await start();
    const agent = listen(-1, { agent: true });
    d.context.emit("kit-fixture.glanced", { at: 1 }, { wake: true });
    d.context.emit("kit-fixture.pinged", { n: 1 }, { wake: false });
    d.context.emit("kit-fixture.pinged", { n: 2 });
    await agent.waitFor((e) => e.type === "kit-fixture.pinged" && e.n === 2);
    expect(
      agent.events.filter((e) => e.type.startsWith("kit-fixture.")).map((e) => e.type),
    ).toEqual(["kit-fixture.glanced", "kit-fixture.pinged"]);
  });

  test("a re-arm from the agent's last cursor skips the quiet frames after it, and doubles nothing", async () => {
    const { d, base, listen } = await start();
    const first = listen(-1, { agent: true });
    d.context.emit("kit-fixture.pinged", { n: 1 });
    const one = await first.waitFor((e) => e.type === "kit-fixture.pinged");
    await first.stop();
    d.context.emit("kit-fixture.glanced", { at: 1 });
    d.context.emit("kit-fixture.glanced", { at: 2 });
    d.context.emit("kit-fixture.pinged", { n: 2 });
    // The log moved past the bookmark by the quiet frames as well.
    expect(await cursorOf(base)).toBe(one.id + 3);
    const rearm = listen(one.id, { agent: true });
    const two = await rearm.waitFor((e) => e.type === "kit-fixture.pinged");
    expect(two.n).toBe(2);
    await Bun.sleep(50);
    expect(types(rearm.events)).toEqual(["kit-fixture.pinged"]);
  });

  test("a --once that closes having been sent only quiet frames was not woken", async () => {
    const { s, base, listen } = await start({ agentGraceMs: 100, agentOnceGraceMs: 2000 });
    const cursor = await cursorOf(base);
    const once = listen(cursor, { agent: true, once: true });
    await waitUntil("listening", () => s.state.agentListening === true);
    s.send({ op: "context.add", path: docs });
    await humanOpens(s, inSet("a.md"));
    expect(await cursorOf(base)).toBeGreaterThan(cursor);
    await once.stop();
    // The short grace, not the woken one.
    await waitUntil("not listening", () => s.state.agentListening === false, 1000);
  });
});

describe("notes", () => {
  test("the agent's own acts on notes are on the log and off its tail; the human's wake it", async () => {
    const { s, base, listen } = await start();
    s.send({ op: "context.add", path: docs });
    await humanOpens(s, inSet("a.md"));
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    // The human's note wakes the agent.
    s.send({ op: "note.add", doc: "a", from: 5, to: 8, body: "cut this?" });
    const added = await agent.waitFor((e) => e.type === "note.added" && e.by === "human");
    const id = String(added.note);
    // The agent's own: a note, a rewrite of it, a reply, a resolve and a reopen.
    const own = await cmd(base, { op: "note.add", doc: "a", quote: "one", body: "mine" });
    expect(own.status).toBe(200);
    const ownId = String(own.body.note);
    expect(
      (await cmd(base, { op: "note.edit", doc: "a", id: ownId, body: "mine, better" })).status,
    ).toBe(200);
    expect((await cmd(base, { op: "note.reply", doc: "a", id, body: "cut" })).status).toBe(200);
    expect((await cmd(base, { op: "note.resolve", doc: "a", id, resolved: true })).status).toBe(
      200,
    );
    await everyone.waitFor((e) => e.type === "note.resolved" && e.by === "agent");
    // The human's acts after them do wake it.
    s.send({ op: "note.resolve", doc: "a", id, resolved: false });
    await agent.waitFor((e) => e.type === "note.resolved" && e.by === "human");
    s.send({ op: "note.edit", doc: "a", id, body: "cut it, then" });
    await agent.waitFor((e) => e.fact === "note.edited" && e.by === "human");
    const byAgent = (evs: Ev[]) =>
      evs.filter(
        (e) => e.by === "agent" && /^note\./.test(String(e.type === "system" ? e.fact : e.type)),
      );
    expect(byAgent(agent.events)).toEqual([]);
    expect(byAgent(everyone.events).map((e) => (e.type === "system" ? e.fact : e.type))).toEqual([
      "note.added",
      "note.edited",
      "note.resolved",
    ]);
  });
});

describe("the human's save", () => {
  async function opened() {
    const started = await start();
    const { s } = started;
    s.send({ op: "context.add", path: docs });
    await humanOpens(s, inSet("a.md"));
    return started;
  }

  /** Save as the human, and return the `saved` frame from the whole log. */
  async function save(s: FakeSurface, everyone: ReturnType<typeof collectEvents>) {
    const had = everyone.of("saved").length;
    s.send({ op: "save", doc: "a" });
    await waitUntil("saved", () => everyone.of("saved").length > had);
    return everyone.of("saved")[had] as Ev;
  }

  test("a save that changed nothing on disk never wakes the agent", async () => {
    const { s, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    // An open human note would wake an edited save: an unchanged one still does not.
    s.send({ op: "note.add", doc: "a", from: 5, to: 8, body: "hm" });
    await agent.waitFor((e) => e.type === "note.added");
    const saved = await save(s, everyone);
    expect(saved).toMatchObject({ unchanged: true });
    expect(saved.because).toBeUndefined();
    s.send({ op: "say", text: "marker", withSelection: false });
    await agent.waitFor((e) => e.type === "message");
    expect(types(agent.events)).not.toContain("saved");
  });

  test("an edited save with nothing of the agent's in flight is the human's own work, and quiet", async () => {
    const { s, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\none, edited\n" });
    const saved = await save(s, everyone);
    expect(saved.unchanged).toBeUndefined();
    expect(saved.because).toBeUndefined();
    s.send({ op: "say", text: "marker", withSelection: false });
    await agent.waitFor((e) => e.type === "message");
    expect(types(agent.events)).not.toContain("saved");
  });

  test("a save wakes the agent once per proposal it has not taken", async () => {
    const { s, base, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    const propose = async (body: string) =>
      expect((await cmd(base, { op: "version.new", doc: "a", body })).status).toBe(200);
    await propose("# A\n\nproposed\n");
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine\n" });
    expect((await save(s, everyone)).because).toEqual(["version"]);
    // The proposal still sits there: the next save does not say so again.
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine, again\n" });
    expect((await save(s, everyone)).because).toBeUndefined();
    // A new proposal is news again.
    await propose("# A\n\nproposed again\n");
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine, a third time\n" });
    expect((await save(s, everyone)).because).toEqual(["version"]);
    await waitUntil("two woken saves", () => agent.of("saved").length === 2);
  });

  test("a task the daemon runs (a render) is not the agent's work in flight", async () => {
    const { s, base, listen } = await opened();
    const everyone = listen(-1);
    expect((await cmd(base, { op: "kit-fixture.demo", hold: true })).status).toBe(200);
    await waitUntil("the running render", () =>
      s.state.tasks.some((t) => t.status === "running" && t.by === "daemon"),
    );
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine\n" });
    expect((await save(s, everyone)).because).toBeUndefined();
  });

  test("a save wakes the agent while it works a task the human created and it picked up", async () => {
    const { s, base, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    s.send({ op: "task.create", title: "Tidy a" });
    const asked = await agent.waitFor((e) => e.type === "task.created" && e.by === "human");
    // The agent picks it up: naming what it is on starts it.
    const r = await cmd(base, { op: "task.status", id: asked.task, detail: "on it" });
    expect(r.status).toBe(200);
    await waitUntil("running", () =>
      s.state.tasks.some((t) => t.id === asked.task && t.status === "running" && t.by === "human"),
    );
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine\n" });
    await save(s, everyone);
    expect((await agent.waitFor((e) => e.type === "saved")).because).toEqual(["task"]);
  });

  test("a save wakes the agent while a task of its own is running", async () => {
    const { s, base, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    expect((await cmd(base, { op: "task.create", title: "Revising a" })).status).toBe(200);
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine\n" });
    await save(s, everyone);
    expect((await agent.waitFor((e) => e.type === "saved")).because).toEqual(["task"]);
  });

  test("a save wakes the agent while a note of the human's on that document is open", async () => {
    const { s, listen } = await opened();
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    s.send({ op: "note.add", doc: "a", from: 5, to: 8, body: "cut this?" });
    await agent.waitFor((e) => e.type === "note.added");
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\none more\n" });
    await save(s, everyone);
    expect((await agent.waitFor((e) => e.type === "saved")).because).toEqual(["note"]);
  });

  test("a save that changes the findings the agent reports wakes it, with the findings", async () => {
    const meta = join(docs, "set", "_meta", "profiles");
    mkdirSync(meta, { recursive: true });
    const vocab = join(meta, "_relations.json");
    const good = `${JSON.stringify({ relations: { applies: { label: "applies" } } }, null, 2)}\n`;
    writeFileSync(vocab, good);
    const { s, listen } = await start();
    s.send({ op: "context.add", path: docs });
    await humanOpens(s, vocab);
    const agent = listen(-1, { agent: true });
    const everyone = listen(-1);
    const slug = s.state.openDoc as string;
    const typo = `${JSON.stringify({ relations: { applies: { label: "applies", symetric: true } } }, null, 2)}\n`;
    s.send({ op: "edit", doc: slug, version: 1, text: typo });
    const had = everyone.of("saved").length;
    s.send({ op: "save", doc: slug });
    await waitUntil("saved", () => everyone.of("saved").length > had);
    const woke = await agent.waitFor((e) => e.type === "saved");
    expect(woke.because).toEqual(["findings"]);
    expect((woke.findings as { kind: string }[]).map((f) => f.kind)).toEqual([
      "relations.warnings",
    ]);
  });
});

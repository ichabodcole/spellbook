// An edit overtaken by a version switch is saved where it was typed (Story
// Studio's 4e6d4d4, `kit-agent-activate-pending-edit`), driven through the
// daemon in process. The agent's `activate` does not go through the human's
// client, so an edit that waited out the client's pause reaches the daemon
// naming the version it was typed in, which is no longer active. The daemon
// takes it into that version, or keeps it as a version of its own when that one
// changed or went since, and tells the human in the chat; the agent hears
// nothing new. Only a version a switch left within `LATE_EDIT_MS` takes a late
// edit: any other edit to a version that is not active is refused as before.
//
// Story Studio holds this against its client (`daemonClient.agentSwitch.test.ts`),
// which this kit does not have yet; here the edit frame is sent as that client
// sends it, straight to the socket.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import { LATE_EDIT_MS, type WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("edit-left");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(overrides: Parameters<typeof fixtureDaemon>[0] = {}) {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "ws"), ...overrides });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  return { d: daemon, s: surface };
}

const docOf = (s: FakeSurface, slug: string) => s.state.docs.find((d) => d.slug === slug);
const fileOf = (s: FakeSurface, slug: string, n: number) =>
  docOf(s, slug)?.versions.find((v) => v.n === n)?.path as string;
const chat = (s: FakeSurface) => s.state.chat.map((m) => m.text);
const edit = (s: FakeSurface, version: number, text: string, rid?: string) =>
  s.send({ op: "edit", doc: "solo", version, text, ...(rid ? { rid } : {}) });

/**
 * Open solo.md and give it a second version made by the agent, with a text of
 * its own, so an edit written into the wrong version shows. v1 stays active.
 */
async function soloWithTwo(s: FakeSurface, base: string) {
  s.send({ op: "context.add", path: docs });
  s.send({ op: "open", path: join(docs, "solo.md") });
  await waitUntil("solo open", () => docOf(s, "solo"));
  const r = await cmd(base, { op: "version.new", doc: "solo", body: "# Version two\n" });
  expect(r.status).toBe(200);
  await waitUntil("v2", () => docOf(s, "solo")?.versions.length === 2);
  expect(docOf(s, "solo")?.active).toBe(1);
  return { v1: fileOf(s, "solo", 1), v2: fileOf(s, "solo", 2) };
}

/** A plain say, waited for: every frame sent before it has been handled. */
async function settle(s: FakeSurface, text: string) {
  s.send({ op: "say", text, withSelection: false });
  await waitUntil(`"${text}"`, () => chat(s).includes(text));
}

const refusedFor = (s: FakeSurface, rid: string) =>
  s.frames.find((f) => f.op === "error" && (f as { requestId?: unknown }).requestId === rid);

describe("an edit to the version a switch just left", () => {
  test("after the agent's switch: saved to the version it was typed in, and only the human is told", async () => {
    const { d, s } = await start();
    const { v1, v2 } = await soloWithTwo(s, d.url);
    const tail = collectEvents(d.url, -1, { agent: true });
    const before = await waitUntil("the tail's backlog", () =>
      tail.events.length > 0 ? tail.events.length : undefined,
    );
    expect((await cmd(d.url, { op: "activate", doc: "solo", version: 2 })).status).toBe(200);
    edit(s, 1, "# Typed in v1\n", "e1");
    await waitUntil("the chat line", () =>
      chat(s).includes("Your last edit was saved to v1 of solo; the agent made v2 active."),
    );
    expect(readFileSync(v1, "utf8")).toBe("# Typed in v1\n");
    expect(readFileSync(v2, "utf8")).toBe("# Version two\n");
    expect(docOf(s, "solo")?.active).toBe(2);
    expect(docOf(s, "solo")?.versions).toHaveLength(2);
    expect(refusedFor(s, "e1")).toBeUndefined();
    // The agent heard its own switch and nothing else.
    await Bun.sleep(200);
    const types = tail.events.slice(before).map((e) => e.type);
    await tail.stop();
    expect(types).toEqual(["activated"]);
  });

  test("two switches in the window: the edit still lands in the version it was typed in", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    await cmd(d.url, { op: "version.new", doc: "solo", from: 1, body: "# Version three\n" });
    await waitUntil("v3", () => docOf(s, "solo")?.versions.length === 3);
    await cmd(d.url, { op: "activate", doc: "solo", version: 2 });
    await cmd(d.url, { op: "activate", doc: "solo", version: 3 });
    edit(s, 1, "# Typed in v1\n");
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    expect(readFileSync(fileOf(s, "solo", 3), "utf8")).toBe("# Version three\n");
    expect(docOf(s, "solo")?.active).toBe(3);
  });

  test("the version changed after the switch: the edit is kept as a version of its own", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    await cmd(d.url, { op: "activate", doc: "solo", version: 2 });
    // The agent rewrites v1's file with its own tools, as it may once v1 is not active.
    writeFileSync(v1, "# The agent's v1\n");
    edit(s, 1, "# Typed in v1\n");
    const kept = await waitUntil("a third version", () =>
      docOf(s, "solo")?.versions.find((v) => v.n === 3),
    );
    expect(readFileSync(v1, "utf8")).toBe("# The agent's v1\n");
    expect(readFileSync(kept.path, "utf8")).toBe("# Typed in v1\n");
    expect(kept).toMatchObject({ by: "human", fromVersion: 1 });
    expect(docOf(s, "solo")?.active).toBe(2);
    await waitUntil("the chat line", () =>
      chat(s).includes(
        "Your last edit to v1 of solo was kept as v3, because v1 changed after the switch; the agent made v2 active.",
      ),
    );
  });

  test("the version was deleted after the switch: the edit is kept as a version of its own", async () => {
    const { d, s } = await start();
    await soloWithTwo(s, d.url);
    await cmd(d.url, { op: "activate", doc: "solo", version: 2 });
    expect((await cmd(d.url, { op: "version.delete", doc: "solo", version: 1 })).status).toBe(200);
    edit(s, 1, "# Typed in v1\n");
    const kept = await waitUntil("a version for the edit", () =>
      docOf(s, "solo")?.versions.find((v) => v.n === 3),
    );
    expect(readFileSync(kept.path, "utf8")).toBe("# Typed in v1\n");
    expect(kept).toMatchObject({ by: "human", fromVersion: 2 });
    await waitUntil("the chat line", () =>
      chat(s).includes(
        "Your last edit to v1 of solo was kept as v3, because v1 was deleted after the switch; the agent made v2 active.",
      ),
    );
  });

  test("typed after the human's own click, before the switch was seen: saved, and said as theirs", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    s.send({ op: "activate", doc: "solo", version: 2 });
    edit(s, 1, "# Typed in v1\n");
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await waitUntil("the chat line", () =>
      chat(s).includes("Your last edit was saved to v1 of solo before you switched to v2."),
    );
  });

  test("a version the human made and moved into counts as a switch too", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    s.send({ op: "version.new", doc: "solo", activate: true });
    await waitUntil("v3 active", () => docOf(s, "solo")?.active === 3);
    edit(s, 1, "# Typed in v1\n");
    await waitUntil("the edit in v1", () => readFileSync(v1, "utf8") === "# Typed in v1\n");
    await waitUntil("the chat line", () =>
      chat(s).includes("Your last edit was saved to v1 of solo before you switched to v3."),
    );
  });
});

describe("only an edit a switch just overtook is taken late", () => {
  test("a version that was never active is refused, its file untouched", async () => {
    const { d, s } = await start();
    const { v2 } = await soloWithTwo(s, d.url);
    edit(s, 2, "# Over v2\n", "e1");
    await settle(s, "after");
    expect(refusedFor(s, "e1")).toBeDefined();
    expect(readFileSync(v2, "utf8")).toBe("# Version two\n");
    expect(docOf(s, "solo")?.versions).toHaveLength(2);
  });

  test("a version that does not exist is refused, and none is made", async () => {
    const { d, s } = await start();
    await soloWithTwo(s, d.url);
    edit(s, 99, "# Made up\n", "e1");
    await settle(s, "after");
    expect(refusedFor(s, "e1")).toBeDefined();
    expect(docOf(s, "solo")?.versions).toHaveLength(2);
  });

  test("an edit arriving after the window is refused, not saved", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    await cmd(d.url, { op: "activate", doc: "solo", version: 2 });
    await Bun.sleep(LATE_EDIT_MS + 200);
    edit(s, 1, "# Typed in v1\n", "e1");
    await settle(s, "after");
    expect(refusedFor(s, "e1")).toBeDefined();
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(docOf(s, "solo")?.versions).toHaveLength(2);
    expect(chat(s).filter((t) => t.includes("last edit"))).toEqual([]);
  }, 15_000);

  test("after a daemon restart there is no record of the switch: a late edit is refused", async () => {
    const one = await start();
    const { v1 } = await soloWithTwo(one.s, one.d.url);
    await cmd(one.d.url, { op: "activate", doc: "solo", version: 2 });
    await waitUntil("v2 active", () => docOf(one.s, "solo")?.active === 2);
    const id = one.d.sessionId;
    one.s.close();
    await one.d.stop();
    daemon = null;
    surface = null;
    const two = await start({ restore: id });
    await waitUntil("restored", () => docOf(two.s, "solo")?.active === 2);
    edit(two.s, 1, "# Typed in v1\n", "e1");
    await settle(two.s, "after");
    expect(refusedFor(two.s, "e1")).toBeDefined();
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(docOf(two.s, "solo")?.versions).toHaveLength(2);
  });

  test("with nothing typed, the switch is as it was: no line about an edit, no file touched", async () => {
    const { d, s } = await start();
    const { v1 } = await soloWithTwo(s, d.url);
    const r = await cmd(d.url, { op: "activate", doc: "solo", version: 2 });
    expect(r.body).toMatchObject({ ok: true, doc: "solo", version: 2, previous: 1 });
    await settle(s, "after");
    expect(readFileSync(v1, "utf8")).toBe("# Solo\n");
    expect(chat(s).filter((t) => t.includes("last edit"))).toEqual([]);
  });
});

// A message says which gesture it came through (`via`) and what it draws on
// beside its one subject (`about.refs`), over a real daemon: stored as sent,
// checked against the lists the kit starts and the app extends, answered with
// an advisory when a value is outside them, and carried on the agent's tail.
// Ported from Story Studio's bbc54fd; the agent's `via` of the wrong type is
// this kit's own cell (its `/cmd` field checks).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pngBytes } from "../lib/testImages.ts";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import {
  cleanVia,
  KIT_REF_ROLES,
  KIT_VIA,
  MAX_REFS,
  messageVia,
  refRole,
  roleAdvisory,
  VIA_MAX,
  viaAdvisory,
} from "./messageParts";
import type { MessageAbout } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli.ts");

let root: string;
let world: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("via-refs");
  world = join(root, "ws", "world");
  mkdirSync(join(world, "places"), { recursive: true });
  writeFileSync(join(world, "places", "cave.md"), "# Cave\n");
  writeFileSync(join(world, "stair.md"), "# Stair\n");
  writeFileSync(join(world, "well.md"), "# Well\n");
  writeFileSync(join(world, "fox.png"), pngBytes(4, 4));
  writeFileSync(join(root, "outside.md"), "# Not in the context\n");
  mkdirSync(join(root, "tmp"));
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
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "ws"), ...overrides });
  await daemon.start();
  tail = collectEvents(daemon.url, -1, { agent: true });
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: world });
  await waitUntil("context", () => surface?.state.context.length === 1);
  return { d: daemon, s: surface, t: tail };
}

const said = (s: FakeSurface, text: string) => s.state.chat.find((m) => m.text === text);
const sent = (s: FakeSurface, text: string) =>
  waitUntil(`"${text}" in the chat`, () => said(s, text));

/** The tail's message event for `text`, once it is there. */
const tailed = (t: ReturnType<typeof collectEvents>, text: string) =>
  t.waitFor((e) => e.type === "message" && e.text === text);

describe("the lists", () => {
  test("the kit knows the composer and its own buttons as gestures, and only reference as a role", () => {
    // The user, 2026-10-14: each of the kit's buttons has its own value.
    expect([...KIT_VIA]).toEqual(["chat", "describe", "fix", "ask"]);
    expect([...KIT_REF_ROLES]).toEqual(["reference"]);
  });

  test("a message without via reads as chat, and a ref without a role as reference", () => {
    expect(messageVia({})).toBe("chat");
    expect(messageVia({ via: "pace" })).toBe("pace");
    expect(refRole({})).toBe("reference");
    expect(refRole({ role: "guidance" })).toBe("guidance");
  });

  test("the advisory names the value and the known ones, and says nothing for a known one", () => {
    expect(viaAdvisory("chat", KIT_VIA)).toBeNull();
    expect(viaAdvisory(undefined, KIT_VIA)).toBeNull();
    const v = viaAdvisory("button", [...KIT_VIA, "pace"]) ?? "";
    expect(v).toContain('"button"');
    expect(v).toContain("chat, describe, fix, ask, pace");
    expect(v).toContain("stored");
    expect(v).toContain("if it is real");
    expect(roleAdvisory(["reference"], KIT_REF_ROLES)).toBeNull();
    expect(roleAdvisory(["odd", "odd", "reference"], KIT_REF_ROLES)).toContain('"odd"');
  });

  test("a via is trimmed and cut to its length; anything not a word of text is none", () => {
    expect(cleanVia(" pace ")).toEqual({ via: "pace", cut: false });
    expect(cleanVia("x".repeat(VIA_MAX))).toEqual({ via: "x".repeat(VIA_MAX), cut: false });
    expect(cleanVia("x".repeat(5000))).toEqual({ via: "x".repeat(VIA_MAX), cut: true });
    expect(cleanVia("")).toEqual({ via: undefined, cut: false });
    expect(cleanVia(42)).toEqual({ via: undefined, cut: false });
  });
});

describe("via", () => {
  test("is stored as sent, defaults to chat on the tail, and is carried there", async () => {
    const { s, t } = await start({ via: [...KIT_VIA, "pace"] });
    s.send({ op: "say", text: "typed", withSelection: false, via: "chat" });
    s.send({ op: "say", text: "pressed", withSelection: false, via: "pace" });
    // An old page, or a message from before the field: none is stored, and it reads as chat.
    s.send({ op: "say", text: "older", withSelection: false });
    await t.waitFor((e) => e.type === "message" && e.text === "older");
    const tailed = t.of("message").map((e) => [e.text, e.via]);
    expect(tailed).toEqual([
      ["typed", "chat"],
      ["pressed", "pace"],
      ["older", "chat"],
    ]);
    await sent(s, "older");
    expect(said(s, "typed")?.via).toBe("chat");
    expect(said(s, "pressed")?.via).toBe("pace");
    expect(said(s, "older")).not.toHaveProperty("via");
    expect(messageVia(said(s, "older") ?? {})).toBe("chat");
  });

  test("an unknown value is stored as sent and answered with an advisory, never refused", async () => {
    const { d, s, t } = await start();
    s.send({ op: "say", text: "a new button", withSelection: false, via: "shiny" });
    // A page's say has no result: the advisory rides the tail's message, to the agent.
    const ev = await tailed(t, "a new button");
    expect(ev.via).toBe("shiny");
    expect(String(ev.warning)).toContain('via "shiny"');
    expect((await sent(s, "a new button")).via).toBe("shiny");
    // A known one earns no warning.
    s.send({ op: "say", text: "typed", withSelection: false, via: "chat" });
    expect(await tailed(t, "typed")).not.toHaveProperty("warning");
    // The agent's say: the result carries it as `warning`.
    const r = await cmd(d.url, { op: "say", text: "from the agent", via: "shiny" });
    expect(r.status).toBe(200);
    expect(String(r.body.warning)).toContain('via "shiny"');
    expect((await sent(s, "from the agent")).via).toBe("shiny");
    const known = await cmd(d.url, { op: "say", text: "plain", via: "chat" });
    expect(known.body).not.toHaveProperty("warning");
  });

  test("a via longer than its limit is stored cut, and the warning says so", async () => {
    const { d, s, t } = await start();
    const long = `a${"b".repeat(4999)}`;
    s.send({ op: "say", text: "long gesture", withSelection: false, via: long });
    const ev = await tailed(t, "long gesture");
    expect(ev.via).toBe(long.slice(0, VIA_MAX));
    expect(String(ev.warning)).toContain(`longer than ${VIA_MAX}`);
    // It says the value was cut, never that it was kept as sent.
    expect(String(ev.warning)).toContain(`stored with it cut to ${VIA_MAX} characters`);
    expect(String(ev.warning)).not.toContain("as sent");
    expect((await sent(s, "long gesture")).via).toBe(long.slice(0, VIA_MAX));
    const r = await cmd(d.url, { op: "say", text: "long from the agent", via: long });
    expect(String(r.body.warning)).toContain(`longer than ${VIA_MAX}`);
    expect((await sent(s, "long from the agent")).via).toHaveLength(VIA_MAX);
  });

  test("the agent's via that is not a string is refused with a 400, before anything is stored", async () => {
    // This kit's `/cmd` field checks (`checkAgentCmd`): a field of the wrong
    // type is refused, not read as absent.
    const { d, s } = await start();
    const r = await cmd(d.url, { op: "say", text: "typed wrong", via: 42 });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("via must be a string when given");
    await cmd(d.url, { op: "say", text: "after" });
    await sent(s, "after");
    expect(said(s, "typed wrong")).toBeUndefined();
  });

  test("the agent's say with a human's button value is stored, with a warning that says so", async () => {
    const { d, s } = await start({ via: [...KIT_VIA, "pace"] });
    for (const via of ["ask", "describe", "fix", "pace"]) {
      const r = await cmd(d.url, { op: "say", text: `agent ${via}`, via });
      expect(r.status).toBe(200);
      expect(String(r.body.warning)).toContain(`via "${via}" is a button the human presses`);
      expect((await sent(s, `agent ${via}`)).via).toBe(via);
    }
    const plain = await cmd(d.url, { op: "say", text: "agent chat", via: "chat" });
    expect(plain.body).not.toHaveProperty("warning");
  });

  test("the agent's say keeps only entryIds and noteId: refs, docs and a subject are not stored", async () => {
    const { d, s } = await start();
    const r = await cmd(d.url, {
      op: "say",
      text: "about a note",
      about: {
        noteId: "n-1",
        entryIds: ["e1", 7],
        refs: [{ path: "/etc/passwd" }],
        docs: ["/nope"],
        path: "/etc/passwd",
      },
    });
    expect(r.status).toBe(200);
    expect((await sent(s, "about a note")).about).toEqual({ entryIds: ["e1"], noteId: "n-1" });
    await cmd(d.url, { op: "say", text: "only refs", about: { refs: [{ path: "/etc/passwd" }] } });
    expect((await sent(s, "only refs")).about).toBeUndefined();
  });

  test("the CLI takes --via and prints the advisory on stderr", async () => {
    const { d, s } = await start();
    const run = async (...args: string[]) => {
      const p = Bun.spawn(["bun", CLI, ...args, "--session", d.sessionId], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...process.env, TMPDIR: `${join(root, "tmp")}/` },
      });
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { out, err, code };
    };
    const odd = await run("say", "via a gesture", "--via", "shiny");
    expect(odd.code).toBe(0);
    expect(odd.err).toContain('via "shiny"');
    expect(JSON.parse(odd.out).warning).toContain('via "shiny"');
    expect((await sent(s, "via a gesture")).via).toBe("shiny");
    const plain = await run("say", "plainly");
    expect(plain.code).toBe(0);
    expect(plain.err).toBe("");
    expect((await sent(s, "plainly")).via).toBeUndefined();
  }, 30_000);
});

describe("refs", () => {
  test("ride about through say and on the tail, each kept only in the context, canonical", async () => {
    const { s, t } = await start();
    s.send({
      op: "say",
      text: "draw on these",
      withSelection: false,
      via: "chat",
      about: {
        refs: [
          { path: join(world, "places", "cave.md"), label: "Cave" },
          { path: join(world, "fox.png"), role: "reference" },
          { path: "/etc/passwd" },
          { path: join(world, "places", "..", "..", "..", "outside.md") },
          { path: "relative/stair.md" },
          { nope: true },
          42,
          // A `..` that stays inside is the same document as the next: kept once.
          { path: join(world, "places", "..", "stair.md") },
          { path: join(world, "stair.md"), label: "a second time" },
        ],
      } as never,
    });
    const ev = await tailed(t, "draw on these");
    // Four were dropped as outside the context (a value that is no object at all is no ref).
    expect(String(ev.warning)).toContain("4 refs were dropped: not a document or image");
    const want = [
      { path: join(world, "places", "cave.md"), label: "Cave" },
      { path: join(world, "fox.png"), role: "reference" },
      { path: join(world, "stair.md") },
    ];
    expect((ev.about as MessageAbout).refs).toEqual(want);
    expect((await sent(s, "draw on these")).about?.refs).toEqual(want);
    // Nothing in the context: no refs key at all.
    s.send({
      op: "say",
      text: "nothing here",
      withSelection: false,
      about: { refs: [{ path: "/etc/passwd" }] },
    });
    expect((await sent(s, "nothing here")).about).toBeUndefined();
    expect(String((await tailed(t, "nothing here")).warning)).toContain("1 ref was dropped");
  });

  test("at most MAX_REFS ride a message; the rest are dropped, and the warning says how many", async () => {
    const many = join(world, "many");
    mkdirSync(many);
    for (let i = 0; i < 60; i++) writeFileSync(join(many, `d${i}.md`), `# D${i}\n`);
    const { s, t } = await start();
    // The new folder shows in the context once the watch has read it.
    await waitUntil("the folder's documents", () =>
      JSON.stringify(s.state.context).includes("many/d59.md"),
    );
    s.send({
      op: "say",
      text: "sixty",
      withSelection: false,
      about: { refs: Array.from({ length: 60 }, (_, i) => ({ path: join(many, `d${i}.md`) })) },
    });
    const ev = await tailed(t, "sixty");
    const refs = (ev.about as MessageAbout).refs ?? [];
    expect(MAX_REFS).toBe(50);
    expect(refs).toHaveLength(MAX_REFS);
    expect(refs.at(-1)?.path).toBe(join(many, "d49.md"));
    expect(String(ev.warning)).toContain(`10 refs were dropped past the first ${MAX_REFS}`);
    expect((await sent(s, "sixty")).about?.refs).toHaveLength(MAX_REFS);
  });

  test("a ref naming the subject is dropped, whether the subject is the open document or a selection", async () => {
    const { s } = await start();
    s.send({ op: "open", path: join(world, "well.md") });
    await waitUntil("well open", () => s.state.openDoc === "well");
    s.send({
      op: "say",
      text: "about the well",
      withSelection: false,
      about: {
        refs: [{ path: join(world, "well.md") }, { path: join(world, "stair.md") }],
      },
    });
    const m = await sent(s, "about the well");
    expect(m.about?.doc).toBe("well");
    expect(m.about?.refs).toEqual([{ path: join(world, "stair.md") }]);
    // The selection's document is the subject too, by its original path.
    const path = s.state.docs.find((d) => d.slug === "well")?.versions[0]?.path ?? "";
    s.send({
      op: "select",
      selection: { doc: "well", version: 1, path, fromLine: 1, toLine: 1, text: "Well" },
    });
    await waitUntil("held", () => s.state.selection?.text === "Well");
    s.send({
      op: "say",
      text: "this line",
      withSelection: true,
      about: { refs: [{ path: join(world, "well.md") }, { path: path }] },
    });
    const sel = await sent(s, "this line");
    expect(sel.about?.text).toBe("Well");
    expect(sel.about?.refs).toBeUndefined();
  });

  test("a page names a whole document or image as the subject; refs beside it skip it", async () => {
    const { s, t } = await start();
    s.send({
      op: "say",
      text: "describe this",
      withSelection: false,
      about: {
        path: join(world, "fox.png"),
        refs: [{ path: join(world, "fox.png") }, { path: join(world, "well.md") }],
      },
    });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "describe this");
    expect(ev.about).toEqual({
      path: join(world, "fox.png"),
      refs: [{ path: join(world, "well.md") }],
    });
    // A document the session holds is said as its active version.
    s.send({ op: "open", path: join(world, "stair.md") });
    await waitUntil("stair open", () => s.state.openDoc === "stair");
    s.send({ op: "open", path: join(world, "well.md") });
    await waitUntil("well open", () => s.state.openDoc === "well");
    s.send({
      op: "say",
      text: "the stair",
      withSelection: false,
      about: { path: join(world, "stair.md") },
    });
    const m = await sent(s, "the stair");
    expect(m.about?.doc).toBe("stair");
    expect(m.about?.version).toBe(1);
    // One outside the context names no subject: the human pointed at it, so the
    // open document would be the wrong answer. The warning says so.
    s.send({
      op: "say",
      text: "outside",
      withSelection: false,
      about: { path: join(root, "outside.md") },
    });
    expect((await sent(s, "outside")).about).toBeUndefined();
    const ev2 = await tailed(t, "outside");
    expect(ev2.about).toBeUndefined();
    expect(String(ev2.warning)).toContain("the message names no subject");
  });

  test("with nothing named and no selection, the daemon's open image is the subject", async () => {
    const { s, t } = await start();
    s.send({ op: "open", path: join(world, "well.md") });
    await waitUntil("well open", () => s.state.openDoc === "well");
    s.send({ op: "open", path: join(world, "fox.png") });
    await waitUntil("fox open", () => s.state.openImage?.path === join(world, "fox.png"));
    // A page that names nothing (a client porting the daemon half first).
    s.send({ op: "say", text: "what is this?", withSelection: false });
    expect((await tailed(t, "what is this?")).about).toEqual({ path: join(world, "fox.png") });
  });

  test("an unknown role is stored as sent, with the advisory; an app's own role is known", async () => {
    const { s, t } = await start({ refRoles: ["guidance"] });
    s.send({
      op: "say",
      text: "roles",
      withSelection: false,
      about: {
        refs: [
          { path: join(world, "well.md"), role: "guidance" },
          { path: join(world, "stair.md"), role: "adherence" },
        ],
      },
    });
    const warning = String((await tailed(t, "roles")).warning);
    expect(warning).toContain('ref role "adherence"');
    expect(warning).not.toContain('"guidance"');
    expect((await sent(s, "roles")).about?.refs?.map((r) => r.role)).toEqual([
      "guidance",
      "adherence",
    ]);
  });

  test("no app part may be named refs: the kit's key wins", async () => {
    const { s, t } = await start({
      hooks: { messageAbout: () => ({ refs: ["the app's own"], glance: { at: "the harbour" } }) },
    });
    s.send({
      op: "say",
      text: "with the app's part",
      withSelection: false,
      about: { refs: [{ path: join(world, "well.md") }] },
    });
    const ev = await t.waitFor((e) => e.type === "message" && e.text === "with the app's part");
    expect(ev.about).toEqual({
      refs: [{ path: join(world, "well.md") }],
      glance: { at: "the harbour" },
    });
    s.send({ op: "say", text: "the app alone", withSelection: false });
    const alone = await t.waitFor((e) => e.type === "message" && e.text === "the app alone");
    expect(alone.about).toEqual({ glance: { at: "the harbour" } });
  });

  test("about.docs is no longer read from a page", async () => {
    const { s } = await start();
    s.send({
      op: "say",
      text: "old shape",
      withSelection: false,
      about: { docs: [join(world, "well.md")] } as never,
    });
    expect((await sent(s, "old shape")).about).toBeUndefined();
  });
});

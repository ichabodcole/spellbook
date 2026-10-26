// `show`: the agent points the human's view at a change or a passage. The daemon
// checks the target is there, makes the document the open one, tells every
// surface where to scroll, and says so in the chat. A target that is not there
// moves nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-show");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

const inSet = (name: string) => join(docs, "set", name);

/** A daemon with `a.md` open and a v2 that changes two separate lines of it. */
async function start() {
  writeFileSync(inSet("a.md"), "# A\n\none\n\nmiddle\n\nthree\n");
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), platform: "darwin", reveal: () => {} });
  await daemon.start();
  const s = new FakeSurface();
  surface = s;
  await s.connect(daemon.port);
  s.send({ op: "context.add", path: docs });
  s.send({ op: "open", path: inSet("a.md") });
  await s.waitFor((m) => m.op === "version.text");
  const v2 = await cmd(daemon.url, { op: "version.new", doc: "a" });
  writeFileSync(String(v2.body.path), "# A\n\nONE\n\nmiddle\n\nTHREE\n");
  await waitUntil("v2 seen", () => s.state.docs[0]?.versions.length === 2);
  return { s, base: daemon.url };
}

const shows = (s: FakeSurface) =>
  s.frames.filter((f): f is Extract<ServerOp, { op: "show" }> => f.op === "show");
const chatSays = (s: FakeSurface, text: string) =>
  s.state.chat.some((m) => m.from === "system" && m.text.includes(text));

describe("show", () => {
  test("a change: every surface is told the hunk and the side, and the chat says which", async () => {
    const { s, base } = await start();
    const r = await cmd(base, { op: "show", doc: "a", hunk: 2, against: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      doc: "a",
      version: 1,
      hunk: 2,
      of: 2,
      against: 2,
      line: 7,
      surfaces: 1,
    });
    const f = await s.waitFor((m) => m.op === "show");
    expect(f).toMatchObject({ op: "show", doc: "a", version: 1, hunk: 2, against: 2 });
    await waitUntil("the chat line", () => chatSays(s, "showing you change 2 of 2 in a.md"));
  });

  test("a change against the saved file is the default side", async () => {
    const { s, base } = await start();
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\none\n\nmiddle, edited\n\nthree\n" });
    await waitUntil("dirty", () => s.state.docs[0]?.dirty);
    const r = await cmd(base, { op: "show", hunk: 1 });
    expect(r.body).toMatchObject({ hunk: 1, of: 1, against: "original", line: 5 });
    await s.waitFor((m) => m.op === "show" && "hunk" in m && m.against === "original");
  });

  test("a passage: the offsets of the quote in the active version, and its line", async () => {
    const { s, base } = await start();
    const r = await cmd(base, { op: "show", doc: "a", quote: "middle" });
    expect(r.body).toMatchObject({ doc: "a", version: 1, from: 10, to: 16, line: 5 });
    const f = await s.waitFor((m) => m.op === "show");
    expect(f).toMatchObject({ doc: "a", version: 1, from: 10, to: 16, quote: "middle" });
    await waitUntil("the chat line", () => chatSays(s, 'showing you "middle" in a.md'));
  });

  test("a document not on screen is opened for the human first", async () => {
    const { s, base } = await start();
    s.send({ op: "open", path: join(docs, "solo.md") });
    await waitUntil("solo open", () => s.state.openDoc === "solo");
    const at = s.frames.length;
    await cmd(base, { op: "show", doc: "a", quote: "three" });
    await waitUntil("a open again", () => s.state.openDoc === "a");
    // The snapshot that opens it comes before the frame that says where to look.
    const after = s.frames.slice(at);
    const opened = after.findIndex((f) => f.op === "state" && f.state.openDoc === "a");
    const shown = after.findIndex((f) => f.op === "show");
    expect(opened).toBeGreaterThanOrEqual(0);
    expect(shown).toBeGreaterThan(opened);
  });

  test("a path the session does not hold yet is opened and shown", async () => {
    const { s, base } = await start();
    const r = await cmd(base, { op: "show", doc: inSet(join("part", "b.md")), quote: "# B" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ doc: "b", from: 0, to: 3, line: 1 });
    await waitUntil("b open", () => s.state.openDoc === "b");
  });

  test("a target that is not there is refused, and nothing moves", async () => {
    const { s, base } = await start();
    s.send({ op: "open", path: join(docs, "solo.md") });
    await waitUntil("solo open", () => s.state.openDoc === "solo");
    const chat = s.state.chat.length;

    const noHunk = await cmd(base, { op: "show", doc: "a", hunk: 9, against: 2 });
    expect(noHunk.status).toBe(404);
    expect(noHunk.body).toMatchObject({ choices: ["1", "2"] });
    expect(String(noHunk.body.error)).toContain("no hunk 9");

    const noQuote = await cmd(base, { op: "show", doc: "a", quote: "not in it" });
    expect(noQuote.status).toBe(404);
    expect(String(noQuote.body.error)).toContain("does not contain that text");

    const neither = await cmd(base, { op: "show", doc: "a" });
    expect(neither.status).toBe(400);
    const both = await cmd(base, { op: "show", doc: "a", hunk: 1, quote: "one" });
    expect(both.status).toBe(400);
    const badHunk = await cmd(base, { op: "show", doc: "a", hunk: 0 });
    expect(badHunk.status).toBe(400);

    // A moment for anything that might have been sent to arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(shows(s)).toEqual([]);
    expect(s.state.openDoc).toBe("solo");
    expect(s.state.chat.length).toBe(chat);
  });

  test("a path not held yet is checked before it is opened: a miss opens nothing", async () => {
    const { s, base } = await start();
    const docsBefore = s.state.docs.length;
    const b = inSet(join("part", "b.md"));
    const noQuote = await cmd(base, { op: "show", doc: b, quote: "not in it" });
    expect(noQuote.status).toBe(404);
    const noHunk = await cmd(base, { op: "show", doc: b, hunk: 1 });
    expect(noHunk.status).toBe(404);
    expect(String(noHunk.body.error)).toContain("not open in this session");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.state.docs.length).toBe(docsBefore);
    expect(s.state.docs.some((d) => d.slug === "b")).toBe(false);
  });

  test("a filename of a context document not open: the refusal offers its absolute path", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "show", doc: "solo.md", quote: "Solo" });
    expect(r.status).toBe(404);
    const solo = join(docs, "solo.md");
    expect(r.body.choices).toEqual([solo, "a"]);
    expect(String(r.body.hint)).toContain(solo);
  });

  test("nobody watching is said in the answer", async () => {
    const { s, base } = await start();
    s.close();
    surface = null;
    await new Promise((r) => setTimeout(r, 50));
    const r = await cmd(base, { op: "show", doc: "a", quote: "middle" });
    expect(r.body).toMatchObject({ surfaces: 0 });
  });

  test("with nothing open and no --doc, it says to name one", async () => {
    daemon = fixtureDaemon({ tmp: join(root, "tmp") });
    await daemon.start();
    const r = await cmd(daemon.url, { op: "show", quote: "one" });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain("name one with --doc");
  });
});

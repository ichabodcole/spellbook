// Links to a heading, through the daemon (kit-heading-links-build): following
// one says where the heading is in the version it opened, the picker's second
// step lists a document's headings with the anchor to write, the agent's `show`
// takes a heading, and the link check lists links to a heading that is not
// there apart from dangling links, with repeated headings as a hint.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { LinkCheck, ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

const TOUCHSTONES = [
  "# Touchstones",
  "",
  "## Ritual",
  "",
  "### *A Voyage to Arcturus* — David Lindsay",
  "",
  "Maskull crosses Tormance.",
  "",
  "## How lenses work",
  "### Stacking lenses",
  "## Methodology",
  "### Stacking lenses",
  "",
].join("\n");

const GRAMMAR = [
  "# Grammar of passage",
  "",
  "Form as instrument: see [Arcturus](./touchstones.md?rel=grounded-in#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay).",
  "",
  "Reworded: [old](./touchstones.md#A%20Voyage%20to%20Arcturus).",
  "",
  "Repeated: [stack](./touchstones.md#Stacking%20lenses).",
  "",
  "Pathed: [stack](./touchstones.md#Methodology#Stacking%20lenses).",
  "",
  "Slug: [slug](./touchstones.md#a-voyage-to-arcturus--david-lindsay).",
  "",
  "Gone: [gone](./nowhere.md#Anything).",
  "",
].join("\n");

beforeEach(() => {
  root = tempRoot("workspace-headings");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  world = join(root, "world");
  mkdirSync(world, { recursive: true });
  writeFileSync(join(world, "touchstones.md"), TOUCHSTONES);
  writeFileSync(join(world, "grammar.md"), GRAMMAR);
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), platform: "darwin", reveal: () => {} });
  await daemon.start();
  const s = new FakeSurface();
  surface = s;
  await s.connect(daemon.port);
  s.send({ op: "context.add", path: world });
  s.send({ op: "open", path: join(world, "grammar.md") });
  await s.waitFor((m) => m.op === "version.text");
  return { s, base: daemon.url };
}

type Target = Extract<ServerOp, { op: "link.target" }>;
const follow = async (s: FakeSurface, target: string): Promise<Target> => {
  s.send({ op: "link.open", target, doc: "grammar" });
  return (await s.waitFor((m) => m.op === "link.target" && m.target === target)) as Target;
};

describe("following a link to a heading", () => {
  test("the reply names the heading and its line's extent in the version opened", async () => {
    const { s } = await start();
    const t = await follow(
      s,
      "./touchstones.md?rel=grounded-in#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay",
    );
    expect(t.state).toBe("in-context");
    expect(t.heading).toEqual({
      anchor: "A Voyage to Arcturus — David Lindsay",
      doc: "touchstones",
      version: 1,
      found: {
        text: "A Voyage to Arcturus — David Lindsay",
        line: 5,
        from: TOUCHSTONES.indexOf("### *A"),
        to: TOUCHSTONES.indexOf("Lindsay") + "Lindsay".length,
      },
    });
    await waitUntil("opened", () => s.state.openDoc === "touchstones");
  });

  test("a slug and a path of headings follow too; a bare repeat lands on the first", async () => {
    const { s } = await start();
    expect(
      (await follow(s, "./touchstones.md#a-voyage-to-arcturus--david-lindsay")).heading?.found
        ?.line,
    ).toBe(5);
    expect(
      (await follow(s, "./touchstones.md#Methodology#Stacking%20lenses")).heading?.found?.line,
    ).toBe(12);
    const bare = await follow(s, "./touchstones.md#Stacking%20lenses");
    expect(bare.heading?.found).toMatchObject({ line: 10, ambiguous: true });
  });

  test("a heading that is not there still opens the document, and says so", async () => {
    const { s } = await start();
    const t = await follow(s, "./touchstones.md#A%20Voyage%20to%20Arcturus");
    expect(t.state).toBe("in-context");
    expect(t.heading).toEqual({ anchor: "A Voyage to Arcturus", doc: "touchstones", version: 1 });
    await waitUntil("opened", () => s.state.openDoc === "touchstones");
  });

  test("a link without an anchor carries no heading", async () => {
    const { s } = await start();
    expect((await follow(s, "./touchstones.md")).heading).toBeUndefined();
  });
});

describe("the picker's headings", () => {
  test("each heading with the anchor to write; a repeat as its path", async () => {
    const { s } = await start();
    s.send({ op: "link.headings", doc: "grammar", path: join(world, "touchstones.md") });
    const f = (await s.waitFor((m) => m.op === "link.headings")) as Extract<
      ServerOp,
      { op: "link.headings" }
    >;
    expect(f.headings.map((h) => [h.level, h.text, h.anchor])).toEqual([
      [1, "Touchstones", "Touchstones"],
      [2, "Ritual", "Ritual"],
      [
        3,
        "A Voyage to Arcturus — David Lindsay",
        "A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay",
      ],
      [2, "How lenses work", "How%20lenses%20work"],
      [3, "Stacking lenses", "How%20lenses%20work#Stacking%20lenses"],
      [2, "Methodology", "Methodology"],
      [3, "Stacking lenses", "Methodology#Stacking%20lenses"],
    ]);
  });

  test("a path outside the context has none", async () => {
    const { s } = await start();
    s.send({ op: "link.headings", doc: "grammar", path: join(root, "elsewhere.md") });
    const f = (await s.waitFor((m) => m.op === "link.headings")) as Extract<
      ServerOp,
      { op: "link.headings" }
    >;
    expect(f.headings).toEqual([]);
  });
});

describe("show --heading", () => {
  test("points at the heading's line, opens the document, and says so", async () => {
    const { s, base } = await start();
    const r = await cmd(base, {
      op: "show",
      doc: join(world, "touchstones.md"),
      heading: "A Voyage to Arcturus — David Lindsay",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ heading: "A Voyage to Arcturus — David Lindsay", line: 5 });
    const f = await s.waitFor((m) => m.op === "show");
    expect(f).toMatchObject({
      doc: "touchstones",
      quote: "### *A Voyage to Arcturus* — David Lindsay",
    });
    await waitUntil("the chat line", () =>
      s.state.chat.some((m) => m.text.includes('the heading "A Voyage to Arcturus')),
    );
  });

  test("a heading that is not there moves nothing and names the nearest", async () => {
    const { s, base } = await start();
    const r = await cmd(base, {
      op: "show",
      doc: join(world, "touchstones.md"),
      heading: "Stacking lens",
    });
    expect(r.status).toBe(404);
    expect(String(r.body.error)).toContain('the nearest is "Stacking lenses"');
    expect(s.frames.some((m) => m.op === "show")).toBe(false);
  });

  test("one of hunk, quote or heading, never two", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "show", heading: "Ritual", quote: "Ritual" });
    expect(r.status).toBe(400);
  });
});

describe("the link check", () => {
  test("lists links to a missing heading apart from dangling links, with the nearest; a bare repeat is a hint", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "link.check" });
    const c = r.body as unknown as LinkCheck;
    expect(c.dangling.links.map((l) => l.raw)).toEqual(["./nowhere.md#Anything"]);
    expect(c.headings.count).toBe(1);
    expect(c.headings.links[0]).toMatchObject({
      raw: "./touchstones.md#A%20Voyage%20to%20Arcturus",
      heading: "A Voyage to Arcturus",
      target: join(world, "touchstones.md"),
      targetShown: "touchstones.md",
      nearest: "A Voyage to Arcturus — David Lindsay",
      line: 5,
    });
    expect(c.ambiguousHeadings.count).toBe(1);
    expect(c.ambiguousHeadings.hints[0]).toMatchObject({
      raw: "./touchstones.md#Stacking%20lenses",
      nearest: "Stacking lenses",
    });
    // Dangling and missing headings count; the hint does not.
    expect(c.count).toBe(2);
  });

  test("a link that is only #heading is checked against its own document; a repeated one-word heading is a hint", async () => {
    writeFileSync(
      join(world, "places.md"),
      [
        "# Places",
        "",
        "Up: [notes](#Notes), [here](#Places), [gone](#No%20such), [[#Nor%20this]].",
        "",
        "## The Glade",
        "### Notes",
        "## The Ruin",
        "### Notes",
        "",
      ].join("\n"),
    );
    const { base } = await start();
    const c = (await cmd(base, { op: "link.check" })).body as unknown as LinkCheck;
    const here = (l: { source: string }) => l.source === join(world, "places.md");
    expect(c.headings.links.filter(here).map((l) => [l.raw, l.target])).toEqual([
      ["#No%20such", join(world, "places.md")],
      ["#Nor%20this", join(world, "places.md")],
    ]);
    expect(c.ambiguousHeadings.hints.filter(here).map((l) => l.raw)).toEqual(["#Notes"]);
    // A fragment is never a dangling link.
    expect(c.dangling.links.some(here)).toBe(false);
  });

  test("the doctor names the missing heading as a finding", async () => {
    const { base } = await start();
    const r = await cmd(base, { op: "doctor" });
    const findings = (r.body.findings ?? []) as { kind: string; count?: number }[];
    expect(findings.find((f) => f.kind === "links.heading")?.count).toBe(1);
  });
});

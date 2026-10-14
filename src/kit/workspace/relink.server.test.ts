// The daemon's half of links that follow a rename or move: the offer both
// parties see, accepting it as part of the act (one undo entry for the file and
// its links), `--update-links`, leaving them, and an open editor following.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let set: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("workspace-relink-server");
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "world");
  mkdirSync(join(set, "places"), { recursive: true });
  writeFileSync(join(set, "places", "glade.md"), "# The Glade\n\n## The Well\n");
  writeFileSync(
    join(set, "keeper.md"),
    "# Keeper\n\nLives by [the Glade](./places/glade.md?rel=located-in#The%20Well).\n",
  );
  writeFileSync(join(set, "index.md"), "- [Glade](places/glade.md)\n");
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

const at = (rel: string) => join(set, rel);
const read = (rel: string) => readFileSync(at(rel), "utf8");

async function start() {
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  daemon = fixtureDaemon({ tmp, workspace: root, platform: "darwin" });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: set });
  await waitUntil("the set", () => surface?.state.context.length === 1);
  return { s: surface, base: daemon.url, t: tail };
}

test("a rename offers the broken links; accepting updates them, and one undo puts back both", async () => {
  const { s, t } = await start();
  s.send({ op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  const offer = await waitUntil("the offer", () => s.state.relink);
  expect(offer).toMatchObject({ what: "glade.md", by: "human", count: 2 });
  expect(offer.docs.map((d) => d.shown).sort()).toEqual(["world/index.md", "world/keeper.md"]);
  const fact = await t.waitFor((e) => e.type === "system" && e.fact === "rename");
  expect(fact.broken).toMatchObject({ count: 2 });
  expect(String(fact.text)).toContain("2 links in 2 documents still point at where glade.md was");
  // Declined so far: nothing rewritten.
  expect(read("keeper.md")).toContain("./places/glade.md");

  s.send({ op: "relink" });
  await waitUntil("rewritten", () => read("index.md").includes("the-glade.md"));
  expect(read("keeper.md")).toBe(
    "# Keeper\n\nLives by [the Glade](./places/the-glade.md?rel=located-in#The%20Well).\n",
  );
  expect(read("index.md")).toBe("- [Glade](./places/the-glade.md)\n");
  const done = await t.waitFor((e) => e.type === "system" && e.fact === "relink");
  expect(done).toMatchObject({ by: "human", count: 2 });
  await waitUntil("offer gone", () => !s.state.relink);
  expect(s.state.history.undoLabel).toBe("renamed glade.md to the-glade.md, updating 2 links");

  // One undo: the file and its links, together.
  s.send({ op: "history.undo" });
  await waitUntil("undone", () => existsSync(at("places/glade.md")));
  await waitUntil("links back", () => read("index.md") === "- [Glade](places/glade.md)\n");
  expect(read("keeper.md")).toContain("](./places/glade.md?rel=located-in#The%20Well)");
  // The state frame can trail the files on disk.
  await waitUntil("nothing left to undo", () => s.state.history.canUndo === false);
  // And redo does both again.
  s.send({ op: "history.redo" });
  await waitUntil("redone", () => existsSync(at("places/the-glade.md")));
  await waitUntil("links again", () => read("index.md") === "- [Glade](./places/the-glade.md)\n");
});

test("the agent's move --update-links does both in one act and says which links changed", async () => {
  const { s, base } = await start();
  expect((await cmd(base, { op: "folder.create", dir: set, name: "lore" })).status).toBe(200);
  const r = await cmd(base, {
    op: "move",
    path: at("places/glade.md"),
    into: at("lore"),
    updateLinks: true,
  });
  expect(r.status).toBe(200);
  const links = r.body.links as {
    count: number;
    docs: { path: string; links: { to: string }[] }[];
  };
  expect(links.count).toBe(2);
  expect(links.docs.find((d) => d.path === at("keeper.md"))?.links[0]?.to).toBe(
    "./lore/glade.md?rel=located-in#The%20Well",
  );
  expect(read("index.md")).toBe("- [Glade](./lore/glade.md)\n");
  expect(s.state.relink).toBeUndefined();
  await waitUntil("one undo entry", () => s.state.history.undoLabel?.endsWith("updating 2 links"));
  s.send({ op: "history.undo" });
  await waitUntil("back", () => read("index.md") === "- [Glade](places/glade.md)\n");
  expect(existsSync(at("places/glade.md"))).toBe(true);
});

test("relink is refused once the offer has lapsed, and leaving the links keeps them broken for the link check", async () => {
  const { s, base } = await start();
  const moved = await cmd(base, { op: "rename", path: at("places/glade.md"), name: "g2.md" });
  expect((moved.body.broken as { count: number }).count).toBe(2);
  await waitUntil("the offer", () => s.state.relink);
  // Another act ends the offer.
  await cmd(base, { op: "folder.create", dir: set, name: "lore" });
  await waitUntil("lapsed", () => !s.state.relink);
  const refused = await cmd(base, { op: "relink" });
  expect(refused.status).toBe(409);

  // Named back, the links land again: nothing is broken, nothing offered.
  const back = await cmd(base, { op: "rename", path: at("places/g2.md"), name: "glade.md" });
  expect(back.body.broken).toBeUndefined();
  await cmd(base, { op: "rename", path: at("places/glade.md"), name: "g3.md" });
  await waitUntil("a new offer", () => s.state.relink?.what === "glade.md");
  s.send({ op: "relink.leave" });
  await waitUntil("left", () => !s.state.relink);
  expect(read("index.md")).toBe("- [Glade](places/glade.md)\n");
  const check = await cmd(base, { op: "link.check" });
  expect((check.body.dangling as { count: number }).count).toBe(2);
});

test("an open document with unsaved edits keeps them, unsaved, and its editor is sent the new text", async () => {
  const { s } = await start();
  s.send({ op: "open", path: at("keeper.md") });
  const loaded = await s.waitFor((f) => f.op === "version.text" && f.origin === "load");
  if (loaded.op !== "version.text") throw new Error("no text");
  const typed = `${loaded.text}\nAn unsaved line.\n`;
  s.send({ op: "edit", doc: loaded.doc, version: loaded.version, text: typed });
  await waitUntil("dirty", () => s.state.docs.find((d) => d.slug === loaded.doc)?.dirty);
  s.send({ op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  await waitUntil("the offer", () => s.state.relink);
  s.send({ op: "relink" });
  const remote = await s.waitFor((f) => f.op === "version.text" && f.origin === "remote");
  expect(remote.op === "version.text" && remote.text).toBe(
    typed.replace("./places/glade.md", "./places/the-glade.md"),
  );
  // Still unsaved: the file has the original's text with only the link changed.
  expect(read("keeper.md")).toBe(
    "# Keeper\n\nLives by [the Glade](./places/the-glade.md?rel=located-in#The%20Well).\n",
  );
  await waitUntil("still dirty", () => s.state.docs.find((d) => d.slug === loaded.doc)?.dirty);
});

/** The human opens `rel` and types: its slug, version and the text typed. */
async function openAndType(s: FakeSurface, rel: string, extra: string) {
  s.send({ op: "open", path: at(rel) });
  const loaded = await s.waitFor(
    (f) => f.op === "version.text" && f.origin === "load" && f.text.includes("Keeper"),
  );
  if (loaded.op !== "version.text") throw new Error("no text");
  const typed = `${loaded.text}${extra}`;
  s.send({ op: "edit", doc: loaded.doc, version: loaded.version, text: typed });
  await waitUntil("dirty", () => s.state.docs.find((d) => d.slug === loaded.doc)?.dirty);
  return { doc: loaded.doc, version: loaded.version, typed };
}

test("the debounce race: an edit typed before the rewrite carries the old link, and the new one is kept, through Save", async () => {
  const { s, base } = await start();
  const { doc, version, typed } = await openAndType(s, "keeper.md", "\nOne line.\n");
  const r = await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  expect(r.status).toBe(200);
  // The surface's pending write fires after the rewrite, with the buffer typed before it.
  const before = s.frames.length;
  s.send({ op: "edit", doc, version, text: `${typed}Another line.\n` });
  const told = await waitUntil("the kept text", () =>
    s.frames
      .slice(before)
      .find((f) => f.op === "version.text" && f.origin === "remote" && f.text.includes("Another")),
  );
  const kept = typed.replace("./places/glade.md", "./places/the-glade.md");
  expect(told.op === "version.text" && told.text).toBe(`${kept}Another line.\n`);
  s.send({ op: "save", doc });
  await waitUntil("saved", () => read("keeper.md").includes("Another line."));
  expect(read("keeper.md")).toBe(`${kept}Another line.\n`);
  // An edit that already has the new link is the surface's acknowledgement:
  // afterwards an old target typed on purpose stays as typed.
  s.send({ op: "edit", doc, version, text: `${kept}Done.\n` });
  s.send({
    op: "edit",
    doc,
    version,
    text: `${kept}[old](./places/glade.md?rel=located-in#The%20Well)\n`,
  });
  s.send({ op: "save", doc });
  await waitUntil("saved again", () => read("keeper.md").includes("[old]"));
  expect(read("keeper.md")).toContain("[old](./places/glade.md?rel=located-in#The%20Well)");
});

test("an outside write not yet seen is announced as the conflict the watcher would raise, and the document is left alone", async () => {
  const { s, t } = await start();
  const { doc } = await openAndType(s, "keeper.md", "\nMine.\n");
  s.send({ op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  await waitUntil("the offer", () => s.state.relink);
  writeFileSync(at("keeper.md"), "# Keeper\n\nTheirs: [the Glade](./places/glade.md).\n");
  s.send({ op: "relink" });
  await t.waitFor((e) => e.type === "system" && e.fact === "original.conflict" && e.doc === doc);
  const done = await t.waitFor((e) => e.type === "system" && e.fact === "relink");
  expect(done.count).toBe(1);
  expect(String(done.text)).toContain("left world/keeper.md");
  expect(read("keeper.md")).toBe("# Keeper\n\nTheirs: [the Glade](./places/glade.md).\n");
  await waitUntil("marked", () => s.state.docs.find((d) => d.slug === doc)?.outsideChanged);
});

test("wiki links the rename breaks are counted in the offer and in the agent's broken", async () => {
  writeFileSync(at("notes.md"), "See [[places/glade]].\n");
  const { s, base } = await start();
  const r = await cmd(base, { op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  const broken = r.body.broken as { count: number; wiki: unknown[] };
  expect(broken.count).toBe(2);
  expect(broken.wiki).toEqual([{ path: at("notes.md"), line: 1, raw: "places/glade" }]);
  const offer = await waitUntil("the offer", () => s.state.relink);
  expect(offer.wiki.map((w) => w.shown)).toEqual(["world/notes.md"]);
  const said = s.state.chat.at(-1)?.text ?? "";
  expect(said).toContain("and 1 wiki link it can't update");
});

test("an undo names the documents it could not put back; a redo with no link edits offers afresh", async () => {
  const { s } = await start();
  s.send({ op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  await waitUntil("the offer", () => s.state.relink);
  s.send({ op: "relink" });
  await waitUntil("rewritten", () => read("index.md").includes("the-glade.md"));
  rmSync(at("index.md"));
  s.send({ op: "history.undo" });
  await waitUntil("undone", () => existsSync(at("places/glade.md")));
  const undid = await waitUntil("the undo line", () =>
    s.state.chat.find((m) => m.text.startsWith("You undid:")),
  );
  expect(undid.text).toContain(
    "You undid: renamed glade.md to the-glade.md. Links: 1 link in 1 document",
  );
  expect(undid.text).toContain("left world/index.md");
  expect(undid.text).not.toContain("updating 2 links");

  // A second act, declined, then undone and redone: the redo offers again.
  writeFileSync(at("index.md"), "- [Glade](places/glade.md)\n");
  s.send({ op: "rename", path: at("places/glade.md"), name: "g2.md" });
  await waitUntil("an offer", () => s.state.relink?.what === "glade.md");
  s.send({ op: "relink.leave" });
  await waitUntil("left", () => !s.state.relink);
  s.send({ op: "history.undo" });
  await waitUntil("undone again", () => existsSync(at("places/glade.md")));
  expect(s.state.relink).toBeUndefined();
  s.send({ op: "history.redo" });
  await waitUntil("redone", () => existsSync(at("places/g2.md")));
  const again = await waitUntil("a fresh offer", () => s.state.relink);
  expect(again).toMatchObject({ what: "glade.md", count: 2 });
  s.send({ op: "relink" });
  await waitUntil("rewritten", () => read("index.md") === "- [Glade](./places/g2.md)\n");
});

test("a refused undo leaves the offer standing", async () => {
  const { s } = await start();
  s.send({ op: "rename", path: at("places/glade.md"), name: "the-glade.md" });
  await waitUntil("the offer", () => s.state.relink);
  // Something now stands where the undo would put the file back.
  writeFileSync(at("places/glade.md"), "# Another\n");
  s.send({ op: "history.undo" });
  await s.waitFor((f) => f.op === "error");
  await Bun.sleep(50);
  expect(s.state.relink?.what).toBe("glade.md");
});

/** The human opens `rel`: its slug, version and text. */
async function openDoc(s: FakeSurface, rel: string) {
  const from = s.frames.length;
  s.send({ op: "open", path: at(rel) });
  const loaded = await waitUntil("its text", () =>
    s.frames.slice(from).find((f) => f.op === "version.text" && f.origin === "load"),
  );
  if (loaded.op !== "version.text") throw new Error("no text");
  return { doc: loaded.doc, version: loaded.version, text: loaded.text };
}
/** The `rev` of the newest rewritten text the surface was sent for `doc`, as the real surface takes it. */
const revOf = async (s: FakeSurface, doc: string) => {
  const f = await waitUntil("a rewritten text", () =>
    s.frames.findLast((x) => x.op === "version.text" && x.doc === doc && x.rev !== undefined),
  );
  return f.op === "version.text" ? (f.rev as number) : 0;
};
const saveAndRead = async (s: FakeSurface, doc: string, rel: string, expectIn: string) => {
  s.send({ op: "save", doc });
  await waitUntil("saved", () => read(rel).includes(expectIn));
  return read(rel);
};

test("S8: after the rewrite is taken, a link typed on purpose to a new file at the old path is kept", async () => {
  const { s, base } = await start();
  const { doc, version } = await openDoc(s, "keeper.md");
  await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  const rev = await revOf(s, doc);
  const now = read("keeper.md");
  writeFileSync(at("places/glade.md"), "# A new glade\n");
  s.send({ op: "edit", doc, version, text: `${now}[new glade](./places/glade.md)\n`, base: rev });
  const saved = await saveAndRead(s, doc, "keeper.md", "new glade");
  expect(saved).toContain("[new glade](./places/glade.md)");
  expect(saved).toContain("](./places/the-glade.md?rel=located-in#The%20Well)");
});

test("S10: a link written from a moved document's new place, meaning a file there, is kept", async () => {
  mkdirSync(at("people"));
  writeFileSync(at("x.md"), "# X at the root\n");
  writeFileSync(at("people/x.md"), "# X among people\n");
  writeFileSync(at("note.md"), "# Note\n\n[x](./x.md)\n");
  const { s, base } = await start();
  const { doc, version } = await openDoc(s, "note.md");
  const r = await cmd(base, {
    op: "move",
    path: at("note.md"),
    into: at("people"),
    updateLinks: true,
  });
  expect(r.status).toBe(200);
  const rev = await revOf(s, doc);
  expect(read("people/note.md")).toBe("# Note\n\n[x](../x.md)\n");
  s.send({
    op: "edit",
    doc,
    version,
    text: "# Note\n\n[x](../x.md)\n[sibling](./x.md)\n",
    base: rev,
  });
  const saved = await saveAndRead(s, doc, "people/note.md", "sibling");
  expect(saved).toBe("# Note\n\n[x](../x.md)\n[sibling](./x.md)\n");
});

test("S12: closing the document ends the rewrite's hold on its edits", async () => {
  const { s, base } = await start();
  const opened = await openDoc(s, "keeper.md");
  await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  await revOf(s, opened.doc);
  s.send({ op: "doc.close", doc: opened.doc });
  const again = await openDoc(s, "keeper.md");
  // The human puts the old link back on purpose (a glade made again at the old path).
  writeFileSync(at("places/glade.md"), "# Again\n");
  s.send({ op: "edit", doc: again.doc, version: again.version, text: opened.text });
  const saved = await saveAndRead(s, again.doc, "keeper.md", "](./places/glade.md?");
  expect(saved).toBe(opened.text);
});

test("an edit with no newer base, typed over the old text, keeps the rewrite on the lines it did not change", async () => {
  const { s, base } = await start();
  const { doc, version, text } = await openDoc(s, "keeper.md");
  await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  // The surface had a write pending, so it dropped the rewrite (base unchanged),
  // and the human also typed a line naming the old path on purpose.
  s.send({ op: "edit", doc, version, text: `${text}Late line [old](./places/glade.md).\n` });
  const saved = await saveAndRead(s, doc, "keeper.md", "Late line");
  expect(saved).toContain("](./places/the-glade.md?rel=located-in#The%20Well)");
  expect(saved).toContain("Late line [old](./places/glade.md).");
});

test("scenario D: typing in the link's own paragraph while the links update keeps the new link and the typing", async () => {
  const { s, base, t } = await start();
  const { doc, version, text } = await openDoc(s, "keeper.md");
  await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  // The surface's late write: the link's line itself was typed in, over the old text.
  const typed = text.replace(").\n", "), by the water.\n");
  expect(typed).not.toBe(text);
  s.send({ op: "edit", doc, version, text: typed });
  const saved = await saveAndRead(s, doc, "keeper.md", "by the water");
  expect(saved).toBe(
    "# Keeper\n\nLives by [the Glade](./places/the-glade.md?rel=located-in#The%20Well), by the water.\n",
  );
  // Nothing old was kept, so nothing is said of it.
  expect(t.events.some((e) => e.type === "system" && e.fact === "relink.kept")).toBe(false);
});

test("a second copy of the old target typed into the changed line is kept, and said", async () => {
  const { s, base, t } = await start();
  const { doc, version, text } = await openDoc(s, "keeper.md");
  await cmd(base, {
    op: "rename",
    path: at("places/glade.md"),
    name: "the-glade.md",
    updateLinks: true,
  });
  const old = "./places/glade.md?rel=located-in#The%20Well";
  const typed = text.replace(").\n", `), and [again](${old}).\n`);
  s.send({ op: "edit", doc, version, text: typed });
  const kept = await t.waitFor((e) => e.type === "system" && e.fact === "relink.kept");
  expect(kept).toMatchObject({ doc, links: [{ line: 3, raw: old }] });
  expect(String(kept.text)).toContain("kept 1 link to where glade.md was (line 3)");
  const saved = await saveAndRead(s, doc, "keeper.md", "again");
  expect(saved).toBe(
    `# Keeper\n\nLives by [the Glade](./places/the-glade.md?rel=located-in#The%20Well), and [again](${old}).\n`,
  );
});

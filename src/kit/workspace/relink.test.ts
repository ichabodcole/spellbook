// Links that follow a rename or move (kit-rename-updates-references): what a
// move breaks, how each link is written again, and what rewriting does to a
// document the session holds. The daemon's offer, accept and undo are in
// `relink.server.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { retarget, swapLinkTargets } from "./links";
import { WorkspaceSession } from "./session";
import { tempRoot, testApp } from "./testing";

let root: string;
let set: string;

beforeEach(() => {
  root = tempRoot("workspace-relink");
  set = join(root, "world");
  mkdirSync(join(set, "places"), { recursive: true });
  mkdirSync(join(set, "people"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(set, rel);
const write = (rel: string, text: string) => writeFileSync(at(rel), text);
const read = (rel: string) => readFileSync(at(rel), "utf8");
const session = () => {
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  s.addContext(set);
  return s;
};
/** Apply every fix a move found, as the daemon's accept does. */
const accept = (
  s: WorkspaceSession,
  links: { path: string; fixes: { from: string; to: string }[] }[] | undefined,
) =>
  s.rewriteLinks(
    (links ?? []).map((d) => ({
      path: d.path,
      swaps: d.fixes.map((f): [string, string] => [f.from, f.to]),
    })),
  );

describe("writing a link again", () => {
  test("retarget keeps the query and the anchor, and writes the path as the picker does", () => {
    expect(
      retarget(
        "../places/glade.md?rel=grounded-in#The%20Well",
        at("people/keeper.md"),
        at("places/the glade.md"),
        set,
      ),
    ).toBe("../places/the%20glade.md?rel=grounded-in#The%20Well");
    expect(retarget("glade.md", at("a.md"), at("places/glade.md"), set)).toBe("./places/glade.md");
  });

  test("a target written from the root stays written from the root", () => {
    expect(retarget("/places/glade.md#Top", at("people/keeper.md"), at("lore/glade.md"), set)).toBe(
      "/lore/glade.md#Top",
    );
  });

  test("swapLinkTargets changes only the targets, keeping label, embed, angle brackets and title", () => {
    const text = [
      'See [the *Glade*](./glade.md?rel=x "t") and ![fox](<./fox one.png>).',
      "`[code](./glade.md)` and [[glade]] stay.",
      "[other](./other.md)",
    ].join("\n");
    const out = swapLinkTargets(text, (raw) =>
      raw === "./glade.md?rel=x"
        ? "./places/glade.md?rel=x"
        : raw === "./fox one.png"
          ? "./img/fox%20one.png"
          : undefined,
    );
    expect(out.count).toBe(2);
    expect(out.text).toBe(
      [
        'See [the *Glade*](./places/glade.md?rel=x "t") and ![fox](<./img/fox%20one.png>).',
        "`[code](./glade.md)` and [[glade]] stay.",
        "[other](./other.md)",
      ].join("\n"),
    );
  });
});

describe("what a rename or move breaks", () => {
  test("a rename finds the links to it, each with its new target; rewriting them lands them again", () => {
    write("places/glade.md", "# The Glade\n\n## The Well\n");
    write(
      "people/keeper.md",
      "Lives by [the Glade](../places/glade.md?rel=located-in#The%20Well).\n",
    );
    write("index.md", "[Glade](places/glade.md) and [Keeper](people/keeper.md)\n");
    const s = session();
    const r = s.rename(at("places/glade.md"), "the-glade.md", { links: true });
    expect(r.path).toBe(at("places/the-glade.md"));
    const byDoc = Object.fromEntries((r.links ?? []).map((d) => [d.path, d.fixes]));
    expect(byDoc[at("people/keeper.md")]).toEqual([
      {
        line: 1,
        label: "the Glade",
        from: "../places/glade.md?rel=located-in#The%20Well",
        to: "../places/the-glade.md?rel=located-in#The%20Well",
      },
    ]);
    expect(byDoc[at("index.md")]?.map((f) => f.to)).toEqual(["./places/the-glade.md"]);
    // The link to the keeper did not break, so it is not offered.
    expect(Object.keys(byDoc).length).toBe(2);
    const done = accept(s, r.links);
    expect(done.count).toBe(2);
    expect(read("people/keeper.md")).toBe(
      "Lives by [the Glade](../places/the-glade.md?rel=located-in#The%20Well).\n",
    );
    expect(read("index.md")).toBe(
      "[Glade](./places/the-glade.md) and [Keeper](people/keeper.md)\n",
    );
    expect(s.linkCheck().dangling.count).toBe(0);
  });

  test("a moved document's own links out are fixed, from where it is now", () => {
    write("places/glade.md", "# The Glade\n");
    write("keeper.md", "[the Glade](./places/glade.md) and [me](./keeper.md)\n");
    const s = session();
    const r = s.move(at("keeper.md"), at("people"), { links: true });
    expect(r.links).toEqual([
      {
        path: at("people/keeper.md"),
        was: at("keeper.md"),
        fixes: [
          { line: 1, label: "the Glade", from: "./places/glade.md", to: "../places/glade.md" },
          { line: 1, label: "me", from: "./keeper.md", to: "./keeper.md" },
        ].filter((f) => f.from !== f.to),
      },
    ]);
    accept(s, r.links);
    expect(read("people/keeper.md")).toBe(
      "[the Glade](../places/glade.md) and [me](./keeper.md)\n",
    );
  });

  test("a folder's move fixes links into its contents and leaves links inside it alone", () => {
    write("places/glade.md", "[the Well](./well.md)\n");
    write("places/well.md", "# Well\n");
    write("index.md", "[Glade](./places/glade.md) ![map](places/map.png)\n");
    writeFileSync(at("places/map.png"), "png");
    mkdirSync(at("lore"));
    const s = session();
    const r = s.move(at("places"), at("lore"), { links: true });
    expect(r.links?.map((d) => d.path)).toEqual([at("index.md")]);
    expect(r.links?.[0]?.fixes.map((f) => [f.to, f.embed ?? false])).toEqual([
      ["./lore/places/glade.md", false],
      ["./lore/places/map.png", true],
    ]);
    accept(s, r.links);
    expect(read("index.md")).toBe(
      "[Glade](./lore/places/glade.md) ![map](./lore/places/map.png)\n",
    );
    expect(read("lore/places/glade.md")).toBe("[the Well](./well.md)\n");
  });

  test("an image moves with its description, and the embeds follow it", () => {
    writeFileSync(at("places/fox.png"), "png");
    write("places/fox.png.md", "---\ntype: image\n---\nA fox.\n");
    write("index.md", "![a fox](./places/fox.png)\n");
    const s = session();
    const r = s.move(at("places/fox.png"), at("people"), { links: true });
    expect(r.sidecar).toBe(at("people/fox.png.md"));
    expect(r.links?.[0]?.fixes[0]).toMatchObject({
      from: "./places/fox.png",
      to: "./people/fox.png",
      embed: true,
    });
  });

  test("without links asked, nothing is pinned or offered", () => {
    write("a.md", "[b](./b.md)\n");
    write("b.md", "# B\n");
    const s = session();
    expect(s.rename(at("b.md"), "c.md").links).toBeUndefined();
  });
});

describe("rewriting a document the session holds", () => {
  test("unsaved edits survive, still unsaved; the file gets its own text with the new link", () => {
    write("glade.md", "# Glade\n");
    write("keeper.md", "# Keeper\n\n[the Glade](./glade.md)\n");
    const s = session();
    const { slug } = s.openPath(at("keeper.md"));
    const typed = "# Keeper, rewritten\n\n[the Glade](./glade.md)\n\nAn unsaved line.\n";
    s.edit(slug, 1, typed);
    expect(s.doc(slug).dirty).toBe(true);
    const r = s.rename(at("glade.md"), "the-glade.md", { links: true });
    const done = accept(s, r.links);
    expect(done.texts).toEqual([
      { doc: slug, version: 1, text: typed.replace("./glade.md", "./the-glade.md"), was: typed },
    ]);
    // The active version: the user's text, with only the link changed.
    expect(s.readVersion(slug, 1).text).toBe(typed.replace("./glade.md", "./the-glade.md"));
    // The file: the original's text, never the unsaved one, with the link changed.
    expect(read("keeper.md")).toBe("# Keeper\n\n[the Glade](./the-glade.md)\n");
    expect(s.doc(slug).dirty).toBe(true);
    // Save writes the user's text, and the new link with it.
    s.save(slug);
    expect(read("keeper.md")).toBe(typed.replace("./glade.md", "./the-glade.md"));
  });

  test("a clean document stays clean", () => {
    write("glade.md", "# Glade\n");
    write("keeper.md", "[the Glade](./glade.md)\n");
    const s = session();
    const { slug } = s.openPath(at("keeper.md"));
    accept(s, s.rename(at("glade.md"), "the-glade.md", { links: true }).links);
    expect(s.doc(slug).dirty).toBe(false);
    expect(read("keeper.md")).toBe("[the Glade](./the-glade.md)\n");
  });

  test("a document whose file changed outside the session is left alone, and named", () => {
    write("glade.md", "# Glade\n");
    write("keeper.md", "[the Glade](./glade.md)\n");
    const s = session();
    const { slug } = s.openPath(at("keeper.md"));
    s.edit(slug, 1, "[the Glade](./glade.md)\nmine\n");
    write("keeper.md", "[the Glade](./glade.md)\ntheirs\n");
    s.onFileEvent(at("keeper.md"));
    const done = accept(s, s.rename(at("glade.md"), "the-glade.md", { links: true }).links);
    expect(done.count).toBe(0);
    expect(done.skipped).toEqual([
      { path: at("keeper.md"), reason: expect.stringContaining("outside") },
    ]);
    expect(read("keeper.md")).toBe("[the Glade](./glade.md)\ntheirs\n");
  });

  test("an outside write the watcher has not reported yet is never folded in: dirty, it is marked changed and skipped", () => {
    write("glade.md", "# Glade\n");
    write("keeper.md", "[the Glade](./glade.md)\n");
    const s = session();
    const { slug } = s.openPath(at("keeper.md"));
    s.edit(slug, 1, "[the Glade](./glade.md)\nmine\n");
    // Written outside, and no watcher event delivered.
    write("keeper.md", "[the Glade](./glade.md)\ntheirs\n");
    const done = accept(s, s.rename(at("glade.md"), "the-glade.md", { links: true }).links);
    expect(done.count).toBe(0);
    expect(done.skipped).toEqual([
      { path: at("keeper.md"), reason: expect.stringContaining("outside") },
    ]);
    expect(done.events).toEqual([
      { kind: "original.conflict", doc: slug, original: at("keeper.md") },
    ]);
    expect(s.doc(slug).outsideChanged).toBe(true);
    // Theirs is still on disk, and the session still asks before Save overwrites it.
    expect(read("keeper.md")).toBe("[the Glade](./glade.md)\ntheirs\n");
    expect(s.onFileEvent(at("keeper.md"))).toBeNull();
  });

  test("an unreported outside write to a clean document reloads it first, then the links are rewritten in it", () => {
    write("glade.md", "# Glade\n");
    write("keeper.md", "[the Glade](./glade.md)\n");
    const s = session();
    const { slug } = s.openPath(at("keeper.md"));
    write("keeper.md", "[the Glade](./glade.md)\ntheirs\n");
    const done = accept(s, s.rename(at("glade.md"), "the-glade.md", { links: true }).links);
    expect(done.events.map((e) => e.kind)).toEqual(["original.reloaded"]);
    expect(read("keeper.md")).toBe("[the Glade](./the-glade.md)\ntheirs\n");
    expect(s.readVersion(slug, 1).text).toBe("[the Glade](./the-glade.md)\ntheirs\n");
    expect(s.doc(slug).dirty).toBe(false);
  });

  test("a wiki link the rename breaks is named, never rewritten", () => {
    write("glade.md", "# Glade\n");
    write("notes.md", "See [[glade]] and [the Glade](./glade.md).\n");
    const s = session();
    const r = s.rename(at("glade.md"), "the-glade.md", { links: true });
    expect(r.wiki).toEqual([{ path: at("notes.md"), line: 1, raw: "glade" }]);
    expect(r.links?.[0]?.fixes.map((f) => f.from)).toEqual(["./glade.md"]);
    accept(s, r.links);
    expect(read("notes.md")).toBe("See [[glade]] and [the Glade](./the-glade.md).\n");
  });
});

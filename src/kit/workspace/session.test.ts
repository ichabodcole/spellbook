// The session model's unit tests: the manifest, the versions, the context
// model, and the watcher's one question: whose write was that?
// Every test runs against a fresh temp folder and temp originals; nothing here
// spawns a process or opens a socket.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { contentHash, WorkspaceSession } from "./session";
import { inContext as inContextIn, refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-session");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const create = () => WorkspaceSession.create(sessions, testApp);
const restore = (id: string) => WorkspaceSession.restore(sessions, testApp, id);
const inContext = () => inContextIn(sessions, docs);

describe("the context model one type for a document and a set", () => {
  test("a folder entry is mirrored and rooted at the folder; its nodes mirror documents and images", () => {
    const s = create();
    const { entry } = s.addContext(join(docs, "set"));
    expect(entry.root).toBe(join(docs, "set"));
    expect(entry.membership).toBe("mirrored");
    expect(entry.nodes).toEqual([
      { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/b.md" }] },
      { kind: "doc", rel: "a.md" },
      // An image's own kind of node, never a document.
      { kind: "image", rel: "skip.png" },
    ]);
  });

  test("a single-file entry is rooted at the parent and holds ONLY that doc — not its siblings", () => {
    const s = create();
    const { entry } = s.addContext(join(docs, "solo.md"));
    expect(entry.root).toBe(docs);
    expect(entry.membership).toBe("listed");
    expect(entry.nodes).toEqual([{ kind: "doc", rel: "solo.md" }]);
    // Same shape as a folder entry: no file/folder discriminant anywhere.
    expect(Object.keys(entry).sort()).toEqual([
      "id",
      "label",
      "membership",
      "nodes",
      "realRoot",
      "root",
    ]);
  });

  test("removing the entry that holds the open document closes it — its versions stay", () => {
    const s = create();
    const set = s.addContext(join(docs, "set"));
    s.addContext(join(docs, "solo.md"));
    const { slug } = s.openPath(join(docs, "set", "a.md"));
    expect(s.openDocSlug).toBe(slug);
    s.removeContext(set.entry.id);
    expect(s.openDocSlug).toBeNull();
    // Nothing deleted: the doc and its v1 are still in the session.
    expect(s.view().docs.map((d) => d.slug)).toContain(slug);
  });

  test("removing an entry that does NOT hold the open document leaves it open", () => {
    const s = create();
    const set = s.addContext(join(docs, "set"));
    s.addContext(join(docs, "solo.md"));
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.removeContext(set.entry.id);
    expect(s.openDocSlug).toBe(slug);
  });

  test("adding the same path twice is idempotent", () => {
    const s = create();
    const first = s.addContext(join(docs, "set"));
    const again = s.addContext(join(docs, "set"));
    expect(again.added).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(s.context).toHaveLength(1);
  });

  test("a missing path, and a file that is no document or image, are refused", () => {
    const s = create();
    expect(() => s.addContext(join(docs, "nope.md"))).toThrow(/no such file/);
    writeFileSync(join(docs, "set", "notes.zip"), "PK");
    expect(() => s.addContext(join(docs, "set", "notes.zip"))).toThrow(/not a document or image/);
    writeFileSync(join(docs, "set", "logo.svg"), "<svg/>");
    expect(() => s.addContext(join(docs, "set", "logo.svg"))).toThrow(/SVG/);
    writeFileSync(join(docs, "set", "IMG_1.HEIC"), "x");
    expect(() => s.addContext(join(docs, "set", "IMG_1.HEIC"))).toThrow(/HEIC/);
  });

  test("a single image is listed as its own entry, holding only itself", () => {
    const s = create();
    const { entry } = s.addContext(join(docs, "set", "skip.png"));
    expect(entry).toMatchObject({
      label: "skip.png",
      root: join(docs, "set"),
      membership: "listed",
      nodes: [{ kind: "image", rel: "skip.png" }],
    });
  });

  test("a new file under a MIRRORED root is picked up; under a LISTED root it is not", () => {
    const s = create();
    s.addContext(join(docs, "set"));
    s.addContext(join(docs, "solo.md"));
    writeFileSync(join(docs, "set", "new.md"), "# new\n");
    expect(s.onFileEvent(join(docs, "set", "new.md"))).toMatchObject({ kind: "tree" });
    expect(s.context[0]?.nodes.some((n) => n.kind === "doc" && n.rel === "new.md")).toBe(true);
    writeFileSync(join(docs, "another.md"), "# not mine\n");
    expect(s.onFileEvent(join(docs, "another.md"))).toBeNull();
    expect(s.context[1]?.nodes).toEqual([{ kind: "doc", rel: "solo.md" }]);
  });
});

describe("documents and versions", () => {
  test("opening writes v1 from the original and names its path", () => {
    const s = inContext();
    const { slug, created } = s.openPath(join(docs, "set", "a.md"));
    expect(created).toBe(true);
    const doc = s.doc(slug);
    expect(doc.versions.map((v) => v.n)).toEqual([1]);
    expect(doc.versions[0]?.path).toBe(join(s.dir, "docs", slug, "v1.md"));
    expect(readFileSync(doc.versions[0]?.path ?? "", "utf8")).toBe("# A\n\none\n");
    expect(doc.dirty).toBe(false);
  });

  test("an edit reaches the active version's file and never the original", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "# Solo\n\nedited\n");
    expect(readFileSync(s.readVersion(slug, 1).path, "utf8")).toBe("# Solo\n\nedited\n");
    expect(readFileSync(join(docs, "solo.md"), "utf8")).toBe("# Solo\n");
    expect(s.doc(slug).dirty).toBe(true);
  });

  test("only the active version is editable", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    expect(refusal(() => s.edit(slug, 2, "x")).status).toBe(409);
  });

  test("version-new copies the active version to the next number, with provenance", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "# Solo\n\nunsaved\n");
    const { version } = s.newVersion({ doc: slug, label: "tighten", by: "agent" });
    expect(version).toMatchObject({ n: 2, fromVersion: 1, by: "agent", label: "tighten" });
    expect(readFileSync(version.path, "utf8")).toBe("# Solo\n\nunsaved\n");
  });

  test("save writes the ACTIVE version over the original; revert copies the original back", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const { version } = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(version.path, "# Solo, by the agent\n");
    s.activate({ doc: slug, version: 2 });
    expect(s.doc(slug).dirty).toBe(true);
    s.save(slug);
    expect(readFileSync(join(docs, "solo.md"), "utf8")).toBe("# Solo, by the agent\n");
    expect(s.doc(slug).dirty).toBe(false);
    s.edit(slug, 2, "scribbled\n");
    const r = s.revert(slug);
    expect(r.text).toBe("# Solo, by the agent\n");
    expect(readFileSync(version.path, "utf8")).toBe("# Solo, by the agent\n");
    expect(s.doc(slug).dirty).toBe(false);
  });

  test("unknown doc and version refusals carry the set in hand as choices", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const noDoc = refusal(() => s.newVersion({ doc: "missing", by: "agent" }));
    expect(noDoc.status).toBe(404);
    expect(noDoc.choices).toEqual([slug]);
    const noVersion = refusal(() => s.activate({ doc: slug, version: 7 }));
    expect(noVersion.status).toBe(404);
    expect(noVersion.choices).toEqual(["v1"]);
  });

  test("compare with pick: the first side that differs, the file, then the newest other version", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    // v2 differs, v3 is an untouched copy of v1: v1 is the file.
    const v2 = s.newVersion({ doc: slug, by: "agent", body: "# Solo, changed\n" });
    s.newVersion({ doc: slug, from: 1, by: "agent" });
    const p = s.compare({ doc: slug, against: "original", pick: true });
    expect([p.against, p.picked, p.everyMatches]).toEqual([v2.version.n, true, undefined]);
    expect(p.diff.same).toBe(false);
    // The active version differing from the file: the file comes first.
    s.edit(slug, 1, "# Solo, edited\n");
    expect(s.compare({ doc: slug, against: "original", pick: true }).against).toBe("original");
    // Without pick, the side asked for, whatever it holds.
    expect(s.compare({ doc: slug, against: 3 }).against).toBe(3);
  });

  test("compare with pick, nothing differing: the side asked for, and everyMatches", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    const p = s.compare({ doc: slug, against: "original", pick: true });
    expect([p.against, p.picked, p.everyMatches, p.diff.same]).toEqual([
      "original",
      true,
      true,
      true,
    ]);
  });

  test("a filename naming a context document that is not open: the hint names its path; a verb that takes a path offers it", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const other = join(docs, "sibling.md");
    // version-new takes (and opens) an absolute path from the context: a choice.
    const opens = refusal(() => s.newVersion({ doc: "sibling.md", by: "agent" }));
    expect(opens.status).toBe(404);
    expect(opens.message).toBe('no document "sibling.md" in this session');
    expect(opens.choices).toEqual([other, slug]);
    expect(opens.hint).toContain(other);
    expect(opens.hint).toContain("pass that absolute path to --doc");
    // `show` goes through `doc(…, { takesPath: true })` the same way, and a
    // link question (`backlinks`), which reads a path it does not open.
    expect(refusal(() => s.doc("sibling.md", { takesPath: true })).choices).toEqual([other, slug]);
    expect(refusal(() => s.backlinks("sibling.md")).choices).toEqual([other, slug]);
    // A verb that needs the document open names the path, not as a choice.
    const needsOpen = refusal(() => s.activate({ doc: "sibling.md", version: 1 }));
    expect(needsOpen.choices).toEqual([slug]);
    expect(needsOpen.hint).toContain(other);
    expect(needsOpen.hint).toContain("open it first");
    // The path from its set's root names it too.
    expect(refusal(() => s.activate({ doc: "set/part/b.md", version: 1 })).hint).toContain(
      join(docs, "set", "part", "b.md"),
    );
    // A name the context does not show keeps the plain refusal.
    expect(refusal(() => s.activate({ doc: "missing.md", version: 1 })).hint).toBeUndefined();
  });

  test("a doc is found by slug, by original path, or by a unique basename", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "set", "a.md"));
    expect(s.findDoc(slug)?.slug).toBe(slug);
    expect(s.findDoc(join(docs, "set", "a.md"))?.slug).toBe(slug);
    expect(s.findDoc("a.md")?.slug).toBe(slug);
  });
});

describe("self-write suppression — whose write was that?", () => {
  test("the daemon's own writes classify as nothing", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "mine\n");
    expect(s.onFileEvent(s.readVersion(slug, 1).path)).toBeNull();
    s.save(slug);
    expect(s.onFileEvent(join(docs, "solo.md"))).toBeNull();
  });

  test("an outside write to the ACTIVE version is kept as a new agent version, and the active text restored", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "what the human typed\n");
    const path = s.readVersion(slug, 1).path;
    writeFileSync(path, "the agent wrote here\n");
    expect(s.onFileEvent(path)).toMatchObject({
      kind: "active.outside",
      doc: slug,
      version: 1,
      preservedAs: 2,
    });
    expect(s.readVersion(slug, 2).text).toBe("the agent wrote here\n");
    expect(s.readVersion(slug, 1).text).toBe("what the human typed\n");
    expect(s.doc(slug).versions[1]).toMatchObject({
      by: "agent",
      label: "outside write to v1",
    });
    // The restore is the daemon's own write: a second event is nothing.
    expect(s.onFileEvent(path)).toBeNull();
  });

  test("CHECK BEFORE WRITE: an outside write the watcher has not seen yet is preserved by the next edit", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const path = s.readVersion(slug, 1).path;
    writeFileSync(path, "outside, a moment before the keystroke\n");
    // No onFileEvent: the settle timer has not fired. The edit must not clobber it.
    const r = s.edit(slug, 1, "the keystroke\n");
    expect(r.preserved?.n).toBe(2);
    expect(s.readVersion(slug, 2).text).toBe("outside, a moment before the keystroke\n");
    expect(s.readVersion(slug, 1).text).toBe("the keystroke\n");
    // ...and the daemon's own edits never trip it.
    expect(s.edit(slug, 1, "more typing\n").preserved).toBeNull();
    expect(s.doc(slug).versions).toHaveLength(2);
  });

  test("an outside write to a NON-active version is a change to push, not a violation", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const { version } = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(version.path, "# agent draft\n");
    expect(s.onFileEvent(version.path)).toMatchObject({
      kind: "version.changed",
      version: 2,
      text: "# agent draft\n",
    });
  });

  test("a version file the agent writes by hand is adopted as an agent version", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const p = join(s.dir, "docs", slug, "v5.md");
    writeFileSync(p, "hand-made\n");
    expect(s.onFileEvent(p)).toMatchObject({ kind: "version.created", version: 5 });
    expect(s.doc(slug).versions.map((v) => [v.n, v.by])).toEqual([
      [1, "human"],
      [5, "agent"],
    ]);
  });

  test("an outside change to the original: clean buffer → reload; dirty → ask, once", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    writeFileSync(join(docs, "solo.md"), "# Solo, changed elsewhere\n");
    expect(s.onFileEvent(join(docs, "solo.md"))).toMatchObject({ kind: "original.reloaded" });
    expect(s.readVersion(slug, 1).text).toBe("# Solo, changed elsewhere\n");

    s.edit(slug, 1, "my unsaved edit\n");
    writeFileSync(join(docs, "solo.md"), "# changed again\n");
    expect(s.onFileEvent(join(docs, "solo.md"))).toMatchObject({ kind: "original.conflict" });
    expect(s.doc(slug).outsideChanged).toBe(true);
    expect(s.readVersion(slug, 1).text).toBe("my unsaved edit\n"); // nothing merged
    expect(s.onFileEvent(join(docs, "solo.md"))).toBeNull(); // asked once
  });
});

describe("admission: only a document in the context is opened or saved", () => {
  test("a document outside every context entry is refused", () => {
    const s = create();
    s.addContext(join(docs, "set"));
    expect(refusal(() => s.openPath(join(docs, "solo.md"))).status).toBe(400);
    expect(s.view().docs).toHaveLength(0);
  });

  test("a non-document file is refused even inside a context folder", () => {
    const s = inContext();
    expect(refusal(() => s.openPath(join(docs, "set", "skip.png"))).status).toBe(400);
  });

  test("save refuses an original that was not admitted by openPath", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const mpath = join(s.dir, "manifest.json");
    const m = JSON.parse(readFileSync(mpath, "utf8"));
    const victim = join(root, "victim.rc");
    writeFileSync(victim, "export SAFE=1\n");
    m.docs[0].original = victim;
    delete m.docs[0].admitted;
    writeFileSync(mpath, JSON.stringify(m));
    const r = restore(s.id);
    expect(refusal(() => r.save(slug)).status).toBe(409);
    expect(readFileSync(victim, "utf8")).toBe("export SAFE=1\n");
  });
});

describe("symlinks and relative keys", () => {
  test("a symlinked original is watched at its REAL directory and its events map back to the doc", () => {
    mkdirSync(join(root, "real"), { recursive: true });
    writeFileSync(join(root, "real", "target.md"), "T\n");
    symlinkSync(join(root, "real", "target.md"), join(docs, "link.md"));
    const s = inContext();
    const { slug } = s.openPath(join(docs, "link.md"));
    const realDir = realpathSync(join(root, "real"));
    expect(s.watchRoots().some((r) => r.watch === realDir)).toBe(true);
    writeFileSync(join(root, "real", "target.md"), "changed at the target\n");
    expect(s.onFileEvent(join(realDir, "target.md"))).toMatchObject({
      kind: "original.reloaded",
      doc: slug,
    });
  });

  test("a symlinked home is watched at its realpath and reported under the stored path", () => {
    mkdirSync(join(root, "realhome"), { recursive: true });
    symlinkSync(join(root, "realhome"), join(root, "linkhome"));
    const s = WorkspaceSession.create(join(root, "linkhome"), testApp);
    const docsRoot = s.watchRoots()[0];
    expect(docsRoot?.path).toBe(join(root, "linkhome", s.id, "docs"));
    expect(docsRoot?.watch).toBe(realpathSync(join(root, "realhome", s.id, "docs")));
  });

  test("a RELATIVE key is never resolved against the daemon's cwd", () => {
    const s = inContext();
    s.openPath(join(docs, "set", "a.md"));
    expect(s.findDoc("set/a.md")?.slug).toBe("a"); // the rel form, not a cwd path
    expect(s.findDoc("./nowhere/a.md")).toBeUndefined();
  });
});

describe("the manifest survives a restart (--restore)", () => {
  test("context, docs, versions, active and chat come back", () => {
    const s = inContext();
    s.addContext(join(docs, "set"));
    const { slug } = s.openPath(join(docs, "set", "a.md"));
    s.newVersion({ doc: slug, by: "agent", label: "draft" });
    s.activate({ doc: slug, version: 2 });
    s.addMessage({ from: "human", text: "hello" });
    const r = restore(s.id);
    expect(r.context).toEqual(s.context);
    expect(r.doc(slug)).toEqual(s.doc(slug));
    expect(r.view().chat.map((m) => m.text)).toEqual(["hello"]);
    expect(WorkspaceSession.listSaved(sessions)).toEqual([s.id]);
  });

  test("an original changed while closed is marked and reported on restore", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    writeFileSync(join(docs, "solo.md"), "# changed while no daemon watched\n");
    const r = restore(s.id);
    expect(r.doc(slug).outsideChanged).toBe(true);
    expect(r.restoreReport.outside).toEqual([
      { doc: slug, original: join(docs, "solo.md"), missing: false },
    ]);
    // The active version was not touched — asked, not merged.
    expect(r.readVersion(slug, 1).text).toBe("# Solo\n");
  });

  test("an unchanged original restores with nothing to report", () => {
    const s = inContext();
    s.openPath(join(docs, "solo.md"));
    expect(restore(s.id).restoreReport.outside).toEqual([]);
  });

  test("restoring an unknown session is not_found", () => {
    expect(refusal(() => restore("nope")).status).toBe(404);
  });

  test("the manifest on disk is valid JSON after every change (atomic writes)", () => {
    const s = create();
    s.addContext(join(docs, "solo.md"));
    const m = JSON.parse(readFileSync(join(s.dir, "manifest.json"), "utf8"));
    expect(m.format).toBe(1);
    expect(m.context).toHaveLength(1);
  });
});

test("contentHash is stable and distinguishes content", () => {
  expect(contentHash("a")).toBe(contentHash("a"));
  expect(contentHash("a")).not.toBe(contentHash("b"));
});

describe("deleting a version", () => {
  test("removes the record AND the file", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const v2 = s.newVersion({ doc: slug, by: "agent" }).version;
    expect(existsSync(v2.path)).toBe(true);
    const r = s.deleteVersion({ doc: slug, version: 2 });
    expect(r.remaining).toBe(1);
    expect(s.doc(slug).versions.map((v) => v.n)).toEqual([1]);
    expect(existsSync(v2.path)).toBe(false);
  });

  test("REFUSES the active version, naming what to do instead", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    const e = refusal(() => s.deleteVersion({ doc: slug, version: 1 }));
    expect(e.status).toBe(409);
    expect(e.message).toContain("activate another one first");
  });

  test("so the LAST version can never be deleted — one is always active", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    expect(refusal(() => s.deleteVersion({ doc: slug, version: 1 })).status).toBe(409);
    expect(s.doc(slug).versions).toHaveLength(1);
  });

  test("a version that does not exist is a 404 listing the ones that do", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const e = refusal(() => s.deleteVersion({ doc: slug, version: 9 }));
    expect(e.status).toBe(404);
    expect(e.choices).toEqual(["v1"]);
  });

  test("the number is NOT reused by the next version", () => {
    // Numbering as `max(existing) + 1` would hand the deleted highest number
    // to the next version, and a "v2" named in a chat message or an agent's
    // notes would then point at a different document.
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    s.deleteVersion({ doc: slug, version: 2 });
    const next = s.newVersion({ doc: slug, by: "human" }).version;
    expect(next.n).toBe(3);
  });

  test("numbers keep climbing across several deletions", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    for (const n of [2, 3, 4]) {
      s.newVersion({ doc: slug, by: "agent" });
      s.deleteVersion({ doc: slug, version: n });
    }
    expect(s.newVersion({ doc: slug, by: "human" }).version.n).toBe(5);
  });

  test("`fromVersion` on the survivors is left alone — it stays true", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    s.activate({ doc: slug, version: 2 });
    const v3 = s.newVersion({ doc: slug, from: 2, by: "agent" }).version;
    expect(v3.fromVersion).toBe(2);
    s.activate({ doc: slug, version: 1 });
    s.deleteVersion({ doc: slug, version: 2 });
    expect(s.doc(slug).versions.find((v) => v.n === 3)?.fromVersion).toBe(2);
  });

  test("a file already gone does not block removing the record", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const v2 = s.newVersion({ doc: slug, by: "agent" }).version;
    rmSync(v2.path);
    expect(() => s.deleteVersion({ doc: slug, version: 2 })).not.toThrow();
    expect(s.doc(slug).versions.map((v) => v.n)).toEqual([1]);
  });

  test("the deletion survives a restore", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" });
    s.deleteVersion({ doc: slug, version: 2 });
    const again = restore(s.id);
    expect(again.doc(slug).versions.map((v) => v.n)).toEqual([1]);
    expect(again.newVersion({ doc: slug, by: "human" }).version.n).toBe(3);
  });
});

describe("removeCreated: undo's delete must forget the thing", () => {
  test("a deleted single document leaves the sidebar", () => {
    // `rescan` returns early for a `listed` entry, and a single document is
    // one, so without pruning it stayed in the sidebar with its file gone.
    const s = create();
    const solo = join(docs, "solo.md");
    s.addContext(solo);
    expect(existsSync(solo)).toBe(true);
    const before = s.view().context.length;

    s.removeCreated(solo, false);

    expect(existsSync(solo)).toBe(false);
    const after = s.view().context;
    // The entry is gone, not merely emptied.
    expect(after.length).toBe(before - 1);
    expect(JSON.stringify(after)).not.toContain("solo.md");
  });

  test("and frees the slug: the second half of the same bug", () => {
    // The record outlived the file, so the slug stayed taken and the next
    // Untitled.md became `untitled-2` while the file on disk was `Untitled.md`.
    const s = create();
    const set = join(docs, "set");
    s.addContext(set);
    const first = s.createDoc(set, "Untitled.md");
    s.openPath(first.path);
    expect(s.view().docs[0]?.slug).toBe("untitled");

    s.removeCreated(first.path, false);
    expect(s.view().docs.map((d) => d.slug)).not.toContain("untitled");

    const again = s.createDoc(set, "Untitled.md");
    s.openPath(again.path);
    // The same name gets the same slug, because nothing stale is holding it.
    expect(s.view().docs.map((d) => d.slug)).toEqual(["untitled"]);
  });

  test("a document inside a mirrored set leaves the tree too", () => {
    const s = create();
    const { entry } = s.addContext(join(docs, "set"));
    const made = s.createDoc(join(docs, "set"), "temp.md");
    expect(JSON.stringify(s.view().context)).toContain("temp.md");
    s.removeCreated(made.path, false);
    const after = s.view().context;
    expect(JSON.stringify(after)).not.toContain("temp.md");
    // The set survives: only the document went.
    expect(after.some((e) => e.id === entry.id)).toBe(true);
  });

  test("a non-empty folder is refused, and nothing is forgotten", () => {
    const s = create();
    s.addContext(join(docs, "set"));
    const folder = s.createFolder(join(docs, "set"), "keep");
    writeFileSync(join(folder.path, "stray.md"), "# stray\n");
    expect(refusal(() => s.removeCreated(folder.path, true)).message).toContain("not empty");
    expect(existsSync(join(folder.path, "stray.md"))).toBe(true);
    expect(existsSync(folder.path)).toBe(true);
  });

  test("a path already gone is not an error", () => {
    const s = create();
    expect(s.removeCreated(join(docs, "never-existed.md"), false)).toEqual({
      path: join(docs, "never-existed.md"),
      removed: false,
    });
  });

  test("a file that has become a folder is refused: the world moved", () => {
    const s = create();
    s.addContext(join(docs, "set"));
    const made = s.createFolder(join(docs, "set"), "surprise");
    // Recorded as a file, found as a directory.
    expect(refusal(() => s.removeCreated(made.path, false)).message).toContain(
      "no longer describes",
    );
    expect(existsSync(made.path)).toBe(true);
  });
});

describe("slugs are unique per session", () => {
  test("two documents with the same name in different entries get different slugs", () => {
    mkdirSync(join(docs, "other"), { recursive: true });
    writeFileSync(join(docs, "other", "a.md"), "# Another A\n");
    const s = create();
    s.addContext(join(docs, "set"));
    s.addContext(join(docs, "other"));
    const first = s.openPath(join(docs, "set", "a.md"));
    const second = s.openPath(join(docs, "other", "a.md"));
    expect(first.slug).toBe("a");
    expect(second.slug).toBe("a-2");
    expect(s.view().docs.map((d) => d.slug)).toEqual(["a", "a-2"]);
    // Each slug reaches its own text.
    expect(s.readVersion("a", 1).text).toBe("# A\n\none\n");
    expect(s.readVersion("a-2", 1).text).toBe("# Another A\n");
  });

  test("a slug is unique against punctuation that normalises to the same stem", () => {
    writeFileSync(join(docs, "Ab C.md"), "x");
    writeFileSync(join(docs, "ab-c.md"), "y");
    const s = inContext();
    expect(s.openPath(join(docs, "Ab C.md")).slug).toBe("ab-c");
    expect(s.openPath(join(docs, "ab-c.md")).slug).toBe("ab-c-2");
  });
});

describe("the stored doc and version shapes", () => {
  test("a doc carries the resolution's fields, and a version carries by and fromVersion", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent", label: "tighten" });
    const stored = JSON.parse(readFileSync(join(s.dir, "manifest.json"), "utf8")) as {
      docs: Record<string, unknown>[];
    };
    const d = stored.docs[0] as Record<string, unknown>;
    expect(Object.keys(d).sort()).toEqual(
      [
        "active",
        "admitted",
        "entryId",
        "ext",
        "name",
        "nextVersion",
        "notes",
        "original",
        "originalHash",
        "outsideChanged",
        "rel",
        "slug",
        "versions",
      ].sort(),
    );
    const versions = d.versions as Record<string, unknown>[];
    expect(Object.keys(versions[0] as object).sort()).toEqual(["by", "createdAt", "n"]);
    expect(Object.keys(versions[1] as object).sort()).toEqual(
      ["by", "createdAt", "fromVersion", "label", "n"].sort(),
    );
    expect(d.nextVersion).toBe(3);
    // Every timestamp is ISO 8601.
    expect(new Date(String(versions[1]?.createdAt)).toISOString()).toBe(
      String(versions[1]?.createdAt),
    );
  });

  test("the derived active-text hash follows the text", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const before = s.doc(slug).hash;
    expect(before).toBe(contentHash("# Solo\n"));
    s.edit(slug, 1, "changed\n");
    expect(s.doc(slug).hash).toBe(contentHash("changed\n"));
  });

  test("a hand-written version file moves the counter past itself", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const p = join(s.dir, "docs", slug, "v5.md");
    writeFileSync(p, "hand-made\n");
    s.onFileEvent(p);
    expect(s.newVersion({ doc: slug, by: "agent" }).version.n).toBe(6);
  });
});

describe("a hand-written version file never reuses a number", () => {
  test("one whose number was deleted is renumbered to the counter, and says so", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, by: "agent" }); // v2
    s.deleteVersion({ doc: slug, version: 2 });
    const dir = join(s.dir, "docs", slug);
    writeFileSync(join(dir, "v2.md"), "hand-made\n");
    const ev = s.onFileEvent(join(dir, "v2.md"));
    expect(ev).toMatchObject({ kind: "version.created", version: 3, renamedFrom: 2 });
    expect(existsSync(join(dir, "v2.md"))).toBe(false);
    expect(readFileSync(join(dir, "v3.md"), "utf8")).toBe("hand-made\n");
    expect(s.doc(slug).versions.map((v) => [v.n, v.by])).toEqual([
      [1, "human"],
      [3, "agent"],
    ]);
    // The renumbered file is now the daemon's own: no second event, and the next number is 4.
    expect(s.onFileEvent(join(dir, "v3.md"))).toBeNull();
    expect(s.newVersion({ doc: slug, by: "agent" }).version.n).toBe(4);
  });

  test("a number above the counter is adopted as written, and the counter moves past it", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const p = join(s.dir, "docs", slug, "v9.md");
    writeFileSync(p, "x\n");
    expect(s.onFileEvent(p)).toMatchObject({ version: 9 });
    expect(s.newVersion({ doc: slug, by: "agent" }).version.n).toBe(10);
  });
});

describe("who ended the session", () => {
  test("is written as it ends, and a restore clears it on disk too", () => {
    const s = create();
    s.markEnded("human");
    s.persist();
    const manifest = () =>
      JSON.parse(readFileSync(join(sessions, s.id, "manifest.json"), "utf8")) as {
        ended?: { by: string };
      };
    expect(manifest().ended?.by).toBe("human");
    restore(s.id);
    // Not only in memory: a daemon that then dies without closing must not
    // leave a re-armed tail reading the old end.
    expect(manifest().ended).toBeUndefined();
  });
});

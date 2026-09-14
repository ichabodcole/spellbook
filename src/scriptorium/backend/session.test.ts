// The session model's unit cells: the manifest, the versions, the context
// model (E15), and the watcher's one question — whose write was that?
// Every cell runs against a fresh temp home and temp originals; nothing here
// spawns a process or opens a socket.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, Session, SessionError } from "./session";

let root: string;
let home: string;
let docs: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scriptorium-session-"));
  home = join(root, "home");
  docs = join(root, "docs");
  mkdirSync(join(docs, "set", "part"), { recursive: true });
  writeFileSync(join(docs, "set", "a.md"), "# A\n\none\n");
  writeFileSync(join(docs, "set", "part", "b.md"), "# B\n");
  writeFileSync(join(docs, "set", "skip.png"), "not a doc");
  writeFileSync(join(docs, "solo.md"), "# Solo\n");
  writeFileSync(join(docs, "sibling.md"), "# Sibling\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A session whose context is the whole temp docs folder — the admission rule
 *  (verify-pass fix 1b) means a document must be in context to be opened. */
const inContext = (): Session => {
  const s = Session.create(home);
  s.addContext(docs);
  return s;
};

const refusal = (fn: () => unknown): SessionError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof SessionError) return e;
    throw e;
  }
  throw new Error("expected a SessionError");
};

describe("the context model (E15) — one type for a document and a set", () => {
  test("a folder entry is mirrored and rooted at the folder; its nodes mirror documents only", () => {
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "set"));
    expect(entry.root).toBe(join(docs, "set"));
    expect(entry.membership).toBe("mirrored");
    expect(entry.nodes).toEqual([
      { kind: "group", rel: "part", children: [{ kind: "doc", rel: "part/b.md" }] },
      { kind: "doc", rel: "a.md" },
    ]);
  });

  test("a single-file entry is rooted at the parent and holds ONLY that doc — not its siblings", () => {
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "solo.md"));
    expect(entry.root).toBe(docs);
    expect(entry.membership).toBe("listed");
    expect(entry.nodes).toEqual([{ kind: "doc", rel: "solo.md" }]);
    // Same shape as a folder entry: no file/folder discriminant anywhere.
    expect(Object.keys(entry).sort()).toEqual(["id", "label", "membership", "nodes", "root"]);
  });

  test("removing the entry that holds the open document closes it — its versions stay", () => {
    const s = Session.create(home);
    const set = s.addContext(join(docs, "set"));
    s.addContext(join(docs, "solo.md"));
    const { slug } = s.openPath(join(docs, "set", "a.md"));
    expect(s.openDocSlug).toBe(slug);
    s.removeContext(set.entry.id);
    expect(s.openDocSlug).toBeNull();
    // Nothing deleted: the doc and its v1 are still in the session.
    expect(s.view("release", null).docs.map((d) => d.slug)).toContain(slug);
  });

  test("removing an entry that does NOT hold the open document leaves it open", () => {
    const s = Session.create(home);
    const set = s.addContext(join(docs, "set"));
    s.addContext(join(docs, "solo.md"));
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.removeContext(set.entry.id);
    expect(s.openDocSlug).toBe(slug);
  });

  test("adding the same path twice is idempotent", () => {
    const s = Session.create(home);
    const first = s.addContext(join(docs, "set"));
    const again = s.addContext(join(docs, "set"));
    expect(again.added).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(s.context).toHaveLength(1);
  });

  test("a missing path and a non-document file are refused", () => {
    const s = Session.create(home);
    expect(() => s.addContext(join(docs, "nope.md"))).toThrow(/no such file/);
    expect(() => s.addContext(join(docs, "set", "skip.png"))).toThrow(/not a document/);
  });

  test("a new file under a MIRRORED root is picked up; under a LISTED root it is not", () => {
    const s = Session.create(home);
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

describe("documents and versions (E8)", () => {
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

  test("an edit reaches the active version's file and never the original (E7)", () => {
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
    s.newVersion({ doc: slug, author: "agent" });
    expect(refusal(() => s.edit(slug, 2, "x")).status).toBe(409);
  });

  test("version-new copies the active version to the next number, with provenance", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "# Solo\n\nunsaved\n");
    const { version } = s.newVersion({ doc: slug, label: "tighten", author: "agent" });
    expect(version).toMatchObject({ n: 2, from: 1, author: "agent", label: "tighten" });
    expect(readFileSync(version.path, "utf8")).toBe("# Solo\n\nunsaved\n");
  });

  test("save writes the ACTIVE version over the original; revert copies the original back", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const { version } = s.newVersion({ doc: slug, author: "agent" });
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

  test("unknown doc and version refusals carry the set in hand as choices (A1)", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const noDoc = refusal(() => s.newVersion({ doc: "missing", author: "agent" }));
    expect(noDoc.status).toBe(404);
    expect(noDoc.choices).toEqual([slug]);
    const noVersion = refusal(() => s.activate({ doc: slug, version: 7 }));
    expect(noVersion.status).toBe(404);
    expect(noVersion.choices).toEqual(["v1"]);
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

  test("an outside write to the ACTIVE version is kept as a new agent version, and the active text restored (E2)", () => {
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
      author: "agent",
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
    const { version } = s.newVersion({ doc: slug, author: "agent" });
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
    expect(s.doc(slug).versions.map((v) => [v.n, v.author])).toEqual([
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

describe("admission — only a document in the context is opened or saved (verify-pass fix 1)", () => {
  test("a document outside every context entry is refused", () => {
    const s = Session.create(home);
    s.addContext(join(docs, "set"));
    expect(refusal(() => s.openPath(join(docs, "solo.md"))).status).toBe(400);
    expect(s.view("release", null).docs).toHaveLength(0);
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
    const r = Session.restore(home, s.id);
    expect(refusal(() => r.save(slug)).status).toBe(409);
    expect(readFileSync(victim, "utf8")).toBe("export SAFE=1\n");
  });
});

describe("symlinks and relative keys (verify-pass fixes 3 and 8)", () => {
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
    const s = Session.create(join(root, "linkhome"));
    const docsRoot = s.watchRoots()[0];
    expect(docsRoot?.path).toBe(join(root, "linkhome", "sessions", s.id, "docs"));
    expect(docsRoot?.watch).toBe(realpathSync(join(root, "realhome", "sessions", s.id, "docs")));
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
    s.newVersion({ doc: slug, author: "agent", label: "draft" });
    s.activate({ doc: slug, version: 2 });
    s.addMessage("human", "hello");
    const r = Session.restore(home, s.id);
    expect(r.context).toEqual(s.context);
    expect(r.doc(slug)).toEqual(s.doc(slug));
    expect(r.view("release", null).chat.map((m) => m.text)).toEqual(["hello"]);
    expect(Session.listSaved(home)).toEqual([s.id]);
  });

  test("an original changed WHILE CLOSED is marked and reported on restore (verify-pass fix 2)", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    writeFileSync(join(docs, "solo.md"), "# changed while no daemon watched\n");
    const r = Session.restore(home, s.id);
    expect(r.doc(slug).outsideChanged).toBe(true);
    expect(r.restoreFindings).toEqual([
      { doc: slug, original: join(docs, "solo.md"), missing: false },
    ]);
    // The active version was not touched — asked, not merged.
    expect(r.readVersion(slug, 1).text).toBe("# Solo\n");
  });

  test("an unchanged original restores with nothing to report", () => {
    const s = inContext();
    s.openPath(join(docs, "solo.md"));
    expect(Session.restore(home, s.id).restoreFindings).toEqual([]);
  });

  test("restoring an unknown session is not_found", () => {
    expect(refusal(() => Session.restore(home, "nope")).status).toBe(404);
  });

  test("the manifest on disk is valid JSON after every change (atomic writes)", () => {
    const s = Session.create(home);
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

describe("deleting a version (E41)", () => {
  test("removes the record AND the file", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const v2 = s.newVersion({ doc: slug, author: "agent" }).version;
    expect(existsSync(v2.path)).toBe(true);
    const r = s.deleteVersion({ doc: slug, version: 2 });
    expect(r.remaining).toBe(1);
    expect(s.doc(slug).versions.map((v) => v.n)).toEqual([1]);
    expect(existsSync(v2.path)).toBe(false);
  });

  test("REFUSES the active version, naming what to do instead", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, author: "agent" });
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
    // ⛔ The cell E41 exists for. Numbering was `max(existing) + 1`, so
    // deleting the highest handed its number to the next one — and a "v2"
    // named in a chat message or an agent's notes would then point at a
    // different document.
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, author: "agent" });
    s.deleteVersion({ doc: slug, version: 2 });
    const next = s.newVersion({ doc: slug, author: "human" }).version;
    expect(next.n).toBe(3);
  });

  test("a version made BEFORE the counter existed still does not have its number reused", () => {
    // ⛔ The case the browser found and the cell above missed. A session
    // restored from a manifest written before E41 has no counter; deleting its
    // HIGHEST version must still not free that number for the next one.
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, author: "agent" });
    // Strip the counter from the persisted manifest: a pre-E41 session exactly.
    const file = join(s.dir, "manifest.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      docs: { nextVersion?: number }[];
    };
    for (const doc of raw.docs) doc.nextVersion = undefined;
    writeFileSync(file, JSON.stringify(raw));

    const cold = Session.restore(home, s.id);
    cold.deleteVersion({ doc: slug, version: 2 });
    expect(cold.newVersion({ doc: slug, author: "human" }).version.n).toBe(3);
  });

  test("numbers keep climbing across several deletions", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    for (const n of [2, 3, 4]) {
      s.newVersion({ doc: slug, author: "agent" });
      s.deleteVersion({ doc: slug, version: n });
    }
    expect(s.newVersion({ doc: slug, author: "human" }).version.n).toBe(5);
  });

  test("`from` on the survivors is left alone — it stays true", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, author: "agent" });
    s.activate({ doc: slug, version: 2 });
    const v3 = s.newVersion({ doc: slug, from: 2, author: "agent" }).version;
    expect(v3.from).toBe(2);
    s.activate({ doc: slug, version: 1 });
    s.deleteVersion({ doc: slug, version: 2 });
    expect(s.doc(slug).versions.find((v) => v.n === 3)?.from).toBe(2);
  });

  test("a file already gone does not block removing the record", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const v2 = s.newVersion({ doc: slug, author: "agent" }).version;
    rmSync(v2.path);
    expect(() => s.deleteVersion({ doc: slug, version: 2 })).not.toThrow();
    expect(s.doc(slug).versions.map((v) => v.n)).toEqual([1]);
  });

  test("the deletion survives a restore", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.newVersion({ doc: slug, author: "agent" });
    s.deleteVersion({ doc: slug, version: 2 });
    const again = Session.restore(home, s.id);
    expect(again.doc(slug).versions.map((v) => v.n)).toEqual([1]);
    expect(again.newVersion({ doc: slug, author: "human" }).version.n).toBe(3);
  });
});

describe("dangling links, as a report you can act on (E54)", () => {
  test("file:line lands on the real line, and `wrote` is the string in the file", () => {
    // Four lines of frontmatter, so every body line is short by four.
    writeFileSync(
      join(docs, "set", "a.md"),
      ["---", "type: note", "title: A", "---", "# A", "", "see [it](./nowhere.md?rel=x)", ""].join(
        "\n",
      ),
    );
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "set"));
    const report = s.danglingLinks(entry.id) as {
      count: number;
      links: { from: string; line?: number; wrote?: string; tried: string }[];
    };
    expect(report.count).toBe(1);
    const hit = report.links[0] as { from: string; line?: number; wrote?: string };
    // ⛔ THE LINE IS A FILE LINE. The link is on body line 3 and file line 7;
    // reporting 3 would send a repair to the frontmatter.
    expect(hit.line).toBe(7);
    const fileLines = readFileSync(hit.from, "utf8").split("\n");
    expect(fileLines[(hit.line as number) - 1]).toContain("./nowhere.md?rel=x");
    // And the reported string is the one that is actually there.
    expect(hit.wrote).toBe("./nowhere.md?rel=x");
  });

  test("a resolved link is not in the report at all", () => {
    writeFileSync(join(docs, "set", "a.md"), "# A\n\n[b](part/b.md)\n");
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "set"));
    const report = s.danglingLinks(entry.id) as { count: number };
    expect(report.count).toBe(0);
  });

  test("a frontmatter reference is reported with its KEY and no line", () => {
    writeFileSync(
      join(docs, "set", "a.md"),
      ["---", "type: note", "related:", "  - note/ghost", "---", "# A", ""].join("\n"),
    );
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "set"));
    const report = s.danglingLinks(entry.id) as {
      links: { key?: string; line?: number; source: string }[];
    };
    const ref = report.links.find((l) => l.source === "frontmatter");
    expect(ref?.key).toBe("related");
    // There is no line to give: the address is the key.
    expect(ref?.line).toBeUndefined();
  });
});

describe("removeCreated — undo's delete must forget the thing (E60 fix)", () => {
  test("⛔ A DELETED SINGLE DOCUMENT LEAVES THE SIDEBAR", () => {
    // Cole, within a minute of E60: "it's not being removed from the sidebar…
    // even though it was removed from the file system". `rescan` returns early
    // for a `listed` entry, and a single document IS one, so nothing pruned it.
    const s = Session.create(home);
    s.setWorkspace(docs);
    const made = s.createDoc(docs, "Untitled.md");
    s.addContext(made.path);
    expect(existsSync(made.path)).toBe(true);
    const before = s.view("release", null).context.length;

    s.removeCreated(made.path, false);

    expect(existsSync(made.path)).toBe(false);
    const after = s.view("release", null).context;
    // The entry is gone, not merely emptied.
    expect(after.length).toBe(before - 1);
    expect(JSON.stringify(after)).not.toContain("Untitled.md");
  });

  test("⚠ AND FREES THE SLUG — the second half of the same bug", () => {
    // The record outlived the file, so the slug stayed taken and the NEXT
    // Untitled.md became `untitled-2` while the file on disk was `Untitled.md`.
    const s = Session.create(home);
    s.setWorkspace(docs);
    const first = s.createDoc(docs, "Untitled.md");
    s.addContext(first.path);
    s.openPath(first.path);
    const slug = s.view("release", null).docs[0]?.slug;
    expect(slug).toBe("untitled");

    s.removeCreated(first.path, false);
    expect(s.view("release", null).docs.map((d) => d.slug)).not.toContain("untitled");

    const again = s.createDoc(docs, "Untitled.md");
    s.addContext(again.path);
    s.openPath(again.path);
    // The same name gets the same slug, because nothing stale is holding it.
    expect(s.view("release", null).docs.map((d) => d.slug)).toEqual(["untitled"]);
  });

  test("a document inside a mirrored set leaves the tree too", () => {
    const s = Session.create(home);
    const { entry } = s.addContext(join(docs, "set"));
    const made = s.createDoc(join(docs, "set"), "temp.md");
    expect(JSON.stringify(s.view("release", null).context)).toContain("temp.md");
    s.removeCreated(made.path, false);
    const after = s.view("release", null).context;
    expect(JSON.stringify(after)).not.toContain("temp.md");
    // The SET survives — only the document went.
    expect(after.some((e) => e.id === entry.id)).toBe(true);
  });

  test("a non-empty folder is refused, and nothing is forgotten", () => {
    const s = Session.create(home);
    s.setWorkspace(docs);
    const folder = s.createFolder(docs, "keep");
    writeFileSync(join(folder.path, "stray.md"), "# stray\n");
    expect(refusal(() => s.removeCreated(folder.path, true)).message).toContain("not empty");
    expect(existsSync(join(folder.path, "stray.md"))).toBe(true);
    expect(existsSync(folder.path)).toBe(true);
  });

  test("a path already gone is not an error", () => {
    const s = Session.create(home);
    expect(s.removeCreated(join(docs, "never-existed.md"), false)).toEqual({
      path: join(docs, "never-existed.md"),
      removed: false,
    });
  });

  test("a file that has become a folder is refused — the world moved", () => {
    const s = Session.create(home);
    s.setWorkspace(docs);
    const made = s.createFolder(docs, "surprise");
    // Recorded as a file, found as a directory.
    expect(refusal(() => s.removeCreated(made.path, false)).message).toContain(
      "no longer describes",
    );
    expect(existsSync(made.path)).toBe(true);
  });
});

describe("forget — the answer the 'gone from disk' warning never had (E61)", () => {
  test("forgets a document whose file is gone, and says how many versions go with it", () => {
    const s = inContext();
    s.openPath(join(docs, "solo.md"));
    const slug = s.view("release", null).docs[0]?.slug as string;
    rmSync(join(docs, "solo.md"));

    const f = s.forgetDoc(slug);
    expect(f.name).toBe("solo.md");
    expect(f.versions).toBe(1);
    expect(s.view("release", null).docs.map((d) => d.slug)).not.toContain(slug);
  });

  test("⛔ REFUSED WHILE THE FILE EXISTS, and names the right verb instead", () => {
    // Forgetting a live document's record would discard its version history
    // while the document itself sits on disk.
    const s = inContext();
    s.openPath(join(docs, "solo.md"));
    const slug = s.view("release", null).docs[0]?.slug as string;
    const e = refusal(() => s.forgetDoc(slug));
    expect(e.message).toContain("still on disk");
    expect(e.message).toContain("remove it from Scriptorium");
    expect(s.view("release", null).docs.map((d) => d.slug)).toContain(slug);
  });

  test("the version files are LEFT — nothing reads them, and nobody asked", () => {
    const s = inContext();
    s.openPath(join(docs, "solo.md"));
    const slug = s.view("release", null).docs[0]?.slug as string;
    const vPath = join(home, "sessions", s.id, "docs", slug, "v1.md");
    rmSync(join(docs, "solo.md"));
    s.forgetDoc(slug);
    expect(existsSync(vPath)).toBe(true);
  });

  test("forgetting the OPEN document leaves something else open, not a dangling name", () => {
    const s = inContext();
    s.openPath(join(docs, "sibling.md"));
    s.openPath(join(docs, "solo.md"));
    const open = s.view("release", null).openDoc as string;
    rmSync(join(docs, "solo.md"));
    s.forgetDoc(open);
    const after = s.view("release", null);
    expect(after.openDoc).not.toBe(open);
    expect(after.docs.some((d) => d.slug === after.openDoc)).toBe(true);
  });

  test("an unknown document is a refusal that lists what there is", () => {
    const s = inContext();
    const e = refusal(() => s.forgetDoc("nothing-like-this"));
    expect(e.message).toContain("no document");
  });
});

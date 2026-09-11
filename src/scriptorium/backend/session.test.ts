// The session model's unit cells: the manifest, the versions, the context
// model (E15), and the watcher's one question — whose write was that?
// Every cell runs against a fresh temp home and temp originals; nothing here
// spawns a process or opens a socket.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("an outside write to the ACTIVE version is detected (E2), once", () => {
    const s = inContext();
    const { slug } = s.openPath(join(docs, "solo.md"));
    const path = s.readVersion(slug, 1).path;
    writeFileSync(path, "the agent wrote here\n");
    expect(s.onFileEvent(path)).toMatchObject({ kind: "active.outside", doc: slug, version: 1 });
    // The same bytes seen again (a second watcher event) are not a second write.
    expect(s.onFileEvent(path)).toBeNull();
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

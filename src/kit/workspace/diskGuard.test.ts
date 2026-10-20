// Every disk write goes through one guard (`./disk.ts`). The re-verifier's
// holes, each reproduced against the session: a set that shows the sessions
// (an old manifest's, or a link in an added folder) let one session write into
// ANOTHER live session's folder through an image's description, a link
// rewrite, an app verb's write of a shown file, a version delete through a
// linked version folder, and a home-workspace app's `imported/` swapped for a
// link. Then the normal uses each of those routes has, still working. Each
// test stands up its own folders in a temp root; HOME is the preload's scratch one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DiskRefusal, notInSession, sessionDiskAt, stageRandomForTest, worldDisk } from "./disk";
import { inOwnPlaces, onDisk } from "./noHome";
import { safeSlug } from "./safeNames";
import { type AppDeclaration, WorkspaceSession } from "./session";
import { refusal, seedDocs, tempRoot, testApp } from "./testing";

/** A one-pixel PNG: a real image for the scan and the sniff. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d00000000049454e44ae426082",
  "hex",
);

let root: string;
let docs: string;
let appHome: string;
let sessions: string;
let outside: string;

beforeEach(() => {
  root = tempRoot("workspace-disk-guard");
  docs = seedDocs(root);
  appHome = join(root, "app");
  sessions = join(appHome, "sessions");
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const noHomeApp: AppDeclaration = { ...testApp, homeWorkspace: false };

const session = (app: AppDeclaration = testApp) => {
  const s = WorkspaceSession.create(
    sessions,
    app,
    undefined,
    app.homeWorkspace === false ? undefined : join(root, "ws"),
  );
  s.setAppHome(appHome);
  return s;
};

/** The victim: a live session with a document open, its version files on disk. */
function victim(): { v: WorkspaceSession; slug: string; v1: string; folder: string } {
  const v = session();
  v.addContext(join(docs, "set"));
  const { slug } = v.openPath(join(docs, "set", "a.md"));
  const folder = join(v.dir, "docs", slug);
  return { v, slug, v1: join(folder, "v1.md"), folder };
}

/**
 * The attacker: a session restored from a manifest with an old set rooted at
 * `root`, which held the sessions in plain sight. Since
 * kit-legacy-sets-show-sessions the restore narrows that set, so it no longer
 * shows them: each hole below is closed twice (not shown, then the write
 * guard), and is held to writing nothing, whichever refuses first.
 */
function seesTheSessions(app: AppDeclaration = testApp): WorkspaceSession {
  const s = session(app);
  const at = join(s.dir, "manifest.json");
  const m = JSON.parse(readFileSync(at, "utf8"));
  m.context.push({ id: "c-old100", label: "root", root, membership: "mirrored", nodes: [] });
  writeFileSync(at, JSON.stringify(m));
  const back = WorkspaceSession.restore(sessions, app, s.id);
  back.setAppHome(appHome);
  return back;
}

describe("the holes: no route writes into another session's folder", () => {
  test("hole 2: image.describe's sidecar beside an image in another session is refused", () => {
    const { folder } = victim();
    const pic = join(folder, "pic.png");
    writeFileSync(pic, PNG);
    const x = seesTheSessions();
    x.rescan("c-old100");
    const e = refusal(() => x.describeImage(pic));
    expect([400, 404, 409]).toContain(e.status);
    expect(existsSync(`${pic}.md`)).toBe(false);
  });

  test("hole 3: a link rewrite of a document in another session is refused, and named in skipped", () => {
    const { folder } = victim();
    const planted = join(folder, "planted.md");
    writeFileSync(planted, "# planted\n[b](./b.md)\n");
    const x = seesTheSessions();
    const r = x.rewriteLinks([{ path: planted, swaps: [["./b.md", "./sub/b.md"]] }]);
    expect(r.count).toBe(0);
    expect(r.skipped.map((s) => s.path)).toEqual([planted]);
    expect(r.skipped[0]?.reason).toContain("among the sessions' own folders");
    expect(readFileSync(planted, "utf8")).toBe("# planted\n[b](./b.md)\n");
  });

  test("hole 3: a held document opened from another session's folder is not rewritten either", () => {
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    writeFileSync(v1, `${before}[b](./b.md)\n`);
    const x = seesTheSessions();
    x.rescan("c-old100");
    // Not shown any more, so it does not open; the rewrite is refused besides.
    expect(refusal(() => x.openPath(v1)).status).toBeGreaterThanOrEqual(400);
    const r = x.rewriteLinks([{ path: v1, swaps: [["./b.md", "./sub/b.md"]] }]);
    expect(r.count).toBe(0);
    expect(readFileSync(v1, "utf8")).toBe(`${before}[b](./b.md)\n`);
  });

  test("hole 1: an app verb's write of a shown file (meta-set, meta-init) in another session is refused", () => {
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    const x = seesTheSessions();
    x.rescan("c-old100");
    // Not shown any more (the app's own check refuses first); the write is refused either way.
    expect(refusal(() => x.shownAt(v1)).status).toBeGreaterThanOrEqual(400);
    const e = refusal(() => x.writeShown(v1, "---\nstatus: PWNED\n---\n"));
    expect([400, 404, 409]).toContain(e.status);
    expect(readFileSync(v1, "utf8")).toBe(before);
  });

  test("hole 1 by a link: a folder added whole that links to the sessions writes nothing through it", () => {
    const { v1, v } = victim();
    const before = readFileSync(v1, "utf8");
    const home = join(root, "home");
    mkdirSync(home);
    symlinkSync(sessions, join(home, "peek"));
    const z = session();
    z.addContext(home);
    const viaPeek = join(home, "peek", v.id, "docs", "a", "v1.md");
    expect([400, 404, 409]).toContain(refusal(() => z.writeShown(viaPeek, "PEEKED\n")).status);
    expect(readFileSync(v1, "utf8")).toBe(before);
  });

  // Since kit-legacy-sets-show-sessions the scan never shows the sessions, so
  // the holes above are refused before the write. What only the write guard
  // still catches is a path swapped for a link AFTER the scan showed it: these
  // reach `worldDisk` itself, and go red without its target check.
  describe("after the scan: a shown path swapped for a link into another session", () => {
    /** A session whose set (`<root>/other`) shows `t.md`, `sub/t.md` and `pics/pic.png`. */
    function shows(): { x: WorkspaceSession; set: string } {
      const set = join(root, "other");
      mkdirSync(join(set, "sub"), { recursive: true });
      mkdirSync(join(set, "pics"), { recursive: true });
      writeFileSync(join(set, "t.md"), "# T\n");
      writeFileSync(join(set, "sub", "t.md"), "# T\n");
      writeFileSync(join(set, "pics", "pic.png"), PNG);
      const x = session();
      x.addContext(set);
      return { x, set };
    }

    test("hole 1: a shown document swapped for a link to another session's version: writeShown is refused", () => {
      const { v1 } = victim();
      const before = readFileSync(v1, "utf8");
      const { x, set } = shows();
      const t = join(set, "t.md");
      expect(x.shownAt(t).abs).toBe(t);
      rmSync(t);
      symlinkSync(v1, t);
      const e = refusal(() => x.writeShown(t, "---\nstatus: PWNED\n---\n"));
      expect(e.status).toBe(409);
      expect(e.message).toContain("among the sessions' own folders");
      expect(readFileSync(v1, "utf8")).toBe(before);
    });

    test("hole 1 by a link: a shown folder swapped for a link into another session's folder: nothing is made there", () => {
      const { folder } = victim();
      const { x, set } = shows();
      const t = join(set, "sub", "t.md");
      expect(x.shownAt(t).abs).toBe(t);
      rmSync(join(set, "sub"), { recursive: true });
      symlinkSync(folder, join(set, "sub"));
      const e = refusal(() => x.writeShown(t, "PEEKED\n"));
      expect(e.status).toBe(409);
      expect(existsSync(join(folder, "t.md"))).toBe(false);
    });

    test("hole 2: a shown image's folder swapped for a link into another session's folder: no sidecar is written", () => {
      const { folder } = victim();
      writeFileSync(join(folder, "pic.png"), PNG);
      const { x, set } = shows();
      rmSync(join(set, "pics"), { recursive: true });
      symlinkSync(folder, join(set, "pics"));
      const e = refusal(() => x.describeImage(join(set, "pics", "pic.png")));
      expect(e.status).toBe(409);
      expect(e.message).toContain("among the sessions' own folders");
      expect(existsSync(join(folder, "pic.png.md"))).toBe(false);
    });
  });

  test("hole 4: version-delete through a version folder swapped for a link deletes nothing outside", () => {
    const { v, slug, folder } = victim();
    v.newVersion({ by: "agent", body: "two\n" });
    v.activate({ doc: slug, version: 2 });
    writeFileSync(join(outside, "v1.md"), "OUTSIDE v1\n");
    renameSync(folder, `${folder}.real`);
    symlinkSync(outside, folder);
    const e = refusal(() => v.deleteVersion({ doc: slug, version: 1 }));
    expect(e.status).toBe(409);
    expect(readFileSync(join(outside, "v1.md"), "utf8")).toBe("OUTSIDE v1\n");
    // Refused before the record changed: v1 is still the session's.
    expect(v.doc(slug).versions.map((x) => x.n)).toEqual([1, 2]);
  });

  test("hole 5: a home-workspace app's imported/ swapped for a link to another session writes nothing there", () => {
    const { v } = victim();
    const before = readdirSync(v.dir).sort();
    const s = WorkspaceSession.create(sessions, testApp);
    s.setAppHome(appHome);
    const imported = join(s.dir, "imported");
    symlinkSync(v.dir, imported);
    const e = refusal(() => s.importText("evil.md", "# evil\n"));
    expect(e.status).toBe(409);
    expect(readdirSync(v.dir).sort()).toEqual(before);
    expect(existsSync(join(v.dir, "evil.md"))).toBe(false);
  });

  test("hole 5: a link inside a real imported/ that leads to another session is refused too", () => {
    const { v } = victim();
    const s = WorkspaceSession.create(sessions, testApp);
    s.setAppHome(appHome);
    s.importText("first.md", "# first\n");
    const imported = join(s.dir, "imported");
    symlinkSync(v.dir, join(imported, "door"));
    // Refused (where the door shows no folder of the session's, or at the write).
    refusal(() => s.createDoc(join(imported, "door"), "evil.md"));
    expect(() => s.importText("evil.md", "# evil\n", join(imported, "door"))).toThrow();
    expect(existsSync(join(v.dir, "evil.md"))).toBe(false);
  });

  test("hole 5: a session folder swapped for a link to another session after the open imports nothing there", () => {
    const v = WorkspaceSession.create(sessions, testApp);
    v.setAppHome(appHome);
    v.importText("theirs.md", "# theirs\n");
    const s = WorkspaceSession.create(sessions, testApp);
    s.setAppHome(appHome);
    s.importText("mine.md", "# mine\n");
    renameSync(s.dir, `${s.dir}.moved`);
    symlinkSync(v.dir, s.dir);
    const e = refusal(() => s.importText("evil.md", "# evil\n"));
    expect(e.status).toBe(409);
    expect(readdirSync(join(v.dir, "imported"))).toEqual(["theirs.md"]);
  });

  test("hole 5, the rule: the imported/ exception holds only where the folder really is this session's", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const v = WorkspaceSession.create(sessions, testApp);
    const imported = join(s.dir, "imported");
    const own = {
      sessionsRoot: sessions,
      except: imported,
      exceptReal: join(s.dir, "imported"),
    };
    mkdirSync(imported);
    expect(inOwnPlaces(join(imported, "a.md"), own)).toBeNull();
    rmSync(imported, { recursive: true });
    symlinkSync(v.dir, imported);
    expect(inOwnPlaces(join(imported, "a.md"), own)).toContain("among the sessions' own folders");
    // Not where the pin says (a session folder swapped since the open).
    rmSync(imported);
    mkdirSync(imported);
    expect(
      inOwnPlaces(join(imported, "a.md"), { ...own, exceptReal: join(v.dir, "imported") }),
    ).toContain("among the sessions' own folders");
  });
});

describe("a bare `..` slug is refused (M1)", () => {
  test("safeSlug refuses `..` and anything with `..` in it", () => {
    for (const slug of ["..", "../x", "a..b", "x/.."]) expect(safeSlug(slug), slug).not.toBeNull();
    expect(safeSlug("a.b")).toBeNull();
  });

  test("a manifest whose slug is `..` is refused on restore, and its versions are never read", () => {
    const { v } = victim();
    const at = join(v.dir, "manifest.json");
    const m = JSON.parse(readFileSync(at, "utf8"));
    m.docs[0].slug = "..";
    writeFileSync(at, JSON.stringify(m));
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, v.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("docs[0].slug");
  });
});

describe("the two writers", () => {
  test("worldDisk refuses a target among the sessions, as written and through a link, and a source that holds them", () => {
    const disk = worldDisk(() => ({ sessionsRoot: sessions, appHome }));
    mkdirSync(sessions, { recursive: true });
    symlinkSync(sessions, join(root, "to-sessions"));
    for (const p of [join(sessions, "x.md"), join(root, "to-sessions", "x.md"), join(appHome, "y")])
      expect(() => disk.writeFile(p, "x")).toThrow(DiskRefusal);
    expect(() => disk.rename(root, join(outside, "moved"))).toThrow(DiskRefusal);
    expect(existsSync(join(sessions, "x.md"))).toBe(false);
    disk.writeFile(join(outside, "ok.md"), "ok\n");
    expect(readFileSync(join(outside, "ok.md"), "utf8")).toBe("ok\n");
  });

  test("sessionDiskAt refuses a write that leads out of the session by a link, and a session folder that is a link", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    symlinkSync(outside, join(s.dir, "thumbs"));
    const disk = sessionDiskAt(s.dir);
    expect(() => disk.writeFile(join(s.dir, "thumbs", "t.webp"), "x")).toThrow(DiskRefusal);
    expect(readdirSync(outside)).toEqual([]);
    disk.writeFile(join(s.dir, "own.txt"), "mine\n");
    symlinkSync(s.dir, join(root, "linked-session"));
    expect(() =>
      sessionDiskAt(join(root, "linked-session")).writeFile(join(root, "linked-session", "z"), "z"),
    ).toThrow(DiskRefusal);
    expect(notInSession(join(sessions, "other", "x"), { dir: s.dir })).toContain(
      "is not inside this session's folder",
    );
  });
});

describe("normal use still works through the guard", () => {
  test("describe-image on an image in a set writes its sidecar", () => {
    writeFileSync(join(docs, "set", "pic.png"), PNG);
    const s = session();
    s.addContext(join(docs, "set"));
    const r = s.describeImage(join(docs, "set", "pic.png"));
    expect(readFileSync(r.path, "utf8")).toContain("type: image");
  });

  test("an app verb's write of a shown document lands", () => {
    const s = session();
    s.addContext(join(docs, "set"));
    s.writeShown(join(docs, "set", "a.md"), "---\nstatus: draft\n---\n# A\n");
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toStartWith("---\nstatus: draft");
  });

  test("a link rewrite after a normal move lands", () => {
    writeFileSync(join(docs, "set", "a.md"), "# A\n[b](./part/b.md)\n");
    const s = session();
    s.addContext(join(docs, "set"));
    const r = s.rewriteLinks([
      { path: join(docs, "set", "a.md"), swaps: [["./part/b.md", "./b.md"]] },
    ]);
    expect(r.count).toBe(1);
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toBe("# A\n[b](./b.md)\n");
  });

  test("version-delete of a plain version removes its file", () => {
    const { v, slug, folder } = victim();
    v.newVersion({ by: "agent", body: "two\n" });
    v.deleteVersion({ doc: slug, version: 2 });
    expect(existsSync(join(folder, "v2.md"))).toBe(false);
    expect(v.doc(slug).versions.map((x) => x.n)).toEqual([1]);
  });

  test("make-set and add-folder in a plain set", () => {
    const s = session(noHomeApp);
    s.addContext(join(docs, "solo.md"));
    const made = s.makeSet(join(docs, "solo.md"));
    expect(existsSync(made.path)).toBe(true);
    const f = s.addFolder(join(docs, "set", "fresh"));
    expect(existsSync(f.path)).toBe(true);
  });
});

// Fix round 3: a link planted where the kit then writes (a temp name, a name
// that leads nowhere yet, a hard link to another session's file). Each needs
// someone who can already plant links on disk; the kit's own API makes none.
describe("planted links and twins", () => {
  const own = () => ({ sessionsRoot: sessions, appHome });

  test("writeAtomic: a link at the old temp name (`<path>.<pid>.tmp`) is never written through", () => {
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    const x = session();
    const manifest = join(x.dir, "manifest.json");
    symlinkSync(v1, `${manifest}.${process.pid}.tmp`);
    x.own.writeAtomic(manifest, "{}\n");
    expect(readFileSync(v1, "utf8")).toBe(before);
    expect(lstatSync(manifest).isSymbolicLink()).toBe(false);
    expect(readFileSync(manifest, "utf8")).toBe("{}\n");
    // The fresh temp file is gone: only the planted link is left beside it.
    expect(readdirSync(x.dir).filter((n) => n.startsWith("manifest.json."))).toEqual([
      `manifest.json.${process.pid}.tmp`,
    ]);
  });

  test("stage makes a new file under a random name, beside its target", () => {
    const x = session();
    mkdirSync(join(x.dir, "docs"), { recursive: true });
    const at = join(x.dir, "docs", "v1.md");
    const a = x.own.stage(at, "one", "edit");
    const b = x.own.stage(at, "two", "edit");
    expect(a).not.toBe(b);
    expect(a).toMatch(/v1\.md\.[0-9a-f]{8}\.edit$/);
    expect(readFileSync(a, "utf8")).toBe("one");
    expect(() => x.own.stage(join(sessions, "other", "v1.md"), "x")).toThrow();
  });

  test("an edit: a link at the old staging name (`<path>.<pid>.edit`) that leads nowhere yet writes nothing there", () => {
    const { folder } = victim();
    const x = session();
    x.addContext(join(docs, "set"));
    const { slug } = x.openPath(join(docs, "set", "a.md"));
    const mine = join(x.dir, "docs", slug, "v1.md");
    const planted = join(folder, "planted-by-edit.md");
    symlinkSync(planted, `${mine}.${process.pid}.edit`);
    x.edit(slug, 1, "typed\n");
    expect(existsSync(planted)).toBe(false);
    expect(readFileSync(mine, "utf8")).toBe("typed\n");
    expect(lstatSync(mine).isSymbolicLink()).toBe(false);
  });

  test("a link that leads nowhere yet is judged where it leads (world: dangling, chained, relative)", () => {
    const disk = worldDisk(own);
    mkdirSync(join(sessions, "victim"), { recursive: true });
    const dang = join(outside, "dang.md");
    symlinkSync(join(sessions, "victim", "new.md"), dang);
    expect(onDisk(dang)).toBe(join(realpathSync(sessions), "victim", "new.md"));
    expect(() => disk.writeFile(dang, "x")).toThrow(DiskRefusal);
    // A link to a link to nowhere, the last one relative to where it sits.
    symlinkSync("new2.md", join(sessions, "victim", "hop.md"));
    symlinkSync(join(sessions, "victim", "hop.md"), join(outside, "chain.md"));
    expect(() => disk.writeFile(join(outside, "chain.md"), "x")).toThrow(DiskRefusal);
    // A folder link to nowhere, below which a folder would be made.
    symlinkSync(join(sessions, "victim", "newdir"), join(outside, "dd"));
    expect(() => disk.mkdir(join(outside, "dd", "sub"), { recursive: true })).toThrow(DiskRefusal);
    // A copy and a rename onto one.
    writeFileSync(join(outside, "src.md"), "SRC");
    symlinkSync(join(sessions, "victim", "c.md"), join(outside, "cdang.md"));
    expect(() => disk.copyFile(join(outside, "src.md"), join(outside, "cdang.md"))).toThrow(
      DiskRefusal,
    );
    expect(() => disk.rename(join(outside, "src.md"), join(outside, "cdang.md"))).toThrow(
      DiskRefusal,
    );
    expect(readdirSync(join(sessions, "victim")).sort()).toEqual(["hop.md"]);
    // A loop ends: its path cannot be written through anyway.
    symlinkSync(join(outside, "loop2"), join(outside, "loop1"));
    symlinkSync(join(outside, "loop1"), join(outside, "loop2"));
    expect(typeof onDisk(join(outside, "loop1", "x"))).toBe("string");
  });

  test("session: a dangling link out is refused, and so is any link, even one that stays inside", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const disk = sessionDiskAt(s.dir);
    const victimDir = join(sessions, "victim");
    mkdirSync(victimDir, { recursive: true });
    symlinkSync(join(victimDir, "s.md"), join(s.dir, "out.md"));
    expect(() => disk.writeFile(join(s.dir, "out.md"), "x")).toThrow(DiskRefusal);
    expect(existsSync(join(victimDir, "s.md"))).toBe(false);
    writeFileSync(join(s.dir, "real.md"), "real\n");
    symlinkSync(join(s.dir, "real.md"), join(s.dir, "inside.md"));
    for (const write of [
      () => disk.writeFile(join(s.dir, "inside.md"), "x"),
      () => disk.writeAtomic(join(s.dir, "inside.md"), "x"),
      () => disk.copyFile(join(s.dir, "real.md"), join(s.dir, "inside.md")),
      () => disk.rename(join(s.dir, "real.md"), join(s.dir, "inside.md")),
    ])
      expect(write).toThrow("is a link, and a session's own file never is");
    expect(readFileSync(join(s.dir, "real.md"), "utf8")).toBe("real\n");
    // Removing a link only removes the link.
    disk.unlink(join(s.dir, "inside.md"));
    expect(existsSync(join(s.dir, "real.md"))).toBe(true);
  });

  test("world: a document the human linked on purpose saves to where it really is", () => {
    const real = join(outside, "real.md");
    writeFileSync(real, "# Real\n");
    symlinkSync(real, join(docs, "set", "linked.md"));
    const s = session();
    s.addContext(join(docs, "set"));
    s.writeShown(join(docs, "set", "linked.md"), "# Real, saved\n");
    expect(readFileSync(real, "utf8")).toBe("# Real, saved\n");
    expect(lstatSync(join(docs, "set", "linked.md")).isSymbolicLink()).toBe(true);
  });

  test("hard links: the session writer never writes into one", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const disk = sessionDiskAt(s.dir);
    writeFileSync(join(outside, "w.md"), "world\n");
    linkSync(join(outside, "w.md"), join(s.dir, "twin.md"));
    expect(() => disk.writeFile(join(s.dir, "twin.md"), "x")).toThrow("a hard link");
    expect(() => disk.copyFile(join(outside, "w.md"), join(s.dir, "twin.md"))).toThrow(
      "a hard link",
    );
    expect(readFileSync(join(outside, "w.md"), "utf8")).toBe("world\n");
    // A rename over it changes only this name: the twin keeps its bytes.
    disk.writeAtomic(join(s.dir, "twin.md"), "mine\n");
    expect(readFileSync(join(outside, "w.md"), "utf8")).toBe("world\n");
  });

  test("hard links: the world writer refuses one on the sessions' disk, and writes one on another", () => {
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    const h = join(docs, "set", "h.md");
    linkSync(v1, h);
    const s = session();
    s.addContext(join(docs, "set"));
    expect(refusal(() => s.writeShown(h, "PWNED\n")).message).toContain("a hard link");
    expect(readFileSync(v1, "utf8")).toBe(before);
    // `wx` makes a new file or fails: never written into, so not refused for it.
    const disk = worldDisk(own);
    expect(() => disk.writeFile(h, "x", { flag: "wx" })).toThrow("EEXIST");
    // The sessions on another device (`/dev` is its own file system): a twin
    // there could not be one of theirs, so a hard-linked note still saves.
    const elsewhere = worldDisk(() => ({ sessionsRoot: "/dev/no-such-kit-sessions" }));
    writeFileSync(join(outside, "note.md"), "note\n");
    linkSync(join(outside, "note.md"), join(outside, "note-twin.md"));
    elsewhere.writeFile(join(outside, "note-twin.md"), "saved\n");
    expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("saved\n");
  });

  test("cp checks its target, and rm refuses a folder that holds the sessions", () => {
    const disk = worldDisk(own);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(outside, "src.md"), "SRC");
    expect(() => disk.cp(join(outside, "src.md"), join(sessions, "copied.md"), {})).toThrow(
      DiskRefusal,
    );
    expect(existsSync(join(sessions, "copied.md"))).toBe(false);
    disk.cp(join(outside, "src.md"), join(outside, "copied.md"), {});
    expect(readFileSync(join(outside, "copied.md"), "utf8")).toBe("SRC");
    // `root` is outside the sessions, and holds them.
    expect(() => disk.rm(root, { recursive: true, force: true })).toThrow("holds");
    expect(existsSync(sessions)).toBe(true);
  });

  // Fix round 4: `resolve` drops `sub/..` as text, but the disk follows `sub`
  // (a link) first. A dangling `rel.md -> sub/../x.md` with `sub` a link into
  // another session lands beside where `sub` leads.
  test("a link's `..` is resolved on disk: through a link, it climbs from where that link leads", () => {
    const disk = worldDisk(own);
    const deep = join(sessions, "victim", "deep");
    mkdirSync(deep, { recursive: true });
    symlinkSync(deep, join(outside, "sub"));
    symlinkSync("sub/../dotdot.md", join(outside, "rel.md"));
    expect(onDisk(join(outside, "rel.md"))).toBe(
      join(realpathSync(sessions), "victim", "dotdot.md"),
    );
    expect(() => disk.writeFile(join(outside, "rel.md"), "x")).toThrow(DiskRefusal);
    writeFileSync(join(outside, "src.md"), "SRC");
    symlinkSync("sub/../cp.md", join(outside, "rel2.md"));
    expect(() => disk.copyFile(join(outside, "src.md"), join(outside, "rel2.md"))).toThrow(
      DiskRefusal,
    );
    // The same `..` in the path itself, not in a link's target.
    expect(() => disk.writeFile(join(outside, "sub") + "/../plain-dd.md", "x")).toThrow(
      DiskRefusal,
    );
    // A dangling folder link whose target climbs through `sub`.
    symlinkSync("sub/../newdir", join(outside, "pdd"));
    expect(() => disk.mkdir(join(outside, "pdd", "x"), { recursive: true })).toThrow(DiskRefusal);
    expect(readdirSync(join(sessions, "victim")).sort()).toEqual(["deep"]);
    // A `..` with no link before it is still plain: it stays outside, and saves.
    mkdirSync(join(outside, "plain"));
    symlinkSync("plain/../plain-ok.md", join(outside, "ok.md"));
    disk.writeFile(join(outside, "ok.md"), "ok\n");
    expect(readFileSync(join(outside, "plain-ok.md"), "utf8")).toBe("ok\n");
  });

  test("a two-hop dangling chain whose first hop stays outside is followed to its end", () => {
    const disk = worldDisk(own);
    mkdirSync(join(sessions, "victim"), { recursive: true });
    symlinkSync(join(sessions, "victim", "end.md"), join(outside, "b.md"));
    symlinkSync(join(outside, "b.md"), join(outside, "a.md"));
    expect(onDisk(join(outside, "a.md"))).toBe(join(realpathSync(sessions), "victim", "end.md"));
    expect(() => disk.writeFile(join(outside, "a.md"), "x")).toThrow(DiskRefusal);
    expect(existsSync(join(sessions, "victim", "end.md"))).toBe(false);
  });

  test("stage refuses a name already there, a file or a link, and never writes through it", () => {
    const x = session();
    const at = join(x.dir, "manifest.json");
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    stageRandomForTest((n) => Buffer.alloc(n, 0xab));
    try {
      const name = `${at}.abababab.tmp`;
      writeFileSync(name, "already\n");
      expect(() => x.own.stage(at, "x")).toThrow("EEXIST");
      expect(readFileSync(name, "utf8")).toBe("already\n");
      rmSync(name);
      symlinkSync(v1, name);
      expect(() => x.own.stage(at, "x")).toThrow();
      expect(readFileSync(v1, "utf8")).toBe(before);
      // A link that leads nowhere yet is no different: nothing is made where it leads.
      rmSync(name);
      symlinkSync(join(outside, "made.md"), name);
      expect(() => x.own.stage(at, "x")).toThrow();
      expect(existsSync(join(outside, "made.md"))).toBe(false);
    } finally {
      stageRandomForTest();
    }
  });

  test("a check that throws is a refusal, never a pass", () => {
    const disk = worldDisk(() => {
      throw new Error("no places");
    });
    expect(() => disk.writeFile(join(outside, "w.md"), "x")).toThrow("could not be checked");
    expect(() => disk.mkdir(join(outside, "d"))).toThrow("could not be checked");
    expect(disk.refusal(join(outside, "w.md"))).toContain("could not be checked");
    expect(existsSync(join(outside, "w.md"))).toBe(false);
    expect(existsSync(join(outside, "d"))).toBe(false);
  });

  test("a failed write leaves nothing behind: writeAtomic's staged file goes", () => {
    const disk = worldDisk(own);
    // A folder at the name: the rename onto it fails.
    mkdirSync(join(outside, "taken.md"));
    expect(() => disk.writeAtomic(join(outside, "taken.md"), "x")).toThrow();
    expect(readdirSync(outside).filter((n) => n.startsWith("taken.md."))).toEqual([]);
  });

  test("a failed edit leaves nothing behind: its staged file goes", () => {
    const x = session();
    x.addContext(join(docs, "set"));
    const { slug } = x.openPath(join(docs, "set", "a.md"));
    const folder = join(x.dir, "docs", slug);
    const v = join(folder, "v1.md");
    rmSync(v);
    mkdirSync(v); // the version's name is now a folder: the rename onto it fails
    expect(() => x.edit(slug, 1, "typed\n")).toThrow();
    expect(readdirSync(folder)).toEqual(["v1.md"]);
  });
});

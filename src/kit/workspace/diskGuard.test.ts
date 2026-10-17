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
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DiskRefusal, notInSession, sessionDiskAt, worldDisk } from "./disk";
import { inOwnPlaces } from "./noHome";
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

/** The attacker: a session restored from a manifest with an old set rooted at `root`, which shows the sessions. */
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
    expect(e.status).toBe(409);
    expect(e.message).toContain("among the sessions' own folders");
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
    x.openPath(v1);
    const r = x.rewriteLinks([{ path: v1, swaps: [["./b.md", "./sub/b.md"]] }]);
    expect(r.count).toBe(0);
    expect(readFileSync(v1, "utf8")).toBe(`${before}[b](./b.md)\n`);
  });

  test("hole 1: an app verb's write of a shown file (meta-set, meta-init) in another session is refused", () => {
    const { v1 } = victim();
    const before = readFileSync(v1, "utf8");
    const x = seesTheSessions();
    x.rescan("c-old100");
    // Shown, so the app's own check passes: the write is what refuses.
    expect(x.shownAt(v1).abs).toBe(v1);
    const e = refusal(() => x.writeShown(v1, "---\nstatus: PWNED\n---\n"));
    expect(e.status).toBe(409);
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
    expect(refusal(() => z.writeShown(viaPeek, "PEEKED\n")).status).toBe(409);
    expect(readFileSync(v1, "utf8")).toBe(before);
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

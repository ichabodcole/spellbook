// The session's own places: a manifest cannot name a path outside its session,
// no route makes a set that shows the sessions or the app home, and no
// structure op writes among them, whatever the sets say. Each test stands up
// its own folders in a temp root; HOME is the preload's scratch one.
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
import { dirname, join } from "node:path";
import { homeDir } from "../lib/home";
import { PRE_MIGRATE_FILE } from "./manifestMigrate";
import { type AppDeclaration, GoneError, SessionError, WorkspaceSession } from "./session";
import { refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let docs: string;
let appHome: string;
let sessions: string;
let outside: string;
let victim: string;

beforeEach(() => {
  root = tempRoot("workspace-own-places");
  docs = seedDocs(root);
  appHome = join(root, "app");
  sessions = join(appHome, "sessions");
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(root, "ws"), { recursive: true });
  victim = join(outside, "victim.md");
  writeFileSync(victim, "VICTIM\n");
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

const manifestOf = (s: WorkspaceSession) => join(s.dir, "manifest.json");

/** A saved manifest, as far as these tests edit it. */
type Saved = { docs: [Record<string, unknown>]; context: Record<string, unknown>[] };

/** Edit a saved manifest, then restore it (the way an old or hand-edited one arrives). */
function restoredWith(
  s: WorkspaceSession,
  edit: (m: Saved) => void,
  app: AppDeclaration = testApp,
): WorkspaceSession {
  const m = JSON.parse(readFileSync(manifestOf(s), "utf8"));
  edit(m);
  writeFileSync(manifestOf(s), JSON.stringify(m));
  const back = WorkspaceSession.restore(sessions, app, s.id);
  back.setAppHome(appHome);
  return back;
}

/** A session holding one document of the set, open. */
function withDoc(): WorkspaceSession {
  const s = session();
  s.addContext(join(docs, "set"));
  s.openPath(join(docs, "set", "a.md"));
  return s;
}

/** An `ext` that, appended to `docs/<slug>/v<n>`, climbs to `target`. */
function climbingExt(s: WorkspaceSession, slug: string, target: string): string {
  const depth = join(s.dir, "docs", slug).split("/").filter(Boolean).length;
  return `/${"../".repeat(depth + 1)}${target.slice(1)}`;
}

describe("a manifest cannot name a path outside its session", () => {
  test("an unsafe slug or ext is refused on restore, and the manifest is left as it was", () => {
    const s = withDoc();
    const bad: [string, unknown][] = [
      ["slug", "../../escape"],
      ["slug", "a/b"],
      ["slug", "a\\b"],
      ["slug", ""],
      ["slug", "."],
      ["slug", "x\u0000"],
      ["ext", "/../../../victim.md"],
      ["ext", ".m/d"],
      ["ext", "md"],
      ["ext", ".md/.."],
      ["ext", undefined],
    ];
    const good = readFileSync(manifestOf(s), "utf8");
    for (const [key, value] of bad) {
      const m = JSON.parse(good);
      m.docs[0][key] = value;
      const text = JSON.stringify(m);
      writeFileSync(manifestOf(s), text);
      const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
      expect(e.status).toBe(409);
      expect(e.message).toContain(`docs[0].${key}`);
      expect(readFileSync(manifestOf(s), "utf8")).toBe(text);
    }
    writeFileSync(manifestOf(s), good);
    // A plain extension, or none, is read.
    for (const ext of ["", ".MD", ".json"]) {
      const back = restoredWith(s, (m) => {
        m.docs[0].ext = ext;
        m.docs[0].slug = "a";
      });
      expect(back.doc("a").ext).toBe(ext);
    }
  });

  test("scenD2: an ext that climbs to a file elsewhere is refused, and the file is never written", () => {
    const s = withDoc();
    const slug = s.doc("a").slug;
    const ext = climbingExt(s, slug, victim);
    expect(() =>
      restoredWith(s, (m) => {
        m.docs[0].ext = ext;
      }),
    ).toThrow(/is not a plain extension/);
    expect(readFileSync(victim, "utf8")).toBe("VICTIM\n");
  });

  test("a slug or ext changed under a live session is refused where its path is built", () => {
    const s = withDoc();
    const live = (s as unknown as { m: { docs: { ext: string; slug: string }[] } }).m.docs[0];
    if (!live) throw new Error("no doc");
    live.ext = climbingExt(s, live.slug, victim);
    // A read through it is refused where the path is built: it never reads the file.
    expect(refusal(() => s.readVersion(live.slug, 1)).message).toContain(
      "does not name a version file inside this session",
    );
    const e = refusal(() => s.newVersion({ by: "agent", body: "WRITTEN THROUGH EXT\n" }));
    expect(e.status).toBe(409);
    expect(readFileSync(victim, "utf8")).toBe("VICTIM\n");
    live.ext = ".md";
    live.slug = "../../escape";
    expect(refusal(() => s.newVersion({ doc: live.slug, by: "agent", body: "x" })).status).toBe(
      409,
    );
    expect(existsSync(join(sessions, "escape"))).toBe(false);
  });

  test("a document's version folder made a link to elsewhere is refused at the write", () => {
    const s = withDoc();
    const slug = s.doc("a").slug;
    const folder = join(s.dir, "docs", slug);
    rmSync(folder, { recursive: true });
    symlinkSync(outside, folder);
    const e = refusal(() => s.newVersion({ by: "agent", body: "LEAKED\n" }));
    expect(e.message).toContain("is not inside this session's docs folder");
    expect(readdirSync(outside)).toEqual(["victim.md"]);
  });

  test("scenE: a session folder swapped for a link after the open writes nothing there", () => {
    const s = withDoc();
    const elsewhere = join(outside, "real-session");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "manifest.json"), "REAL\n");
    renameSync(s.dir, `${s.dir}.copy`);
    symlinkSync(elsewhere, s.dir);
    const e = refusal(() => s.persist());
    expect(e.status).toBe(409);
    expect(e.message).toContain("not where this session was opened");
    expect(refusal(() => s.newVersion({ by: "agent", body: "x" })).status).toBe(409);
    expect(readFileSync(join(elsewhere, "manifest.json"), "utf8")).toBe("REAL\n");
    expect(readdirSync(elsewhere)).toEqual(["manifest.json"]);
  });
});

describe("a conversion's write is checked again where it is written (migrateWriteRefusal)", () => {
  /** A saved kit manifest marked `old`, which the app's converter strips. */
  function oldSession(): { id: string; text: string } {
    const s = withDoc();
    const m = JSON.parse(readFileSync(manifestOf(s), "utf8"));
    m.old = true;
    const text = JSON.stringify(m);
    writeFileSync(manifestOf(s), text);
    return { id: s.id, text };
  }
  const converting = (refuse: () => string | null): AppDeclaration => ({
    ...testApp,
    migrateManifest: (raw) => {
      if (raw.old !== true) return null;
      const { old: _old, ...rest } = raw;
      return { manifest: rest, note: "converted" };
    },
    migrateWriteRefusal: refuse,
  });

  test("a refusal at the start, or at the write, writes nothing", () => {
    const { id, text } = oldSession();
    for (const refuse of [
      () => "the disk moved",
      (() => {
        let n = 0;
        return () => (++n === 1 ? null : "the disk moved since the start");
      })(),
    ]) {
      const e = refusal(() => WorkspaceSession.restore(sessions, converting(refuse), id));
      expect(e.status).toBe(409);
      expect(e.message).toContain("the disk moved");
      expect(readFileSync(join(sessions, id, "manifest.json"), "utf8")).toBe(text);
      expect(existsSync(join(sessions, id, PRE_MIGRATE_FILE))).toBe(false);
    }
    // Allowed: converted, with the original kept.
    WorkspaceSession.restore(
      sessions,
      converting(() => null),
      id,
    );
    expect(readFileSync(join(sessions, id, PRE_MIGRATE_FILE), "utf8")).toBe(text);
  });
});

describe("the one set guard, on every route that makes a set", () => {
  test("add refuses the sessions, the app home, a folder holding them in plain sight, a link to either, the top of the disk and every folder above home", () => {
    const s = session();
    symlinkSync(sessions, join(root, "to-sessions"));
    symlinkSync(appHome, join(root, "to-app"));
    const refused = [
      sessions,
      join(sessions, s.id),
      join(sessions, s.id, "docs"),
      appHome,
      join(root, "to-sessions"),
      join(root, "to-app"),
      root,
      "/",
      dirname(homeDir()),
    ];
    for (const p of refused) {
      const e = refusal(() => s.addContext(p));
      expect(e.status).toBe(409);
      expect(e.message).toContain("it is not added to the context");
    }
    expect(s.context).toHaveLength(0);
    // The home folder itself is added, as the shipped Scriptorium allows.
    expect(s.addContext(homeDir()).added).toBe(true);
  });

  test("a folder holding the sessions only through a dot-folder is added: the scan never shows them", () => {
    const dotted = join(root, "dotted");
    const hidden = join(dotted, ".app", "sessions");
    mkdirSync(join(dotted, "notes"), { recursive: true });
    writeFileSync(join(dotted, "notes", "n.md"), "# N\n");
    const s = WorkspaceSession.create(hidden, testApp, undefined, join(root, "ws"));
    expect(s.addContext(dotted).added).toBe(true);
  });

  test("the undo of a hide checks where the folder leads now: one swapped for a link to the sessions is gone", () => {
    const s = session();
    const { entry } = s.addContext(join(docs, "set"));
    const removed = s.removeContext(entry.id);
    renameSync(join(docs, "set"), join(docs, "set.real"));
    symlinkSync(sessions, join(docs, "set"));
    expect(() => s.restoreContext(removed.entry, removed.index)).toThrow(GoneError);
    expect(s.context).toHaveLength(0);
  });

  test("add-folder refuses a place among the sessions even where a set shows it", () => {
    const s = restoredWith(session(), (m) => {
      m.context.push({ id: "c-old001", label: "root", root, membership: "mirrored", nodes: [] });
    });
    const e = refusal(() => s.addFolder(join(sessions, s.id, "evil")));
    expect(e.message).toContain("among the sessions' own folders");
    expect(existsSync(join(sessions, s.id, "evil"))).toBe(false);
    expect(refusal(() => s.addFolder(join(appHome, "evil"))).message).toContain("app's own folder");
  });

  test("make-set refuses a document listed among the sessions (rpa-s2), by add and by an old manifest", () => {
    const made = session(noHomeApp);
    const stray = join(sessions, made.id, "imported", "stray.md");
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(stray, "# stray\n");
    expect(refusal(() => made.addContext(stray)).status).toBe(409);
    const s = restoredWith(
      made,
      (m) => {
        m.context.push({
          id: "c-old002",
          label: "stray.md",
          root: dirname(stray),
          membership: "listed",
          nodes: [{ kind: "doc", rel: "stray.md" }],
        });
      },
      noHomeApp,
    );
    const e = refusal(() => s.makeSet(stray));
    expect(e.status).toBe(409);
    expect(existsSync(join(dirname(stray), "stray"))).toBe(false);
    expect(readFileSync(stray, "utf8")).toBe("# stray\n");
    expect(s.context.find((x) => x.id === "c-old002")?.membership).toBe("listed");
  });
});

describe("the structure backstop: nothing is written among the sessions, whatever the sets say", () => {
  test("scenB: a set that shows a live session's folder cannot create, move, rename or trash there", () => {
    const s = restoredWith(session(), (m) => {
      m.context.push({ id: "c-old003", label: "root", root, membership: "mirrored", nodes: [] });
    });
    const own = join(sessions, s.id);
    const before = readdirSync(own).sort();
    const refusals: [string, () => unknown][] = [
      ["new doc in docs/", () => s.createDoc(join(own, "docs"), "evil.md")],
      ["new folder in the session", () => s.createFolder(own, "x")],
      ["move a session's docs/ out", () => s.move(join(own, "docs"), docs)],
      ["move a document in", () => s.move(join(docs, "solo.md"), own)],
      ["rename docs/", () => s.rename(join(own, "docs"), "gone")],
      ["trash docs/", () => s.trashPreview(join(own, "docs"))],
      ["trash the app home", () => s.trashPreview(appHome)],
      ["move the app home", () => s.move(appHome, docs)],
      ["import into the session", () => s.importText("evil.md", "# evil\n", own)],
    ];
    for (const [what, act] of refusals) {
      const e = refusal(act);
      expect([what, e.status]).toEqual([what, 409]);
    }
    expect(readdirSync(own).sort()).toEqual(before);
    expect(existsSync(join(docs, "docs"))).toBe(false);
    expect(existsSync(join(docs, "solo.md"))).toBe(true);
  });

  test("a home-workspace app's own imported/ folder is still where a drop lands", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.setAppHome(appHome);
    const r = s.importText("dropped.md", "# Dropped\n");
    expect(r.path).toBe(join(s.dir, "imported", "dropped.md"));
    expect(s.context.some((e) => e.root === join(s.dir, "imported"))).toBe(true);
  });

  test("a SessionError, never a raw error, names the refusal", () => {
    const s = session();
    expect(refusal(() => s.addContext(sessions))).toBeInstanceOf(SessionError);
  });
});

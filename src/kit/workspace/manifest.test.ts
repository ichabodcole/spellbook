// The manifest: its shape, the app slot and its migration hook, the refusal of
// a format this build does not know, and what a restore does to tasks.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppDeclaration, checkApp, checkSessionId, WorkspaceSession } from "./session";
import { refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-manifest");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const readManifest = (s: WorkspaceSession) =>
  JSON.parse(readFileSync(join(s.dir, "manifest.json"), "utf8")) as Record<string, unknown>;
const writeManifest = (s: WorkspaceSession, m: Record<string, unknown>) =>
  writeFileSync(join(s.dir, "manifest.json"), JSON.stringify(m));

describe("the manifest's shape", () => {
  test("a new session writes the resolution's fields, at format 1, with the app slot", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    expect(Object.keys(m).sort()).toEqual(
      [
        "app",
        "appName",
        "chat",
        "context",
        "createdAt",
        "docs",
        "format",
        "openDoc",
        "sessionId",
        "tasks",
        "workspace",
      ].sort(),
    );
    expect(m.format).toBe(1);
    expect(m.sessionId).toBe(s.id);
    expect(m.appName).toBe(testApp.name);
    expect(new Date(String(m.createdAt)).toISOString()).toBe(String(m.createdAt));
    // A fresh slot is `migrate({}, 0)` at the declared version.
    expect(m.app).toEqual({ renders: [], version: 2 });
  });

  test("updateApp changes the slot, persists it, and keeps the version", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.updateApp((slot) => {
      (slot.renders as unknown[]).push({ id: "r1" });
    });
    expect(s.appSlot).toEqual({ renders: [{ id: "r1" }] });
    expect(readManifest(s).app).toEqual({ renders: [{ id: "r1" }], version: 2 });
    expect(() =>
      s.updateApp((slot) => {
        slot.version = 9;
      }),
    ).toThrow(/reserved/);
  });

  test("appSlot is a copy: mutating it changes nothing until updateApp", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    (s.appSlot.renders as unknown[]).push("x");
    expect(s.appSlot).toEqual({ renders: [] });
  });

  test("reads and progress-time detail do not write the manifest; status changes do", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.addContext(docs);
    const { slug } = s.openPath(join(docs, "solo.md"));
    const task = s.createTask({ title: "Render", by: "daemon", kind: "render", status: "running" });
    let writes = 0;
    const persist = s.persist.bind(s);
    s.persist = () => {
      writes += 1;
      persist();
    };
    s.view();
    s.tasks();
    s.notesOf({ doc: slug });
    s.checkup();
    s.messages();
    s.setTaskDetail(task.id, "50%: stitching");
    expect(writes).toBe(0);
    s.transitionTask(task.id, "done", { outcome: "rendered" });
    expect(writes).toBe(1);
    // The detail set during the run was written with the status change.
    expect(readManifest(s).tasks).toMatchObject([
      { id: task.id, status: "done", detail: "50%: stitching" },
    ]);
  });
});

describe("manifest migration and refusal", () => {
  test("a slot stored at an older version is migrated forward on restore, and persisted", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    // What version 1 of the app wrote: no `renders` list, a counter instead.
    m.app = { version: 1, count: 3 };
    writeManifest(s, m);
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.appSlot).toEqual({ count: 3, renders: [], migrated: true });
    expect(r.restoreReport.slotMigratedFrom).toBe(1);
    expect(readManifest(r).app).toEqual({ count: 3, renders: [], migrated: true, version: 2 });
  });

  test("a slot with no version at all is migrated from 0", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    m.app = {};
    writeManifest(s, m);
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.appSlot).toEqual({ renders: [] });
    expect(r.restoreReport.slotMigratedFrom).toBe(0);
  });

  test("a slot at the declared version is left exactly as written", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.updateApp((slot) => {
      slot.renders = [{ id: "r1" }];
    });
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.appSlot).toEqual({ renders: [{ id: "r1" }] });
    expect(r.restoreReport.slotMigratedFrom).toBeUndefined();
  });

  test("a slot from a newer app is refused, not truncated", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    m.app = { version: 3, fancy: true };
    writeManifest(s, m);
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("newer kit-test");
    // The manifest on disk is untouched.
    expect(readManifest(s).app).toEqual({ version: 3, fancy: true });
  });

  test("a manifest whose format is unknown is refused, and left alone", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    m.format = 2;
    writeManifest(s, m);
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("manifest format 2");
    expect(readManifest(s).format).toBe(2);
    // So is a missing or non-numeric one.
    delete m.format;
    writeManifest(s, m);
    expect(refusal(() => WorkspaceSession.restore(sessions, testApp, s.id)).status).toBe(409);
    m.format = "1";
    writeManifest(s, m);
    expect(refusal(() => WorkspaceSession.restore(sessions, testApp, s.id)).status).toBe(409);
  });

  test("a manifest that is not JSON is refused with a reason", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    writeFileSync(join(s.dir, "manifest.json"), "{ not json");
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("not valid JSON");
  });

  test("migrate may not smuggle in a version key", () => {
    const bad: AppDeclaration = {
      name: "bad-app",
      slot: { version: 1, migrate: () => ({ version: 7 }) },
    };
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    m.app = { version: 0 };
    // Unstamped, as a kit manifest from before `appName`, so bad-app may read it.
    delete m.appName;
    writeManifest(s, m);
    expect(() => WorkspaceSession.restore(sessions, bad, s.id)).toThrow(/may not set/);
  });

  test("an app declaration is checked: a name the discovery files can carry, a real version", () => {
    expect(() => checkApp({ name: "Bad Name", slot: testApp.slot })).toThrow(/invalid app name/);
    expect(() => checkApp({ name: "ok", slot: { version: 0, migrate: (p) => p } })).toThrow(
      /slot.version/,
    );
    expect(checkApp(testApp)).toBe(testApp);
  });
});

describe("restore and tasks", () => {
  test("a daemon task that was running is failed with a restore note; an agent task is left alone", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const daemon = s.createTask({
      title: "Render one",
      by: "daemon",
      kind: "render",
      status: "running",
    });
    const queued = s.createTask({ title: "Render two", by: "daemon", kind: "render" });
    const agent = s.createTask({ title: "Tighten the ending", by: "agent", status: "running" });
    const human = s.createTask({ title: "Render all", by: "human" });
    const done = s.createTask({ title: "Older", by: "daemon", kind: "render", status: "running" });
    s.transitionTask(done.id, "done", { outcome: "ok" });

    const r = WorkspaceSession.restore(sessions, testApp, s.id);

    const byId = Object.fromEntries(r.tasks().map((t) => [t.id, t]));
    expect(byId[daemon.id]?.status).toBe("failed");
    expect(byId[daemon.id]?.detail).toContain("restored");
    // A queued daemon task will never start on its own, and re-running it unasked could spend money.
    expect(byId[queued.id]?.status).toBe("cancelled");
    expect(byId[queued.id]?.detail).toContain("restored");
    // The agent outlives the daemon: its task stands as it was.
    expect(byId[agent.id]?.status).toBe("running");
    expect(byId[human.id]?.status).toBe("open");
    // Finished work stays as it finished.
    expect(byId[done.id]?.status).toBe("done");
    expect(byId[done.id]?.outcome).toBe("ok");

    expect(r.restoreReport.tasks.map((t) => [t.id, t.was, t.now])).toEqual([
      [daemon.id, "running", "failed"],
      [queued.id, "open", "cancelled"],
    ]);
    // And it is written, so a second restore has nothing more to settle.
    const again = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(again.restoreReport.tasks).toEqual([]);
    expect(again.task(daemon.id).status).toBe("failed");
  });

  test("a restore with nothing to settle writes nothing", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.createTask({ title: "Mine", by: "agent", status: "running" });
    const before = readFileSync(join(s.dir, "manifest.json"), "utf8");
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.restoreReport).toEqual({ outside: [], tasks: [] });
    expect(readFileSync(join(s.dir, "manifest.json"), "utf8")).toBe(before);
  });

  test("restore marks an active version whose original changed while closed, and leaves the text", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.addContext(docs);
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "# Solo, edited\n");
    writeFileSync(join(docs, "solo.md"), "# Solo, changed outside\n");
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.doc(slug).outsideChanged).toBe(true);
    expect(r.restoreReport.outside).toEqual([
      { doc: slug, original: join(docs, "solo.md"), missing: false },
    ]);
    expect(r.readVersion(slug, 1).text).toBe("# Solo, edited\n");
  });

  test("an original that is gone is reported as missing", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.addContext(docs);
    const { slug } = s.openPath(join(docs, "solo.md"));
    rmSync(join(docs, "solo.md"));
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.restoreReport.outside[0]).toMatchObject({ doc: slug, missing: true });
    expect(r.checkup().map((f) => f.kind)).toContain("original.missing");
  });

  test("chat, notes and the app slot come back as recorded", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.addContext(docs);
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.addMessage({ from: "human", text: "hello", about: { doc: slug, version: 1 } });
    s.addNote({ doc: slug, by: "agent", quote: "Solo", body: "a title" });
    s.updateApp((slot) => {
      slot.renders = [{ id: "r1" }];
    });
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.messages().map((m) => [m.from, m.type, m.text, m.about?.doc])).toEqual([
      ["human", "message", "hello", slug],
    ]);
    expect(r.doc(slug).notes.map((n) => n.body)).toEqual(["a title"]);
    expect(r.appSlot).toEqual({ renders: [{ id: "r1" }] });
  });
});

describe("session ids", () => {
  test("an id is one plain folder name: a path, a dot-dot and `latest` are refused", () => {
    for (const bad of ["../x", "a/b", "..", ".hidden", "", "latest", "LATEST", "a b"]) {
      expect(refusal(() => WorkspaceSession.restore(sessions, testApp, bad)).status, bad).toBe(400);
      expect(refusal(() => WorkspaceSession.create(sessions, testApp, bad)).status, bad).toBe(400);
    }
    expect(checkSessionId("ab12-cd_3")).toBe("ab12-cd_3");
    expect(WorkspaceSession.create(sessions, testApp, "v1.0-first").id).toBe("v1.0-first");
  });

  test("a new session never overwrites a saved one", () => {
    const s = WorkspaceSession.create(sessions, testApp, "keep");
    s.addMessage({ from: "human", text: "precious" });
    const e = refusal(() => WorkspaceSession.create(sessions, testApp, "keep"));
    expect(e.status).toBe(409);
    expect(WorkspaceSession.restore(sessions, testApp, "keep").messages()).toHaveLength(1);
  });

  test("a manifest that says it is another session is refused", () => {
    const s = WorkspaceSession.create(sessions, testApp, "one");
    const m = readManifest(s);
    m.sessionId = "two";
    writeManifest(s, m);
    expect(refusal(() => WorkspaceSession.restore(sessions, testApp, "one")).status).toBe(409);
  });
});

/**
 * A Scriptorium session manifest, by the shape `src/scriptorium/backend/session.ts`
 * writes (`Manifest`, format 1): no `app`, times in milliseconds, chat by `who`,
 * versions by `author`, and `tasks` only from E50 on. Built here, never read from
 * a real `~/.scriptorium`.
 */
function scriptoriumManifest(sessionId: string, withTasks: boolean): Record<string, unknown> {
  const t = 1_760_000_000_000;
  return {
    format: 1,
    sessionId,
    createdAt: t,
    context: [],
    docs: [
      {
        slug: "solo",
        name: "solo.md",
        original: join(docs, "solo.md"),
        entryId: null,
        rel: null,
        ext: ".md",
        versions: [{ n: 1, author: "human", createdAt: t }],
        active: 1,
        originalHash: "0",
        outsideChanged: false,
      },
    ],
    openDoc: "solo",
    chat: [{ id: "m1", who: "human", text: "hello", ts: t }],
    ...(withTasks
      ? { tasks: [{ id: "t1", text: "Tighten it", who: "agent", createdAt: t, messageId: "m1" }] }
      : {}),
    workspace: docs,
  };
}

describe("a manifest that is not this app's own", () => {
  const plant = (id: string, m: Record<string, unknown>) => {
    mkdirSync(join(sessions, id), { recursive: true });
    const path = join(sessions, id, "manifest.json");
    writeFileSync(path, JSON.stringify(m));
    return path;
  };

  for (const withTasks of [false, true])
    test(`a Scriptorium manifest ${withTasks ? "with" : "without"} tasks is refused with a hint, and left alone`, () => {
      const path = plant("scr1", scriptoriumManifest("scr1", withTasks));
      const before = readFileSync(path, "utf8");
      const e = refusal(() => WorkspaceSession.restore(sessions, testApp, "scr1"));
      expect(e.status).toBe(409);
      expect(e.message).toContain("no app slot");
      expect(e.hint).toContain("a Scriptorium session");
      expect(readFileSync(path, "utf8")).toBe(before);
    });

  test("a manifest with no app slot that is not Scriptorium's is still refused", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    delete m.app;
    writeManifest(s, m);
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
    expect(e.status).toBe(409);
    expect(e.hint).toContain("no `app` slot");
    // An app slot that is not an object is no slot either.
    for (const bad of [null, 3, "x", []]) {
      m.app = bad;
      writeManifest(s, m);
      expect(refusal(() => WorkspaceSession.restore(sessions, testApp, s.id)).status).toBe(409);
    }
  });

  test("another app's manifest is refused, naming that app", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const m = readManifest(s);
    m.appName = "sound-stage";
    writeManifest(s, m);
    const e = refusal(() => WorkspaceSession.restore(sessions, testApp, s.id));
    expect(e.status).toBe(409);
    expect(e.message).toContain("belongs to sound-stage");
    expect(e.hint).toContain("a sound-stage session");
  });

  test("a kit manifest from before the app's name was stamped still restores, and gains it", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    s.addMessage({ from: "human", text: "kept" });
    const m = readManifest(s);
    delete m.appName;
    writeManifest(s, m);
    const r = WorkspaceSession.restore(sessions, testApp, s.id);
    expect(r.messages().map((x) => x.text)).toEqual(["kept"]);
    r.addMessage({ from: "human", text: "again" });
    expect(readManifest(r).appName).toBe(testApp.name);
  });
});

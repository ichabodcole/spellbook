// The shipped Scriptorium's sessions, converted for the kit path, and restored
// by the kit: one test per manifest shape the shipped writer has put on disk
// (from `git log -p` on ../session.ts and ../protocol.ts), and one session the
// shipped writer itself wrote, driven through its own `Session` and CAPTURED
// (`fixtures/shipped-today/`, written by `../kitFixtures.capture.ts` over
// `fixtures/worlds.ts`'s `CONVERT_WORLD`), so this path imports no shipped code
// (scriptorium-kit-keepers).
// Everything lives under a temp folder; the real home is never read.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homeDir } from "../../../kit/lib/home";
import { PRE_MIGRATE_FILE } from "../../../kit/workspace/manifestMigrate";
import {
  type AppDeclaration,
  SessionError,
  WorkspaceSession,
} from "../../../kit/workspace/session";
import { scriptoriumApp } from "./app";
import { convertShippedManifest, isShippedManifest, WORKSPACE_ENTRY_ID } from "./convert";
import { CONVERT_WORLD } from "./fixtures/worlds";

const app: AppDeclaration = { ...scriptoriumApp, migrateManifest: convertShippedManifest };

let root: string;
let home: string;
let sessions: string;
let docs: string;
const T = 1_757_000_000_000; // 2025-09-04, a millisecond time like the shipped writer's

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-convert-")));
  home = join(root, "home");
  sessions = join(home, "sessions");
  docs = join(root, "docs");
  for (const [rel, text] of Object.entries(CONVERT_WORLD)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const iso = (ms: number) => new Date(ms).toISOString();

/** A doc record as the first shipped writer (b84a22e6) wrote it, with its v1 file on disk. */
function firstDoc(id: string) {
  mkdirSync(join(sessions, id, "docs", "solo"), { recursive: true });
  writeFileSync(join(sessions, id, "docs", "solo", "v1.md"), "# Solo\n");
  return {
    slug: "solo",
    name: "solo.md",
    original: join(docs, "solo.md"),
    entryId: "c-1",
    rel: "solo.md",
    ext: ".md",
    versions: [{ n: 1, author: "human", createdAt: T + 1 }],
    active: 1,
    originalHash: "x",
    outsideChanged: false,
  };
}

const listedEntry = () => ({
  id: "c-1",
  label: "solo.md",
  root: docs,
  membership: "listed",
  nodes: [{ kind: "doc", rel: "solo.md" }],
});

function plant(id: string, m: Record<string, unknown>): string {
  mkdirSync(join(sessions, id, "docs"), { recursive: true });
  const path = join(sessions, id, "manifest.json");
  writeFileSync(path, JSON.stringify({ format: 1, sessionId: id, ...m }, null, 2));
  return path;
}

const restore = (id: string) => WorkspaceSession.restore(sessions, app, id);
const stored = (id: string) =>
  JSON.parse(readFileSync(join(sessions, id, "manifest.json"), "utf8")) as Record<string, unknown>;

describe("every shape the shipped writer has written", () => {
  test("b84a22e6 (the first): no workspace, tasks, notes, nextVersion or admitted", () => {
    plant("s1", {
      createdAt: T,
      context: [listedEntry()],
      docs: [firstDoc("s1")],
      openDoc: "solo",
      chat: [
        {
          id: "m-1",
          who: "human",
          text: "tighten this",
          ts: T + 2,
          selection: {
            doc: "solo",
            version: 1,
            path: join(sessions, "s1", "docs", "solo", "v1.md"),
            fromLine: 1,
            toLine: 1,
            text: "# Solo",
          },
          activePath: join(sessions, "s1", "docs", "solo", "v1.md"),
        },
        { id: "m-2", who: "agent", text: "done", ts: T + 3, selection: null, activePath: null },
        { id: "m-3", who: "system", text: "saved", ts: T + 4 },
      ],
    });
    const s = restore("s1");
    expect(s.restoreReport.slotMigratedFrom).toBeUndefined();
    const m = stored("s1");
    expect(m).toMatchObject({ format: 1, appName: "scriptorium", createdAt: iso(T), tasks: [] });
    expect(m.app).toEqual({ version: scriptoriumApp.slot.version });
    // No workspace of its own: nothing is added, and no destination is written
    // for it (the kit path has no home workspace).
    expect((m.context as { id: string }[]).map((e) => e.id)).toEqual(["c-1"]);
    expect("workspace" in m).toBe(false);
    const d = (m.docs as Record<string, unknown>[])[0];
    expect(d).toMatchObject({ nextVersion: 2, notes: [], admitted: false });
    expect(d?.versions).toEqual([{ n: 1, by: "human", createdAt: iso(T + 1) }]);
    expect(s.messages().map((x) => [x.from, x.type, x.ts])).toEqual([
      ["human", "message", iso(T + 2)],
      ["agent", "message", iso(T + 3)],
      ["system", "info", iso(T + 4)],
    ]);
    expect(s.messages()[0]?.about).toEqual({
      doc: "solo",
      version: 1,
      path: join(sessions, "s1", "docs", "solo", "v1.md"),
      fromLine: 1,
      toLine: 1,
      text: "# Solo",
    });
    expect(s.messages()[1]?.about).toBeUndefined();
    expect(s.readVersion("solo", 1).text).toBe("# Solo\n");
  });

  test("1f328241: docs carry admitted", () => {
    plant("s2", {
      createdAt: T,
      context: [listedEntry()],
      docs: [{ ...firstDoc("s2"), admitted: true }],
      openDoc: null,
      chat: [],
    });
    restore("s2");
    expect((stored("s2").docs as { admitted: boolean }[])[0]?.admitted).toBe(true);
  });

  test("923ee09a: a workspace, which becomes an added folder, and hidden rels, which move to the app slot", () => {
    const ws = join(root, "ws");
    plant("s3", {
      createdAt: T,
      workspace: ws,
      context: [
        {
          id: "c-set",
          label: "set",
          root: join(docs, "set"),
          membership: "mirrored",
          nodes: [{ kind: "doc", rel: "a.md" }],
          hidden: ["drafts", "a-old.md"],
        },
      ],
      docs: [],
      openDoc: null,
      chat: [],
    });
    // The converter itself writes no destination (the restore would drop one
    // too, so the manifest it hands back is asked, not only the stored one).
    const raw = JSON.parse(readFileSync(join(sessions, "s3", "manifest.json"), "utf8"));
    const converted = convertShippedManifest(raw, {
      sessionId: "s3",
      dir: join(sessions, "s3"),
      sessionsRoot: sessions,
    });
    expect(converted && "workspace" in converted.manifest).toBe(false);
    const s = restore("s3");
    const m = stored("s3");
    const ctx = m.context as Record<string, unknown>[];
    expect(ctx.map((e) => [e.id, e.root, e.membership])).toEqual([
      ["c-set", join(docs, "set"), "mirrored"],
      [WORKSPACE_ENTRY_ID, ws, "mirrored"],
    ]);
    expect(ctx.some((e) => "hidden" in e)).toBe(false);
    expect(m.app).toEqual({
      version: scriptoriumApp.slot.version,
      hidden: { "c-set": ["drafts", "a-old.md"] },
    });
    // An ordinary added folder: mirrored, re-read on restore, its document in the tree.
    expect(JSON.stringify(ctx[1]?.nodes)).toContain("w.md");
    // The workspace is no longer where new files go: there is no destination
    // nobody chose, and a drop that names no folder is refused.
    expect("workspace" in m).toBe(false);
    expect(s.hasHome).toBe(false);
    expect(() => s.importText("dropped.md", "x")).toThrow(/no location was named/);
    expect(s.restoreReport.manifestMigrated?.note).toContain(
      `Its workspace folder, ${ws}, is now an ordinary added folder`,
    );
  });

  test("e2a756e6: nextVersion is kept, and never falls below a version file on disk", () => {
    const doc = { ...firstDoc("s4"), nextVersion: 3 };
    // v5 is on disk though the manifest forgot it: its number is not handed out again.
    writeFileSync(join(sessions, "s4", "docs", "solo", "v5.md"), "stray\n");
    plant("s4", { createdAt: T, context: [listedEntry()], docs: [doc], openDoc: null, chat: [] });
    restore("s4");
    expect((stored("s4").docs as { nextVersion: number }[])[0]?.nextVersion).toBe(6);
    expect(readdirSync(join(sessions, "s4", "docs", "solo")).sort()).toEqual(["v1.md", "v5.md"]);
  });

  test("8c5d5e9a + 38a378e1: notes by who, with editedAt", () => {
    const note = {
      id: "n-1",
      version: 1,
      quote: "Solo",
      before: "# ",
      after: "\n",
      at: 2,
      body: "why solo?",
      who: "human",
      createdAt: T + 5,
      editedAt: T + 6,
      resolved: false,
    };
    plant("s5", {
      createdAt: T,
      context: [listedEntry()],
      docs: [{ ...firstDoc("s5"), notes: [note] }],
      openDoc: "solo",
      chat: [],
    });
    restore("s5");
    const n = (stored("s5").docs as { notes: Record<string, unknown>[] }[])[0]?.notes[0];
    expect(n).toEqual({
      id: "n-1",
      version: 1,
      quote: "Solo",
      before: "# ",
      after: "\n",
      at: 2,
      body: "why solo?",
      by: "human",
      createdAt: iso(T + 5),
      editedAt: iso(T + 6),
      resolved: false,
    });
  });

  test("c810d3dd: tasks, open, under way (a step) and done", () => {
    plant("s6", {
      createdAt: T,
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
      tasks: [
        { id: "t-1", text: "read", who: "agent", createdAt: T + 1, messageId: "m-1" },
        {
          id: "t-2",
          text: "link",
          who: "agent",
          createdAt: T + 2,
          messageId: "m-2",
          status: "step 2 of 3",
        },
        {
          id: "t-3",
          text: "write",
          who: "human",
          createdAt: T + 3,
          messageId: "m-3",
          doneAt: T + 9,
          outcome: "three files",
        },
      ],
    });
    const s = restore("s6");
    expect([...s.tasks()].reverse()).toEqual([
      {
        id: "t-1",
        title: "read",
        by: "agent",
        status: "open",
        messageId: "m-1",
        createdAt: iso(T + 1),
        updatedAt: iso(T + 1),
      },
      {
        id: "t-2",
        title: "link",
        by: "agent",
        status: "running",
        messageId: "m-2",
        detail: "step 2 of 3",
        createdAt: iso(T + 2),
        updatedAt: iso(T + 2),
      },
      {
        id: "t-3",
        title: "write",
        by: "human",
        status: "done",
        messageId: "m-3",
        outcome: "three files",
        createdAt: iso(T + 3),
        updatedAt: iso(T + 9),
      },
    ]);
    // The kit settles only the daemon's own tasks on restore: these are kept as they were.
    expect(s.restoreReport.tasks).toEqual([]);
  });

  test("e9c219c0 + 8a65c39d: E65's editedBy, reopenedAt and reopenedBy, and a message asking about a note", () => {
    const note = {
      id: "n-1",
      version: 1,
      quote: "Solo",
      before: "# ",
      after: "\n",
      at: 2,
      body: "why?",
      who: "human",
      createdAt: T + 5,
      editedAt: T + 6,
      editedBy: "agent",
      reopenedAt: T + 7,
      reopenedBy: "human",
      resolved: false,
    };
    plant("s7", {
      createdAt: T,
      context: [listedEntry()],
      docs: [{ ...firstDoc("s7"), notes: [note], nextVersion: 2, admitted: true }],
      openDoc: "solo",
      chat: [
        {
          id: "m-ask",
          who: "human",
          text: "Ask about this note",
          ts: T + 8,
          activePath: join(sessions, "s7", "docs", "solo", "v1.md"),
          note: { doc: "solo", id: "n-1" },
        },
      ],
      tasks: [],
    });
    const s = restore("s7");
    const n = (stored("s7").docs as { notes: Record<string, unknown>[] }[])[0]?.notes[0];
    expect(n).toMatchObject({
      by: "human",
      editedBy: "agent",
      reopenedAt: iso(T + 7),
      reopenedBy: "human",
    });
    // The kit's one-ask guard keys on the human's `via: "ask"` with `about.noteId`.
    expect(s.messages()[0]).toMatchObject({
      from: "human",
      via: "ask",
      about: {
        doc: "solo",
        version: 1,
        path: join(sessions, "s7", "docs", "solo", "v1.md"),
        noteId: "n-1",
      },
    });
  });

  test("only a human's message about a note is an ask: an agent's or the system's keeps the note, not via", () => {
    plant("s9", {
      createdAt: T,
      context: [listedEntry()],
      docs: [{ ...firstDoc("s9"), notes: [], nextVersion: 2, admitted: true }],
      openDoc: "solo",
      chat: [
        { id: "m-a", who: "agent", text: "on it", ts: T + 1, note: { doc: "solo", id: "n-1" } },
        { id: "m-s", who: "system", text: "noted", ts: T + 2, note: { doc: "solo", id: "n-1" } },
      ],
      tasks: [],
    });
    const msgs = restore("s9").messages();
    expect(msgs.map((m) => [m.from, m.via, m.about?.noteId])).toEqual([
      ["agent", undefined, "n-1"],
      ["system", undefined, "n-1"],
    ]);
  });

  test("56929d27: ended {by, at}, which the restore clears as the kit does", () => {
    plant("s8", {
      createdAt: T,
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
      tasks: [],
      ended: { by: "human", at: T + 1 },
    });
    restore("s8");
    expect(stored("s8").ended).toBeUndefined();
    expect(readFileSync(join(sessions, "s8", PRE_MIGRATE_FILE), "utf8")).toContain(
      `"at": ${T + 1}`,
    );
  });
});

describe("the shipped writer, as it writes today", () => {
  test("a session it made and used converts whole, and the kit restores it", () => {
    // What the shipped writer left on disk: created in `ws`, the set and
    // solo.md added, solo opened, a second version, a note edited, resolved and
    // reopened, a message about it, two tasks (one done), a.md hidden, ended by
    // the agent. Captured once, and placed here under this test's root.
    const fixtures = join(import.meta.dir, "fixtures");
    const { slug, noteId } = JSON.parse(
      readFileSync(join(fixtures, "shipped-today.json"), "utf8"),
    ) as { slug: string; noteId: string };
    const note = { id: noteId };
    const from = join(fixtures, "shipped-today");
    const place = (rel: string) => {
      for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
        const r = join(rel, e.name);
        if (e.isDirectory()) place(r);
        else {
          mkdirSync(dirname(join(sessions, "today", r)), { recursive: true });
          writeFileSync(
            join(sessions, "today", r),
            readFileSync(join(from, r), "utf8").replaceAll("@ROOT@", root),
          );
        }
      }
    };
    place("");
    const before = readFileSync(join(sessions, "today", "manifest.json"), "utf8");
    const versionFiles = readdirSync(join(sessions, "today", "docs", slug)).sort();

    const k = restore("today");
    // Converted at the slot's current version: no slot migrate on the same restore.
    expect(k.restoreReport.slotMigratedFrom).toBeUndefined();
    expect(k.restoreReport.manifestMigrated?.kept).toBe(join(sessions, "today", PRE_MIGRATE_FILE));
    expect(readFileSync(join(sessions, "today", PRE_MIGRATE_FILE), "utf8")).toBe(before);
    expect(readdirSync(join(sessions, "today", "docs", slug)).sort()).toEqual(versionFiles);
    const m = stored("today");
    expect(m.app).toMatchObject({
      version: scriptoriumApp.slot.version,
      hidden: { [String((m.context as { id: string }[])[0]?.id)]: ["a.md"] },
    });
    expect((m.context as { label: string }[]).map((e) => e.label)).toEqual([
      "set",
      "solo.md",
      "ws",
    ]);
    const v = k.doc(slug);
    expect(v.versions.map((x) => [x.n, x.by, x.fromVersion, x.label])).toEqual([
      [1, "human", undefined, undefined],
      [2, "agent", 1, "longer"],
    ]);
    expect(v.notes[0]).toMatchObject({
      body: "why more?",
      by: "human",
      editedBy: "human",
      reopenedBy: "human",
      resolved: false,
    });
    expect([...k.tasks()].reverse().map((x) => [x.title, x.status, x.detail, x.outcome])).toEqual([
      ["read the set", "running", "halfway", undefined],
      ["tidy", "done", undefined, "tidied"],
    ]);
    expect(k.messages().find((x) => x.via === "ask")?.about?.noteId).toBe(note.id);
    // A second restore reads the kit's own shape: nothing converted again.
    expect(restore("today").restoreReport.manifestMigrated).toBeUndefined();
  });
});

describe("what the converter will not do", () => {
  test("a kit manifest is not its business: null, and the kit restores it as ever", () => {
    const s = WorkspaceSession.create(sessions, scriptoriumApp);
    const raw = stored(s.id);
    expect(isShippedManifest(raw)).toBe(false);
    expect(
      convertShippedManifest(raw, { sessionId: s.id, dir: s.dir, sessionsRoot: sessions }),
    ).toBeNull();
    expect(restore(s.id).restoreReport.manifestMigrated).toBeUndefined();
  });

  test("a shipped manifest it cannot read is refused with the field, and left as it was", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ createdAt: T, format: 2, context: [], docs: [], openDoc: null, chat: [] }, "format is 2"],
      [
        {
          createdAt: T,
          context: [],
          docs: [],
          openDoc: null,
          chat: [{ id: "m", who: "bot", text: "", ts: T }],
        },
        "`chat[0].who`",
      ],
      [
        {
          createdAt: T,
          context: [],
          docs: [],
          openDoc: null,
          chat: [{ id: "m", who: "human", text: "", ts: "now" }],
        },
        "`chat[0].ts`",
      ],
      [
        {
          createdAt: T,
          context: [listedEntry()],
          docs: [{ ...firstDoc("bad"), versions: [] }],
          openDoc: null,
          chat: [],
        },
        "`docs[0].versions` is empty",
      ],
      [
        { createdAt: T, context: [], docs: [], openDoc: null, chat: [], tasks: [{ id: "t" }] },
        "`tasks[0].createdAt`",
      ],
    ];
    for (const [m, why] of cases) {
      const path = plant("bad", m);
      const before = readFileSync(path, "utf8");
      const listing = readdirSync(join(sessions, "bad")).sort();
      let e: unknown;
      try {
        restore("bad");
      } catch (x) {
        e = x;
      }
      expect(e, why).toBeInstanceOf(SessionError);
      expect((e as SessionError).status).toBe(409);
      expect((e as SessionError).message).toContain("a shipped Scriptorium manifest, but");
      expect((e as SessionError).message).toContain(why);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(readdirSync(join(sessions, "bad")).sort()).toEqual(listing);
    }
  });

  test("a workspace that was the home folder, is gone, or is already shown, is not added", () => {
    const cases: [string | undefined, string][] = [
      [homeDir(), "your home folder"],
      [join(root, "gone"), "is gone"],
      [join(docs, "set"), "already shown in set"],
    ];
    for (const [ws, why] of cases) {
      plant("ws", {
        createdAt: T,
        ...(ws ? { workspace: ws } : {}),
        context: [
          { id: "c-set", label: "set", root: join(docs, "set"), membership: "mirrored", nodes: [] },
        ],
        docs: [],
        openDoc: null,
        chat: [],
      });
      rmSync(join(sessions, "ws", PRE_MIGRATE_FILE), { force: true });
      const s = restore("ws");
      expect(
        (stored("ws").context as { id: string }[]).map((e) => e.id),
        why,
      ).toEqual(["c-set"]);
      expect(s.restoreReport.manifestMigrated?.note, why).toContain(why);
    }
  });
});

// The downgrade trap (`docs/items/scriptorium-downgraded-session-refused.md`):
// 6.0.0 converts a session, the shipped writer (5.2.0) opens it again and
// writes to it in its own shape, and 6.0.0 must read it back. The 5.2.0
// entries below are the shapes 5.2.0 wrote onto a converted manifest when run
// for this fix (`say`, `task`, `task-status`, `version-new`, `note`, `hide`,
// `close`), with its kit entries left as they were.
describe("a converted session the shipped writer wrote to again", () => {
  const T5 = 1_794_950_506_526; // a millisecond time like 5.2.0's

  /** The captured session, restored once by the kit (so converted), and its stored manifest. */
  function convertedToday(id: string): Record<string, unknown> {
    const from = join(import.meta.dir, "fixtures", "shipped-today");
    const place = (rel: string) => {
      for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
        const r = join(rel, e.name);
        if (e.isDirectory()) place(r);
        else {
          mkdirSync(dirname(join(sessions, id, r)), { recursive: true });
          const text = readFileSync(join(from, r), "utf8").replaceAll("@ROOT@", root);
          writeFileSync(
            join(sessions, id, r),
            r === "manifest.json" ? text.replace('"today"', JSON.stringify(id)) : text,
          );
        }
      }
    };
    place("");
    restore(id);
    const m = stored(id);
    expect(m.appName).toBe("scriptorium");
    return m;
  }

  type M = Record<string, unknown> & {
    chat: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    context: Record<string, unknown>[];
    docs: (Record<string, unknown> & {
      versions: Record<string, unknown>[];
      notes: Record<string, unknown>[];
    })[];
  };

  /** What 5.2.0 does to a converted manifest, as it wrote it. */
  function writeAs520(id: string, m: M): void {
    m.chat.push(
      { id: "m-5a", who: "agent", text: "hello from five two", ts: T5 },
      { id: "m-5b", who: "agent", text: "old task", ts: T5 + 15 },
      {
        id: "m-5c",
        who: "system",
        text: "Agent created v3 of solo from v1 — fromold.",
        ts: T5 + 30,
      },
    );
    m.tasks.push({
      id: "t-5a",
      text: "old task",
      who: "agent",
      createdAt: T5 + 15,
      messageId: "m-5b",
      status: "halfway",
    });
    // A kit task 5.2.0 finished: `doneAt` in ms, its `status` cleared.
    const kitTask = m.tasks.find((t) => t.title === "read the set") as Record<string, unknown>;
    delete kitTask.status;
    kitTask.doneAt = T5 + 40;
    kitTask.outcome = "read";
    const solo = m.docs[0] as M["docs"][number];
    solo.versions.push({ n: 3, author: "agent", from: 1, createdAt: T5 + 30, label: "fromold" });
    writeFileSync(join(sessions, id, "docs", "solo", "v3.md"), "new text\n");
    solo.nextVersion = 4;
    solo.notes.push({
      id: "n-5a",
      version: 1,
      quote: "Solo",
      before: "# ",
      after: "\n",
      at: 2,
      body: "an old note",
      who: "agent",
      createdAt: T5 + 44,
      resolved: false,
    });
    // A kit note 5.2.0 edited.
    const kitNote = solo.notes[0] as Record<string, unknown>;
    kitNote.body = "edited in 5.2.0";
    kitNote.editedAt = T5 + 50;
    kitNote.editedBy = "agent";
    // `hide` on the set: 5.2.0 never saw the kit's list in the app slot.
    (m.context[0] as Record<string, unknown>).hidden = ["c.md"];
    m.ended = { by: "agent", at: T5 + 60 };
    writeFileSync(join(sessions, id, "manifest.json"), JSON.stringify(m, null, 2));
  }

  test("its entries are converted, the kit's are left as they were, and the next restore converts nothing", () => {
    const before = convertedToday("back") as M;
    const untouched = {
      chat: structuredClone(before.chat),
      tidy: structuredClone(before.tasks.find((t) => t.title === "tidy")),
      v1v2: structuredClone(before.docs[0]?.versions),
    };
    const setId = String(before.context[0]?.id);
    writeAs520("back", structuredClone(before));
    const written = readFileSync(join(sessions, "back", "manifest.json"), "utf8");

    const k = restore("back");
    // 3 chat lines, 2 tasks, 1 version, 2 notes, 1 hidden list.
    expect(k.restoreReport.manifestMigrated?.note).toContain(
      "written to by the shipped Scriptorium after it was converted: 9 entries",
    );
    expect(readFileSync(join(sessions, "back", PRE_MIGRATE_FILE), "utf8")).toBe(written);

    const said = k.messages().map((x) => [x.id, x.from, x.type, x.text, x.ts]);
    expect(said).toContainEqual(["m-5a", "agent", "message", "hello from five two", iso(T5)]);
    expect(said).toContainEqual([
      "m-5c",
      "system",
      "info",
      "Agent created v3 of solo from v1 — fromold.",
      iso(T5 + 30),
    ]);
    const tasks = k.tasks();
    expect(tasks.find((t) => t.id === "t-5a")).toMatchObject({
      title: "old task",
      by: "agent",
      status: "running",
      detail: "halfway",
      createdAt: iso(T5 + 15),
    });
    expect(tasks.find((t) => t.title === "read the set")).toMatchObject({
      status: "done",
      outcome: "read",
      updatedAt: iso(T5 + 40),
    });
    const v = k.doc("solo");
    expect(v.versions.map((x) => [x.n, x.by, x.fromVersion, x.label])).toEqual([
      [1, "human", undefined, undefined],
      [2, "agent", 1, "longer"],
      [3, "agent", 1, "fromold"],
    ]);
    expect(v.notes.map((n) => [n.body, n.by, n.editedAt, n.editedBy])).toEqual([
      ["edited in 5.2.0", "human", iso(T5 + 50), "agent"],
      ["an old note", "agent", undefined, undefined],
    ]);

    const m = stored("back") as M;
    expect(JSON.stringify(m)).not.toContain('"who"');
    expect(m.docs[0]?.nextVersion).toBe(4);
    expect(m.app).toMatchObject({ hidden: { [setId]: ["a.md", "c.md"] } });
    expect("hidden" in (m.context[0] as object)).toBe(false);
    expect(m.ended).toBeUndefined();
    // The kit's own entries, as they were.
    expect(m.chat.slice(0, untouched.chat.length)).toEqual(untouched.chat);
    expect(m.tasks.find((t) => t.title === "tidy")).toEqual(untouched.tidy);
    expect(m.docs[0]?.versions.slice(0, 2)).toEqual(untouched.v1v2);

    const again = readFileSync(join(sessions, "back", "manifest.json"), "utf8");
    expect(restore("back").restoreReport.manifestMigrated).toBeUndefined();
    expect(readFileSync(join(sessions, "back", PRE_MIGRATE_FILE), "utf8")).toBe(written);
    expect(stored("back").chat).toEqual((JSON.parse(again) as M).chat);
  });

  test("an untouched converted manifest is not its business", () => {
    const m = convertedToday("still");
    const text = readFileSync(join(sessions, "still", "manifest.json"), "utf8");
    const kept = readFileSync(join(sessions, "still", PRE_MIGRATE_FILE), "utf8");
    expect(
      convertShippedManifest(m, {
        sessionId: "still",
        dir: join(sessions, "still"),
        sessionsRoot: sessions,
      }),
    ).toBeNull();
    expect(restore("still").restoreReport.manifestMigrated).toBeUndefined();
    expect(readFileSync(join(sessions, "still", PRE_MIGRATE_FILE), "utf8")).toBe(kept);
    expect(stored("still").chat).toEqual((JSON.parse(text) as M).chat);
  });

  test("a workspace it saved: the home folder is not kept, a real folder is added, and the note says which", () => {
    const cases: [string, string, string[]][] = [
      [homeDir(), "The workspace it saved was not kept", []],
      [join(docs, "set"), "The workspace it saved was not kept: its workspace folder", []],
      [join(root, "ws2"), "is now an ordinary added folder", [`${WORKSPACE_ENTRY_ID}-2`]],
    ];
    mkdirSync(join(root, "ws2"), { recursive: true });
    for (const [ws, said, added] of cases) {
      rmSync(join(sessions, "ws"), { recursive: true, force: true });
      const m = convertedToday("ws") as M;
      const ids = m.context.map((e) => e.id);
      expect(ids).toContain(WORKSPACE_ENTRY_ID);
      m.workspace = ws;
      m.chat.push({ id: "m-5a", who: "human", text: "hi", ts: T5 });
      writeFileSync(join(sessions, "ws", "manifest.json"), JSON.stringify(m));
      const s = restore("ws");
      expect(s.restoreReport.manifestMigrated?.note, ws).toContain(said);
      const after = stored("ws") as M;
      expect("workspace" in after, ws).toBe(false);
      expect(
        after.context.map((e) => e.id),
        ws,
      ).toEqual([...ids, ...added]);
    }
    expect(homeDir()).not.toBe(root);
  });

  test("an entry it cannot read is refused with how to recover, and nothing is changed", () => {
    const m = convertedToday("bad") as M;
    m.chat.push({ id: "m-5a", who: "bot", text: "?", ts: T5 });
    const path = join(sessions, "bad", "manifest.json");
    writeFileSync(path, JSON.stringify(m));
    const before = readFileSync(path, "utf8");
    const listing = readdirSync(join(sessions, "bad")).sort();
    const kept = readFileSync(join(sessions, "bad", PRE_MIGRATE_FILE), "utf8");
    let e: unknown;
    try {
      restore("bad");
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(SessionError);
    expect((e as SessionError).status).toBe(409);
    const said = (e as SessionError).message;
    expect(said).toContain("a converted session the shipped Scriptorium wrote to again, but");
    expect(said).toContain("`chat[");
    expect(said).toContain("To recover: fix or remove that entry in manifest.json");
    expect(said).toContain(PRE_MIGRATE_FILE);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readFileSync(join(sessions, "bad", PRE_MIGRATE_FILE), "utf8")).toBe(kept);
    expect(readdirSync(join(sessions, "bad")).sort()).toEqual(listing);
  });

  test("a manifest another writer made, with chat by `who`, is still refused as not Scriptorium's", () => {
    const kitShaped = {
      createdAt: new Date(T5).toISOString(),
      context: [],
      docs: [],
      openDoc: null,
      chat: [{ id: "m", who: "agent", text: "hi", ts: T5 }],
      tasks: [],
      app: { version: 2 },
    };
    // Another app's, and one with no name: neither is converted, and the
    // kit's guard refuses both as it always has.
    const cases: [Record<string, unknown>, string][] = [
      [{ ...kitShaped, appName: "other" }, "was not written by scriptorium"],
      [kitShaped, "was not written by scriptorium"],
    ];
    for (const [m, why] of cases) {
      expect(
        convertShippedManifest(m, {
          sessionId: "foreign",
          dir: join(sessions, "foreign"),
          sessionsRoot: sessions,
        }),
      ).toBeNull();
      const path = plant("foreign", m);
      const before = readFileSync(path, "utf8");
      let e: unknown;
      try {
        restore("foreign");
      } catch (x) {
        e = x;
      }
      expect(e, why).toBeInstanceOf(SessionError);
      expect((e as SessionError).message, why).toContain(why);
      expect(readFileSync(path, "utf8"), why).toBe(before);
      expect(readdirSync(join(sessions, "foreign")), why).not.toContain(PRE_MIGRATE_FILE);
    }
  });
});

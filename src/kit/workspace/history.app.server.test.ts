// An app's own acts on the context's undo (`ctx.history.push`), through a real
// daemon and its socket: the label on the arrows and in the chat, undo and
// redo, the order shared with the kit's own acts, a way back that can no
// longer apply, and an act that made things (asked first, to the Trash, only
// while unchanged, never redone). No test touches the real Trash: the daemon
// is given a trash function that moves the path into a temp folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixtureDaemon, fixtureVerbs } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import { History } from "./history";
import type { VerbHandler, WorkspaceDaemon } from "./server";
import { GoneError, SessionError } from "./session";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let bin: string;
let trashed: string[];
let daemon: WorkspaceDaemon | null = null;
let surface: FakeSurface | null = null;

/** The app's own state, changed only by its acts: a list of words. */
let words: string[];
/** What the next act's undo does when the world has moved: nothing, a refusal, or gone. */
let undoFails: "no" | "refuse" | "gone";
/** Which call of the Trash refuses (1-based), or none. */
let trashRefuses: number | null;
/** A path the make act's undo writes into as it runs (a change between check and Trash). */
let undoWritesInto: string | null;

const appVerbs: Record<string, VerbHandler> = {
  ...fixtureVerbs,
  "kit-fixture.word": (ctx, args) => {
    const word = String(args.word);
    words.push(word);
    ctx.history.push({
      label: `added the word ${word}`,
      undo: () => {
        if (undoFails === "gone") throw new GoneError(`the word ${word} is gone`, 404);
        if (undoFails === "refuse") throw new SessionError(`the list does not read now`, 409);
        // By name, never by position: the word comes out wherever it is now.
        words.splice(words.lastIndexOf(word), 1);
      },
      redo: () => {
        words.push(word);
      },
    });
    return { words };
  },
  "kit-fixture.make": (ctx, args) => {
    const names = (args.names as string[]).map((n) => join(docs, n));
    for (const p of names) writeFileSync(p, `# ${basename(p)}\n`);
    words.push("made");
    ctx.history.push({
      label: `made ${names.length} documents`,
      undo: () => {
        words.splice(words.indexOf("made"), 1);
        if (undoWritesInto) writeFileSync(undoWritesInto, "# changed under the undo\n");
      },
      // A redo is dropped for an act that made things: a creation has none.
      redo: () => {
        throw new Error("never redone");
      },
      creates: names.map((path) => ({ path, dir: false })),
    });
    return { made: names };
  },
};

beforeEach(() => {
  root = tempRoot("history-app");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  bin = join(root, "fake-trash");
  mkdirSync(bin, { recursive: true });
  trashed = [];
  words = [];
  undoFails = "no";
  trashRefuses = null;
  undoWritesInto = null;
});

afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  daemon = null;
  surface = null;
  rmSync(root, { recursive: true, force: true });
});

async function start() {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    verbs: appVerbs,
    trash: async (p: string) => {
      if (trashRefuses === trashed.length + 1) {
        trashRefuses = null;
        throw new Error("the Trash is full");
      }
      trashed.push(p);
      renameSync(p, join(bin, basename(p)));
    },
  });
  await daemon.start();
  const d = daemon;
  surface = new FakeSurface();
  await surface.connect(d.port);
  const s = surface;
  s.send({ op: "context.add", path: docs });
  await waitUntil("context", () => s.state.context.length === 1);
  const ok = async (body: { op: string; [key: string]: unknown }) => {
    const r = await cmd(d.url, body);
    if (r.status !== 200) throw new Error(`${body.op}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  /** The next error frame after now. */
  const errorAfter = async (send: () => void) => {
    const at = s.frames.length;
    send();
    const f = await s.waitFor((m) => m.op === "error" && s.frames.indexOf(m) >= at);
    return f.op === "error" ? f.message : "";
  };
  return { s, ok, errorAfter };
}

describe("History: an app's act", () => {
  test("shows its label; one that made things asks first and names each", () => {
    const h = new History();
    h.did({ label: "added a", inverse: { kind: "app", label: "added a", undo: () => {} } });
    expect(h.view()).toEqual({ canUndo: true, canRedo: false, undoLabel: "added a" });
    h.did({
      label: "made 2",
      inverse: {
        kind: "app",
        label: "made 2",
        undo: () => {},
        creates: [
          { path: "/w/a.md", dir: false, unchanged: "x" },
          { path: "/w/b.md", dir: false, unchanged: "y" },
        ],
      },
    });
    expect(h.view().undoDeletes).toEqual({ path: "/w/a.md", dir: false, also: ["/w/b.md"] });
  });
});

describe("ctx.history.push through the daemon", () => {
  test("undo and redo run the app's way back, labelled on the arrows and in the chat", async () => {
    const { s, ok } = await start();
    await ok({ op: "kit-fixture.word", word: "keeper" });
    await ok({ op: "kit-fixture.word", word: "light" });
    await waitUntil("the label", () => s.state.history.undoLabel === "added the word light");
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    expect(words).toEqual(["keeper"]);
    expect(s.state.history).toMatchObject({
      undoLabel: "added the word keeper",
      redoLabel: "added the word light",
    });
    expect(s.state.chat.some((m) => m.text === "You undid: added the word light.")).toBe(true);
    s.send({ op: "history.redo" });
    await waitUntil("redone", () => !s.state.history.canRedo);
    expect(words).toEqual(["keeper", "light"]);
    expect(s.state.history.undoLabel).toBe("added the word light");
    expect(s.state.chat.some((m) => m.text === "You redid: added the word light.")).toBe(true);
    // And back again: the redo's own undo is the act's.
    s.send({ op: "history.undo" });
    await waitUntil("undone again", () => s.state.history.canRedo);
    expect(words).toEqual(["keeper"]);
  });

  test("interleaves with the kit's acts: each undo takes the newest, whoever made it", async () => {
    const { s, ok } = await start();
    const a = join(docs, "set", "a.md");
    await ok({ op: "kit-fixture.word", word: "keeper" });
    s.send({ op: "rename", path: a, name: "aa.md" });
    await waitUntil("renamed", () => s.state.history.undoLabel === "renamed a.md to aa.md");
    await ok({ op: "kit-fixture.word", word: "light" });
    await waitUntil("pushed", () => s.state.history.undoLabel === "added the word light");

    s.send({ op: "history.undo" });
    await waitUntil("word out", () => s.state.history.undoLabel === "renamed a.md to aa.md");
    expect(words).toEqual(["keeper"]);
    s.send({ op: "history.undo" });
    await waitUntil("name back", () => existsSync(a));
    await waitUntil("next", () => s.state.history.undoLabel === "added the word keeper");
    s.send({ op: "history.undo" });
    await waitUntil("all undone", () => !s.state.history.canUndo);
    expect(words).toEqual([]);

    s.send({ op: "history.redo" });
    await waitUntil("keeper again", () => words.length === 1);
    s.send({ op: "history.redo" });
    await waitUntil("renamed again", () => existsSync(join(docs, "set", "aa.md")));
    s.send({ op: "history.redo" });
    await waitUntil("all redone", () => !s.state.history.canRedo);
    expect(words).toEqual(["keeper", "light"]);
  });

  test("a new act, the app's or the kit's, ends what redo offered", async () => {
    const { s, ok } = await start();
    await ok({ op: "kit-fixture.word", word: "keeper" });
    s.send({ op: "history.undo" });
    await waitUntil("undone", () => s.state.history.canRedo);
    await ok({ op: "kit-fixture.word", word: "light" });
    await waitUntil("redo gone", () => !s.state.history.canRedo);
    expect(s.state.history.undoLabel).toBe("added the word light");
  });

  test("a way back that cannot apply now is refused and kept; one that never can comes off", async () => {
    const { s, ok, errorAfter } = await start();
    await ok({ op: "kit-fixture.word", word: "keeper" });
    await ok({ op: "kit-fixture.word", word: "light" });
    await waitUntil("pushed", () => s.state.history.undoLabel === "added the word light");

    undoFails = "refuse";
    expect(await errorAfter(() => s.send({ op: "history.undo" }))).toBe(
      "the list does not read now",
    );
    expect(words).toEqual(["keeper", "light"]);
    expect(s.state.history.undoLabel).toBe("added the word light");

    undoFails = "gone";
    expect(await errorAfter(() => s.send({ op: "history.undo" }))).toBe(
      "the word light is gone; it has been taken off the undo list.",
    );
    await waitUntil("dropped", () => s.state.history.undoLabel === "added the word keeper");
    expect(words).toEqual(["keeper", "light"]);
    expect(s.state.history.canRedo).toBe(false);
  });

  test("an act that made things: asked first, then the app's undo and every one to the Trash, no redo", async () => {
    const { s, ok, errorAfter } = await start();
    const made = (await ok({ op: "kit-fixture.make", names: ["x.md", "y.md"] })).made as string[];
    await waitUntil("pushed", () => s.state.history.undoLabel === "made 2 documents");
    expect(s.state.history.undoDeletes).toEqual({
      path: made[0] as string,
      dir: false,
      also: [made[1] as string],
    });

    // A client that does not confirm gets a refusal, never a deletion.
    const refused = await errorAfter(() => s.send({ op: "history.undo" }));
    expect(refused).toContain("would delete");
    expect(refused).toContain("and 1 more: confirm it first");
    expect(words).toEqual(["made"]);
    expect(trashed).toEqual([]);

    s.send({ op: "history.undo", confirmDelete: true });
    await waitUntil("gone", () => made.every((p) => !existsSync(p)));
    expect(trashed).toEqual(made);
    expect(words).toEqual([]);
    await waitUntil("the undo's snapshot", () => !s.state.history.canUndo);
    expect(s.state.history.canRedo).toBe(false);
    // The rest of the context untouched.
    expect(readFileSync(join(docs, "solo.md"), "utf8")).toBe("# Solo\n");
  });

  test("one of what it made written into: refused whole, the app's undo not run, nothing trashed", async () => {
    const { s, ok, errorAfter } = await start();
    const made = (await ok({ op: "kit-fixture.make", names: ["x.md", "y.md"] })).made as string[];
    await waitUntil("pushed", () => s.state.history.undoLabel === "made 2 documents");
    writeFileSync(made[1] as string, "# y\n\nwritten into\n");
    const refused = await errorAfter(() => s.send({ op: "history.undo", confirmDelete: true }));
    expect(refused).toContain("written into");
    expect(words).toEqual(["made"]);
    expect(trashed).toEqual([]);
    expect(made.every((p) => existsSync(p))).toBe(true);
    expect(s.state.history.undoLabel).toBe("made 2 documents");
  });

  test("the Trash refusing part way: said with what was done, and the step comes off so older ones are reached", async () => {
    const { s, ok, errorAfter } = await start();
    await ok({ op: "kit-fixture.word", word: "keeper" });
    const made = (await ok({ op: "kit-fixture.make", names: ["x.md", "y.md"] })).made as string[];
    await waitUntil("pushed", () => s.state.history.undoLabel === "made 2 documents");
    trashRefuses = 2;
    const said = await errorAfter(() => s.send({ op: "history.undo", confirmDelete: true }));
    expect(said).toContain('undoing "made 2 documents" was done only in part');
    expect(said).toContain("x.md went to the Trash, but");
    expect(said).toContain("y.md did not (the Trash is full), and stays where it is");
    expect(said).toEndWith("it has been taken off the undo list.");
    expect(trashed).toEqual([made[0] as string]);
    expect(existsSync(made[1] as string)).toBe(true);
    // The app's own undo ran: its record no longer names what it made.
    expect(words).toEqual(["keeper"]);
    // Off the list: the older step is next, and it undoes.
    await waitUntil("dropped", () => s.state.history.undoLabel === "added the word keeper");
    await waitUntil("said in the chat", () =>
      s.state.chat.some((m) => m.text.startsWith("You undid in part: undoing")),
    );
    s.send({ op: "history.undo" });
    await waitUntil("the older undone", () => words.length === 0);
  });

  test("one of what it made changed while the undo ran: it is checked again just before the Trash, and left", async () => {
    const { s, ok, errorAfter } = await start();
    const made = (await ok({ op: "kit-fixture.make", names: ["x.md", "y.md"] })).made as string[];
    await waitUntil("pushed", () => s.state.history.undoLabel === "made 2 documents");
    undoWritesInto = made[1] as string;
    const said = await errorAfter(() => s.send({ op: "history.undo", confirmDelete: true }));
    expect(said).toContain("done only in part");
    expect(said).toContain("written into");
    expect(trashed).toEqual([made[0] as string]);
    expect(readFileSync(made[1] as string, "utf8")).toBe("# changed under the undo\n");
    await waitUntil("dropped", () => !s.state.history.canUndo);
  });

  test("an act with no label is refused", async () => {
    await start();
    const d = daemon as WorkspaceDaemon;
    expect(() => d.context.history.push({ label: " ", undo: () => {} })).toThrow(
      "an act needs a label",
    );
  });
});

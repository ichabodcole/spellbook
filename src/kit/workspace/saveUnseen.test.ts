// Save never overwrites an outside change it has not seen.
//
// The kit hears of an outside change only from the file watch, and a watch can
// miss one: a write just as it arms (up to about 3 s on a saturated fseventsd),
// or, possibly, an event a busy fseventsd drops. Save asks the disk instead: an
// original whose text is no longer the one the session last read is refused,
// and the human lands where a delivered event would have put them: "Changed on
// disk" with the difference to see, their text to keep, or the file's to take.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { collectEvents, FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { UnseenChangeError, type WorkspaceSession } from "./session";
import { inContext, refusal, seedDocs, tempRoot } from "./testing";

let root: string;
let sessions: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-save-unseen");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
});

/** The session alone has no watcher at all: no event is ever delivered to it. */
describe("the session: Save asks the disk, not the watcher", () => {
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const solo = () => join(docs, "solo.md");

  test("with unsaved edits, an unseen outside change is refused, kept, and asked about", () => {
    const s: WorkspaceSession = inContext(sessions, docs);
    const { slug } = s.openPath(solo());
    s.edit(slug, 1, "# Solo\n\nmine\n");
    writeFileSync(solo(), "# Solo\n\ntheirs\n");

    const e = refusal(() => s.save(slug));
    expect(e).toBeInstanceOf(UnseenChangeError);
    expect(e.status).toBe(409);
    expect(e.message).toContain("changed on disk");
    // The refusal carries the act that answers it.
    expect(e.hint).toContain("See the difference");
    expect(e.hint).toContain("Keep mine");
    expect(e.hint).toContain("Take the file's");
    expect((e as UnseenChangeError).event).toMatchObject({ kind: "original.conflict", doc: slug });
    // The outside change survives, the human's text too, and the document is
    // in the state a delivered event leaves it: "Changed on disk".
    expect(readFileSync(solo(), "utf8")).toBe("# Solo\n\ntheirs\n");
    expect(s.readVersion(slug, 1).text).toBe("# Solo\n\nmine\n");
    expect(s.doc(slug).outsideChanged).toBe(true);
    expect(s.doc(slug).dirty).toBe(true);

    // "Keep mine": once asked, Save is the human's deliberate overwrite.
    s.save(slug);
    expect(readFileSync(solo(), "utf8")).toBe("# Solo\n\nmine\n");
    expect(s.doc(slug).outsideChanged).toBe(false);
  });

  test('"Take the file\'s" after the refusal loads the outside text and clears the ask', () => {
    const s = inContext(sessions, docs);
    const { slug } = s.openPath(solo());
    s.edit(slug, 1, "mine\n");
    writeFileSync(solo(), "theirs\n");
    refusal(() => s.save(slug));
    s.revert(slug);
    expect(s.readVersion(slug, 1).text).toBe("theirs\n");
    expect(s.doc(slug).outsideChanged).toBe(false);
    expect(readFileSync(solo(), "utf8")).toBe("theirs\n");
  });

  test("with no unsaved edits, the outside text is loaded, as a delivered event would, and nothing is written", () => {
    const s = inContext(sessions, docs);
    const { slug } = s.openPath(solo());
    writeFileSync(solo(), "# Solo, changed elsewhere\n");
    const e = refusal(() => s.save(slug));
    expect(e).toBeInstanceOf(UnseenChangeError);
    expect((e as UnseenChangeError).event).toMatchObject({ kind: "original.reloaded" });
    // No banner rises for a clean document, so the refusal must not send the human to one.
    expect(e.message).toContain("its text was loaded");
    expect(e.message).not.toContain("banner");
    expect(readFileSync(solo(), "utf8")).toBe("# Solo, changed elsewhere\n");
    expect(s.readVersion(slug, 1).text).toBe("# Solo, changed elsewhere\n");
    expect(s.doc(slug).dirty).toBe(false);
    expect(s.doc(slug).outsideChanged).toBe(false);
  });

  test("an outside change that is already the human's text is no conflict: Save goes ahead", () => {
    const s = inContext(sessions, docs);
    const { slug } = s.openPath(solo());
    s.edit(slug, 1, "same\n");
    writeFileSync(solo(), "same\n");
    expect(s.save(slug)).toMatchObject({ unchanged: true });
    expect(s.doc(slug).dirty).toBe(false);
  });
});

/**
 * The daemon, with its watch suppressed: every folder is "watched" by a watch
 * on an empty folder, so no event for the documents is ever delivered. This
 * is the arm window, or a dropped event, made certain.
 */
describe("the daemon: the human's Save over an unseen change", () => {
  let daemon: WorkspaceDaemon | null = null;
  let surface: FakeSurface | null = null;
  let tail: ReturnType<typeof collectEvents> | null = null;
  afterEach(async () => {
    surface?.close();
    await tail?.stop();
    if (daemon) await daemon.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("is refused, the outside text survives, and the human is asked as an event would ask", async () => {
    mkdirSync(join(root, "tmp"), { recursive: true });
    const quiet = join(root, "quiet");
    mkdirSync(quiet);
    process.env.KIT_FIXTURE_HOME = join(root, "home");
    daemon = fixtureDaemon({
      tmp: join(root, "tmp"),
      platform: "darwin",
      reveal: () => {},
      watch: (_path, _options, _listener) => watch(quiet, () => {}),
    });
    await daemon.start();
    tail = collectEvents(daemon.url);
    surface = new FakeSurface();
    await surface.connect(daemon.port);
    const s = surface;
    const file = join(docs, "set", "a.md");

    s.send({ op: "context.add", path: docs });
    await waitUntil("listed", () => s.state.context.length === 1);
    s.send({ op: "open", path: file });
    await s.waitFor((m) => m.op === "version.text");
    s.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nmine\n" });
    await waitUntil("dirty", () => s.state.docs.find((d) => d.slug === "a")?.dirty);

    writeFileSync(file, "# A\n\ntheirs\n");
    s.send({ op: "save", doc: "a", rid: 3 } as never);
    const refused = await s.waitFor((m) => m.op === "error" && m.requestId === 3);
    expect(refused.op === "error" && refused.message).toContain("changed on disk");
    expect(refused.op === "error" && refused.hint).toContain("See the difference");
    expect(readFileSync(file, "utf8")).toBe("# A\n\ntheirs\n");

    // The banner's state, and the agent told as a delivered event tells it.
    await waitUntil("asked", () => s.state.docs.find((d) => d.slug === "a")?.outsideChanged);
    const asked = await tail.waitFor((e) => e.type === "system" && e.fact === "original.conflict");
    expect(asked).toMatchObject({ doc: "a" });
    expect(tail.events.some((e) => e.type === "saved")).toBe(false);

    // "Keep mine": the deliberate overwrite.
    s.send({ op: "save", doc: "a" });
    await tail.waitFor((e) => e.type === "saved");
    expect(readFileSync(file, "utf8")).toBe("# A\n\nmine\n");
    await waitUntil("answered", () => !s.state.docs.find((d) => d.slug === "a")?.outsideChanged);
  }, 20_000);
});

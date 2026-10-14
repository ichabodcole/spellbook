// An open document whose file goes away outside the app: the daemon notices
// (the file itself, or only its folder, deleted), marks it missing rather than
// dirty, tells the agent on the tail and in `state`, keeps the versions, and
// Save recreates the file, or its folder, only when asked to.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { WorkspaceSession } from "./session";
import { inContext, refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;
let tail: ReturnType<typeof collectEvents> | null;

beforeEach(() => {
  root = tempRoot("workspace-file-gone");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  daemon = null;
  surface = null;
  tail = null;
});
afterEach(async () => {
  surface?.close();
  await tail?.stop();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

async function start(restore?: string) {
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    platform: "darwin",
    reveal: () => {},
    ...(restore ? { restore } : {}),
  });
  await daemon.start();
  tail = collectEvents(daemon.url);
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  return { d: daemon, s: surface, t: tail, base: daemon.url };
}

/**
 * Add the docs to the context, and wait until its watch is live. The watch is
 * armed by `context.add` and is not live at once (FSEvents on macOS): a delete
 * made in its first milliseconds is never reported, which a parallel run makes
 * likely. A file made until the tree shows it says the watch is live.
 */
async function addLive(s: FakeSurface) {
  s.send({ op: "context.add", path: docs });
  await writeUntilSeen(
    "the context's watch",
    () => writeFileSync(join(docs, "watch-live.md"), "# Live\n"),
    () =>
      s.frames.some(
        (f) => f.op === "state" && JSON.stringify(f.state.context).includes("watch-live.md"),
      ),
  );
}

/** Open `set/part/b.md` with an unsaved edit, as the hand run had it. */
async function openEdited(s: FakeSurface) {
  await addLive(s);
  s.send({ op: "open", path: join(docs, "set", "part", "b.md") });
  await s.waitFor((m) => m.op === "version.text");
  s.send({ op: "edit", doc: "b", version: 1, text: "# B\n\nunsaved\n" });
  await waitUntil("dirty", () => s.state.docs.find((d) => d.slug === "b")?.dirty);
}

const docB = (s: FakeSurface) => s.state.docs.find((d) => d.slug === "b");

/**
 * Delete a file, and delete it again until the daemon has seen it go. Under a
 * parallel run a watch can miss a removal (FSEvents on macOS); a removal is
 * not repeatable as it stands, so each retry puts the file back as it was
 * and takes it away again, which a daemon that missed the first reads the
 * same way.
 */
async function removeUntilSeen(file: string, seen: () => unknown) {
  const was = readFileSync(file, "utf8");
  await writeUntilSeen(
    "the file gone",
    () => {
      if (existsSync(file)) rmSync(file);
      else {
        writeFileSync(file, was);
        rmSync(file);
      }
    },
    () => seen() as boolean,
  );
}

describe("a deleted file", () => {
  test("reads as missing, not dirty, on the tail and in state, and its versions stay", async () => {
    const { s, t, base } = await start();
    await openEdited(s);
    await removeUntilSeen(join(docs, "set", "part", "b.md"), () =>
      t.events.some((e) => e.type === "system" && e.fact === "original.missing"),
    );
    const ev = await t.waitFor((e) => e.type === "system" && e.fact === "original.missing");
    expect(ev).toMatchObject({ doc: "b", folder: false });
    expect(String(ev.text)).toContain("gone from disk");
    await waitUntil("missing in state", () => docB(s)?.missing === "file");
    expect(docB(s)?.dirty).toBe(false);
    expect(docB(s)?.outsideChanged).toBe(false);
    expect(s.state.openDoc).toBe("b");

    // The agent's `state` says so too.
    const st = (await (await fetch(`${base}/state`)).json()) as {
      docs: { slug: string; missing?: string }[];
    };
    expect(st.docs.find((d) => d.slug === "b")?.missing).toBe("file");
    // The text is still the session's.
    const v1 = docB(s)?.versions[0]?.path ?? "";
    expect(readFileSync(v1, "utf8")).toBe("# B\n\nunsaved\n");
  });

  test("Save refuses without being asked, and recreates the file when asked", async () => {
    const { s, t } = await start();
    await openEdited(s);
    const file = join(docs, "set", "part", "b.md");
    await removeUntilSeen(file, () => docB(s)?.missing === "file");

    s.send({ op: "save", doc: "b", rid: 7 } as never);
    const refused = await s.waitFor((m) => m.op === "error" && m.requestId === 7);
    // In the human's words, not the protocol's.
    expect(refused.op === "error" && refused.message).toContain("Save to recreate it");
    expect(refused.op === "error" && refused.message).not.toContain("recreate:");
    expect(existsSync(file)).toBe(false);

    s.send({ op: "save", doc: "b", recreate: "file" });
    const saved = await t.waitFor((e) => e.type === "saved");
    expect(saved).toMatchObject({ doc: "b", recreated: "file" });
    expect(readFileSync(file, "utf8")).toBe("# B\n\nunsaved\n");
    await waitUntil("no longer missing", () => docB(s)?.missing === undefined);
    expect(docB(s)?.dirty).toBe(false);
  });

  test("Close puts it away and keeps the record and its versions; opening it again finds them", async () => {
    const { s } = await start();
    await openEdited(s);
    const file = join(docs, "set", "part", "b.md");
    await removeUntilSeen(file, () => docB(s)?.missing === "file");

    s.send({ op: "doc.close", doc: "b" });
    await waitUntil("closed", () => s.state.openDoc === null);
    expect(docB(s)?.versions).toHaveLength(1);

    // Put back (from the Trash, say), as it was: it is simply back.
    writeFileSync(file, "# B\n");
    await waitUntil("back", () => docB(s)?.missing === undefined);
    s.send({ op: "open", path: file });
    await waitUntil("reopened", () => s.state.openDoc === "b");
    expect(readFileSync(docB(s)?.versions[0]?.path ?? "", "utf8")).toBe("# B\n\nunsaved\n");
  });

  test("back with other text is asked about, never reloaded over the session's text", async () => {
    const { s, t } = await start();
    await addLive(s);
    s.send({ op: "open", path: join(docs, "set", "a.md") });
    await s.waitFor((m) => m.op === "version.text");
    const file = join(docs, "set", "a.md");
    await removeUntilSeen(file, () =>
      t.events.some((e) => e.type === "system" && e.fact === "original.missing"),
    );
    writeFileSync(file, "a different file with the same name\n");
    await t.waitFor((e) => e.type === "system" && e.fact === "original.conflict");
    const a = s.state.docs.find((d) => d.slug === "a");
    expect(a?.missing).toBeUndefined();
    expect(readFileSync(a?.versions[0]?.path ?? "", "utf8")).toBe("# A\n\none\n");
  });
});

describe("a file gone only for a moment", () => {
  test("is never called missing: an atomic save or a quick rename back does not flash", async () => {
    const { s, t } = await start();
    await openEdited(s);
    const file = join(docs, "set", "part", "b.md");
    const aside = join(docs, "set", "part", "b.md.tmp");
    renameSync(file, aside);
    // Past the watcher's settle, inside the re-check.
    await Bun.sleep(150);
    renameSync(aside, file);
    await Bun.sleep(900);
    expect(t.events.some((e) => e.type === "system" && e.fact === "original.missing")).toBe(false);
    expect(docB(s)?.missing).toBeUndefined();
  });
});

describe("a deleted parent folder", () => {
  test("marks the document missing with its folder, and Save makes the folder only when asked", async () => {
    const { s, t, base } = await start();
    await openEdited(s);
    const folder = join(docs, "set", "part");
    rmSync(folder, { recursive: true });

    const ev = await t.waitFor((e) => e.type === "system" && e.fact === "original.missing");
    expect(ev).toMatchObject({ doc: "b", folder: true });
    await waitUntil("missing folder", () => docB(s)?.missing === "folder");
    expect(docB(s)?.dirty).toBe(false);
    // The sidebar dropped the folder.
    await waitUntil("tree rescanned", () =>
      s.state.context[0]?.nodes.every((n) => n.rel !== "set/part"),
    );

    // Asked for the file only: still refused, because the folder would come back too.
    s.send({ op: "save", doc: "b", recreate: "file", rid: 9 } as never);
    const refused = await s.waitFor((m) => m.op === "error" && m.requestId === 9);
    expect(refused.op === "error" && refused.message).toContain("its folder");
    expect(existsSync(folder)).toBe(false);

    s.send({ op: "save", doc: "b", recreate: "folder" });
    expect(await t.waitFor((e) => e.type === "saved")).toMatchObject({ recreated: "folder" });
    expect(readFileSync(join(folder, "b.md"), "utf8")).toBe("# B\n\nunsaved\n");
    // The agent cannot save at all: Save is the human's.
    const agentSave = await cmd(base, { op: "save", doc: "b" });
    expect(agentSave.status).not.toBe(200);
  });
});

describe("the session, without a daemon", () => {
  test("a restore finds a gone file missing, not changed", () => {
    const sessions = join(root, "sessions");
    const s = inContext(sessions, docs);
    const file = join(docs, "solo.md");
    s.openPath(file);
    rmSync(file);
    const back = WorkspaceSession.restore(sessions, testApp, basename(s.dir));
    expect(back.restoreReport.outside).toEqual([{ doc: "solo", original: file, missing: true }]);
    const v = back.doc("solo");
    expect(v.missing).toBe("file");
    expect(v.outsideChanged).toBe(false);
    expect(v.dirty).toBe(false);
    expect(refusal(() => back.revert("solo")).message).toContain("no file to revert to");
    expect(refusal(() => back.save("solo")).status).toBe(409);
  });

  test("originalsUnder finds the documents under a deleted folder, once", () => {
    const s = inContext(join(root, "sessions"), docs);
    s.openPath(join(docs, "set", "a.md"));
    s.openPath(join(docs, "set", "part", "b.md"));
    rmSync(join(docs, "set"), { recursive: true });
    const evs = s.originalsUnder(join(docs, "set"));
    expect(evs.map((e) => e.kind === "original.missing" && [e.doc, e.folder])).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(s.originalsUnder(join(docs, "set"))).toEqual([]);
  });
});

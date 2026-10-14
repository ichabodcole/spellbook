// What may not go to the Trash, and what a trashed or deleted document stops
// answering: the review's guards. No real Trash: the session's own checks
// (`trashPreview`) are what refuse, before any trash function runs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSession } from "./session";
import { inContext, refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-trash-guards");
  docs = seedDocs(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what the Trash may not take", () => {
  test("a folder that is also a set of its own, or holds one, is refused", () => {
    const s = inContext(join(root, "sessions"), docs);
    s.addContext(join(docs, "set", "part"));
    expect(refusal(() => s.trashPreview(join(docs, "set", "part"))).message).toContain(
      "holds the set part",
    );
    expect(refusal(() => s.trashPreview(join(docs, "set"))).message).toContain("holds the set");
    // A document in the nested set is still fine.
    expect(s.trashPreview(join(docs, "set", "part", "b.md")).files).toBe(1);
  });

  test("a path through a linked folder that leads outside the set is refused", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.md"), "# Not the set's\n");
    symlinkSync(outside, join(docs, "set", "home"));
    const s = inContext(join(root, "sessions"), docs);
    expect(
      refusal(() => s.trashPreview(join(docs, "set", "home", "precious.md"))).message,
    ).toContain("outside");
  });

  test("the link itself may go, and says it is a link", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.md"), "# Not the set's\n");
    symlinkSync(outside, join(docs, "set", "home"));
    const s = inContext(join(root, "sessions"), docs);
    const p = s.trashPreview(join(docs, "set", "home"));
    expect(p).toMatchObject({ link: true, dir: false, files: 1, folders: 0 });
  });

  test("the workspace folder, or anything holding it, is refused", () => {
    // Only a session from before the overlap block has its workspace inside a
    // set, so it is written into the manifest.
    const sessions = join(root, "sessions");
    const made = inContext(sessions, docs);
    const file = join(sessions, made.id, "manifest.json");
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.workspace = join(docs, "set", "part");
    writeFileSync(file, JSON.stringify(m));
    const s = WorkspaceSession.restore(sessions, testApp, made.id);
    expect(refusal(() => s.trashPreview(join(docs, "set", "part"))).message).toContain(
      "the workspace folder",
    );
    expect(refusal(() => s.trashPreview(join(docs, "set"))).message).toContain(
      "the workspace folder",
    );
  });

  test("the session's own store, inside a set, is refused", () => {
    const sessions = join(docs, "set", "sessions");
    mkdirSync(sessions, { recursive: true });
    // The workspace outside the set: its own imported/ folder would be inside it.
    const s = WorkspaceSession.create(sessions, testApp, undefined, root);
    s.addContext(docs);
    expect(refusal(() => s.trashPreview(sessions)).message).toMatch(/session/);
  });
});

describe("a gone document answers no link", () => {
  const linking = () => {
    writeFileSync(join(docs, "set", "a.md"), "# A\n\nSee [B](./part/b.md).\n");
    const s = inContext(join(root, "sessions"), docs);
    s.openPath(join(docs, "set", "part", "b.md"));
    return s;
  };

  test("a trashed link target makes the link dangle", () => {
    const s = linking();
    expect(s.linkCheck().dangling.count).toBe(0);
    rmSync(join(docs, "set", "part", "b.md"));
    s.trashed(join(docs, "set", "part", "b.md"));
    const d = s.linkCheck().dangling;
    expect(d.count).toBe(1);
    expect(d.links[0]?.raw).toBe("./part/b.md");
  });

  test("so does one deleted outside the app", () => {
    const s = linking();
    rmSync(join(docs, "set", "part", "b.md"));
    s.originalsUnder(join(docs, "set", "part", "b.md"));
    expect(s.linkCheck().dangling.count).toBe(1);
  });
});

// What the centre shows: the record's `openDoc`, `openImage` and `docAside`,
// read together after each act that sets them. Characterization tests: each
// pins what the session does today (a document coming on screen puts an image
// away, an image puts the document aside, and only a close brings it back), so
// a change to who writes the three keys cannot change what the human sees.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSession } from "./session";
import { seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-viewer");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "two.png"), "not a doc either");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Screen = { openDoc: string | null; openImage: string | null; docAside: string | null };

/** The three keys as the record holds them (`docAside` has no public read). */
const screen = (s: WorkspaceSession): Screen => {
  const m = (s as unknown as { core: { m: Partial<Screen> } }).core.m;
  return {
    openDoc: m.openDoc ?? null,
    openImage: m.openImage ?? null,
    docAside: m.docAside ?? null,
  };
};

const at = (rel: string) => join(docs, rel);
const SKIP = () => at("set/skip.png");
const TWO = () => at("set/two.png");

/** A session showing the set and the loose `solo.md`, each its own entry. */
const twoEntries = () => {
  const s = WorkspaceSession.create(sessions, testApp);
  const set = s.addContext(at("set"));
  const solo = s.addContext(at("solo.md"));
  return { s, set: set.entry.id, solo: solo.entry.id };
};

describe("an image coming on screen", () => {
  test("puts the open document aside", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: slug });
  });

  test("with no document open, nothing is aside", () => {
    const { s } = twoEntries();
    s.openImage(SKIP());
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: null });
  });

  test("a second image over the first keeps the same document aside", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.openImage(TWO());
    expect(screen(s)).toEqual({ openDoc: null, openImage: TWO(), docAside: slug });
  });
});

describe("a document coming on screen", () => {
  test("by its path puts the image away, and nothing stays aside", () => {
    const { s } = twoEntries();
    s.openPath(at("solo.md"));
    s.openImage(SKIP());
    const { slug } = s.openPath(at("set/a.md"));
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });

  test("by its slug does the same", () => {
    const { s } = twoEntries();
    const a = s.openPath(at("set/a.md"));
    const solo = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.openSlug(a.slug);
    expect(screen(s)).toEqual({ openDoc: a.slug, openImage: null, docAside: null });
    expect(solo.slug).not.toBe(a.slug);
  });

  test("opened without focus leaves the screen as it was", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.openPath(at("set/a.md"), { focus: false });
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: slug });
  });
});

describe("closing the image", () => {
  test("brings back the document it was opened over", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.closeImage();
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });

  test("brings back the document even after a closeDoc of it while it was aside", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.closeDoc(slug);
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: slug });
    s.closeImage();
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });

  test("brings nothing back once the aside document is forgotten", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: slug });
    s.closeImage();
    expect(screen(s)).toEqual({ openDoc: null, openImage: null, docAside: null });
  });

  test("by removing the entry that shows it brings back the document aside", () => {
    const { s, set } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.removeContext(set);
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });
});

describe("what goes away closes without bringing anything back", () => {
  test("a trashed open image closes; the document stays aside for a later close", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    rmSync(SKIP());
    s.trashed(SKIP());
    expect(screen(s)).toEqual({ openDoc: null, openImage: null, docAside: slug });
    s.closeImage();
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });

  test("a trashed aside document is still held, so a close brings it back", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    rmSync(at("solo.md"));
    const r = s.trashed(at("solo.md"));
    expect(r.closed).toBeNull();
    expect(screen(s)).toEqual({ openDoc: null, openImage: SKIP(), docAside: slug });
    s.closeImage();
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });

  test("a deleted open image closes and the document stays aside", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.removeCreated(SKIP(), false);
    expect(screen(s)).toEqual({ openDoc: null, openImage: null, docAside: slug });
  });

  test("a deleted open document gives way to the first held, and the aside stays", () => {
    const { s } = twoEntries();
    const first = s.openPath(at("set/a.md"));
    const { slug } = s.openPath(at("set/part/b.md"));
    s.removeCreated(at("set/part/b.md"), false);
    expect(screen(s)).toEqual({ openDoc: first.slug, openImage: null, docAside: null });
    expect(slug).not.toBe(first.slug);
  });

  test("forgetting the open document gives way to the first held", () => {
    const { s } = twoEntries();
    const first = s.openPath(at("set/a.md"));
    const { slug } = s.openPath(at("solo.md"));
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    expect(screen(s)).toEqual({ openDoc: first.slug, openImage: null, docAside: null });
  });

  test("forgetting a document not on screen leaves the screen", () => {
    const { s } = twoEntries();
    const gone = s.openPath(at("set/a.md"));
    const { slug } = s.openPath(at("solo.md"));
    rmSync(at("set/a.md"));
    s.forgetDoc(gone.slug);
    expect(screen(s)).toEqual({ openDoc: slug, openImage: null, docAside: null });
  });
});

describe("a move", () => {
  test("the open image follows a rename; the document stays aside", () => {
    const { s } = twoEntries();
    const { slug } = s.openPath(at("solo.md"));
    s.openImage(SKIP());
    s.rename(SKIP(), "fox.png");
    expect(screen(s)).toEqual({ openDoc: null, openImage: at("set/fox.png"), docAside: slug });
  });
});

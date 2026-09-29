// The new-version toast's logic: WHICH versions are news, WHEN a toast stops
// being true, and WHAT each of its two buttons does. Each is a place the
// surface can lie: announcing a version the human has already seen (opening a
// document, a reload), staying silent about one they have not (a reconnect),
// announcing twice when "Now editing" already said it,
// or a Show diff that quietly activates.
import { describe, expect, test } from "bun:test";
import type { DocView, Version } from "../../backend/protocol";
import {
  createVersionWatch,
  newVersionActs,
  newVersionToast,
  spotNewVersions,
  versionName,
  withdrawn,
} from "./newVersions";

const v = (n: number, extra: Partial<Version> = {}): Version => ({
  n,
  author: "agent",
  createdAt: n * 1000,
  path: `/s/docs/note/v${n}.md`,
  ...extra,
});

const doc = (versions: Version[], active: number, extra: Partial<DocView> = {}): DocView => ({
  slug: "note",
  name: "note.md",
  original: "/w/note.md",
  entryId: null,
  rel: null,
  versions,
  active,
  meta: null,
  dirty: false,
  outsideChanged: false,
  notes: [],
  ...extra,
});

describe("spotNewVersions", () => {
  test("the first sight of a document is a baseline, never news", () => {
    // Opening a document, or reloading the page, is
    // the surface meeting versions that already existed.
    const r = spotNewVersions(undefined, doc([v(1), v(2), v(3)], 1));
    expect(r.fresh).toEqual([]);
    expect([...r.seen].sort()).toEqual([1, 2, 3]);
  });

  test("a version that was not there before, and is not active, is news", () => {
    const r = spotNewVersions(new Set([1]), doc([v(1), v(2)], 1));
    expect(r.fresh.map((x) => x.n)).toEqual([2]);
    expect([...r.seen].sort()).toEqual([1, 2]);
  });

  test("the same snapshot seen twice announces nothing the second time", () => {
    const d = doc([v(1), v(2)], 1);
    const first = spotNewVersions(new Set([1]), d);
    const second = spotNewVersions(first.seen, d);
    expect(second.fresh).toEqual([]);
  });

  test("a version created WITH activation gives way to 'Now editing'", () => {
    // One toast, not two: the active-version toast already covers it.
    const r = spotNewVersions(new Set([1]), doc([v(1), v(2)], 2));
    expect(r.fresh).toEqual([]);
    // ...and it is recorded, so it is not announced later either.
    expect(r.seen.has(2)).toBe(true);
  });

  test("activating an OLD version is not a new version", () => {
    const r = spotNewVersions(new Set([1, 2]), doc([v(1), v(2)], 1));
    expect(r.fresh).toEqual([]);
  });

  test("several new versions in one snapshot are each news", () => {
    const r = spotNewVersions(new Set([1]), doc([v(1), v(2), v(3)], 1));
    expect(r.fresh.map((x) => x.n)).toEqual([2, 3]);
  });

  test("the caller's seen set is not mutated", () => {
    const seen = new Set([1]);
    spotNewVersions(seen, doc([v(1), v(2)], 1));
    expect([...seen]).toEqual([1]);
  });
});

describe("createVersionWatch: one page's memory across a reconnect", () => {
  // Cole's ruling (2026-09-28): a version made while the browser was
  // disconnected is the same silent stall he first reported, so a reconnect in
  // the same page announces what this page has not seen. A RELOAD stays quiet,
  // and it does so for free: a reload is a new page, so a new, empty watch.
  const n = (vs: Version[]) => vs.map((x) => x.n);

  test("a version made while disconnected is news on the first snapshot back", () => {
    const w = createVersionWatch();
    expect(w.snapshot(doc([v(1)], 1))).toEqual([]);
    w.disconnected();
    expect(n(w.snapshot(doc([v(1), v(2)], 1)))).toEqual([2]);
  });

  test("a reconnect with nothing new announces nothing", () => {
    const w = createVersionWatch();
    w.snapshot(doc([v(1), v(2)], 1));
    w.disconnected();
    expect(w.snapshot(doc([v(1), v(2)], 1))).toEqual([]);
  });

  test("a version made AND activated during the gap gives way to 'Now editing'", () => {
    const w = createVersionWatch();
    w.snapshot(doc([v(1)], 1));
    w.disconnected();
    expect(w.snapshot(doc([v(1), v(2)], 2))).toEqual([]);
  });

  test("several drops in a row still announce each unseen version once", () => {
    const w = createVersionWatch();
    w.snapshot(doc([v(1)], 1));
    w.disconnected();
    w.disconnected();
    expect(n(w.snapshot(doc([v(1), v(2), v(3)], 1)))).toEqual([2, 3]);
    w.disconnected();
    expect(w.snapshot(doc([v(1), v(2), v(3)], 1))).toEqual([]);
  });

  test("another document this page saw keeps its memory across the gap", () => {
    // Announced when the human next opens it, as without a reconnect.
    const w = createVersionWatch();
    w.snapshot(doc([v(1)], 1, { slug: "other" }));
    w.snapshot(doc([v(1)], 1));
    w.disconnected();
    w.snapshot(doc([v(1)], 1));
    expect(n(w.snapshot(doc([v(1), v(2)], 1, { slug: "other" })))).toEqual([2]);
  });

  test("a document first seen after a reconnect is still a baseline", () => {
    const w = createVersionWatch();
    w.disconnected();
    expect(w.snapshot(doc([v(1), v(2)], 1))).toEqual([]);
  });

  test("a reload is a new watch: opening the document says nothing", () => {
    const before = createVersionWatch();
    before.snapshot(doc([v(1)], 1));
    const reloaded = createVersionWatch();
    expect(reloaded.snapshot(doc([v(1), v(2)], 1))).toEqual([]);
  });
});

describe("versionName", () => {
  test("the label, by the menu's rule", () => {
    expect(versionName(doc([v(1), v(2, { label: "  tighter intro " })], 1), 2)).toBe(
      "v2 · tighter intro",
    );
  });
  test("no label, or a blank one, is the number alone", () => {
    expect(versionName(doc([v(1), v(2, { label: "  " })], 1), 2)).toBe("v2");
    expect(versionName(doc([v(1)], 1), 1)).toBe("v1");
  });
});

describe("newVersionToast", () => {
  test("names the document, the version and the agent as its author", () => {
    const d = doc([v(1), v(2, { label: "answers your notes" })], 1);
    const t = newVersionToast(d, v(2, { label: "answers your notes" }));
    expect(t.title).toBe("New version: v2 · answers your notes");
    expect(t.description).toContain("note.md");
    expect(t.description).toContain("the agent");
    expect(t.description).toContain("still editing v1");
  });

  test("a version the human made says so, not 'the agent'", () => {
    const d = doc([v(1), v(2, { author: "human" })], 1);
    const t = newVersionToast(d, v(2, { author: "human" }));
    expect(t.description).toContain("you");
    expect(t.description).not.toContain("agent");
  });
});

describe("withdrawn", () => {
  const target = { doc: "note", n: 2 };

  test("still true while the version exists, is not active, and its document is open", () => {
    expect(withdrawn(target, doc([v(1), v(2)], 1))).toBe(false);
  });

  test("gives way once that version becomes the active one", () => {
    // By the toast's Activate, the menu, or the agent: 'Now editing' says it.
    expect(withdrawn(target, doc([v(1), v(2)], 2))).toBe(true);
  });

  test("withdraws when the version is deleted", () => {
    expect(withdrawn(target, doc([v(1)], 1))).toBe(true);
  });

  test("withdraws when its document is no longer the open one", () => {
    // Its Show diff acts on the OPEN document's compare view; offering it
    // over a different document would compare the wrong thing.
    expect(withdrawn(target, doc([v(1), v(2)], 1, { slug: "other" }))).toBe(true);
    expect(withdrawn(target, null)).toBe(true);
  });
});

describe("newVersionActs", () => {
  const target = { doc: "note", n: 3 };

  test("Activate sends the menu's activate, and nothing else", () => {
    expect(newVersionActs("activate", target)).toEqual([
      { send: { type: "activate", doc: "note", version: 3 } },
    ]);
  });

  test("Show diff compares active vs the new version and does NOT activate", () => {
    const acts = newVersionActs("diff", target);
    expect(acts).toEqual([{ mode: "compare" }, { against: 3 }]);
    expect(acts.some((a) => "send" in a)).toBe(false);
  });
});

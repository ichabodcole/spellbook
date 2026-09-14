// E62: what a checkup reports, and what it refuses to do about it.
import { describe, expect, test } from "bun:test";
import { type Checkup, findings, summary } from "./doctor";

const clean: Checkup = { docs: [], nodes: [], links: [] };

describe("findings", () => {
  test("a clean session has nothing to say", () => {
    expect(findings(clean)).toEqual([]);
    expect(summary([])).toBeNull();
  });

  test("a document whose file is gone names `forget`, and says what is still held", () => {
    const got = findings({
      ...clean,
      docs: [
        { slug: "notes", name: "notes.md", original: "/w/notes.md", exists: false, versions: 3 },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("original.missing");
    expect(got[0]?.fix).toBe("forget --doc notes");
    // ⛔ The versions are the reason this is a DECISION and not a cleanup.
    expect(got[0]?.message).toContain("3 versions are");
    expect(got[0]?.message).toContain("saving would recreate");
  });

  test("a document that still exists is not a finding", () => {
    expect(
      findings({
        ...clean,
        docs: [{ slug: "a", name: "a.md", original: "/w/a.md", exists: true, versions: 1 }],
      }),
    ).toEqual([]);
  });

  test("a ghost in the context names `hide`", () => {
    const got = findings({
      ...clean,
      nodes: [{ entry: "c-1", path: "/w/solo.md", shown: "~/w/solo.md", exists: false }],
    });
    expect(got[0]?.kind).toBe("context.ghost");
    expect(got[0]?.fix).toBe("hide /w/solo.md");
    expect(got[0]?.message).toContain("not on disk");
  });

  test("⚠ A RECORD AND AN ENTRY FOR THE SAME PATH ARE TWO FINDINGS", () => {
    // They are two different things to clean up with two different verbs;
    // merging them would leave whichever one the human did not do.
    const got = findings({
      docs: [{ slug: "solo", name: "solo.md", original: "/w/solo.md", exists: false, versions: 1 }],
      nodes: [{ entry: "c-1", path: "/w/solo.md", shown: "~/w/solo.md", exists: false }],
      links: [],
    });
    expect(got.map((f) => f.kind)).toEqual(["original.missing", "context.ghost"]);
    expect(new Set(got.map((f) => f.fix)).size).toBe(2);
  });

  test("dangling links are reported per set, with the entry in the fix", () => {
    const got = findings({
      ...clean,
      links: [
        { entry: "c-1", label: "Hollowbrook", dangling: 3 },
        { entry: "c-2", label: "Clean set", dangling: 0 },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.fix).toBe("dangling --entry c-1");
    expect(got[0]?.count).toBe(3);
  });

  test("singular and plural both read correctly", () => {
    const one = findings({ ...clean, links: [{ entry: "c-1", label: "Set", dangling: 1 }] });
    expect(one[0]?.message).toContain("1 link that answer");
  });
});

describe("summary — one line, and silence when clean", () => {
  test("nothing found says nothing at all", () => {
    expect(summary([])).toBeNull();
  });

  test("counts by kind and points at the verb", () => {
    const list = findings({
      docs: [{ slug: "a", name: "a.md", original: "/w/a.md", exists: false, versions: 1 }],
      nodes: [
        { entry: "c-1", path: "/w/b.md", shown: "b.md", exists: false },
        { entry: "c-1", path: "/w/c.md", shown: "c.md", exists: false },
      ],
      links: [],
    });
    const line = summary(list) as string;
    expect(line).toContain("1 missing file");
    expect(line).toContain("2 ghosts in the context");
    expect(line).toContain("doctor");
  });
});

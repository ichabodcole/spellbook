// What a checkup reports, and what it refuses to do about it.
import { describe, expect, test } from "bun:test";
import { type Checkup, findings, summary } from "./doctor";

const clean: Checkup = { docs: [], nodes: [] };

describe("findings", () => {
  test("a clean session has nothing to say", () => {
    expect(findings(clean)).toEqual([]);
    expect(summary([])).toBeNull();
  });

  test("a document whose file is gone says what is still held and what can be done", () => {
    const got = findings({
      ...clean,
      docs: [
        { slug: "notes", name: "notes.md", original: "/w/notes.md", exists: false, versions: 3 },
      ],
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("original.missing");
    expect(got[0]?.fix).toContain("recreate the file");
    expect(got[0]?.fix).toContain("ask the human");
    // The versions are the reason this is a decision and not a cleanup.
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

  test("a ghost in the context is named", () => {
    const got = findings({
      ...clean,
      nodes: [{ entry: "c-1", path: "/w/solo.md", shown: "~/w/solo.md", exists: false }],
    });
    expect(got[0]?.kind).toBe("context.ghost");
    expect(got[0]?.fix).toContain("remove its entry");
    expect(got[0]?.message).toContain("not on disk");
  });

  test("a record and an entry for the same path are two findings", () => {
    // They are two different things to clean up; merging them would leave
    // whichever one the human did not do.
    const got = findings({
      docs: [{ slug: "solo", name: "solo.md", original: "/w/solo.md", exists: false, versions: 1 }],
      nodes: [{ entry: "c-1", path: "/w/solo.md", shown: "~/w/solo.md", exists: false }],
    });
    expect(got.map((f) => f.kind)).toEqual(["original.missing", "context.ghost"]);
    expect(new Set(got.map((f) => f.fix)).size).toBe(2);
  });

  test("singular and plural both read correctly", () => {
    const one = findings({
      ...clean,
      docs: [{ slug: "a", name: "a.md", original: "/w/a.md", exists: false, versions: 1 }],
    });
    expect(one[0]?.message).toContain("1 version is");
  });
});

describe("the link check's findings", () => {
  const links = { dangling: 0, unsupported: 0, schemes: [] as string[], duplicates: 0 };

  test("a clean check, or none at all, says nothing about links", () => {
    expect(findings({ ...clean, links })).toEqual([]);
    expect(findings(clean)).toEqual([]);
  });

  test("broken links are one finding, counted, naming the verb, and not an error", () => {
    const got = findings({ ...clean, links: { ...links, dangling: 3 } });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "links.dangling", subject: "link-check", count: 3 });
    expect(got[0]?.message).toBe("3 broken links: they point at nothing in this session.");
    expect(got[0]?.fix).toContain("`link-check`");
    expect(got[0]?.fix).toContain("not an error");
    expect(findings({ ...clean, links: { ...links, dangling: 1 } })[0]?.message).toBe(
      "1 broken link: it points at nothing in this session.",
    );
  });

  test("unsupported links are a finding of their own, with the schemes named", () => {
    const got = findings({ ...clean, links: { ...links, unsupported: 12, schemes: ["op"] } });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "links.unsupported", subject: "link-check", count: 12 });
    expect(got[0]?.message).toBe(
      "12 unsupported links: they use a scheme nothing here opens (op:).",
    );
    // Both at once are two findings, each with its own count: 0 broken is never "12 dangling".
    const both = findings({
      ...clean,
      links: { ...links, dangling: 1, unsupported: 2, schemes: ["op", "x-devonthink"] },
    });
    expect(both.map((f) => [f.kind, f.count])).toEqual([
      ["links.dangling", 1],
      ["links.unsupported", 2],
    ]);
    expect(both[1]?.message).toContain("(op:, x-devonthink:)");
  });

  test("shared file names are their own finding, naming the verb and `rename`", () => {
    const got = findings({ ...clean, links: { ...links, duplicates: 1 } });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "names.shared", subject: "link-check", count: 1 });
    expect(got[0]?.message).toContain("1 shared file name: more than one document has it");
    expect(got[0]?.fix).toContain("`link-check`");
    expect(got[0]?.fix).toContain("only if the human agrees");
  });

  test("the startup summary leaves the link findings to the status bar", () => {
    const linksOnly = findings({
      ...clean,
      links: { ...links, dangling: 1, unsupported: 12, schemes: ["op"], duplicates: 1 },
    });
    expect(linksOnly).toHaveLength(3);
    expect(summary(linksOnly)).toBeNull();
    const mixed = findings({
      ...clean,
      docs: [{ slug: "a", name: "a.md", original: "/w/a.md", exists: false, versions: 1 }],
      links: { ...links, unsupported: 12, schemes: ["op"] },
    });
    expect(summary(mixed)).toBe("Startup check: 1 missing file. Run `doctor` for the detail.");
  });
});

describe("a workspace that overlaps a set (a session from before the block)", () => {
  test("is a finding that names the set and what to change, said by its own startup line", () => {
    const got = findings({
      ...clean,
      overlap: { workspace: "/w/bible", label: "bible", root: "/w/bible", same: true },
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe("workspace.overlap");
    expect(got[0]?.message).toContain("is the folder of the set bible");
    expect(got[0]?.message).toContain("such as /w,");
    expect(got[0]?.fix).toContain("ask the human");
    // The daemon's own startup line says it in full, so the summary does not repeat it.
    expect(summary(got)).toBeNull();
  });
});

describe("summary: one line, and silence when clean", () => {
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
    });
    const line = summary(list) as string;
    expect(line).toContain("Startup check");
    expect(line).toContain("1 missing file");
    expect(line).toContain("2 ghosts in the context");
    expect(line).toContain("doctor");
  });
});

describe("the relation vocabulary's ignored keys", () => {
  test("a key repeated in another case is said apart, naming the key that stands, never as a typo", () => {
    const got = findings({
      ...clean,
      relations: {
        broken: 0,
        warnings: 2,
        folded: [{ key: "Extends", earlier: "extends", file: "_meta/profiles/_relations.json" }],
      },
    });
    expect(got.map((f) => [f.kind, f.count])).toEqual([
      ["relations.warnings", 1],
      ["relations.folded", 1],
    ]);
    const folded = got.find((f) => f.kind === "relations.folded");
    expect(folded?.message).toContain("Extends in _meta/profiles/_relations.json, after extends");
    expect(folded?.message).not.toContain("typo");
    expect(got.find((f) => f.kind === "relations.warnings")?.message).toContain("typo");
    // Quiet, like the other vocabulary warnings.
    expect(summary(got)).toBeNull();
  });

  test("only repeats: no typo finding at all", () => {
    const got = findings({
      ...clean,
      relations: {
        broken: 0,
        warnings: 1,
        folded: [{ key: "Extends", earlier: "extends", file: "x.json" }],
      },
    });
    expect(got.map((f) => f.kind)).toEqual(["relations.folded"]);
  });

  test("not told apart (no `folded`): one message that does not claim a typo only", () => {
    const [f] = findings({ ...clean, relations: { broken: 0, warnings: 2 } });
    expect(f?.kind).toBe("relations.warnings");
    expect(f?.message).toContain("or a relation repeated in another case");
  });
});

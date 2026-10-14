// The relation vocabulary over a real session and disk: what the link picker is
// offered (declared meanings, used-but-undeclared relations, the use between
// kinds it ranks by), the `relations` verb's report, the inverse a backlink
// reads as, a broken file said by the doctor, an unsaved edit counting, and a
// world with no `_relations.json` behaving as it did. The picker's own ranking
// and drawing are in `document/LinkPicker.relations.test.tsx`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kindUseFrom } from "../lib/relationUse.ts";
import { summary } from "./doctor";
import {
  smallDreamwood,
  VOCABULARY,
  writeVocabulary as vocabulary,
  writeDoc,
} from "./fixtures/relations";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

const dreamwood = (withVocabulary = true) => smallDreamwood(world, withVocabulary);

beforeEach(() => {
  root = tempRoot("relations-session");
  world = join(root, "bible");
  mkdirSync(world, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const open = (rel: string) => s.openPath(join(world, rel)).slug;

describe("the link picker's relations", () => {
  test("each declared relation with its words, used ones with counts, and undeclared ones offered too", () => {
    dreamwood();
    s = inContext(join(root, "sessions"), world);
    const t = s.linkTargets(open("locations/the-ruin.md"));
    expect(t.kind).toBe("location");
    expect(t.vocabulary).toBe(true);
    expect(t.relations.map((r) => [r.rel, r.count, r.declared])).toEqual([
      ["contrasts-with", 4, true],
      ["applies", 3, true],
      ["sourced-from", 3, true],
      ["grounded-in", 1, true],
      ["sourced_from", 1, false],
      ["sister-of", 0, true],
    ]);
    expect(t.relations[0]).toEqual({
      rel: "contrasts-with",
      count: 4,
      declared: true,
      label: "contrasts with",
      means: "Defined against the target; each sharpens the other.",
      symmetric: true,
    });
    // Each target carries its kind; the picker ranks by it.
    const kindOf = (name: string) => t.targets.find((x) => x.name === name)?.kind;
    expect(kindOf("the-cave.md")).toBe("location");
    expect(kindOf("00-touchstones.md")).toBe("reference");
  });

  test("each relation's use into each kind, and from the open document's kind", () => {
    dreamwood();
    s = inContext(join(root, "sessions"), world);
    const t = s.linkTargets(open("locations/the-ruin.md"));
    const by = (x: typeof t) =>
      x.byKind
        .map((u) => `${u.kind} ${u.rel} ${u.links}/${u.fromKind}`)
        .sort()
        .join("; ");
    // A scheme link (op:) and a link to nothing in the session have no kind at the far end.
    expect(by(t)).toBe(
      [
        "foundation applies 3/2",
        "location contrasts-with 4/4",
        "reference sourced-from 2/0",
        "reference sourced_from 1/0",
        "ritual grounded-in 1/0",
      ].join("; "),
    );
    const r = s.linkTargets(open("the-eight-marks.md"));
    expect(r.kind).toBe("ritual");
    expect(r.byKind).toContainEqual({
      kind: "reference",
      rel: "sourced-from",
      links: 2,
      fromKind: 2,
    });
  });

  test("a document of no kind gets no pair counts, and a target of no kind none", () => {
    dreamwood();
    writeDoc(
      world,
      "notes.md",
      null,
      "# Notes\n\n[the Ruin](./locations/the-ruin.md?rel=echoes)\n",
    );
    s = inContext(join(root, "sessions"), world);
    const t = s.linkTargets(open("notes.md"));
    expect(t.kind).toBeNull();
    expect(t.byKind.every((u) => u.fromKind === 0)).toBe(true);
    expect(t.targets.find((x) => x.name === "notes.md")).toBeUndefined();
    const ruin = s.linkTargets(open("locations/the-ruin.md"));
    expect(ruin.targets.find((x) => x.name === "notes.md")?.kind).toBeUndefined();
  });

  test("relationsAt: what is in force at a path, each relation's use between every pair of kinds, and the nearest file", () => {
    dreamwood();
    vocabulary(join(world, "locations"), {
      relations: { "sister-of": { label: "sister place", color: "4", symmetric: true } },
    });
    s = inContext(join(root, "sessions"), world);
    const at = s.relationsAt(join(world, "locations", "boards"));
    expect(at.vocabulary).toBe(true);
    expect(at.file).toBe(join(world, "locations", "_meta", "profiles", "_relations.json"));
    expect(at.relations.find((r) => r.rel === "sister-of")).toMatchObject({
      label: "sister place",
      color: "4",
      symmetric: true,
    });
    expect(at.pairs.map((p) => `${p.from} ${p.kind} ${p.rel} ${p.links}`).sort()).toEqual(
      [
        "location foundation applies 2",
        "location location contrasts-with 4",
        "ritual foundation applies 1",
        "ritual reference sourced-from 2",
        "ritual reference sourced_from 1",
        "ritual ritual grounded-in 1",
      ].sort(),
    );
    // The link picker's own ranking reads the same pairs, folded for its kind.
    const t = s.linkTargets(open("locations/the-ruin.md"));
    expect(t.byKind).toEqual(kindUseFrom(at.pairs, "location"));
    // At the world's root, the world's own file.
    expect(s.relationsAt(join(world, "a-board")).file).toBe(
      join(world, "_meta", "profiles", "_relations.json"),
    );
  });

  test("relationsAt in a world with no _relations.json: no vocabulary and no file", () => {
    dreamwood(false);
    s = inContext(join(root, "sessions"), world);
    const at = s.relationsAt(join(world, "a-board"));
    expect(at.vocabulary).toBe(false);
    expect(at.file).toBeNull();
    expect(at.relations.every((r) => !r.declared)).toBe(true);
  });

  test("relationsAt names a broken nearest file, and why", () => {
    dreamwood();
    vocabulary(world, "{ not json");
    s = inContext(join(root, "sessions"), world);
    const at = s.relationsAt(join(world, "a-board"));
    expect(at.file).toBe(join(world, "_meta", "profiles", "_relations.json"));
    expect(at.broken).toContain("does not parse as JSON");
  });

  test("an unsaved edit counts", () => {
    dreamwood();
    s = inContext(join(root, "sessions"), world);
    const slug = open("locations/the-glade.md");
    s.edit(
      slug,
      1,
      "---\ntype: location\n---\n# The Glade\n\n[the Ruin](./the-ruin.md?rel=echoes)\n",
    );
    const t = s.linkTargets(slug);
    expect(t.relations.find((r) => r.rel === "echoes")).toEqual({
      rel: "echoes",
      count: 1,
      declared: false,
    });
    expect(t.relations.find((r) => r.rel === "applies")?.count).toBe(2);
  });

  test("a world with no _relations.json: the relations in use by count, no meanings, nothing flagged", () => {
    dreamwood(false);
    s = inContext(join(root, "sessions"), world);
    const t = s.linkTargets(open("locations/the-ruin.md"));
    expect(t.vocabulary).toBe(false);
    expect(t.relations).toEqual([
      { rel: "contrasts-with", count: 4, declared: false },
      { rel: "applies", count: 3, declared: false },
      { rel: "sourced-from", count: 3, declared: false },
      { rel: "grounded-in", count: 1, declared: false },
      { rel: "sourced_from", count: 1, declared: false },
    ]);
    expect(s.relations()).toEqual({
      files: [],
      broken: 0,
      warnings: 0,
      declared: [],
      undeclared: [],
      used: [
        { rel: "contrasts-with", count: 4 },
        { rel: "applies", count: 3 },
        { rel: "sourced-from", count: 3 },
        { rel: "grounded-in", count: 1 },
        { rel: "sourced_from", count: 1 },
      ],
    });
    expect(s.backlinks(join(world, "locations", "the-cave.md")).relations).toEqual([
      { rel: "contrasts-with", count: 1 },
    ]);
    expect(s.checkup().filter((f) => f.kind.startsWith("relations."))).toEqual([]);
  });
});

describe("the relations verb", () => {
  test("a key a relation does not read is listed per file and is a quiet doctor finding", () => {
    dreamwood();
    vocabulary(world, {
      relations: { ...VOCABULARY.relations, extends: { label: "extends", symetric: true } },
    });
    s = inContext(join(root, "sessions"), world);
    const r = s.relations();
    expect(r.broken).toBe(0);
    expect(r.warnings).toBe(1);
    expect(r.files[0]?.warnings).toEqual([
      'relations.extends has "symetric", which is not read (a relation takes label, means, symmetric, inverse, color); it is ignored',
    ]);
    expect(r.declared.find((d) => d.rel === "extends")?.symmetric).toBe(false);
    const found = s.checkup().filter((f) => f.kind.startsWith("relations."));
    expect(found.map((f) => [f.kind, f.subject, f.count])).toEqual([
      ["relations.warnings", "relations", 1],
    ]);
    // Quiet: never in the startup line.
    expect(summary(found)).toBeNull();
  });

  test("files, each declared relation with its uses, the undeclared and the used", () => {
    dreamwood();
    s = inContext(join(root, "sessions"), world);
    const r = s.relations();
    expect(r.files).toEqual([
      {
        path: join(world, "_meta", "profiles", "_relations.json"),
        shown: "_meta/profiles/_relations.json",
        relations: 5,
      },
    ]);
    expect(r.broken).toBe(0);
    expect(r.declared.map((d) => [d.rel, d.uses, d.symmetric, d.inverse ?? null])).toEqual([
      ["grounded-in", 1, false, "grounds"],
      ["applies", 3, false, "applied in"],
      ["sourced-from", 3, false, "source for"],
      ["contrasts-with", 4, true, null],
      ["sister-of", 0, true, null],
    ]);
    expect(r.declared[0]?.file).toBe("_meta/profiles/_relations.json");
    expect(r.undeclared).toEqual([{ rel: "sourced_from", count: 1 }]);
    expect(r.used[0]).toEqual({ rel: "contrasts-with", count: 4 });
  });

  test("nearest wins: a nested file overrides one relation beneath it, and its uses count there", () => {
    dreamwood();
    vocabulary(join(world, "locations"), {
      relations: { "contrasts-with": { label: "stands against", symmetric: true } },
    });
    s = inContext(join(root, "sessions"), world);
    const r = s.relations();
    expect(r.files.map((f) => f.shown)).toEqual([
      "_meta/profiles/_relations.json",
      "locations/_meta/profiles/_relations.json",
    ]);
    const contrasts = r.declared.filter((d) => d.rel === "contrasts-with");
    expect(contrasts.map((d) => [d.file, d.label, d.uses])).toEqual([
      ["_meta/profiles/_relations.json", "contrasts with", 0],
      ["locations/_meta/profiles/_relations.json", "stands against", 4],
    ]);
    // Relations defined only above still apply beneath it.
    const t = s.linkTargets(open("locations/the-ruin.md"));
    expect(t.relations.find((x) => x.rel === "contrasts-with")?.label).toBe("stands against");
    expect(t.relations.find((x) => x.rel === "applies")?.declared).toBe(true);
    // Above it, the world's own.
    const m = s.linkTargets(open("the-eight-marks.md"));
    expect(m.relations.find((x) => x.rel === "contrasts-with")?.label).toBe("contrasts with");
  });

  test("a broken file is reported with its line and column, defines nothing, and the doctor says so", () => {
    dreamwood();
    vocabulary(world, '{\n  "relations": {\n    "applies": { "label": "applies" },\n  }\n}');
    s = inContext(join(root, "sessions"), world);
    const r = s.relations();
    expect(r.broken).toBe(1);
    expect(r.files[0]?.broken).toBe(
      'does not parse as JSON: line 3, column 38: a comma before "}" is not allowed in JSON',
    );
    expect(r.declared).toEqual([]);
    // A broken file is still a vocabulary in force: nothing is declared, so
    // every relation is used but not declared.
    expect(r.undeclared.map((u) => u.rel)).toContain("applies");
    const t = s.linkTargets(open("locations/the-ruin.md"));
    expect(t.relations.every((x) => !x.declared && x.means === undefined)).toBe(true);
    const found = s.checkup().filter((f) => f.kind === "relations.broken");
    expect(found).toEqual([
      {
        kind: "relations.broken",
        subject: "relations",
        message:
          "1 broken relation vocabulary file (_relations.json): until fixed, it defines no relation, and the relations declared above it apply instead.",
        fix: "run `relations` for each file and the reason; offer to fix the file in a new version the human saves",
        count: 1,
      },
    ]);
    expect(summary(found)).toBe(
      "Startup check: 1 broken relation vocabulary file. Run `doctor` for the detail.",
    );
  });

  test("a file is parsed once per change, however many asks", () => {
    dreamwood();
    s = inContext(join(root, "sessions"), world);
    const reader = (s as unknown as { relationsReader: { parsed: number } }).relationsReader;
    const slug = open("locations/the-ruin.md");
    s.linkTargets(slug);
    s.linkTargets(slug);
    s.relations();
    s.backlinks(join(world, "locations", "the-cave.md"));
    expect(reader.parsed).toBe(1);
    vocabulary(world, { relations: { applies: {} } });
    expect(s.relations().declared.map((d) => d.rel)).toEqual(["applies"]);
    expect(reader.parsed).toBe(2);
  });
});

describe("backlinks read from this end", () => {
  test("a declared inverse, a symmetric relation's label, and nothing for one with neither", () => {
    dreamwood();
    vocabulary(world, {
      relations: { ...VOCABULARY.relations, applies: { label: "applies" } },
    });
    s = inContext(join(root, "sessions"), world);
    expect(s.backlinks(join(world, "the-eight-marks.md")).relations).toEqual([
      { rel: "grounded-in", count: 1, as: "grounds" },
    ]);
    expect(s.backlinks(join(world, "locations", "the-glade.md")).relations).toEqual([
      { rel: "contrasts-with", count: 2, as: "contrasts with" },
    ]);
    // `applies` declared without an inverse: no words for this end.
    expect(s.backlinks(join(world, "03-cosmology.md")).relations).toEqual([
      { rel: "applies", count: 3 },
    ]);
    // Undeclared: as written.
    expect(s.backlinks(join(world, "touchstones", "00-touchstones.md")).relations).toEqual([
      { rel: "sourced-from", count: 2, as: "source for" },
      { rel: "sourced_from", count: 1 },
    ]);
  });
});

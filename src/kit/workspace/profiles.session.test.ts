// Profiles over a real session and disk: the nearest folder wins per kind, the
// lookup never climbs above the context entry, a broken file matches nothing,
// the three answers behind `profiles`, `profile` and `profile-check`, an
// unsaved edit counting, `kindOf` feeding the graph, the doctor's findings, and
// a world with no profiles behaving as it did.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summary } from "./doctor";
import type { ProfileReader } from "./profiles";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

const LOCATION = {
  kind: "location",
  label: "Location",
  description: "One canonical place.",
  type: "object",
  properties: {
    type: { const: "location" },
    title: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1, description: "One sentence." },
    status: { enum: ["draft", "stable", "deprecated"] },
  },
  required: ["type", "title", "description", "status"],
};

const profile = (dir: string, name: string, body: unknown) => {
  mkdirSync(join(dir, "_meta", "profiles"), { recursive: true });
  writeFileSync(
    join(dir, "_meta", "profiles", name),
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
  );
};

const doc = (path: string, front: Record<string, string> | null, body = "# Doc\n") => {
  mkdirSync(join(path, ".."), { recursive: true });
  const fm =
    front === null
      ? ""
      : `---\n${Object.entries(front)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}\n---\n`;
  writeFileSync(path, fm + body);
};

beforeEach(() => {
  root = tempRoot("profiles-session");
  world = join(root, "bible");
  // Above the context entry: never read.
  profile(root, "meta.json", { kind: "meta", required: ["owner"] });
  profile(root, "location.json", { kind: "location", required: ["never-from-above"] });
  profile(world, "location.json", LOCATION);
  profile(world, "ritual.json", { kind: "ritual", label: "Ritual", required: ["title"] });
  profile(world, "_relations.json", "{ reserved, not a kind, not read");
  // A nested folder overrides `location` only.
  profile(join(world, "locations"), "location.json", {
    kind: "location",
    label: "Wild place",
    required: ["region"],
  });
  doc(join(world, "00-overview.md"), null, "# Overview\n");
  doc(join(world, "_meta", "CONTRIBUTING.md"), { type: "meta", title: "Contributing" });
  doc(join(world, "the-mark.md"), { type: "ritual", title: "The Mark" });
  doc(join(world, "the-cave.md"), {
    type: "location",
    title: "The Cave",
    description: "Dark.",
    status: "final",
  });
  doc(join(world, "locations", "the-glade.md"), {
    type: "location",
    title: "The Glade",
    region: "centre",
  });
  doc(join(world, "locations", "the-stair.md"), { type: "location", title: "The Stair" });
  doc(join(world, "locations", "the-ritual.md"), { type: "ritual" });
  s = inContext(join(root, "sessions"), world);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("which profile applies", () => {
  test("the nearest folder wins per kind: a nested location, a ritual from above", () => {
    const glade = s.documentProfile(join(world, "locations", "the-glade.md"));
    expect(glade).toMatchObject({
      doc: null,
      shown: "locations/the-glade.md",
      type: "location",
      kind: "location",
      match: "matched",
      label: "Wild place",
      canon: true,
      source: join(world, "locations", "_meta", "profiles", "location.json"),
      sourceShown: "locations/_meta/profiles/location.json",
      warnings: [],
    });
    // Used whole: the root's required fields do not leak into the nested one.
    expect(glade.fields).toEqual([
      {
        field: "region",
        required: true,
        file: join(world, "locations", "_meta", "profiles", "location.json"),
        fileShown: "locations/_meta/profiles/location.json",
      },
    ]);

    const ritual = s.documentProfile(join(world, "locations", "the-ritual.md"));
    expect(ritual).toMatchObject({
      kind: "ritual",
      label: "Ritual",
      sourceShown: "_meta/profiles/ritual.json",
    });
    expect(ritual.warnings.map((w) => [w.field, w.rule])).toEqual([["title", "required"]]);

    const cave = s.documentProfile(join(world, "the-cave.md"));
    expect(cave).toMatchObject({ label: "Location", sourceShown: "_meta/profiles/location.json" });
    expect(cave.warnings).toEqual([expect.objectContaining({ field: "status", rule: "enum" })]);
    expect(cave.description).toBe("One canonical place.");
    expect(cave.fields?.find((f) => f.field === "description")).toEqual({
      field: "description",
      required: true,
      type: ["string"],
      minLength: 1,
      description: "One sentence.",
      file: join(world, "_meta", "profiles", "location.json"),
      fileShown: "_meta/profiles/location.json",
    });
  });

  test("never above the context entry: a profile beside the world is not read", () => {
    const meta = s.documentProfile(join(world, "_meta", "CONTRIBUTING.md"));
    expect(meta).toMatchObject({ type: "meta", kind: "meta", match: "none", warnings: [] });
    expect(meta.source).toBeUndefined();
    expect(s.profiles().kinds.map((k) => k.source)).not.toContain(
      join(root, "_meta", "profiles", "location.json"),
    );
  });

  test("an entry deeper in the world sees only what is at or under its own root", () => {
    const only = inContext(join(root, "sessions-2"), join(world, "locations"));
    expect(only.documentProfile(join(world, "locations", "the-glade.md"))).toMatchObject({
      match: "matched",
      label: "Wild place",
      sourceShown: "_meta/profiles/location.json",
    });
    // The world's ritual profile is above this entry's root.
    expect(only.documentProfile(join(world, "locations", "the-ritual.md"))).toMatchObject({
      type: "ritual",
      kind: "ritual",
      match: "none",
    });
  });

  test("a listed document looks only in its own folder's _meta/profiles", () => {
    const one = inContext(join(root, "sessions-3"), join(world, "the-cave.md"));
    expect(one.documentProfile(join(world, "the-cave.md"))).toMatchObject({
      match: "matched",
      sourceShown: "_meta/profiles/location.json",
    });
    expect(one.watchRoots()).toContainEqual({
      path: join(world, "_meta", "profiles"),
      watch: join(world, "_meta", "profiles"),
      recursive: false,
    });
  });

  test("a broken nearest file is reported, matches nothing, and does not fall through", () => {
    profile(join(world, "locations"), "location.json", '{ "kind": "location", ');
    const glade = s.documentProfile(join(world, "locations", "the-glade.md"));
    expect(glade).toMatchObject({
      type: "location",
      // The kind is still the type, as before profiles.
      kind: "location",
      match: "broken",
      sourceShown: "locations/_meta/profiles/location.json",
      warnings: [],
    });
    expect(glade.reason).toMatch(/^does not parse as JSON: /);
    const p = s.profiles();
    expect(p.broken).toEqual([
      {
        path: join(world, "locations", "_meta", "profiles", "location.json"),
        shown: "locations/_meta/profiles/location.json",
        kind: "location",
        reason: expect.stringMatching(/^does not parse as JSON/),
        documents: 2,
      },
    ]);
    const check = s.profileCheck();
    expect(check.broken.count).toBe(1);
    expect(check.broken.files[0]?.fix).toContain("locations/_meta/profiles/location.json");
    // Nothing under the broken file is checked; the cave above it still is.
    expect(check.warnings.list.map((w) => w.shown)).toEqual([
      "locations/the-ritual.md",
      "the-cave.md",
    ]);

    // A usable file that does not match its name is broken too, with the reason.
    profile(join(world, "locations"), "location.json", { kind: "place" });
    expect(s.documentProfile(join(world, "locations", "the-glade.md")).reason).toBe(
      'says "kind": "place" but the file is named location.json; they must match',
    );
    // Fixed, it matches again.
    profile(join(world, "locations"), "location.json", { kind: "location" });
    expect(s.documentProfile(join(world, "locations", "the-glade.md")).match).toBe("matched");
  });
});

describe("the three answers", () => {
  test("profiles: each kind with its file and counts, unprofiled types, untyped, broken", () => {
    expect(s.profiles()).toEqual({
      documents: 7,
      kinds: [
        {
          kind: "location",
          label: "Location",
          canon: true,
          source: join(world, "_meta", "profiles", "location.json"),
          shown: "_meta/profiles/location.json",
          documents: 1,
          withWarnings: 1,
          refs: [],
        },
        {
          kind: "location",
          label: "Wild place",
          canon: true,
          source: join(world, "locations", "_meta", "profiles", "location.json"),
          shown: "locations/_meta/profiles/location.json",
          documents: 2,
          withWarnings: 1,
          refs: [],
        },
        {
          kind: "ritual",
          label: "Ritual",
          canon: true,
          source: join(world, "_meta", "profiles", "ritual.json"),
          shown: "_meta/profiles/ritual.json",
          documents: 2,
          withWarnings: 1,
          refs: [],
        },
      ],
      unprofiled: [{ type: "meta", documents: 1 }],
      untyped: 1,
      unparsed: { count: 0, documents: [] },
      broken: [],
      brokenFiles: 0,
    });
  });

  test("profile-check: every warning with its file, rule and fix, like link-check", () => {
    const r = s.profileCheck();
    expect(r.count).toBe(3);
    expect(r.warnings.documents).toBe(3);
    expect(r.warnings.list).toEqual([
      {
        field: "title",
        rule: "required",
        message: "title is missing; the Ritual profile requires it",
        source: join(world, "locations", "the-ritual.md"),
        name: "the-ritual.md",
        shown: "locations/the-ritual.md",
        kind: "ritual",
        profile: "_meta/profiles/ritual.json",
        file: join(world, "_meta", "profiles", "ritual.json"),
        fileShown: "_meta/profiles/ritual.json",
        fix: "add `title` to the frontmatter",
      },
      expect.objectContaining({
        shown: "locations/the-stair.md",
        field: "region",
        rule: "required",
        profile: "locations/_meta/profiles/location.json",
        fix: "add `region` to the frontmatter",
      }),
      expect.objectContaining({
        shown: "the-cave.md",
        field: "status",
        rule: "enum",
        message: 'status is "final", which is not one of draft, stable, deprecated',
        fix: "set `status` to one of draft, stable, deprecated",
      }),
    ]);
    expect(r.broken).toEqual({ count: 0, files: [] });
    expect(r.truncated).toBeUndefined();
  });

  test("profile: the open document when no key is given, read from its active version", () => {
    const { slug } = s.openPath(join(world, "the-cave.md"));
    expect(s.documentProfile().warnings).toHaveLength(1);
    s.edit(slug, 1, "---\ntype: location\ntitle: The Cave\nstatus: stable\n---\n# The Cave\n");
    const now = s.documentProfile();
    expect(now.doc).toBe(slug);
    // The version it was read from, so the header can tell a stale answer.
    expect(now.version).toBe(1);
    expect(now.warnings).toEqual([
      {
        field: "description",
        rule: "required",
        message: "description is missing; the Location profile requires it",
        description: "One sentence.",
        file: join(world, "_meta", "profiles", "location.json"),
        fileShown: "_meta/profiles/location.json",
        fix: "add `description` to the frontmatter (One sentence.)",
      },
    ]);
    expect(s.profileCheck().warnings.list.filter((w) => w.shown === "the-cave.md")).toEqual([
      expect.objectContaining({
        field: "description",
        fix: "add `description` to the frontmatter (One sentence.)",
      }),
    ]);
  });

  test("an unknown document is refused as backlinks refuses one", () => {
    expect(() => s.documentProfile(join(root, "elsewhere.md"))).toThrow();
  });
});

describe("kindOf, the doctor, and a world with none", () => {
  test("the graph's kinds come from kindOf: the profile's kind, else the type", () => {
    const g = s.linkGraph();
    const kinds = Object.fromEntries(g.nodes.map((n) => [n.shown, n.kind]));
    expect(kinds).toEqual({
      "00-overview.md": null,
      "_meta/CONTRIBUTING.md": "meta",
      "the-mark.md": "ritual",
      "the-cave.md": "location",
      "locations/the-glade.md": "location",
      "locations/the-stair.md": "location",
      "locations/the-ritual.md": "ritual",
    });
  });

  test("the doctor counts warnings quietly and says a broken file at startup", () => {
    const quiet = s.checkup().filter((f) => f.kind.startsWith("profiles."));
    expect(quiet).toEqual([
      expect.objectContaining({
        kind: "profiles.warnings",
        subject: "profile-check",
        message:
          "3 profile warnings in 3 documents: frontmatter that does not match its kind's profile.",
        count: 3,
      }),
    ]);
    expect(summary(quiet)).toBeNull();
    profile(world, "ritual.json", { kind: "ritual", required: "title" });
    const loud = s.checkup().filter((f) => f.kind.startsWith("profiles."));
    expect(loud.map((f) => f.kind)).toEqual(["profiles.broken", "profiles.warnings"]);
    expect(loud[0]?.fix).toContain("`profile-check`");
    expect(summary(loud)).toBe(
      "Startup check: 1 broken profile file. Run `doctor` for the detail.",
    );
  });

  test("a world with no profiles behaves as it did: kinds are types, nothing is said", () => {
    rmSync(join(world, "_meta", "profiles"), { recursive: true });
    rmSync(join(world, "locations", "_meta"), { recursive: true });
    const p = s.profiles();
    expect(p.kinds).toEqual([]);
    expect(p.broken).toEqual([]);
    expect(p.unprofiled).toEqual([
      { type: "location", documents: 3 },
      { type: "ritual", documents: 2 },
      { type: "meta", documents: 1 },
    ]);
    expect(s.profileCheck()).toEqual({
      count: 0,
      warnings: { count: 0, documents: 0, list: [] },
      broken: { count: 0, files: [] },
    });
    expect(s.checkup().filter((f) => f.kind.startsWith("profiles."))).toEqual([]);
    expect(s.documentProfile(join(world, "the-cave.md"))).toEqual({
      doc: null,
      path: join(world, "the-cave.md"),
      shown: "the-cave.md",
      type: "location",
      kind: "location",
      canon: true,
      match: "none",
      reason:
        "no _meta/profiles/location.json between its folder and the root of its context entry",
      warnings: [],
    });
    const kinds = s.linkGraph().kinds;
    expect(kinds).toContainEqual({ kind: "location", label: "location", canon: true, count: 3 });
    expect(kinds).toContainEqual({ kind: null, label: null, canon: true, count: 1 });
    expect(s.linkGraph().nodes.every((n) => n.canon && n.label === n.kind)).toBe(true);
  });
});

describe("canon", () => {
  test("a kind file's canon: false reaches profile and profiles; absent is canon", () => {
    profile(world, "meta.json", { kind: "meta", label: "Meta", canon: false });
    const contributing = s.documentProfile(join(world, "_meta", "CONTRIBUTING.md"));
    expect(contributing).toMatchObject({ match: "matched", label: "Meta", canon: false });
    expect(s.documentProfile(join(world, "the-mark.md"))).toMatchObject({
      label: "Ritual",
      canon: true,
    });
    const kinds = s.profiles().kinds.map((k) => [k.kind, k.label, k.canon]);
    expect(kinds).toContainEqual(["meta", "Meta", false]);
    expect(kinds).toContainEqual(["ritual", "Ritual", true]);
    // The _relations.json beside them is still not a kind, and not broken.
    expect(s.profiles().broken).toEqual([]);
  });

  test("a canon that is not a boolean breaks the kind; its documents stay canon", () => {
    profile(world, "meta.json", { kind: "meta", canon: "no" });
    const p = s.profiles();
    expect(p.broken).toEqual([
      expect.objectContaining({ kind: "meta", reason: '"canon" must be true or false, not "no"' }),
    ]);
    expect(s.documentProfile(join(world, "_meta", "CONTRIBUTING.md"))).toMatchObject({
      match: "broken",
      canon: true,
    });
  });

  test("graph nodes carry their kind's label and canon; kinds list both", () => {
    profile(world, "meta.json", { kind: "meta", label: "Meta", canon: false });
    const g = s.linkGraph();
    const by = Object.fromEntries(g.nodes.map((n) => [n.shown, [n.kind, n.label, n.canon]]));
    expect(by["_meta/CONTRIBUTING.md"]).toEqual(["meta", "Meta", false]);
    expect(by["the-mark.md"]).toEqual(["ritual", "Ritual", true]);
    expect(by["locations/the-glade.md"]).toEqual(["location", "Wild place", true]);
    expect(by["00-overview.md"]).toEqual([null, null, true]);
    expect(g.kinds).toContainEqual({ kind: "meta", label: "Meta", canon: false, count: 1 });
    // The kind is labelled by its root-most profile; the nested relabel stays on
    // its own documents, whichever document the graph met first.
    expect(g.kinds).toContainEqual({ kind: "location", label: "Location", canon: true, count: 3 });
    // Hiding the kind in the daemon drops its document before the cut.
    const shown = s.linkGraph({ kind: ["ritual", "location"], kindless: true });
    expect(shown.nodes.map((n) => n.kind)).not.toContain("meta");
    expect(shown.nodes.map((n) => n.kind)).toContain(null);
  });

  test("with no profiles every document is canon", () => {
    rmSync(join(world, "_meta", "profiles"), { recursive: true });
    rmSync(join(world, "locations", "_meta"), { recursive: true });
    expect(s.documentProfile(join(world, "_meta", "CONTRIBUTING.md")).canon).toBe(true);
  });
});

describe("after review", () => {
  /** Pick up documents written after the session listed the world. */
  const rescan = () => {
    for (const e of s.view().context) s.rescan(e.id);
  };

  test("frontmatter that does not parse is counted as unparsed, with why, not as untyped", () => {
    writeFileSync(join(world, "broken-yaml.md"), "---\ntype: [location\ntitle: x\n---\n# Broken\n");
    writeFileSync(join(world, "twice.md"), "---\ntype: location\ntype: ritual\n---\n# Twice\n");
    // Not frontmatter at all by the kit's rule (its first line is not a key): untyped.
    writeFileSync(join(world, "a-list.md"), "---\n- one\n- two\n---\n# A list\n");
    writeFileSync(join(world, "empty-block.md"), "---\n---\n# Empty\n");
    rescan();
    const p = s.profiles();
    expect(p.untyped).toBe(3); // 00-overview.md, the list and the empty block
    expect(p.unparsed.count).toBe(2);
    expect(p.unparsed.documents.map((d) => [d.shown, d.reason])).toEqual([
      ["broken-yaml.md", expect.stringMatching(/^does not parse as YAML: Flow sequence/)],
      ["twice.md", "does not parse as YAML: Map keys must be unique"],
    ]);
    const one = s.documentProfile(join(world, "broken-yaml.md"));
    expect(one).toMatchObject({ type: null, kind: null, match: "none", warnings: [] });
    expect(one.reason).toMatch(/^its frontmatter does not parse as YAML: /);
  });

  test("when nothing matches, profile says why", () => {
    expect(s.documentProfile(join(world, "00-overview.md")).reason).toBe(
      "it has no frontmatter, so no type",
    );
    writeFileSync(join(world, "no-type.md"), "---\ntitle: No type\n---\n# No type\n");
    rescan();
    expect(s.documentProfile(join(world, "no-type.md")).reason).toBe("its frontmatter has no type");
    expect(s.documentProfile(join(world, "_meta", "CONTRIBUTING.md")).reason).toBe(
      "no _meta/profiles/meta.json between its folder and the root of its context entry",
    );
  });

  test("one document lists at most 20 warnings; more counts the rest, and count is the whole", () => {
    const required = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    profile(world, "ledger.json", { kind: "ledger", label: "Ledger", required });
    writeFileSync(join(world, "ledger.md"), "---\ntype: ledger\n---\n# Ledger\n");
    rescan();
    const r = s.profileCheck();
    expect(r.warnings.count).toBe(3 + 25);
    expect(r.count).toBe(3 + 25);
    expect(r.warnings.documents).toBe(4);
    const mine = r.warnings.list.filter((w) => w.shown === "ledger.md");
    expect(mine).toHaveLength(20);
    expect(mine.at(-1)?.field).toBe("f19");
    expect(r.warnings.more).toEqual([
      { source: join(world, "ledger.md"), shown: "ledger.md", count: 5 },
    ]);
    // `profile --doc` on the one document still lists every warning.
    expect(s.documentProfile(join(world, "ledger.md")).warnings).toHaveLength(25);
  });

  test("a profile file is shown from the entry of the document that reached it", () => {
    const sub = join(world, "east");
    profile(sub, "region.json", { kind: "region", label: "Region", required: ["name"] });
    doc(join(sub, "the-east.md"), { type: "region" });
    // Two listed entries, the outer one first: the profile under `east/` is
    // inside both roots, and it is the inner document's.
    const two = inContext(join(root, "sessions-4"), join(world, "the-cave.md"));
    two.addContext(join(sub, "the-east.md"));
    expect(two.profiles().kinds.find((k) => k.kind === "region")?.shown).toBe(
      "_meta/profiles/region.json",
    );
    expect(two.profileCheck().warnings.list.find((w) => w.kind === "region")?.profile).toBe(
      "_meta/profiles/region.json",
    );
    expect(two.documentProfile(join(sub, "the-east.md")).sourceShown).toBe(
      "_meta/profiles/region.json",
    );
  });
});

describe("shared fields: allOf with whole-file $ref", () => {
  const BIBLE_DOC = {
    $comment: "The fields every bible document carries.",
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, description: "The display name." },
      description: { type: "string", minLength: 1, description: "One sentence." },
      status: { enum: ["draft", "stable", "deprecated"], description: "Where it stands." },
    },
    required: ["title", "description", "status"],
  };
  const kindUsing = (kind: string, label: string, ref = "_bible-doc.json", extra = {}) => ({
    kind,
    label,
    allOf: [{ $ref: ref }],
    properties: { type: { const: kind } },
    required: ["type"],
    ...extra,
  });
  const reader = () => (s as unknown as { profileReader: ProfileReader }).profileReader;
  const cave = () => join(world, "the-cave.md");
  const mark = () => join(world, "the-mark.md");

  beforeEach(() => {
    profile(world, "_bible-doc.json", BIBLE_DOC);
    profile(world, "location.json", kindUsing("location", "Location"));
    profile(world, "ritual.json", kindUsing("ritual", "Ritual"));
  });

  test("one shared file used by two kinds: each warning names the file whose rule it is", () => {
    const shared = join(world, "_meta", "profiles", "_bible-doc.json");
    expect(s.documentProfile(cave())).toMatchObject({
      match: "matched",
      refs: ["_meta/profiles/_bible-doc.json"],
      warnings: [
        {
          field: "status",
          rule: "enum",
          file: shared,
          fileShown: "_meta/profiles/_bible-doc.json",
        },
      ],
    });
    expect(s.documentProfile(mark()).warnings.map((w) => [w.field, w.rule, w.fileShown])).toEqual([
      ["description", "required", "_meta/profiles/_bible-doc.json"],
      ["status", "required", "_meta/profiles/_bible-doc.json"],
    ]);
    // The effective fields, each with the file its rule is written in; nothing merged.
    expect(
      s.documentProfile(cave()).fields?.map((f) => [f.field, f.required, f.fileShown]),
    ).toEqual([
      ["type", true, "_meta/profiles/location.json"],
      ["title", true, "_meta/profiles/_bible-doc.json"],
      ["description", true, "_meta/profiles/_bible-doc.json"],
      ["status", true, "_meta/profiles/_bible-doc.json"],
    ]);
    const kinds = s.profiles().kinds.filter((k) => k.shown.startsWith("_meta/"));
    expect(kinds.map((k) => [k.kind, k.refs])).toEqual([
      ["location", ["_meta/profiles/_bible-doc.json"]],
      ["ritual", ["_meta/profiles/_bible-doc.json"]],
    ]);
    // The shared file is not a kind.
    expect(s.profiles().kinds.map((k) => k.kind)).not.toContain("_bible-doc");
    const check = s.profileCheck().warnings.list.find((w) => w.shown === "the-cave.md");
    expect(check).toMatchObject({
      profile: "_meta/profiles/location.json",
      fileShown: "_meta/profiles/_bible-doc.json",
    });
  });

  test("a change to the shared file re-checks every kind that uses it, parsing it once", () => {
    s.profileCheck();
    const before = reader().parsed;
    profile(world, "_bible-doc.json", { ...BIBLE_DOC, required: ["owner"] });
    const r = s.profileCheck();
    expect(reader().parsed).toBe(before + 1);
    const owners = r.warnings.list.filter((w) => w.field === "owner").map((w) => w.shown);
    expect(owners).toEqual(["locations/the-ritual.md", "the-cave.md", "the-mark.md"]);
  });

  test("the same field failing the same rule in two files is said once, from the kind's own file", () => {
    profile(
      world,
      "ritual.json",
      kindUsing("ritual", "Ritual", "_bible-doc.json", { required: ["type", "status"] }),
    );
    const ws = s.documentProfile(mark()).warnings;
    expect(ws.filter((w) => w.field === "status")).toEqual([
      expect.objectContaining({ rule: "required", fileShown: "_meta/profiles/ritual.json" }),
    ]);
  });

  test("a cycle of references makes the kind broken, with the chain", () => {
    profile(world, "_a.json", { allOf: [{ $ref: "_b.json" }] });
    profile(world, "_b.json", { allOf: [{ $ref: "_a.json" }] });
    profile(world, "location.json", kindUsing("location", "Location", "_a.json"));
    expect(s.documentProfile(cave())).toMatchObject({
      match: "broken",
      reason: "its references go round in a circle: location.json → _a.json → _b.json → _a.json",
    });
    // The other kind is untouched.
    expect(s.documentProfile(mark()).match).toBe("matched");
  });

  test("a chain deeper than the cap makes the kind broken", () => {
    for (let i = 0; i < 10; i++)
      profile(world, `_d${i}.json`, i < 9 ? { allOf: [{ $ref: `_d${i + 1}.json` }] } : {});
    profile(world, "location.json", kindUsing("location", "Location", "_d0.json"));
    expect(s.documentProfile(cave()).reason).toMatch(
      /^its references go deeper than 8 files: location\.json → _d0\.json → /,
    );
  });

  test("a missing or broken shared file makes the kind broken, naming the file", () => {
    profile(world, "location.json", kindUsing("location", "Location", "_gone.json"));
    expect(s.documentProfile(cave()).reason).toBe(
      "refers to _gone.json, which is not there (location.json → _gone.json)",
    );
    profile(world, "location.json", kindUsing("location", "Location"));
    profile(world, "_bible-doc.json", "{ nope");
    expect(s.documentProfile(cave()).reason).toMatch(
      /^refers to _bible-doc\.json, which has an error: does not parse as JSON: .* \(location\.json → _bible-doc\.json\)$/,
    );
  });

  test("a broken shared file is one broken file to fix; each kind using it points there", () => {
    profile(world, "_bible-doc.json", '{"required":["title",]}');
    const check = s.profileCheck();
    // Two kinds use it, but it is one file to fix.
    expect(check.broken.count).toBe(1);
    expect(check.broken.files.map((f) => [f.shown, f.kind, f.through ?? null])).toEqual([
      ["_meta/profiles/_bible-doc.json", null, null],
      ["_meta/profiles/location.json", "location", "_meta/profiles/_bible-doc.json"],
      ["_meta/profiles/ritual.json", "ritual", "_meta/profiles/_bible-doc.json"],
    ]);
    const [shared, location] = check.broken.files;
    expect(shared?.reason).toMatch(/^does not parse as JSON: line 1, column 21: /);
    expect(shared?.fix).toBe(
      "fix _meta/profiles/_bible-doc.json: until it is fixed, every kind that refers to it matches no document",
    );
    expect(location?.fix).toMatch(
      /^fix _meta\/profiles\/_bible-doc\.json, which this kind refers to: /,
    );
    // A document of the kind names the shared file as the one to fix, as the check does.
    expect(s.documentProfile(cave())).toMatchObject({
      match: "broken",
      sourceShown: "_meta/profiles/location.json",
      through: join(world, "_meta", "profiles", "_bible-doc.json"),
      throughShown: "_meta/profiles/_bible-doc.json",
    });
    const p = s.profiles();
    expect(p.brokenFiles).toBe(1);
    // The shared file leaves both kinds' documents unchecked: the cave, the mark and the ritual.
    expect(p.broken.find((f) => f.kind === null)?.documents).toBe(3);
    const doctor = s.checkup().filter((f) => f.kind === "profiles.broken");
    expect(doctor.map((f) => f.count)).toEqual([1]);
    expect(summary(doctor)).toBe(
      "Startup check: 1 broken profile file. Run `doctor` for the detail.",
    );
  });

  test("a missing reference written in a shared file is that file's to fix", () => {
    profile(world, "_bible-doc.json", { ...BIBLE_DOC, allOf: [{ $ref: "_gone.json" }] });
    const check = s.profileCheck();
    expect(check.broken.count).toBe(1);
    expect(check.broken.files[0]).toMatchObject({
      shown: "_meta/profiles/_bible-doc.json",
      kind: null,
      reason: "refers to _gone.json, which is not there",
    });
    expect(s.documentProfile(cave()).reason).toBe(
      "refers to _gone.json, which is not there (location.json → _bible-doc.json → _gone.json)",
    );
  });

  test("a reference may name only a shared file", () => {
    profile(world, "location.json", kindUsing("location", "Location", "ritual.json"));
    expect(s.documentProfile(cave()).reason).toBe(
      "allOf[0]: refers to ritual.json, which is a kind; shared files start with _",
    );
  });

  test("a shared file's own kind is a note, not a problem", () => {
    profile(world, "_bible-doc.json", { ...BIBLE_DOC, kind: "bible-doc" });
    const note = {
      path: join(world, "_meta", "profiles", "_bible-doc.json"),
      shown: "_meta/profiles/_bible-doc.json",
      note: 'has "kind": "bible-doc"; a shared file\'s kind is ignored (a kind is a file whose name has no leading _)',
    };
    expect(s.profiles().notes).toEqual([note]);
    expect(s.profileCheck().notes).toEqual([note]);
    expect(s.profileCheck().broken.count).toBe(0);
    expect(s.documentProfile(cave()).match).toBe("matched");
  });

  test("different rules on one field are both said, each from its own file", () => {
    profile(
      world,
      "location.json",
      kindUsing("location", "Location", "_bible-doc.json", {
        properties: { type: { const: "location" }, status: { enum: ["canon", "draft"] } },
      }),
    );
    const ws = s.documentProfile(cave()).warnings.filter((w) => w.field === "status");
    expect(ws.map((w) => [w.rule, w.fileShown])).toEqual([
      ["enum", "_meta/profiles/location.json"],
      ["enum", "_meta/profiles/_bible-doc.json"],
    ]);
  });

  test("a reference may not leave the context entry", () => {
    // From the world's root profile, to a file beside the world.
    profile(root, "_outside.json", { required: ["x"] });
    profile(
      world,
      "location.json",
      kindUsing("location", "Location", "../../../_meta/profiles/_outside.json"),
    );
    expect(s.documentProfile(cave()).reason).toBe(
      'refers to "../../../_meta/profiles/_outside.json", which is outside the folder the human opened',
    );
    // A nested folder's profile reaching up to the world's shared file: fine
    // when the world is the entry, outside it when only the nested folder is.
    profile(
      join(world, "locations"),
      "location.json",
      kindUsing("location", "Wild place", "../../../_meta/profiles/_bible-doc.json"),
    );
    expect(s.documentProfile(join(world, "locations", "the-glade.md")).match).toBe("matched");
    const only = inContext(join(root, "sessions-5"), join(world, "locations"));
    expect(only.documentProfile(join(world, "locations", "the-glade.md"))).toMatchObject({
      match: "broken",
      reason: expect.stringContaining("outside the folder the human opened"),
    });
  });

  test("a # fragment, a URL, an inline schema or a non-JSON reference is refused, with why", () => {
    profile(
      world,
      "location.json",
      kindUsing("location", "Location", "_bible-doc.json#/properties"),
    );
    expect(s.documentProfile(cave()).reason).toBe(
      'allOf[0]: "$ref" "_bible-doc.json#/properties" points inside a file; only whole files are read, so drop the "#…" part',
    );
  });
});

describe("JSON documents (kit-json-documents)", () => {
  test("profile files are JSON documents in the context, and never counted as documents to check", () => {
    // The world holds seven markdown documents and six JSON files (the
    // profiles, the reserved `_relations.json` among them).
    const g = s.linkGraph();
    expect(g.total.nodes).toBe(7);
    const p = s.profiles();
    expect(p.documents).toBe(7);
    expect(p.untyped).toBe(1); // 00-overview.md, which has no frontmatter
    rmSync(join(world, "00-overview.md"));
    for (const e of s.view().context) s.rescan(e.id);
    expect(s.profiles()).toMatchObject({ documents: 6, untyped: 0 });
  });

  test("profile --doc on a JSON file says it is not a frontmatter document", () => {
    const file = join(world, "_meta", "profiles", "location.json");
    expect(s.documentProfile(file)).toEqual({
      doc: null,
      path: file,
      shown: "_meta/profiles/location.json",
      type: null,
      kind: null,
      canon: true,
      match: "none",
      reason: "a JSON file, not a frontmatter document: profiles describe markdown documents",
      warnings: [],
    });
  });

  test("a profile file that does not parse says where, by line and column", () => {
    profile(world, "ritual.json", '{\n  "kind": "ritual",\n  "label": "Ritual",\n}\n');
    expect(s.documentProfile(join(world, "the-mark.md")).reason).toMatch(
      'does not parse as JSON: line 3, column 20: a comma before "}" is not allowed in JSON',
    );
    // A shared file's too, named through the kind that refers to it.
    profile(world, "_shared.json", '{ "required": ["x"]\n  "properties": {} }');
    profile(world, "ritual.json", { kind: "ritual", allOf: [{ $ref: "_shared.json" }] });
    expect(s.documentProfile(join(world, "the-mark.md")).reason).toMatch(
      /^refers to _shared\.json, which has an error: does not parse as JSON: line 1, column 20: a "," is missing here, after the property before it \(ritual\.json → _shared\.json\)$/,
    );
  });
});

describe("profile files shown apart when two would read the same", () => {
  test("two listed entries in different folders lead each file with its folder", () => {
    const east = join(root, "east");
    const west = join(root, "west");
    for (const side of [east, west]) {
      profile(side, "location.json", { kind: "location", required: ["region"] });
      doc(join(side, "place.md"), { type: "location" });
    }
    const two = inContext(join(root, "sessions-6"), join(east, "place.md"));
    two.addContext(join(west, "place.md"));
    expect(two.profiles().kinds.map((k) => k.shown)).toEqual([
      "east/_meta/profiles/location.json",
      "west/_meta/profiles/location.json",
    ]);
    expect(two.profileCheck().warnings.list.map((w) => [w.profile, w.fileShown])).toEqual([
      ["east/_meta/profiles/location.json", "east/_meta/profiles/location.json"],
      ["west/_meta/profiles/location.json", "west/_meta/profiles/location.json"],
    ]);
  });
});

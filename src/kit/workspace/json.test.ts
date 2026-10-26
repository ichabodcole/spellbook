// JSON documents in the session (the kit-json-documents item): shown and opened
// like any document, versioned and compared, kept `.json` through new files and
// renames, refused at Save when they do not parse, and never read as markdown
// by the link layer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { WorkspaceSession } from "./session";
import { inContext, refusal, seedDocs, tempRoot } from "./testing";

let root: string;
let sessions: string;
let docs: string;
let profiles: string;
let profile: string;

const VALID = '{\n  "kind": "location",\n  "required": ["title"]\n}\n';
const BROKEN = '{\n  "kind": "location"\n  "required": ["title"]\n}\n';

beforeEach(() => {
  root = tempRoot("workspace-json");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
  profiles = join(docs, "_meta", "profiles");
  mkdirSync(profiles, { recursive: true });
  profile = join(profiles, "location.json");
  writeFileSync(profile, VALID);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const session = (): WorkspaceSession => inContext(sessions, docs);

describe("a JSON document is a document", () => {
  test("it shows in the tree and opens, its versions are .json files", () => {
    const s = session();
    const entry = s.view().context[0];
    expect(JSON.stringify(entry?.nodes)).toContain("_meta/profiles/location.json");
    const { slug } = s.openPath(profile);
    const v2 = s.newVersion({ doc: slug, by: "agent" });
    expect(v2.version.path.endsWith(".json")).toBe(true);
    expect(readFileSync(v2.version.path, "utf8")).toBe(VALID);
  });

  test("versions compare and merge as documents do", () => {
    const s = session();
    const { slug } = s.openPath(profile);
    const v2 = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(v2.version.path, VALID.replace('"title"', '"title", "status"'));
    const d = s.compare({ doc: slug, against: 2 });
    expect(d.diff.hunks).toHaveLength(1);
    const r = s.merge({ doc: slug, against: 2, hunks: [1], json: "refuse" });
    expect(r.text).toContain('"status"');
    s.save(slug);
    expect(readFileSync(profile, "utf8")).toContain('"status"');
  });
});

describe("Save refuses JSON that does not parse", () => {
  test("the file on disk is unchanged, the version keeps the text, the refusal says where", () => {
    const s = session();
    const { slug } = s.openPath(profile);
    s.edit(slug, 1, BROKEN);
    const e = refusal(() => s.save(slug));
    expect(e.status).toBe(409);
    expect(e.message).toContain("location.json is not valid JSON");
    expect(e.message).toMatch(/line 2, column 21: /);
    expect(readFileSync(profile, "utf8")).toBe(VALID);
    expect(s.readVersion(slug, 1).text).toBe(BROKEN);
    expect(s.view().docs[0]?.dirty).toBe(true);
    // Fixed, it saves.
    s.edit(slug, 1, VALID.replace("location", "place"));
    s.save(slug);
    expect(readFileSync(profile, "utf8")).toContain('"place"');
  });

  test("markdown is never checked", () => {
    const s = session();
    const { slug } = s.openPath(join(docs, "solo.md"));
    s.edit(slug, 1, "{ not json\n");
    s.save(slug);
    expect(readFileSync(join(docs, "solo.md"), "utf8")).toBe("{ not json\n");
  });

  test("the agent's activate and merge refuse it, saying why; the human's activate does not", () => {
    const s = session();
    const { slug } = s.openPath(profile);
    const v2 = s.newVersion({ doc: slug, by: "agent" });
    writeFileSync(v2.version.path, BROKEN);
    expect(s.jsonProblemOf(slug, 2)).toMatchObject({ line: 2, column: 21 });
    const a = refusal(() => s.activate({ doc: slug, version: 2, json: "refuse" }));
    expect(a.message).toMatch(
      /v2 of location\.json is not valid JSON, so it was not activated: line 2, column 21/,
    );
    expect(s.view().docs[0]?.active).toBe(1);
    const m = refusal(() => s.merge({ doc: slug, against: 2, hunks: [1], json: "refuse" }));
    expect(m.message).toBe(
      'taking change 1 from v2 into v1 of location.json would leave invalid JSON (line 2, column 21: a "," is missing here, after the property before it, in the merged text): fix v2, or take fewer changes. Nothing was merged.',
    );
    expect(s.readVersion(slug, 1).text).toBe(VALID);
    // The human may activate it, to fix it there.
    s.activate({ doc: slug, version: 2 });
    expect(s.view().docs[0]?.active).toBe(2);
  });
});

describe("new files and renames keep .json", () => {
  test("a new document named .json is .json, and starts as {} so it saves", () => {
    const s = session();
    const { path } = s.createDoc(profiles, "character.json");
    expect(basename(path)).toBe("character.json");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    const plain = s.createDoc(profiles, "notes");
    expect(basename(plain.path)).toBe("notes.md");
    expect(readFileSync(plain.path, "utf8")).toBe("");
  });

  test("a rename without an extension keeps .json", () => {
    const s = session();
    const r = s.rename(profile, "place");
    expect(basename(r.path)).toBe("place.json");
    const again = s.rename(r.path, "site.json");
    expect(basename(again.path)).toBe("site.json");
  });

  test("an empty document renamed to .json starts as {}, and its open copy follows", () => {
    const s = session();
    // The sidebar's New document: Untitled.md, opened, then named.
    const { path } = s.createDoc(profiles);
    const { slug } = s.openPath(path);
    const r = s.rename(path, "fresh.json");
    expect(basename(r.path)).toBe("fresh.json");
    expect(readFileSync(r.path, "utf8")).toBe("{}\n");
    expect(r.seeded).toEqual({ doc: slug, version: 1, text: "{}\n" });
    expect(s.readVersion(slug, 1).text).toBe("{}\n");
    expect(s.view().docs.find((d) => d.slug === slug)?.dirty).toBe(false);
    s.save(slug);
  });

  test("a rename to .json leaves a file with text, and a typed-in copy, alone", () => {
    const s = session();
    const typed = s.createDoc(profiles, "typed.md");
    const { slug } = s.openPath(typed.path);
    s.edit(slug, 1, '{"a": 1}');
    const r = s.rename(typed.path, "typed.json");
    expect(r.seeded).toBeUndefined();
    expect(readFileSync(r.path, "utf8")).toBe("");
    expect(s.readVersion(slug, 1).text).toBe('{"a": 1}');
    const full = join(docs, "sibling.md");
    expect(readFileSync(s.rename(full, "sibling.json").path, "utf8")).toBe("# Sibling\n");
  });
});

describe("the link layer never reads JSON as markdown", () => {
  // A JSON file whose text LOOKS like markdown with links: if anything ran
  // the markdown link extraction or frontmatter over it, these would show.
  const LOOKS_LINKED =
    '{\n  "description": "see [the glade](../../gone.md) and [[nowhere]]",\n  "title": "# Not a heading"\n}\n';

  beforeEach(() => {
    writeFileSync(profile, LOOKS_LINKED);
    // A markdown document that links to the profile.
    writeFileSync(join(docs, "solo.md"), "# Solo\n\n[profile](./_meta/profiles/location.json)\n");
  });

  test("the link check finds no dangling link in it, and no shared name", () => {
    const s = session();
    const c = s.linkCheck();
    expect(c.dangling.links.map((l) => l.source)).not.toContain(profile);
    expect(c.dangling.links.some((l) => l.raw.includes("gone.md"))).toBe(false);
  });

  test("it is not on the map, and the map holds no edge to it", () => {
    const s = session();
    const g = s.linkGraph();
    expect(g.nodes.map((n) => n.path)).not.toContain(profile);
    expect(g.edges.some((e) => e.to === profile || e.from === profile)).toBe(false);
    expect(g.nodes.length).toBeGreaterThan(0);
  });

  test("it is no link target and gives no relations; its links are no backlinks", () => {
    const s = session();
    const { slug } = s.openPath(join(docs, "sibling.md"));
    const t = s.linkTargets(slug);
    expect(t.targets.map((x) => x.path)).not.toContain(profile);
    const b = s.backlinks(join(docs, "solo.md"));
    expect(b.backlinks.map((x) => x.source)).not.toContain(profile);
    // A markdown link TO the JSON file is a backlink of it, as the skills say.
    const to = s.backlinks(profile);
    expect(to.backlinks.map((x) => x.source)).toEqual([join(docs, "solo.md")]);
  });

  test("search still finds it by name and by text, which reads no markdown", () => {
    const s = session();
    const byName = s.search({ query: "location" });
    expect(byName.results.map((r) => r.path)).toContain(profile);
    const byText = s.search({ query: "Not a heading" });
    expect(byText.results.map((r) => r.path)).toContain(profile);
  });
});

// The profile module on its own: reading a profile file (usable or broken, and
// why), each rule of the JSON Schema subset, the folders a document looks in,
// and the per-file cache.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkFields,
  fixFor,
  kindOfFile,
  type Profile,
  ProfileReader,
  type ProfileWarning,
  parseProfile,
  profileFolders,
  sameJson,
} from "./profiles";
import { tempRoot } from "./testing";

/** A profile as the Dreamwood bible writes one. */
const LOCATION = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  kind: "location",
  label: "Location",
  description: "A location bible: one canonical place.",
  type: "object",
  properties: {
    type: { const: "location", description: "The document's kind." },
    title: { type: "string", minLength: 1, description: "The display name." },
    description: { type: "string", minLength: 1, description: "One sentence." },
    status: { enum: ["draft", "stable", "deprecated"], description: "Where it stands." },
    operator_id: { type: "string" },
  },
  required: ["type", "title", "description", "status"],
};

const usable = (schema: unknown, kind = "location"): Profile => {
  const r = parseProfile(JSON.stringify(schema), kind);
  if (!r.profile) throw new Error(`broken: ${r.broken}`);
  return r.profile;
};

const broken = (text: string, kind = "location"): string => {
  const r = parseProfile(text, kind);
  if (r.profile) throw new Error("expected a broken profile");
  return r.broken;
};

describe("kindOfFile", () => {
  test("a .json file names its kind; a leading underscore or dot is not a kind", () => {
    expect(kindOfFile("location.json")).toBe("location");
    expect(kindOfFile("Location.JSON")).toBe("Location");
    expect(kindOfFile("_relations.json")).toBeNull();
    expect(kindOfFile("_world.json")).toBeNull();
    expect(kindOfFile(".location.json")).toBeNull();
    expect(kindOfFile("location.md")).toBeNull();
    expect(kindOfFile(".json")).toBeNull();
  });
});

describe("parseProfile", () => {
  test("a Dreamwood profile is usable: label, description, properties and required", () => {
    const p = usable(LOCATION);
    expect(p.kind).toBe("location");
    expect(p.label).toBe("Location");
    expect(p.description).toBe("A location bible: one canonical place.");
    expect(p.required).toEqual(["type", "title", "description", "status"]);
    expect(p.properties.title).toEqual({
      type: ["string"],
      minLength: 1,
      description: "The display name.",
    });
    expect(p.properties.type).toEqual({
      const: { value: "location" },
      description: "The document's kind.",
    });
  });

  test("the label defaults to the kind, and properties and required may be absent", () => {
    expect(usable({ kind: "location" })).toEqual({
      kind: "location",
      label: "location",
      canon: true,
      path: "",
      properties: {},
      required: [],
      shared: [],
      refs: [],
    });
  });

  test("canon: false marks a kind not canon; absent or true is canon", () => {
    expect(usable({ kind: "location", canon: false }).canon).toBe(false);
    expect(usable({ kind: "location", canon: true }).canon).toBe(true);
    expect(usable({ kind: "location" }).canon).toBe(true);
  });

  test("a canon that is not a boolean makes the file broken, with why", () => {
    expect(broken('{"kind": "location", "canon": "false"}')).toBe(
      '"canon" must be true or false, not "false"',
    );
    expect(broken('{"kind": "location", "canon": 0}')).toBe('"canon" must be true or false, not 0');
    expect(broken('{"kind": "location", "canon": null}')).toBe(
      '"canon" must be true or false, not null',
    );
  });

  test("unknown keywords are ignored, not errors", () => {
    const p = usable({
      kind: "location",
      additionalProperties: false,
      sections: ["Overview"],
      checkWith: ["cosmology"],
      properties: { title: { type: "string", pattern: "^[A-Z]", maxLength: 3, format: "x" } },
    });
    expect(p.properties.title).toEqual({ type: ["string"] });
  });

  test("a property schema of true takes anything, and false forbids the field", () => {
    const p = usable({ kind: "location", properties: { any: true, never: false } });
    expect(p.properties.any).toEqual({});
    expect(p.properties.never).toBe(false);
  });

  test("a list of types is kept", () => {
    expect(
      usable({ kind: "location", properties: { n: { type: ["integer", "null"] } } }).properties.n,
    ).toEqual({ type: ["integer", "null"] });
  });

  test("each way a file is not usable says why", () => {
    expect(broken("{ not json")).toMatch(/^does not parse as JSON: /);
    expect(broken("[]")).toBe("is not a JSON object");
    expect(broken("{}")).toBe('has no "kind"; it should say "kind": "location"');
    expect(broken('{"kind": "  "}')).toMatch(/^has no "kind"/);
    expect(broken('{"kind": "place"}')).toBe(
      'says "kind": "place" but the file is named location.json; they must match',
    );
    expect(broken('{"kind": "location", "label": 3}')).toBe('"label" must be a string');
    expect(broken('{"kind": "location", "type": "array"}')).toMatch(/^"type" at the top/);
    expect(broken('{"kind": "location", "properties": []}')).toBe('"properties" must be an object');
    expect(broken('{"kind": "location", "properties": {"a": 3}}')).toBe(
      "properties.a: must be an object (or true, or false)",
    );
    expect(broken('{"kind": "location", "properties": {"a": {"type": "strnig"}}}')).toBe(
      'properties.a: "type" "strnig" is not one of string, number, integer, boolean, array, object, null',
    );
    expect(broken('{"kind": "location", "properties": {"a": {"type": []}}}')).toBe(
      'properties.a: "type" lists no type',
    );
    expect(broken('{"kind": "location", "properties": {"a": {"enum": []}}}')).toBe(
      'properties.a: "enum" must list at least one value',
    );
    expect(broken('{"kind": "location", "properties": {"a": {"enum": "x"}}}')).toBe(
      'properties.a: "enum" must list at least one value',
    );
    expect(broken('{"kind": "location", "properties": {"a": {"minLength": -1}}}')).toBe(
      'properties.a: "minLength" must be a whole number from 0',
    );
    expect(broken('{"kind": "location", "properties": {"a": {"minLength": 1.5}}}')).toBe(
      'properties.a: "minLength" must be a whole number from 0',
    );
    expect(broken('{"kind": "location", "required": "title"}')).toBe(
      '"required" must be a list of field names',
    );
    expect(broken('{"kind": "location", "required": [1]}')).toBe(
      '"required" must be a list of field names',
    );
  });
});

describe("checkFields", () => {
  const p = usable(LOCATION);
  const good = {
    type: "location",
    title: "The Glade",
    description: "The safe center of the wood.",
    status: "stable",
    operator_id: "0Qgs",
  };

  test("a document that fits its profile has no warnings, and fields it does not name are not checked", () => {
    expect(checkFields(p, good)).toEqual([]);
    expect(checkFields(p, { ...good, tags: ["x"], extra: 3 })).toEqual([]);
  });

  test("required: a missing field is a warning carrying the field's description", () => {
    const { description: _gone, ...rest } = good;
    expect(checkFields(p, rest)).toEqual([
      {
        field: "description",
        rule: "required",
        message: "description is missing; the Location profile requires it",
        description: "One sentence.",
      },
    ]);
  });

  test("required: a field listed in required but not in properties is still required", () => {
    const q = usable({ kind: "location", required: ["owner"] });
    expect(checkFields(q, {})).toEqual([
      {
        field: "owner",
        rule: "required",
        message: "owner is missing; the location profile requires it",
      },
    ]);
  });

  test("enum: a value outside the list names the list", () => {
    expect(checkFields(p, { ...good, status: "final" })).toEqual([
      {
        field: "status",
        rule: "enum",
        message: 'status is "final", which is not one of draft, stable, deprecated',
        expected: ["draft", "stable", "deprecated"],
        description: "Where it stands.",
      },
    ]);
  });

  test("const: a value other than the constant", () => {
    expect(checkFields(p, { ...good, type: "place" })).toEqual([
      {
        field: "type",
        rule: "const",
        message: 'type is "place"; the Location profile expects "location"',
        expected: "location",
        description: "The document's kind.",
      },
    ]);
  });

  test("type: each JSON type, and a wrong type is not also checked for its value", () => {
    const q = usable(
      {
        kind: "k",
        label: "K",
        properties: {
          s: { type: "string", minLength: 3 },
          n: { type: "number" },
          i: { type: "integer" },
          b: { type: "boolean" },
          a: { type: "array" },
          o: { type: "object" },
          z: { type: "null" },
          e: { type: ["string", "null"], enum: ["x"] },
        },
      },
      "k",
    );
    expect(
      checkFields(q, { s: "abc", n: 1.5, i: 2, b: false, a: [], o: {}, z: null, e: null }),
    ).toEqual([expect.objectContaining({ field: "e", rule: "enum" })]);
    const wrong = checkFields(q, { s: 3, n: "1", i: 1.5, b: "yes", a: {}, o: [], z: 0, e: 4 });
    expect(wrong.map((w) => [w.field, w.rule])).toEqual([
      ["s", "type"],
      ["n", "type"],
      ["i", "type"],
      ["b", "type"],
      ["a", "type"],
      ["o", "type"],
      ["z", "type"],
      ["e", "type"],
    ]);
    expect(wrong[0]?.message).toBe("s should be a string, and it is a whole number");
    expect(wrong[0]?.expected).toEqual(["string"]);
    expect(wrong[2]?.message).toBe("i should be a whole number, and it is a number");
    expect(wrong[3]?.message).toBe("b should be true or false, and it is a string");
    expect(wrong[7]?.message).toBe("e should be a string or empty, and it is a whole number");
  });

  test("type: an empty value (`status:` with nothing after it) is null, said as empty", () => {
    expect(checkFields(p, { ...good, title: null })).toEqual([
      expect.objectContaining({
        field: "title",
        rule: "type",
        message: "title should be a string, and it is empty",
      }),
    ]);
  });

  test("minLength: counts characters, not bytes, and only of strings", () => {
    expect(checkFields(p, { ...good, title: "" })).toEqual([
      {
        field: "title",
        rule: "minLength",
        message: "title is empty; it needs at least 1 character",
        expected: 1,
        description: "The display name.",
      },
    ]);
    const q = usable({ kind: "k", properties: { t: { minLength: 3 } } }, "k");
    expect(checkFields(q, { t: "é🌲" })).toEqual([
      expect.objectContaining({ message: "t has 2 characters; it needs at least 3" }),
    ]);
    expect(checkFields(q, { t: "a🌲b" })).toEqual([]);
    expect(checkFields(q, { t: 7 })).toEqual([]);
  });

  test("forbidden: a field whose schema is false", () => {
    const q = usable({ kind: "k", label: "K", properties: { draft: false } }, "k");
    expect(checkFields(q, { draft: true })).toEqual([
      {
        field: "draft",
        rule: "forbidden",
        message: "draft is set; the K profile does not allow it",
      },
    ]);
    expect(checkFields(q, {})).toEqual([]);
  });

  test("each warning has a fix in words", () => {
    const { description: _gone, ...rest } = good;
    const all = checkFields(p, { ...rest, status: "final", type: "place", title: "" });
    expect(all.map(fixFor)).toEqual([
      "add `description` to the frontmatter (One sentence.)",
      'set `type` to "location"',
      "give `title` at least 1 character",
      "set `status` to one of draft, stable, deprecated",
    ]);
    expect(fixFor({ field: "n", rule: "type", message: "", expected: ["integer", "null"] })).toBe(
      "make `n` a whole number or empty",
    );
    expect(fixFor({ field: "d", rule: "forbidden", message: "" })).toBe("remove `d`");
  });
});

describe("profileFolders", () => {
  test("the document's folder first, then each parent up to the root, never above", () => {
    expect(profileFolders("/w/bible/locations/east", "/w/bible")).toEqual([
      "/w/bible/locations/east",
      "/w/bible/locations",
      "/w/bible",
    ]);
    expect(profileFolders("/w/bible", "/w/bible")).toEqual(["/w/bible"]);
  });

  test("a folder outside the root, or a sibling sharing its prefix, looks nowhere", () => {
    expect(profileFolders("/w", "/w/bible")).toEqual([]);
    expect(profileFolders("/w/bible-two/x", "/w/bible")).toEqual([]);
  });
});

describe("ProfileReader", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot("profiles");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (dir: string, name: string, body: unknown) => {
    mkdirSync(join(dir, "_meta", "profiles"), { recursive: true });
    writeFileSync(
      join(dir, "_meta", "profiles", name),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };

  test("the nearest folder with the kind's file wins, per kind, used whole", () => {
    write(root, "location.json", LOCATION);
    write(root, "ritual.json", { kind: "ritual" });
    const sub = join(root, "locations");
    write(sub, "location.json", { kind: "location", label: "Wild place" });
    const pass = new ProfileReader().pass();
    const near = pass.match(sub, root, "location");
    expect(near).toMatchObject({
      state: "matched",
      path: join(sub, "_meta/profiles/location.json"),
    });
    if (near.state === "matched") expect(near.profile.required).toEqual([]);
    expect(pass.match(sub, root, "ritual")).toMatchObject({
      state: "matched",
      path: join(root, "_meta/profiles/ritual.json"),
    });
    expect(pass.match(root, root, "location")).toMatchObject({
      path: join(root, "_meta/profiles/location.json"),
    });
    expect(pass.match(sub, root, "nothing")).toEqual({ state: "none" });
    expect(pass.match(sub, root, null)).toEqual({ state: "none" });
  });

  test("a broken nearest file wins the lookup and matches nothing; files starting _ are not read", () => {
    write(root, "location.json", LOCATION);
    write(root, "_relations.json", "{ not even json");
    const sub = join(root, "locations");
    write(sub, "location.json", "{ oops");
    const pass = new ProfileReader().pass();
    expect(pass.match(sub, root, "location")).toMatchObject({
      state: "broken",
      kind: "location",
      path: join(sub, "_meta/profiles/location.json"),
    });
    expect(pass.loads().map((l) => l.path)).toEqual([
      join(root, "_meta/profiles/location.json"),
      join(sub, "_meta/profiles/location.json"),
    ]);
  });

  test("a file is parsed once per change of its stamp, and pruned when no pass sees it", () => {
    write(root, "location.json", LOCATION);
    const reader = new ProfileReader();
    reader.pass().match(root, root, "location");
    reader.pass().match(root, root, "location");
    expect(reader.parsed).toBe(1);
    write(root, "location.json", { ...LOCATION, label: "Place" });
    const m = reader.pass().match(root, root, "location");
    expect(reader.parsed).toBe(2);
    expect(m.state === "matched" && m.profile.label).toBe("Place");
    reader.prune(new Set());
    reader.pass().match(root, root, "location");
    expect(reader.parsed).toBe(3);
  });

  test("⛔ an edit that keeps the size and puts the mtime back is still read", () => {
    const file = join(root, "_meta", "profiles", "location.json");
    write(root, "location.json", { ...LOCATION, label: "Aaaaa" });
    const then = new Date("2026-01-02T03:04:05Z");
    utimesSync(file, then, then);
    const before = statSync(file);
    const reader = new ProfileReader();
    reader.pass().match(root, root, "location");
    write(root, "location.json", { ...LOCATION, label: "Bbbbb" });
    utimesSync(file, before.atime, before.mtime);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    const m = reader.pass().match(root, root, "location");
    expect(m.state === "matched" && m.profile.label).toBe("Bbbbb");
  });
});

describe("review fixes", () => {
  test("NaN and the infinities are not finite numbers", () => {
    const q = usable(
      { kind: "k", properties: { n: { type: "number" }, i: { type: "integer" } } },
      "k",
    );
    expect(
      checkFields(q, { n: Number.NaN, i: Number.POSITIVE_INFINITY }).map((w) => w.message),
    ).toEqual([
      "n should be a number, and it is not a finite number",
      "i should be a whole number, and it is not a finite number",
    ]);
    expect(checkFields(q, { n: Number.NEGATIVE_INFINITY })[0]?.message).toBe(
      "n should be a number, and it is not a finite number",
    );
  });

  test("enum and const compare as JSON, whatever the key order", () => {
    expect(sameJson({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson({ a: 1 }, [1])).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    const q = usable(
      {
        kind: "k",
        properties: { at: { const: { x: 1, y: 2 } }, pick: { enum: [{ p: 1, q: 2 }, "plain"] } },
      },
      "k",
    );
    expect(checkFields(q, { at: { y: 2, x: 1 }, pick: { q: 2, p: 1 } })).toEqual([]);
    expect(checkFields(q, { at: { y: 2, x: 9 }, pick: "other" }).map((w) => w.rule)).toEqual([
      "const",
      "enum",
    ]);
  });

  test("a property named __proto__ is a field like any other", () => {
    const q = usable(
      JSON.parse(
        '{"kind":"k","properties":{"__proto__":{"type":"string"},"title":{"type":"string"}},"required":["__proto__"]}',
      ),
      "k",
    );
    expect(Object.keys(q.properties)).toEqual(["__proto__", "title"]);
    expect(Object.getPrototypeOf(q.properties)).toBeNull();
    expect(checkFields(q, {}).map((w) => [w.field, w.rule])).toEqual([["__proto__", "required"]]);
    expect(checkFields(q, JSON.parse('{"__proto__": 3}')).map((w) => [w.field, w.rule])).toEqual([
      ["__proto__", "type"],
    ]);
  });

  test("a long const or enum value is cut in a message, never in expected", () => {
    const long = "x".repeat(200);
    const values = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const q = usable({ kind: "k", properties: { c: { const: long }, e: { enum: values } } }, "k");
    const [c, e] = checkFields(q, { c: "y".repeat(500), e: "nope" });
    expect(c?.expected).toBe(long);
    expect(c?.message).toBe(`c is "${"y".repeat(78)}…; the k profile expects "${"x".repeat(78)}…`);
    expect(fixFor(c as ProfileWarning)).toBe(`set \`c\` to "${"x".repeat(78)}…`);
    expect(e?.expected).toEqual(values);
    expect(e?.message).toBe(
      `e is "nope", which is not one of ${values.slice(0, 12).join(", ")} (and 18 more)`,
    );
  });
});

describe("ProfileReader, after review", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot("profiles-review");
  });
  afterEach(() => {
    try {
      chmodSync(join(root, "_meta", "profiles", "location.json"), 0o644);
    } catch {
      /* not made */
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("parsed is read-only", () => {
    const reader = new ProfileReader();
    expect(() => {
      (reader as unknown as { parsed: number }).parsed = 5;
    }).toThrow();
    expect(reader.parsed).toBe(0);
  });

  test("_meta and profiles are matched by exact name, on any disk", () => {
    mkdirSync(join(root, "_Meta", "Profiles"), { recursive: true });
    writeFileSync(join(root, "_Meta", "Profiles", "location.json"), '{"kind":"location"}');
    expect(new ProfileReader().pass().match(root, root, "location")).toEqual({ state: "none" });
    mkdirSync(join(root, "x", "_meta", "Profiles"), { recursive: true });
    writeFileSync(join(root, "x", "_meta", "Profiles", "location.json"), '{"kind":"location"}');
    expect(new ProfileReader().pass().match(join(root, "x"), root, "location")).toEqual({
      state: "none",
    });
  });

  test("a file that is there but cannot be read is broken, with why, and tried again", () => {
    if (process.getuid?.() === 0) return; // root reads anything
    mkdirSync(join(root, "_meta", "profiles"), { recursive: true });
    const file = join(root, "_meta", "profiles", "location.json");
    writeFileSync(file, '{"kind":"location"}');
    chmodSync(file, 0o000);
    const reader = new ProfileReader();
    expect(reader.pass().match(root, root, "location")).toEqual({
      state: "broken",
      path: file,
      kind: "location",
      reason: "cannot be read (EACCES)",
    });
    expect(reader.parsed).toBe(0);
    chmodSync(file, 0o644);
    expect(reader.pass().match(root, root, "location").state).toBe("matched");
  });
});

describe("allOf references, as written", () => {
  test("whole-file references are kept in order; anything else is refused with why", () => {
    const r = parseProfile(
      '{"kind":"k","allOf":[{"$ref":"_a.json"},{"$ref":"../shared/_b.json","$comment":"why"}]}',
      "k",
    );
    expect(r.profile ? r.allOf : r.broken).toEqual(["_a.json", "../shared/_b.json"]);
    const why = (allOf: unknown) => broken(JSON.stringify({ kind: "k", allOf }), "k");
    expect(why({ $ref: "_a.json" })).toBe('"allOf" must be a list');
    expect(why([{ $ref: "_a.json#/properties" }])).toBe(
      'allOf[0]: "$ref" "_a.json#/properties" points inside a file; only whole files are read, so drop the "#…" part',
    );
    expect(why([{ $ref: "https://example.com/a.json" }])).toBe(
      'allOf[0]: "$ref" "https://example.com/a.json" is a URL; only a file in this world is read',
    );
    expect(why([{ $ref: "/etc/a.json" }])).toBe(
      'allOf[0]: "$ref" "/etc/a.json" must be a path relative to this file',
    );
    expect(why([{ $ref: "_a.yaml" }])).toBe('allOf[0]: "$ref" "_a.yaml" must name a .json file');
    expect(why([{ properties: { a: { type: "string" } } }])).toBe(
      'allOf[0]: only {"$ref": "<file>.json"} is read; write fields in the kind file or in a shared file',
    );
    expect(why([{ $ref: "_a.json", required: ["x"] }])).toMatch(/^allOf\[0\]: only/);
  });
});

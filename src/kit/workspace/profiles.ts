/**
 * Document profiles: what a kind of document is expected to carry in its
 * frontmatter, and the warnings a document gets where it does not. Admitted for
 * Atlas (the kit-document-profiles item), decided in the Atlas phase 2 design
 * write-up ("Revised: profiles are JSON Schema files, checked as warnings").
 *
 * ── THE FILES ──────────────────────────────────────────────────────────────
 *
 * A world keeps one JSON file per kind in a `_meta/profiles/` folder, named for
 * the kind (`_meta/profiles/location.json`). Each is a JSON Schema for a
 * document's frontmatter plus a few Atlas keys beside it: `kind` (must equal
 * the file's name), `label`, and `canon` (`false` marks a kind the world does
 * not count as canon, such as a guide; absent means canon, and anything but a
 * boolean makes the file broken); `sections` and `checkWith` come later and are
 * ignored until they do. A file whose name starts with `_` is not a kind
 * (`_relations.json`, `_world.json` are reserved) and is not read here.
 *
 * ── WHICH FILE APPLIES: THE NEAREST WINS ─────────────────────────────────────
 *
 * A document's frontmatter `type` names its kind. The kind is looked up in the
 * document's own folder's `_meta/profiles/`, then its parent's, up to the root
 * of the context entry that holds the document and NEVER above it, so a profile
 * outside the folder the user opened cannot leak in. The first folder with that
 * kind's file wins and is used whole: no merging. A nested folder that defines
 * only `location` overrides `location` beneath it; every other kind still comes
 * from above.
 *
 * A file that does not parse, or parses but is not a usable schema, is BROKEN:
 * it is reported with the reason, and the kind it names matches nothing beneath
 * it until it is fixed. It still wins the lookup (the lookup does not fall
 * through to a file further up), because silently checking a document against
 * a different schema than the nearest one is worse than not checking it.
 *
 * ── SHARED FIELDS: allOf WITH WHOLE-FILE $ref ──────────────────────────────
 *
 * Fields most kinds share are written once, in a shared file beside the kinds
 * whose name starts with `_` (`_meta/profiles/_bible-doc.json`), and a kind
 * pulls it in with `"allOf": [{ "$ref": "_bible-doc.json" }]`. Nothing is
 * merged: a document is checked against the kind file's own rules and against
 * each referred file on its own, as `allOf` means in JSON Schema, and each
 * warning names the file whose rule it is. A `$ref` is a path to a `.json` file,
 * relative to the file that writes it, and may not leave the context entry; a
 * `#` fragment or a URL is refused. A shared file may refer on. A cycle, a
 * chain deeper than REF_DEPTH_MAX, or a referred file missing or broken makes
 * the kind broken, with the chain in the reason. Decided with the user on
 * 2026-10-04.
 *
 * ── THE CHECK ──────────────────────────────────────────────────────────────
 *
 * A small subset of JSON Schema, written here rather than taken from a
 * validator library: the subset is a page, a library such as Ajv is far larger
 * than the need and refuses unknown keywords by default, which is the opposite
 * of what a hand-written world file needs. Read: top-level `properties` (each
 * with `type`, `enum`, `const`, `minLength`; `description` is carried as
 * guidance) and `required`. Every other keyword is ignored, not an error. Each
 * problem is a warning naming the field, the rule and a sentence; nothing here
 * blocks a save.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeJsonProblem, jsonProblem } from "../lib/json";

const META_DIR = "_meta";
const PROFILES_NAME = "profiles";

/** The folder, under any folder of a world, that holds its profile files. */
export const PROFILES_DIR = join(META_DIR, PROFILES_NAME);

/** A folder's entries, or none when it cannot be listed. */
function listOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Whether `dir` lists `name` exactly, case included, and it is a folder. */
function hasFolder(dir: string, name: string): boolean {
  if (!listOf(dir).includes(name)) return false;
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

/** The JSON Schema types the check knows. Anything else in `type` makes the file broken. */
const TYPES = ["string", "number", "integer", "boolean", "array", "object", "null"] as const;
type JsonType = (typeof TYPES)[number];

/** What one frontmatter field is checked against. `false` is a field the kind forbids. */
export type FieldRule =
  | false
  | {
      type?: JsonType[];
      enum?: unknown[];
      /** Present when the schema has `const` (its value may itself be null). */
      const?: { value: unknown };
      minLength?: number;
      description?: string;
    };

/** The rules one file contributes: its own `properties` and `required`. */
export type SchemaPart = {
  /** The file the rules are written in ("" for a profile read from text alone). */
  path: string;
  properties: Record<string, FieldRule>;
  required: string[];
};

/**
 * A usable profile: one kind and what its documents' frontmatter should carry.
 * `properties` and `required` are the kind file's own; `shared` are the files
 * its `allOf` refers to, each checked on its own, never merged.
 */
export type Profile = {
  kind: string;
  label: string;
  /** Whether the world counts documents of this kind as canon: the file's `canon`, true when absent. */
  canon: boolean;
  description?: string;
  /** The kind file ("" for a profile read from text alone). */
  path: string;
  properties: Record<string, FieldRule>;
  required: string[];
  /** The shared files, depth first, each once. */
  shared: SchemaPart[];
  /** Their paths, in the same order. */
  refs: string[];
};

/**
 * One profile file as read: usable, or broken with the reason. `through` is the
 * shared file to fix when the kind is broken only because a file it refers to
 * is (absent when the kind file itself needs the fix).
 */
export type ProfileLoad = { path: string; kind: string } & (
  | { profile: Profile; broken?: undefined }
  | { profile?: undefined; broken: string; through?: string }
);

/** The rule a warning is about. `forbidden` is a property whose schema is `false`. */
export type ProfileRule = "required" | "type" | "enum" | "const" | "minLength" | "forbidden";

/** One way a document's frontmatter differs from its profile. */
export type ProfileWarning = {
  field: string;
  rule: ProfileRule;
  /** A sentence a human reads. */
  message: string;
  /** What the rule expects: the types, the allowed values, the constant or the length. */
  expected?: unknown;
  /** The profile's `description` of the field, the guidance for fixing it. */
  description?: string;
  /** The file whose rule this is: the kind file or a shared file it refers to. */
  file?: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The kind a profile file's name says, or null for a file that is not a kind. */
export function kindOfFile(name: string): string | null {
  if (name.startsWith("_") || name.startsWith(".")) return null;
  if (!name.toLowerCase().endsWith(".json")) return null;
  const kind = name.slice(0, -".json".length);
  return kind === "" ? null : kind;
}

/** How many files deep a chain of `allOf` references may go before the kind is broken. */
export const REF_DEPTH_MAX = 8;

/** A schema file read for its rules: its own `properties`, `required` and `allOf` references. */
type SchemaFile = {
  raw: Record<string, unknown>;
  properties: Record<string, FieldRule>;
  required: string[];
  /** Each `allOf` member's `$ref`, as written. */
  allOf: string[];
};

/**
 * The rules a schema file holds, or why it cannot be read: the part of a
 * profile file and of a shared file that is the same.
 */
function readSchema(text: string): SchemaFile | { broken: string } {
  // Where it goes wrong, by line and column, as the editor's Save says it.
  const problem = jsonProblem(text);
  if (problem) return { broken: `does not parse as JSON: ${describeJsonProblem(problem)}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { broken: `does not parse as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObject(raw)) return { broken: "is not a JSON object" };
  if (raw.type !== undefined && raw.type !== "object")
    return { broken: `"type" at the top must be "object" (frontmatter is an object)` };
  // No prototype: a property named `__proto__` is a field like any other.
  const properties: Record<string, FieldRule> = Object.create(null);
  if (raw.properties !== undefined) {
    if (!isObject(raw.properties)) return { broken: `"properties" must be an object` };
    for (const [field, schema] of Object.entries(raw.properties)) {
      const rule = fieldRule(schema);
      if (typeof rule === "string") return { broken: `properties.${field}: ${rule}` };
      properties[field] = rule;
    }
  }
  let required: string[] = [];
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || !raw.required.every((r) => typeof r === "string"))
      return { broken: `"required" must be a list of field names` };
    required = [...new Set(raw.required as string[])];
  }
  const allOf: string[] = [];
  if (raw.allOf !== undefined) {
    if (!Array.isArray(raw.allOf)) return { broken: `"allOf" must be a list` };
    for (const [i, member] of raw.allOf.entries()) {
      const why = refProblem(member);
      if (why !== null) return { broken: `allOf[${i}]: ${why}` };
      allOf.push((member as { $ref: string }).$ref);
    }
  }
  return { raw, properties, required, allOf };
}

/** Why an `allOf` member is not a whole-file reference this reads, or null when it is. */
function refProblem(member: unknown): string | null {
  const ONLY = `only {"$ref": "<file>.json"} is read; write fields in the kind file or in a shared file`;
  if (!isObject(member) || typeof member.$ref !== "string") return ONLY;
  if (Object.keys(member).some((k) => k !== "$ref" && k !== "$comment")) return ONLY;
  const ref = member.$ref;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//"))
    return `"$ref" ${JSON.stringify(ref)} is a URL; only a file in this world is read`;
  if (ref.includes("#"))
    return `"$ref" ${JSON.stringify(ref)} points inside a file; only whole files are read, so drop the "#…" part`;
  if (isAbsolute(ref) || ref.startsWith("/"))
    return `"$ref" ${JSON.stringify(ref)} must be a path relative to this file`;
  if (!ref.toLowerCase().endsWith(".json"))
    return `"$ref" ${JSON.stringify(ref)} must name a .json file`;
  const name = ref.split(/[\\/]/).pop() ?? ref;
  if (!name.startsWith("_")) return `refers to ${name}, which is a kind; shared files start with _`;
  return null;
}

/**
 * Read one profile file's text. `kind` is the kind its file name says, and
 * `path` the file (where its `allOf` references are resolved from; the
 * reader resolves them). A file that does not parse, or is not a usable
 * schema, comes back with the reason; keywords the check does not know are
 * ignored. `allOf` is each `$ref` as written.
 */
export function parseProfile(
  text: string,
  kind: string,
  path = "",
):
  | { profile: Profile; allOf: string[]; broken?: undefined }
  | { profile?: undefined; broken: string } {
  const s = readSchema(text);
  return "broken" in s ? s : profileOf(s, kind, path);
}

/** A kind file's own profile, from its schema already read: the kind keys checked. */
function profileOf(
  s: SchemaFile,
  kind: string,
  path: string,
):
  | { profile: Profile; allOf: string[]; broken?: undefined }
  | { profile?: undefined; broken: string } {
  const raw = s.raw;
  if (typeof raw.kind !== "string" || raw.kind.trim() === "")
    return { broken: `has no "kind"; it should say "kind": ${JSON.stringify(kind)}` };
  if (raw.kind !== kind)
    return {
      broken: `says "kind": ${JSON.stringify(raw.kind)} but the file is named ${kind}.json; they must match`,
    };
  if (raw.label !== undefined && typeof raw.label !== "string")
    return { broken: `"label" must be a string` };
  // Strict, as every key the reader knows: a typo such as "false" in quotes
  // must not quietly count a kind as canon.
  if (raw.canon !== undefined && typeof raw.canon !== "boolean")
    return { broken: `"canon" must be true or false, not ${quoted(raw.canon)}` };
  return {
    profile: {
      kind,
      label: typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : kind,
      canon: raw.canon !== false,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      path,
      properties: s.properties,
      required: s.required,
      shared: [],
      refs: [],
    },
    allOf: s.allOf,
  };
}

/** One property's schema as a rule, or why it cannot be one. */
function fieldRule(schema: unknown): FieldRule | string {
  if (schema === true) return {};
  if (schema === false) return false;
  if (!isObject(schema)) return "must be an object (or true, or false)";
  const rule: Exclude<FieldRule, false> = {};
  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (list.length === 0) return `"type" lists no type`;
    for (const t of list)
      if (typeof t !== "string" || !(TYPES as readonly string[]).includes(t))
        return `"type" ${JSON.stringify(t)} is not one of ${TYPES.join(", ")}`;
    rule.type = list as JsonType[];
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      return `"enum" must list at least one value`;
    rule.enum = schema.enum;
  }
  if ("const" in schema) rule.const = { value: schema.const };
  if (schema.minLength !== undefined) {
    if (
      typeof schema.minLength !== "number" ||
      !Number.isInteger(schema.minLength) ||
      schema.minLength < 0
    )
      return `"minLength" must be a whole number from 0`;
    rule.minLength = schema.minLength;
  }
  if (typeof schema.description === "string") rule.description = schema.description;
  return rule;
}

/** JSON equality, as JSON Schema's `enum` and `const` mean it: key order does not count. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameJson(x, b[i]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

function isType(v: unknown, t: JsonType): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    case "null":
      return v === null;
  }
}

/** A value's type, as a warning says it. */
function typeSaid(v: unknown): string {
  if (v === null) return "empty";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a mapping";
  if (typeof v === "number")
    return !Number.isFinite(v)
      ? "not a finite number"
      : Number.isInteger(v)
        ? "a whole number"
        : "a number";
  return `a ${typeof v}`;
}

const A: Record<JsonType, string> = {
  string: "a string",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "a mapping",
  null: "empty",
};

const orList = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;

/** How long one value may run in a message before it is cut. */
export const VALUE_SHOWN_MAX = 80;

/** How many of an `enum`'s values a message lists before saying how many more. */
const ENUM_SHOWN_MAX = 12;

const cut = (t: string) =>
  [...t].length > VALUE_SHOWN_MAX ? `${[...t].slice(0, VALUE_SHOWN_MAX - 1).join("")}…` : t;

/** JSON for a message; NaN and the infinities, which JSON has no word for, by name. */
const json = (v: unknown) =>
  typeof v === "number" && !Number.isFinite(v) ? String(v) : (JSON.stringify(v) ?? String(v));

/** A value as a list in a message says it: bare for a string, cut at VALUE_SHOWN_MAX characters. */
const shown = (v: unknown) => cut(typeof v === "string" ? v : json(v));

/** A value as a message quotes it: JSON, cut at VALUE_SHOWN_MAX characters. */
const quoted = (v: unknown) => cut(json(v));

/** An enum's values as a message lists them, at most ENUM_SHOWN_MAX, each cut. */
const listed = (values: readonly unknown[]) => {
  const head = values.slice(0, ENUM_SHOWN_MAX).map(shown).join(", ");
  return values.length > ENUM_SHOWN_MAX
    ? `${head} (and ${values.length - ENUM_SHOWN_MAX} more)`
    : head;
};

/**
 * The warnings for a document's frontmatter (`fields`, its parsed block)
 * against a profile, the kind file's own rules and each shared file's, every
 * warning naming the `file` whose rule it is. Within one file: each required field missing, then each present field
 * against its rule in the order the profile lists them. A field the profile
 * does not name is not checked. A field with the wrong type is not also
 * checked for its value.
 */
export function checkFields(
  profile: Profile,
  fields: Readonly<Record<string, unknown>>,
): ProfileWarning[] {
  const parts: SchemaPart[] = [
    { path: profile.path, properties: profile.properties, required: profile.required },
    ...profile.shared,
  ];
  // Each file's rules on their own. Two files saying the same thing (the same
  // field, rule and expected value) is said once, from the nearer file (the
  // kind's own first); two different rules on one field are both said, each
  // with its own file.
  const out: ProfileWarning[] = [];
  for (const part of parts)
    for (const w of checkPart(part, profile.label, fields)) {
      const same = out.some(
        (o) => o.field === w.field && o.rule === w.rule && sameJson(o.expected, w.expected),
      );
      if (!same) out.push(part.path ? { ...w, file: part.path } : w);
    }
  return out;
}

/** One file's rules against a document's frontmatter. */
function checkPart(
  part: SchemaPart,
  label: string,
  fields: Readonly<Record<string, unknown>>,
): ProfileWarning[] {
  const out: ProfileWarning[] = [];
  const has = (f: string) => Object.hasOwn(fields, f) && fields[f] !== undefined;
  const guide = (rule: FieldRule | undefined) =>
    rule && rule.description !== undefined ? { description: rule.description } : {};
  for (const field of part.required) {
    if (has(field)) continue;
    out.push({
      field,
      rule: "required",
      message: `${field} is missing; the ${label} profile requires it`,
      ...guide(part.properties[field]),
    });
  }
  for (const [field, rule] of Object.entries(part.properties)) {
    if (!has(field)) continue;
    const v = fields[field];
    if (rule === false) {
      out.push({
        field,
        rule: "forbidden",
        message: `${field} is set; the ${label} profile does not allow it`,
      });
      continue;
    }
    if (rule.type && !rule.type.some((t) => isType(v, t))) {
      out.push({
        field,
        rule: "type",
        message: `${field} should be ${orList(rule.type.map((t) => A[t]))}, and it is ${typeSaid(v)}`,
        expected: rule.type,
        ...guide(rule),
      });
      continue;
    }
    if (rule.const && !sameJson(v, rule.const.value))
      out.push({
        field,
        rule: "const",
        message: `${field} is ${quoted(v)}; the ${label} profile expects ${quoted(rule.const.value)}`,
        expected: rule.const.value,
        ...guide(rule),
      });
    if (rule.enum && !rule.enum.some((e) => sameJson(v, e)))
      out.push({
        field,
        rule: "enum",
        message: `${field} is ${quoted(v)}, which is not one of ${listed(rule.enum)}`,
        expected: rule.enum,
        ...guide(rule),
      });
    if (rule.minLength !== undefined && typeof v === "string") {
      const n = [...v].length;
      if (n < rule.minLength)
        out.push({
          field,
          rule: "minLength",
          message:
            n === 0
              ? `${field} is empty; it needs at least ${rule.minLength} character${rule.minLength === 1 ? "" : "s"}`
              : `${field} has ${n} character${n === 1 ? "" : "s"}; it needs at least ${rule.minLength}`,
          expected: rule.minLength,
          ...guide(rule),
        });
    }
  }
  return out;
}

/** What to do about a warning, in words, for the agent to offer. */
export function fixFor(w: ProfileWarning): string {
  const f = `\`${w.field}\``;
  switch (w.rule) {
    case "required":
      return `add ${f} to the frontmatter${w.description ? ` (${w.description})` : ""}`;
    case "type":
      return `make ${f} ${orList((w.expected as JsonType[]).map((t) => A[t]))}`;
    case "enum":
      return `set ${f} to one of ${listed(w.expected as unknown[])}`;
    case "const":
      return `set ${f} to ${quoted(w.expected)}`;
    case "minLength":
      return `give ${f} at least ${String(w.expected)} character${w.expected === 1 ? "" : "s"}`;
    case "forbidden":
      return `remove ${f}`;
  }
}

/**
 * The folders whose `_meta/profiles/` a document in `dir` looks in, nearest
 * first: `dir`, its parent, and so on up to `root` and never above it. Empty
 * when `dir` is not `root` or under it.
 */
export function profileFolders(dir: string, root: string): string[] {
  if (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : root + sep)) return [];
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (d === root || dirname(d) === d) break;
  }
  return out;
}

/** How a document matched: a usable profile, a broken nearest file, or nothing. */
export type ProfileMatch =
  | { state: "matched"; path: string; profile: Profile }
  | {
      state: "broken";
      path: string;
      kind: string;
      reason: string;
      /** The shared file to fix, when the kind is broken only because of it. */
      through?: string;
    }
  | { state: "none" };

export const NO_MATCH: ProfileMatch = { state: "none" };

/** A schema file as the reader holds it: read, broken with why, or not there. */
type FileRead = { file: SchemaFile } | { broken: string } | { missing: true };

/**
 * The profile files and the shared files they refer to, read so far, by path,
 * each with the stamp (inode, size, mtime) of the file when it was read, as the
 * link cache keeps documents: a file is parsed again only when it changes. A
 * kind is put together from its files on every pass, from this cache, so a
 * change to a shared file reaches every kind that refers to it on the next
 * check, and each file is still parsed once per change however many kinds use
 * it.
 */
export class ProfileReader {
  private cache = new Map<string, { stamp: string; read: FileRead }>();
  private parses = 0;

  /** How many times a file was read and parsed: what the cost test counts. */
  get parsed(): number {
    return this.parses;
  }

  /**
   * One pass over the world: a folder's profile files are listed once per pass
   * however many documents ask, and each file is stat'ed once per pass and
   * read only when its stamp changed since it was last read.
   */
  pass(): ProfileLookup {
    return new ProfileLookup(this);
  }

  /** One schema file, from the cache while its stamp holds. */
  file(path: string): FileRead {
    let stamp: string;
    try {
      const st = statSync(path);
      if (!st.isFile()) return { missing: true };
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return { missing: true };
    }
    const hit = this.cache.get(path);
    if (hit?.stamp === stamp) return hit.read;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      // There but unreadable (permissions): broken, said, and not cached, so
      // it is tried again on the next pass rather than silently skipped.
      const why = e && typeof e === "object" && "code" in e ? String(e.code) : String(e);
      return { broken: `cannot be read (${why})` };
    }
    this.parses++;
    const s = readSchema(text);
    const read: FileRead = "broken" in s ? s : { file: s };
    this.cache.set(path, { stamp, read });
    return read;
  }

  /** Forget files no pass that looked everywhere saw, so the cache is bounded by the world. */
  prune(seen: ReadonlySet<string>): void {
    for (const p of this.cache.keys()) if (!seen.has(p)) this.cache.delete(p);
  }
}

/** One pass's view of the profile files: see `ProfileReader.pass`. */
export class ProfileLookup {
  private folders = new Map<string, Map<string, ProfileLoad>>();
  /** Every file this pass read, kind or shared, once each. */
  private files = new Map<string, FileRead>();
  /** Each profile file's entry root, kind or shared, from the first lookup that reached it. */
  private roots = new Map<string, string>();
  /** Shared files that need a fix, each with its own reason. */
  private brokenShared = new Map<string, string>();
  /** Things worth saying about a usable file that are not problems (a shared file's `kind`). */
  private fileNotes = new Map<string, string>();

  constructor(private readonly reader: ProfileReader) {}

  private file(path: string): FileRead {
    let got = this.files.get(path);
    if (!got) {
      got = this.reader.file(path);
      this.files.set(path, got);
    }
    return got;
  }

  /**
   * The profile files in `dir`'s `_meta/profiles/`, by kind, each put together
   * with the files its `allOf` refers to, which must lie under `root` (the root
   * of the context entry the lookup came from). Empty when it has none.
   */
  folder(dir: string, root: string = dir): Map<string, ProfileLoad> {
    const key = `${root}\0${dir}`;
    const known = this.folders.get(key);
    if (known) return known;
    const kinds = new Map<string, ProfileLoad>();
    const at = join(dir, PROFILES_DIR);
    // Each folder name matched exactly, by listing its parent: on a disk that
    // ignores case `_Meta/Profiles` would open as `_meta/profiles`, and a world
    // must mean the same on macOS and Linux.
    const names =
      hasFolder(dir, META_DIR) && hasFolder(join(dir, META_DIR), PROFILES_NAME) ? listOf(at) : [];
    for (const name of names.sort()) {
      const kind = kindOfFile(name);
      if (kind === null) continue;
      const load = this.load(join(at, name), kind, root);
      if (load) kinds.set(kind, load);
    }
    this.folders.set(key, kinds);
    return kinds;
  }

  /** A kind file, with its shared files resolved; null when it is not there. */
  private load(path: string, kind: string, root: string): ProfileLoad | null {
    if (!this.roots.has(path)) this.roots.set(path, root);
    const got = this.file(path);
    if ("missing" in got) return null;
    if ("broken" in got) return { path, kind, broken: got.broken };
    const own = profileOf(got.file, kind, path);
    if (own.broken !== undefined) return { path, kind, broken: own.broken };
    const shared: SchemaPart[] = [];
    const bad = this.follow(path, own.allOf, root, [path], shared);
    if (bad !== null) {
      // The file to fix: the kind itself, or a shared file it reaches.
      if (bad.blame === path) return { path, kind, broken: bad.why };
      if (!this.brokenShared.has(bad.blame)) this.brokenShared.set(bad.blame, bad.own);
      return { path, kind, broken: bad.why, through: bad.blame };
    }
    const refs = shared.map((s) => s.path);
    return { path, kind, profile: { ...own.profile, shared, refs } };
  }

  /**
   * Follow `refs` (as written in `from`), depth first, adding each file's
   * rules to `out` once. Null when every file was read; else why not, naming
   * the chain of files (`why`), the file to fix (`blame`: the one that writes
   * the bad reference, or a referred file that is broken itself) and that
   * file's own reason (`own`).
   */
  private follow(
    from: string,
    refs: readonly string[],
    root: string,
    chain: string[],
    out: SchemaPart[],
  ): { why: string; blame: string; own: string } | null {
    const named = (p: string) => relative(dirname(chain[0] as string), p) || basename(p);
    const via = (to: string) => [...chain, to].map(named).join(" → ");
    const here = (own: string, why = own) => ({ why, blame: from, own });
    for (const ref of refs) {
      const to = resolve(dirname(from), ref);
      if (to !== root && !to.startsWith(root.endsWith(sep) ? root : root + sep))
        return here(
          `refers to ${JSON.stringify(ref)}, which is outside the folder the human opened`,
        );
      if (chain.includes(to)) return here(`its references go round in a circle: ${via(to)}`);
      if (chain.length > REF_DEPTH_MAX)
        return here(`its references go deeper than ${REF_DEPTH_MAX} files: ${via(to)}`);
      if (!this.roots.has(to)) this.roots.set(to, root);
      const got = this.file(to);
      if ("missing" in got)
        return here(
          `refers to ${basename(to)}, which is not there`,
          `refers to ${named(to)}, which is not there (${via(to)})`,
        );
      if ("broken" in got)
        return {
          why: `refers to ${named(to)}, which has an error: ${got.broken} (${via(to)})`,
          blame: to,
          own: got.broken,
        };
      const k = got.file.raw.kind;
      if (k !== undefined && !this.fileNotes.has(to))
        this.fileNotes.set(
          to,
          `has "kind": ${JSON.stringify(k)}; a shared file's kind is ignored (a kind is a file whose name has no leading _)`,
        );
      if (!out.some((s) => s.path === to))
        out.push({ path: to, properties: got.file.properties, required: got.file.required });
      const deeper = this.follow(to, got.file.allOf, root, [...chain, to], out);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  /** Shared files this pass found broken, each with its own reason, by path order. */
  sharedBroken(): { path: string; reason: string }[] {
    return [...this.brokenShared]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Notes on files this pass read that are usable but worth a word, by path order. */
  notes(): { path: string; note: string }[] {
    return [...this.fileNotes]
      .map(([path, note]) => ({ path, note }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * The profile a document of `type` in folder `dir` matches, looking up to
   * `root` (the root of its context entry). Every folder on the way is listed,
   * so the pass sees every profile file a document could reach.
   */
  match(dir: string, root: string, type: string | null): ProfileMatch {
    let found: ProfileMatch = NO_MATCH;
    for (const d of profileFolders(dir, root)) {
      const loads = this.folder(d, root);
      const load = loads.get(type ?? "");
      if (found.state !== "none" || type === null || !load) continue;
      found = load.profile
        ? { state: "matched", path: load.path, profile: load.profile }
        : {
            state: "broken",
            path: load.path,
            kind: load.kind,
            reason: load.broken,
            ...(load.through !== undefined ? { through: load.through } : {}),
          };
    }
    return found;
  }

  /**
   * The root of the context entry from which `path` (a kind or shared file this
   * pass read) was first reached: what its shown path is relative to.
   */
  rootOf(path: string): string | undefined {
    return this.roots.get(path);
  }

  /** Every kind file this pass listed, once each (the first reading), by path order. */
  loads(): ProfileLoad[] {
    const seen = new Map<string, ProfileLoad>();
    for (const m of this.folders.values())
      for (const l of m.values()) if (!seen.has(l.path)) seen.set(l.path, l);
    return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every file this pass read, kind or shared: what the reader's cache is pruned to. */
  seen(): Set<string> {
    return new Set(this.files.keys());
  }
}

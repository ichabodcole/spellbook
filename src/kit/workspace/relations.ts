/**
 * A world's relation vocabulary: what each `?rel=` a link may carry means, how
 * it reads from the other end, and whether it is symmetric. Admitted for Atlas
 * (the kit-picker-relation-meanings and kit-link-check-symmetry items), decided
 * in the Atlas phase 2 design write-up ("The relation vocabulary in the link
 * picker", and the revised profiles section).
 *
 * ── THE FILE ───────────────────────────────────────────────────────────────
 *
 * `_meta/profiles/_relations.json`, beside the profile files. The leading `_`
 * says it is not a kind, so the profile reader passes over it (`kindOfFile`).
 *
 *     { "relations": {
 *         "grounded-in": { "label": "grounded in", "inverse": "grounds",
 *                          "means": "…", "symmetric": false },
 *         "contrasts-with": { "label": "contrasts with", "means": "…",
 *                             "symmetric": true } } }
 *
 * Every key but `relations` is ignored (`$comment` among them), and so is every
 * key of an entry but `label`, `means`, `symmetric`, `inverse` and `color`. A known key
 * with the wrong kind of value makes the FILE broken, as a profile file is, so
 * a typo cannot quietly switch a meaning off. `inverse` is for a one-way
 * relation only: a symmetric one reads the same from both ends. `color` is
 * what an app draws the relation in (Atlas's board connections), written as
 * JSON Canvas writes a colour: a preset `"1"` to `"6"` or a hex (`#3b6fd8`).
 *
 * ── WHICH DEFINITION APPLIES: THE NEAREST WINS, PER RELATION ────────────────
 *
 * As for kinds: a document's vocabulary is looked up in its own folder's
 * `_meta/profiles/`, then its parent's, up to the root of the context entry
 * that holds it and never above. A relation defined nearer overrides the same
 * relation defined above, whole; relations defined only above still apply.
 *
 * A broken file is reported, with the line and column when it does not parse,
 * and defines nothing until it is fixed: the relations defined above it still
 * apply beneath it. (Unlike a broken kind file, which wins its lookup and
 * matches nothing, a vocabulary is a set of separate words; losing the nearer
 * ones is enough, and the report says which file to fix.)
 *
 * The file is parsed once per change of its stamp (inode, size, mtime), as the
 * link cache holds documents and the profile reader holds profile files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describeJsonProblem, jsonProblem } from "../lib/json";
import { RELATION } from "../lib/linkTarget";
import { PROFILES_DIR, profileFolders } from "./profiles";
import type { RelationOffer } from "./protocol";

/** The vocabulary's file name, in a `_meta/profiles/` folder. */
export const RELATIONS_FILE = "_relations.json";

/** A relation's `color`: a JSON Canvas preset ("1" to "6") or a hex. */
const COLOR = /^(?:[1-6]|#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})$/;

/** A relation word as `?rel=` reads one: the one rule, `lib/linkTarget.ts`. */
const RELATION_WORD = RELATION;

/** One declared relation, as its file writes it. */
export type RelationDef = {
  rel: string;
  /** How it reads in words, from the end that writes it ("grounded in"); the name when unsaid. */
  label: string;
  /** What it means, a sentence: the picker's second line. */
  means?: string;
  /** It reads the same from both ends ("contrasts with"): the link check hints when one end is missing. */
  symmetric: boolean;
  /** How it reads from the other end ("grounds"), for a one-way relation. */
  inverse?: string;
  /** The colour an app draws it in: a JSON Canvas preset ("1" to "6") or a hex. */
  color?: string;
  /** The file it is defined in. */
  source: string;
};

/**
 * A vocabulary file as read: its relations in file order, with `warnings` for
 * keys it ignored (a usable file still), or why it cannot be read. `folded`
 * names each key ignored because it folds onto an earlier key (`Extends` after
 * `extends`), with that earlier key: its warning is in `warnings` too, and the
 * doctor tells the two kinds apart by it.
 */
export type RelationsRead =
  | { relations: RelationDef[]; warnings?: string[]; folded?: FoldedKey[] }
  | { broken: string };

/** A vocabulary key ignored because it is an earlier key in another case. */
export type FoldedKey = { key: string; earlier: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A vocabulary file's text, read: its relations in the order it writes them,
 * or why it cannot be used. `source` is the file, carried on each relation.
 */
export function parseRelations(text: string, source = ""): RelationsRead {
  const problem = jsonProblem(text);
  if (problem) return { broken: `does not parse as JSON: ${describeJsonProblem(problem)}` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { broken: `does not parse as JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObject(raw)) return { broken: "is not a JSON object" };
  if (raw.relations === undefined)
    return { broken: `has no "relations"; it should hold "relations": { "<name>": { … } }` };
  if (!isObject(raw.relations)) return { broken: `"relations" must be an object` };
  const out: RelationDef[] = [];
  const warnings: string[] = [];
  const folded: FoldedKey[] = [];
  /** Each relation's key as the file writes it, by its folded name. */
  const keyOf = new Map<string, string>();
  for (const [key, entry] of Object.entries(raw.relations)) {
    const at = `relations.${key}`;
    if (!RELATION_WORD.test(key))
      return {
        broken: `${JSON.stringify(key)} cannot be written in ?rel=: a relation starts with a letter or a digit and holds only letters, digits, combining marks (after the first character), _, . and -`,
      };
    // A relation's name is case-folded, as `?rel=` is read (`parseRel`): a
    // declared `Extends` is the `extends` links carry. Its label keeps the case
    // the file writes. Two keys that fold together are one relation: the first
    // stands, the later one is said and ignored.
    const rel = key.toLowerCase();
    const earlier = keyOf.get(rel);
    if (earlier !== undefined) {
      warnings.push(
        `${at} is relations.${earlier} again in another case (a relation is read case-insensitively, as ${JSON.stringify(rel)}); relations.${earlier} stands and this one is ignored`,
      );
      folded.push({ key, earlier });
      continue;
    }
    keyOf.set(rel, key);
    if (!isObject(entry)) return { broken: `${at} must be an object` };
    const text = (key: string): string | undefined | { bad: string } => {
      const v = entry[key];
      if (v === undefined) return undefined;
      if (typeof v !== "string") return { bad: `${at}.${key} must be a string` };
      return v.trim() === "" ? undefined : v.trim();
    };
    const label = text("label");
    const means = text("means");
    const inverse = text("inverse");
    const color = text("color");
    for (const v of [label, means, inverse, color])
      if (typeof v === "object") return { broken: v.bad };
    if (typeof color === "string" && !COLOR.test(color))
      return {
        broken: `${at}.color must be a colour: a preset "1" to "6", or a hex such as "#3b6fd8"`,
      };
    if (entry.symmetric !== undefined && typeof entry.symmetric !== "boolean")
      return { broken: `${at}.symmetric must be true or false` };
    const symmetric = entry.symmetric === true;
    if (symmetric && inverse !== undefined)
      return {
        broken: `${at} is symmetric and has an inverse; a symmetric relation reads the same from both ends, so drop "inverse"`,
      };
    // A key the entry does not read is ignored, but said: a typo such as
    // `"symetric": true` would otherwise leave a relation one-way with no word
    // anywhere. A `$`-key (`$comment`) is a note, and says nothing.
    for (const key of Object.keys(entry))
      if (!ENTRY_KEYS.has(key) && !key.startsWith("$"))
        warnings.push(
          `${at} has ${JSON.stringify(key)}, which is not read (a relation takes ${[...ENTRY_KEYS].join(", ")}); it is ignored`,
        );
    out.push({
      rel,
      label: (label as string | undefined) ?? key,
      ...(means !== undefined ? { means: means as string } : {}),
      symmetric,
      ...(inverse !== undefined ? { inverse: inverse as string } : {}),
      ...(color !== undefined ? { color: color as string } : {}),
      source,
    });
  }
  return {
    relations: out,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(folded.length > 0 ? { folded } : {}),
  };
}

/** The keys a relation's entry reads. */
const ENTRY_KEYS = new Set(["label", "means", "symmetric", "inverse", "color"]);

/**
 * How a relation reads from the end it points AT: its inverse when it has one
 * ("grounds"), its label when it is symmetric ("contrasts with"), else nothing
 * (a one-way relation with no inverse declared has no words for that end).
 */
export function readsBack(def: Pick<RelationDef, "label" | "symmetric" | "inverse">) {
  return def.inverse ?? (def.symmetric ? def.label : undefined);
}

/** A folder's entries, or none when it cannot be listed. */
function listOf(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The vocabulary file in `dir`'s `_meta/profiles/`, or null. Each name is
 * matched exactly, case included, by listing its parent, as the profile reader
 * matches its folders: a world must mean the same on macOS and Linux.
 */
function fileIn(dir: string): string | null {
  const [meta, profiles] = PROFILES_DIR.split(/[\\/]/) as [string, string];
  if (!listOf(dir).includes(meta)) return null;
  if (!listOf(join(dir, meta)).includes(profiles)) return null;
  const at = join(dir, meta, profiles);
  return listOf(at).includes(RELATIONS_FILE) ? join(at, RELATIONS_FILE) : null;
}

/**
 * The vocabulary files read so far, by path, each with the stamp of the file
 * when it was read: a file is parsed again only when it changes.
 */
export class RelationsReader {
  private cache = new Map<string, { stamp: string; read: RelationsRead }>();
  private parses = 0;

  /** How many times a file was read and parsed: what the cost test counts. */
  get parsed(): number {
    return this.parses;
  }

  /** One pass over the world: each folder is looked in once, each file stat'ed once. */
  pass(): RelationsLookup {
    return new RelationsLookup(this);
  }

  /** One vocabulary file, from the cache while its stamp holds; null when it is not a file. */
  file(path: string): RelationsRead | null {
    let stamp: string;
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
    const hit = this.cache.get(path);
    if (hit?.stamp === stamp) return hit.read;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      // There but unreadable: broken, said, and not cached, so it is tried again.
      const why = e && typeof e === "object" && "code" in e ? String(e.code) : String(e);
      return { broken: `cannot be read (${why})` };
    }
    this.parses++;
    const read = parseRelations(text, path);
    this.cache.set(path, { stamp, read });
    return read;
  }

  /** Forget files no full pass saw, so the cache is bounded by the world. */
  prune(seen: ReadonlySet<string>): void {
    for (const p of this.cache.keys()) if (!seen.has(p)) this.cache.delete(p);
  }
}

/** The vocabulary in force in one folder: each relation by name, the nearest definition winning. */
export type Vocabulary = {
  relations: ReadonlyMap<string, RelationDef>;
  /** Whether any vocabulary file (usable or broken) lies between the folder and its entry's root. */
  any: boolean;
};

/** No vocabulary in force: a world with no `_relations.json`, or a document outside every entry. */
export const NO_VOCABULARY: Vocabulary = { relations: new Map(), any: false };

/** One pass's view of the vocabulary files: see `RelationsReader.pass`. */
export class RelationsLookup {
  private folders = new Map<string, { path: string; read: RelationsRead } | null>();
  private vocabularies = new Map<string, Vocabulary>();

  constructor(private readonly reader: RelationsReader) {}

  /** The vocabulary file in one folder, as read, once per pass. */
  private folder(dir: string): { path: string; read: RelationsRead } | null {
    if (this.folders.has(dir)) return this.folders.get(dir) ?? null;
    const path = fileIn(dir);
    const read = path === null ? null : this.reader.file(path);
    const got = path === null || read === null ? null : { path, read };
    this.folders.set(dir, got);
    return got;
  }

  /**
   * The vocabulary a document in folder `dir` writes its links with, looking up
   * to `root` (the root of its context entry) and never above: each relation
   * from the nearest usable file that defines it.
   */
  at(dir: string, root: string): Vocabulary {
    const key = `${root}\0${dir}`;
    const known = this.vocabularies.get(key);
    if (known) return known;
    const relations = new Map<string, RelationDef>();
    let any = false;
    for (const d of profileFolders(dir, root)) {
      const f = this.folder(d);
      if (!f) continue;
      any = true;
      if ("broken" in f.read) continue;
      for (const r of f.read.relations) if (!relations.has(r.rel)) relations.set(r.rel, r);
    }
    const v = any ? { relations, any } : NO_VOCABULARY;
    this.vocabularies.set(key, v);
    return v;
  }

  /**
   * The nearest vocabulary file for folder `dir`, usable or broken, looking up
   * to `root` and never above: the file a new relation for that folder would be
   * proposed into. Null when there is none.
   */
  nearest(dir: string, root: string): { path: string; read: RelationsRead } | null {
    for (const d of profileFolders(dir, root)) {
      const f = this.folder(d);
      if (f) return f;
    }
    return null;
  }

  /** Every vocabulary file this pass found, usable or broken, by path order. */
  files(): { path: string; read: RelationsRead }[] {
    return [...this.folders.values()]
      .filter((f): f is { path: string; read: RelationsRead } => f !== null)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every file this pass read: what the reader's cache is pruned to. */
  seen(): Set<string> {
    return new Set(this.files().map((f) => f.path));
  }
}

// ── what the link picker offers ─────────────────────────────────────────────

/**
 * The relations the link picker offers for a document: every relation the
 * world's links use (`uses`, links per relation) and every one `vocabulary`
 * declares, each declared one with its words. Most used first; at equal use a
 * declared one before one that is not, then by name. With no vocabulary in
 * force, exactly the relations in use, by count, as before the vocabulary.
 */
export function relationOffers(
  uses: ReadonlyMap<string, number>,
  vocabulary: Vocabulary,
): RelationOffer[] {
  const out = new Map<string, RelationOffer>();
  for (const [rel, count] of uses) out.set(rel, { rel, count, declared: false });
  for (const d of vocabulary.relations.values())
    out.set(d.rel, {
      rel: d.rel,
      count: uses.get(d.rel) ?? 0,
      declared: true,
      label: d.label,
      ...(d.means !== undefined ? { means: d.means } : {}),
      ...(d.symmetric ? { symmetric: true as const } : {}),
      ...(d.inverse !== undefined ? { inverse: d.inverse } : {}),
      ...(d.color !== undefined ? { color: d.color } : {}),
    });
  return [...out.values()].sort(
    (a, b) =>
      b.count - a.count || Number(b.declared) - Number(a.declared) || a.rel.localeCompare(b.rel),
  );
}

// ── the symmetry hint ───────────────────────────────────────────────────────

/** A typed link between two documents, resolved: what the symmetry hint reads. */
export type TypedEdge<L> = { from: string; to: string; rel: string; link: L };

/**
 * The links that carry a SYMMETRIC relation one way only: A writes `rel` to B,
 * and B writes no link with `rel` back to A. One per (A, B, rel), the first
 * link A writes standing for the rest. A link to itself answers itself, so it
 * is never one. `symmetric(doc, rel)` says whether `rel` is symmetric in the
 * vocabulary in force at document `doc`.
 *
 * ⛔ SYMMETRIC AT BOTH ENDS. The hint asks B to write `rel` back, in B's own
 * words; when `rel` is symmetric only in a vocabulary nested on A's side (B's
 * vocabulary leaves it undeclared, or one-way), asking B for it would ask for a
 * relation B's world does not hold to read both ways. So it is a hint only
 * when both ends' vocabularies say symmetric.
 *
 * ⚠ A HINT, NEVER A PROBLEM: the human may not want the reverse link.
 */
export function oneWaySymmetric<L>(
  edges: Iterable<TypedEdge<L>>,
  symmetric: (doc: string, rel: string) => boolean,
): TypedEdge<L>[] {
  const all = [...edges];
  const written = new Set(all.map((e) => `${e.from}\0${e.to}\0${e.rel}`));
  const said = new Set<string>();
  const out: TypedEdge<L>[] = [];
  for (const e of all) {
    if (e.from === e.to || !symmetric(e.from, e.rel) || !symmetric(e.to, e.rel)) continue;
    const key = `${e.from}\0${e.to}\0${e.rel}`;
    if (said.has(key) || written.has(`${e.to}\0${e.from}\0${e.rel}`)) continue;
    said.add(key);
    out.push(e);
  }
  return out;
}

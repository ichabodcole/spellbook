/**
 * The session's constants and the facts read from a document: the caps on an
 * answer, the manifest's format, the folders the session names, a document's
 * frontmatter facts and how the world's typed links use each relation. Tier 0
 * of the session parts (docs/architecture/workspace-session.md).
 */

import { parseDocument } from "yaml";
import { splitFrontmatter } from "../../lib/frontmatter.ts";
import { withoutCode } from "../../lib/markdownCode.ts";
import { countPair, type KindPairUse } from "../../lib/relationUse.ts";
import type { FieldRule, ProfileLookup, ProfileMatch } from "../profiles";
import type { DocumentProfile, Version } from "../protocol";

export const MANIFEST_FORMAT = 1;

/**
 * How many backlinks one answer carries. The documents read are already bounded
 * the way search and the link picker's are (each context entry lists at most
 * MIRROR_NODE_CAP); this bounds what one heavily linked document can send.
 */
export const BACKLINK_CAP = 500;

/** Schemes a link opens outward, in a browser: what `outlinks` marks `outward`. */
export const OUTWARD = new Set(["http", "https", "mailto"]);

/** How many distinct embeds one `embeds` answer resolves: a document with more shows the rest as placeholders. */
export const EMBED_CAP = 200;

/** How many moves the session keeps for the link check's `proposed` (`moves`). */
export const MOVES_KEPT = 500;

/**
 * A version kept from an outside write to the active one (`preserveOutside`):
 * the agent's by its record, but no proposal. `Version.outside` marks it; one
 * kept before that field, by its label.
 */
export const keptOutside = (v: Version): boolean =>
  v.outside === true || /^outside write to v\d+$/.test(v.label ?? "");

/** How many entries each section of one link check carries; its `count` is the whole. */
export const LINK_CHECK_CAP = 500;

/** How many warnings one profile check lists; its `count` is the whole. */
export const PROFILE_CHECK_CAP = 500;

/**
 * How many documents one link graph answer carries, the best connected first;
 * `total` is the whole. At about twenty links each, 500 documents is already
 * thousands of edges, and no drawing reads more than a few hundred nodes.
 */
export const GRAPH_CAP = 500;

/**
 * What the graph and the profile check read from a document besides its links,
 * kept in the same per-file cache: its frontmatter `title`, `type` and `status`
 * (scalars only), its first `#` heading, and the whole frontmatter block parsed
 * (`fields`, null when there is none or it does not parse), which a profile
 * checks. Frontmatter is the first few hundred bytes, so holding it costs
 * little at 2,500 documents.
 */

export type DocFacts = {
  title: string | null;
  type: string | null;
  status: string | null;
  heading: string | null;
  fields: Record<string, unknown> | null;
  /** Why a frontmatter block that is there could not be read as fields; else null. */
  unparsed: string | null;
};

export const NO_FACTS: DocFacts = {
  title: null,
  type: null,
  status: null,
  heading: null,
  fields: null,
  unparsed: null,
};

/** How many warnings one document contributes to a profile check; the rest are counted. */
export const PROFILE_WARNINGS_PER_DOC = 20;

/** One pass's profile lookup (`profilePass`): the profile a document matches. */
export type ProfilePass = {
  lookup: ProfileLookup;
  match: (path: string, facts: DocFacts) => ProfileMatch;
};

/** What `profile <doc>` shows of one field's rule. */
type FieldView = Omit<NonNullable<DocumentProfile["fields"]>[number], "field" | "required">;

export function ruleView(rule: FieldRule): FieldView {
  if (rule === false) return { forbidden: true };
  return {
    ...(rule.type ? { type: rule.type } : {}),
    ...(rule.enum ? { enum: rule.enum } : {}),
    ...(rule.const ? { const: rule.const.value } : {}),
    ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
    ...(rule.description !== undefined ? { description: rule.description } : {}),
  };
}

/** A frontmatter value the graph can show: a string or a number, trimmed; else null. */
const scalar = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;

/** What a card adds to a summary: the `description` and the count of links to files. */
export function cardFacts(
  facts: DocFacts,
  links: readonly { scheme?: string }[],
): { description?: string; links: number } {
  const description = scalar(facts.fields?.description);
  return {
    ...(description !== null ? { description } : {}),
    links: links.filter((l) => l.scheme === undefined).length,
  };
}

/** The first level-one ATX heading of a body, without its marks. */
const FIRST_HEADING = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m;

/** A document's facts, read from its whole text. A block that will not parse has none. */
/** Text as one line: every run of whitespace, newlines included, one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function docFacts(text: string): DocFacts {
  const { raw, body } = splitFrontmatter(text);
  const heading = FIRST_HEADING.exec(withoutCode(body))?.[1]?.trim() || null;
  if (raw === null) return { ...NO_FACTS, heading };
  try {
    const doc = parseDocument(raw, { prettyErrors: false });
    const error = doc.errors[0];
    if (error)
      return {
        ...NO_FACTS,
        heading,
        unparsed: `does not parse as YAML: ${firstLine(error.message)}`,
      };
    const parsed = doc.toJS() as unknown;
    // An empty block is no frontmatter, not a broken one.
    if (parsed === null || parsed === undefined) return { ...NO_FACTS, heading };
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return {
        ...NO_FACTS,
        heading,
        unparsed: `is ${Array.isArray(parsed) ? "a list" : "a single value"}, not a mapping of fields`,
      };
    const f = parsed as Record<string, unknown>;
    return {
      title: scalar(f.title),
      type: scalar(f.type),
      status: scalar(f.status),
      heading,
      fields: f,
      unparsed: null,
    };
  } catch (e) {
    return {
      ...NO_FACTS,
      heading,
      unparsed: `does not parse as YAML: ${firstLine(e instanceof Error ? e.message : String(e))}`,
    };
  }
}

const firstLine = (t: string) => t.split("\n")[0]?.trim() ?? "";

/**
 * How the world's typed links use each relation: how many links carry it, and
 * how many between each pair of kinds (a link into a document with no kind,
 * or into none, counts only in `uses`). What the link picker ranks by.
 */
export function relationUses(
  kinds: ReadonlyMap<string, string | null>,
  links: readonly { source: string; rel: string[]; to: string | null }[],
): { uses: Map<string, number>; pairs: KindPairUse[] } {
  const uses = new Map<string, number>();
  const pairs = new Map<string, KindPairUse>();
  for (const l of links) {
    const toKind = l.to === null ? null : (kinds.get(l.to) ?? null);
    const fromKind = kinds.get(l.source) ?? null;
    for (const rel of l.rel) {
      uses.set(rel, (uses.get(rel) ?? 0) + 1);
      if (toKind !== null) countPair(pairs, fromKind, toKind, rel);
    }
  }
  return { uses, pairs: [...pairs.values()] };
}

/** The folder inside a session that stands in as the workspace when none was chosen. */
export const IMPORTED_DIR = "imported";

/** The folder beside a document that an image pasted or dropped into it lands in. */
export const IMAGES_DIR = "images";

/** The most names of converted images the manifest remembers for their descriptions. */
export const IMPORT_NAMES_MAX = 500;

/**
 * OKF frontmatter, read (E32). The daemon parses; the surface renders what it
 * is given — `Bun.YAML.parse` is here, so no YAML parser reaches the browser.
 *
 * ⛔ THE SPEC'S TEMPER IS THE POINT, AND IT IS NOT THE USUAL ONE. A consumer
 * "MUST NOT reject documents" for unknown types, unknown keys, missing optional
 * fields or broken links, and "SHOULD preserve unknown keys when round-tripping"
 * (OKF 0.2 §11). So nothing here validates: a document whose frontmatter will
 * not parse keeps its text and reports the reason, every key survives in
 * `fields` whether or not this spell has heard of it, and `type` — the ONE
 * required field — being absent is a fact to show, never an error to raise.
 *
 * The DERIVED values (trust, staleness) are computed on read and never stored,
 * which is also the spec's rule: a trust tier written into a file would be a
 * claim about itself.
 */
import type { DocMeta, DocSummary, TrustTier } from "./protocol";

/** A frontmatter block: `---` on its own first line, to the next `---` line. */
const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Split a document into its raw frontmatter block and the body beneath it.
 * Pure string work, no YAML — the SURFACE has the same function (it must strip
 * the block before rendering) and `frontmatter.test.ts` holds the two equal.
 */
/**
 * How many lines of a document come BEFORE its body — the frontmatter block and
 * its delimiters.
 *
 * ⛔ WITHOUT THIS A REPORTED LINE NUMBER IS A LIE. Links are extracted from the
 * BODY, so a link on body line 9 of a document with four lines of frontmatter
 * is on FILE line 13 — and a report that says 9 sends whoever is fixing it to
 * the wrong place, confidently. Caught the moment E54's report was first read
 * against a document that had frontmatter.
 */
export function bodyLineOffset(text: string): number {
  const { body } = splitFrontmatter(text);
  const prefix = text.slice(0, text.length - body.length);
  let lines = 0;
  for (let i = 0; i < prefix.length; i++) if (prefix.charCodeAt(i) === 10) lines++;
  return lines;
}

export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  const m = BLOCK.exec(text);
  if (!m) return { raw: null, body: text };
  return { raw: m[1] ?? "", body: text.slice(m[0].length) };
}

/** OKF's three, and anything else a producer wrote. `stable` is the default. */
function statusOf(fields: Record<string, unknown>): string {
  const s = fields.status;
  return typeof s === "string" && s.trim() !== "" ? s : "stable";
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" ? [v] : [];

/** An actor is human iff it is spelled `human:<id>` — OKF 0.2 §6's rule. */
const isHuman = (actor: unknown): boolean =>
  typeof actor === "string" && actor.toLowerCase().startsWith("human:");

/**
 * OKF's trust tiers, DERIVED: no `verified` → unverified; verified by machines
 * only → machine-confirmed; verified by a `human:<id>` → human-reviewed.
 */
export function trustTier(fields: Record<string, unknown>): TrustTier {
  const verified = fields.verified;
  const events = Array.isArray(verified) ? verified : verified ? [verified] : [];
  if (events.length === 0) return "unverified";
  for (const e of events)
    if (e && typeof e === "object" && isHuman((e as { by?: unknown }).by)) return "human-reviewed";
  return "machine-confirmed";
}

/** `stale_after` is an INSTANT, not a TTL: stale when now >= it. */
export function isStale(fields: Record<string, unknown>, now: number): boolean {
  const at = fields.stale_after;
  const t =
    at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(t) && now >= t;
}

/** When the content last meaningfully changed, per `generated.at`, as an ISO date. */
export function generatedAt(fields: Record<string, unknown>): string | null {
  const g = fields.generated;
  const at = g && typeof g === "object" ? (g as { at?: unknown }).at : undefined;
  if (at instanceof Date) return at.toISOString().slice(0, 10);
  if (typeof at === "string") {
    const t = Date.parse(at);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : at;
  }
  return null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/**
 * Read a document's frontmatter. Returns null when there is no block at all —
 * which is a normal document, not a defect. A block that will not parse comes
 * back with `error` set and every other field empty: said, not swallowed.
 */
export function readMeta(text: string, now = Date.now()): DocMeta | null {
  const { raw } = splitFrontmatter(text);
  if (raw === null) return null;
  let fields: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    const parsed = Bun.YAML.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      fields = parsed as Record<string, unknown>;
    else if (parsed !== null && parsed !== undefined)
      error = "the frontmatter is not a mapping of keys to values";
  } catch (e) {
    error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  }
  return {
    raw,
    fields,
    type: str(fields.type),
    title: str(fields.title),
    description: str(fields.description),
    status: statusOf(fields),
    tags: asList(fields.tags),
    lifecycle: str(fields.lifecycle),
    trust: trustTier(fields),
    stale: isStale(fields, now),
    date: generatedAt(fields),
    ...(error ? { error } : {}),
  };
}

/** The small shape the sidebar needs for every context document. */
export function summarize(meta: DocMeta | null): DocSummary | null {
  if (!meta) return null;
  return {
    ...(meta.type ? { type: meta.type } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    status: meta.status,
    tags: meta.tags,
    trust: meta.trust,
    stale: meta.stale,
    ...(meta.lifecycle ? { lifecycle: meta.lifecycle } : {}),
    ...(meta.error ? { error: meta.error } : {}),
  };
}

/** pdocs's filter vocabulary, so what the human learns there holds here. */
export type MetaFilter = {
  type?: string;
  status?: string;
  lifecycle?: string;
  tag?: string;
  /** An ISO date; matches documents whose `generated.at` is on or after it. */
  since?: string;
};

/**
 * Filters are ANDed, and every one is optional — a bare filter matches all.
 *
 * ⛔ A DOCUMENT WITH NO FRONTMATTER MATCHES ONLY THE EMPTY FILTER, and that
 * includes `--status stable`. Absent `status` defaults to `stable` for an OKF
 * document (§5), but a document with no block at all is not making the claim:
 * `find --status stable` asks which documents SAY they are stable, and a file
 * with no frontmatter says nothing. Reading the default the other way would put
 * every untouched note in the result.
 */
export function matchesFilter(meta: DocMeta | null, filter: MetaFilter): boolean {
  if (meta === null) return Object.values(filter).every((v) => v === undefined);
  if (filter.type !== undefined && meta.type !== filter.type) return false;
  if (filter.status !== undefined && meta.status !== filter.status) return false;
  if (filter.lifecycle !== undefined && meta.lifecycle !== filter.lifecycle) return false;
  if (filter.tag !== undefined && !meta.tags.includes(filter.tag)) return false;
  if (filter.since !== undefined) {
    if (!meta.date) return false;
    if (meta.date < filter.since) return false;
  }
  return true;
}

// ── WRITING (E35) ────────────────────────────────────────────────────────────
//
// ⛔ EVERY WRITE HERE IS A TEXT EDIT, NEVER A RESERIALISATION. Parsing a block
// and printing it back reorders keys, drops comments and changes quoting — and
// the spec asks a consumer to "preserve unknown keys when round-tripping"
// (§11), which is precisely what that loses. So a new block is BUILT (there is
// nothing to preserve yet) and an existing one is edited a LINE at a time.

/** The document's first H1, which is the title a human already wrote. */
export function titleFromBody(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
    if (line.trim() !== "" && !line.startsWith("#")) break; // prose before any heading
  }
  return undefined;
}

/**
 * A `type` to SUGGEST for a document that has none.
 *
 * ⛔ FROM THE NEIGHBOURS, NEVER FROM A FIXED LIST. OKF's `type` is "not
 * centrally registered" and every corpus invents its own — `report`, `rule`,
 * `archetype` in one, something else in the next — so the only honest source is
 * what the documents beside this one already say. The folder's name is the
 * fallback, and when neither answers, nothing is suggested: a blank the human
 * fills beats a plausible guess (SCHEMA.md's own rule about `generated.by`).
 */
export function guessType(siblingTypes: readonly string[], folder: string): string | undefined {
  const counts = new Map<string, number>();
  for (const t of siblingTypes) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return best[0];
  const name = folder.trim().toLowerCase();
  if (name === "" || name === "." || name === "/") return undefined;
  // `decisions/` → `decision`; `docs/` → `doc`. A plural folder names its kind.
  return name.endsWith("ies")
    ? `${name.slice(0, -3)}y`
    : name.endsWith("s")
      ? name.slice(0, -1)
      : name;
}

/** A YAML scalar, quoted only when it must be. */
function scalar(value: string): string {
  return /^[\w .,''/@+-]*$/.test(value) && !/^\s|\s$/.test(value) && value !== ""
    ? value
    : JSON.stringify(value);
}

export type NewMeta = {
  type?: string;
  title?: string;
  description?: string;
  status?: string;
  tags?: string[];
  /** `generated.by` — the actor, recorded honestly or left `unknown`. */
  by?: string;
  at?: string;
};

/**
 * A frontmatter block for a document that has none. OKF's recommended set in
 * the order the corpora write it, with `description` left EMPTY for the author:
 * a one-line summary nobody wrote is worse than a blank that asks to be filled.
 */
export function buildBlock(meta: NewMeta): string {
  const at = meta.at ?? new Date().toISOString().slice(0, 10);
  const lines = [
    `type: ${scalar(meta.type ?? "")}`,
    `title: ${scalar(meta.title ?? "")}`,
    `description: ${meta.description ? scalar(meta.description) : ""}`,
    `tags: [${(meta.tags ?? []).map(scalar).join(", ")}]`,
    `status: ${scalar(meta.status ?? "draft")}`,
    `generated: { by: ${scalar(meta.by ?? "unknown")}, at: ${at} }`,
  ];
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Put a new block at the top of a document that has none. No blank line is
 * inserted: the corpora write the body directly under the closing `---`, and a
 * block that adds one would show as a diff on every document it touches.
 */
export function withBlock(text: string, block: string): string {
  return `${block}${text}`;
}

/**
 * Set one key in an EXISTING block, as a line edit: the key's line is replaced
 * where it exists and appended before the closing `---` where it does not.
 * Everything else — order, comments, spacing, keys this spell never heard of —
 * survives byte for byte.
 */
export function setKey(text: string, key: string, value: string): string {
  const { raw } = splitFrontmatter(text);
  if (raw === null) throw new Error("this document has no frontmatter block");
  const line = `${key}: ${scalar(value)}`;
  const keyLine = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`);
  const lines = raw.split("\n");
  const at = lines.findIndex((l) => keyLine.test(l));
  if (at === -1) lines.push(line);
  else {
    // A multi-line value (a folded description, a nested mapping) is the
    // key's line PLUS every indented line under it; all of them go.
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end++;
    lines.splice(at, end - at, line);
  }
  const rebuilt = lines.join("\n");
  return text.replace(raw, rebuilt);
}

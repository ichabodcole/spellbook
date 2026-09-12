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

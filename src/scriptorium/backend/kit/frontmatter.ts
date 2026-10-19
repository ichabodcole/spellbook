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
/** OKF 0.2 §6's tiers, DERIVED from `verified` on read and never stored. */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/**
 * A document's frontmatter, read (E32). `fields` carries EVERY key, known or
 * not — the spec requires a consumer to preserve what it does not understand,
 * and the surface shows the rest as labelled values.
 */
export type DocMeta = {
  /** The block as written, so a writer can round-trip what it did not parse. */
  raw: string;
  fields: Record<string, unknown>;
  /** OKF's one REQUIRED field — absent is a fact to show, not an error. */
  type?: string;
  title?: string;
  description?: string;
  /** `draft | stable | deprecated` in practice; any string in principle. Defaults to `stable`. */
  status: string;
  tags: string[];
  /** A house extension (pdocs), shown and filterable, never validated. */
  lifecycle?: string;
  trust: TrustTier;
  stale: boolean;
  /** `generated.at` as an ISO date, for `find --since`. */
  date: string | null;
  /** The frontmatter would not parse. The document is still a document. */
  error?: string;
};

/** What the sidebar needs for every context document — small, because it rides every snapshot. */
export type DocSummary = {
  type?: string;
  title?: string;
  status: string;
  tags: string[];
  lifecycle?: string;
  trust: TrustTier;
  stale: boolean;
  error?: string;
};

/** The most documents one frontmatter scan reads. */
export const META_SCAN_CAP = 500;

/**
 * A frontmatter block: `---` on its own first line, to the next `---` line.
 * A byte-order mark before the fence is part of the file, not of the first
 * line (meta-set-byte-safety): without it here a BOM hid the block from every
 * reader and writer, so `meta-init` stacked a second block above the first.
 */
const BLOCK = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A file's byte-order mark, which stays first whatever is written after it. */
const BOM = "\uFEFF";

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
 * The tier stays on the wire for every document (OKF's rule; `meta` and `state`
 * readers see it beside `fields`), but the surface's header shows it only when
 * `verified` is present: "unverified" from a missing field is not shown (E69).
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
  // A byte-order mark stays the file's first character, before the block.
  return text.startsWith(BOM) ? `${BOM}${block}${text.slice(BOM.length)}` : `${block}${text}`;
}

/**
 * Set one key in an EXISTING block, as a line edit: the key's line is replaced
 * where it exists and appended before the closing `---` where it does not.
 * Everything else — order, comments, spacing, keys this spell never heard of —
 * survives byte for byte.
 *
 * ⛔ THE FIVE WAYS THIS ONCE WROTE MORE THAN ONE KEY (meta-set-byte-safety,
 * found on both paths by the wiki-verbs verifier, 2026-10-17), each a test:
 * - the block is spliced back BY POSITION, never with `String.replace`, whose
 *   replacement string reads `$&`, `$'` and `` $` `` in a value as patterns
 *   and pasted the block into the title;
 * - so an EMPTY block (`---\n\n---`, whose raw text is "") gets its key inside
 *   the fences, not before the opening one (where `replace("", …)` put it);
 * - a CRLF block gets CRLF lines: the written line takes the line ending the
 *   line it replaces had, and an appended one the opening fence's;
 * - a key written quoted (`"status": draft`, `'status': draft`) is the same
 *   key, replaced as written rather than appended a second time;
 * - a block after a byte-order mark is a block (`BLOCK`).
 * And a key named twice (`"status": a` then `status: b`, or two bare lines)
 * has its LAST line set, the one YAML reads, so the set takes effect.
 */
export function setKey(text: string, key: string, value: string): string {
  const m = BLOCK.exec(text);
  if (!m) throw new Error("this document has no frontmatter block");
  const raw = m[1] ?? "";
  // The block's text starts after the opening fence's line break.
  const start = m[0].indexOf("\n") + 1;
  const cr = m[0].slice(0, start).endsWith("\r\n") ? "\r" : "";
  const name = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyLine = new RegExp(`^(${name}|"${name}"|'${name}')\\s*:`);
  const written = (spelled: string) => `${spelled}: ${scalar(value)}`;
  const lines = raw.split("\n");
  // The LAST line that names the key: a block that names it twice means the
  // last one to YAML (last wins), so that is the one a set must change.
  const at = lines.findLastIndex((l) => keyLine.test(l));
  if (at === -1) {
    // The new line goes last; the line that was last now ends as the block's lines do.
    lines[lines.length - 1] += cr;
    lines.push(written(key));
  } else {
    const spelled = (keyLine.exec(lines[at] ?? "") as RegExpExecArray)[1] as string;
    // A multi-line value (a folded description, a nested mapping) is the
    // key's line PLUS every indented line under it; all of them go.
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end++;
    const ending = (lines[end - 1] ?? "").endsWith("\r") ? "\r" : "";
    lines.splice(at, end - at, `${written(spelled)}${ending}`);
  }
  return text.slice(0, start) + lines.join("\n") + text.slice(start + raw.length);
}

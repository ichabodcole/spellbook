// A document's frontmatter, as the rendered view reads it. The block is metadata,
// so it leaves the rendered body and becomes a header above it; the raw view still
// shows it as written.
//
// NOTHING HERE VALIDATES. A document whose block will not parse keeps its body and
// reports why, every key survives in `fields` whether or not the kit has heard of
// it, and a missing key is a fact to show (by showing nothing), never an error. The
// header names a few keys and shows the rest as labelled values, because a reader
// that hides a field it does not understand is discarding it as far as the human
// is concerned.
//
// Pure: no DOM, no React. The header that draws this is `FrontmatterHeader.tsx`;
// what counts as a block at all is `lib/frontmatter.ts`, shared with app backends.
import { parseDocument } from "yaml";
import { splitFrontmatter } from "../lib/frontmatter.ts";

/** A document's frontmatter, read. */
export type Frontmatter = {
  /** The block as written, between its delimiters. */
  raw: string;
  /** Every key the block has, known or not. Empty when it would not parse. */
  fields: Record<string, unknown>;
  /** Why the block could not be read; the body is still shown. */
  error?: string;
};

/**
 * Read a document's frontmatter. Null when there is no block, which is a normal
 * document. A block that will not parse, or parses to something other than a
 * mapping, comes back with `error` set and no fields: said, not swallowed.
 */
export function readFrontmatter(text: string): Frontmatter | null {
  const { raw } = splitFrontmatter(text);
  if (raw === null) return null;
  try {
    // The core schema: a date stays the string it was written as. A document, not
    // `parse`, so a warning is not logged and an error is a value to report.
    const doc = parseDocument(raw, { prettyErrors: false });
    const first = doc.errors[0];
    if (first) return { raw, fields: {}, error: first.message.split("\n")[0] ?? first.message };
    const parsed = doc.toJS() as unknown;
    if (parsed === null || parsed === undefined) return { raw, fields: {} };
    if (typeof parsed === "object" && !Array.isArray(parsed))
      return { raw, fields: parsed as Record<string, unknown> };
    return { raw, fields: {}, error: "the block is not a mapping of keys to values" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { raw, fields: {}, error: message.split("\n")[0] ?? message };
  }
}

/** A value from arbitrary YAML, as one line of text. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(showValue).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${showValue(v)}`)
      .join(" · ");
  return String(value);
}

/** A non-empty string field, trimmed; anything else is absent. */
export function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** A list field's strings: a YAML list, or a lone string as a list of one. */
export function listField(fields: Record<string, unknown>, key: string): string[] {
  const v = fields[key];
  if (Array.isArray(v))
    return v.filter((x) => typeof x === "string" || typeof x === "number").map(String);
  return typeof v === "string" && v.trim() !== "" ? [v.trim()] : [];
}

/**
 * Trust, derived rather than read: no `verified` is unverified, verified by
 * machines only is machine-confirmed, verified by a `human:<id>` is human-reviewed.
 * A file asserting its own trust tier would be asserting the wrong thing, so the
 * tier is never a field.
 */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export function trustTier(fields: Record<string, unknown>): TrustTier {
  const verified = fields.verified;
  const events = Array.isArray(verified) ? verified : verified ? [verified] : [];
  if (events.length === 0) return "unverified";
  for (const e of events) {
    const by = e && typeof e === "object" ? (e as { by?: unknown }).by : undefined;
    if (typeof by === "string" && by.toLowerCase().startsWith("human:")) return "human-reviewed";
  }
  return "machine-confirmed";
}

/** `generated.at` as a date, when there is one. */
export function generatedAt(fields: Record<string, unknown>): string | null {
  const g = fields.generated;
  const at = g && typeof g === "object" ? (g as { at?: unknown }).at : undefined;
  if (at instanceof Date) return at.toISOString().slice(0, 10);
  if (typeof at === "string" && at.trim() !== "") return at.trim();
  return null;
}

// Finding things across the context: fuzzy on document names, exact in text.
//
// Two matchers on purpose, because they answer different questions. Fuzzy on
// names is for jumping ("mbak" finds "Maren's Bakery"); exact on text is for
// finding ("where did I write 'asking nicely'"). Fuzzy full-text would
// surface documents that merely contain similar-looking letters and would
// make "this phrase is on line 29" untrustworthy, which is the only thing a
// text search is for.
//
// The caller supplies each document's text, and the session supplies the
// ACTIVE VERSION as it holds it. That is the reason the verb exists for an
// agent at all: `grep` over the workspace reads the saved file and silently
// misses the version the human is reading.

import { fold, scoreName } from "../lib/fuzzy.ts";
import type { SearchReport, SearchResult } from "./protocol";

// The scorer lives in `lib`, so a pane can rank in the browser with the same
// taste the daemon searches with (the link picker does).
export { fold, scoreName };

/** A document to search. */
export type Candidate = {
  path: string;
  name: string;
  slug: string | null;
  version: number | null;
};

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 500;
/** How many name matches are worth showing before the text matches. */
export const NAME_CAP = 10;
/** Per-document cap on text matches, so one huge document cannot fill the list. */
export const PER_DOC = 20;
/** How much of a line a snippet carries. */
export const SNIPPET_CAP = 160;

type Hit = {
  line: number;
  column: number;
  from: number;
  to: number;
  snippet: string;
  snippetFrom: number;
  snippetTo: number;
};

/** How much of the line before a match a windowed snippet keeps. */
const LEAD = 50;

/** A line cut to a window around the match, with "…" at each cut end. */
function windowed(
  line: string,
  at: number,
  len: number,
): { text: string; from: number; to: number } {
  if (line.length <= SNIPPET_CAP) return { text: line, from: at, to: at + len };
  const start = Math.max(0, Math.min(at - LEAD, line.length - SNIPPET_CAP));
  const end = Math.min(line.length, start + SNIPPET_CAP);
  const head = start > 0 ? "…" : "";
  const tail = end < line.length ? "…" : "";
  const text = `${head}${line.slice(start, end)}${tail}`;
  const from = head.length + (at - start);
  return { text, from, to: Math.min(from + len, head.length + (end - start)) };
}

/** Every match of `query` in `text` (case-insensitive, literal), at most `limit`. */
export function searchText(text: string, query: string, limit: number): Hit[] {
  const needle = fold(query.trim());
  if (needle === "" || limit <= 0) return [];
  const hay = fold(text);
  let at = hay.indexOf(needle);
  if (at === -1) return [];
  // Line starts, walked once: a per-hit `lastIndexOf` is quadratic over a
  // document that matches on every line.
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const hits: Hit[] = [];
  let cursor = 0;
  while (at !== -1 && hits.length < limit) {
    while (cursor + 1 < starts.length && (starts[cursor + 1] as number) <= at) cursor++;
    const lineStart = starts[cursor] as number;
    const lineEnd = cursor + 1 < starts.length ? (starts[cursor + 1] as number) - 1 : text.length;
    const raw = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const lead = raw.length - raw.trimStart().length;
    const line = raw.trim();
    const w = windowed(line, Math.max(0, at - lineStart - lead), needle.length);
    hits.push({
      line: cursor + 1,
      column: at - lineStart + 1,
      from: at,
      to: at + needle.length,
      snippet: w.text,
      snippetFrom: w.from,
      snippetTo: w.to,
    });
    // Advance past the match, not the line: two hits on one line are two hits.
    at = hay.indexOf(needle, at + needle.length);
  }
  return hits;
}

/** The name without its extension, which is what a person types at. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Search `candidates`. `read` returns a document's text, or null for one that
 * has gone missing: a search is not the moment to fail over that, so it is
 * skipped rather than reported as a document with no hits.
 */
export function searchDocuments(
  candidates: readonly Candidate[],
  query: string,
  read: (c: Candidate) => string | null,
  limit: number = DEFAULT_LIMIT,
): SearchReport {
  const q = query.trim();
  const cap = Math.max(0, Math.min(Math.floor(limit), MAX_LIMIT));
  if (q === "" || cap === 0) return { query: q, results: [], count: 0, truncated: false };

  const named = candidates
    .flatMap((c) => {
      const s = scoreName(stem(c.name), q);
      return s === null ? [] : [{ c, s }];
    })
    .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));

  const results: SearchResult[] = [];
  let truncated = false;
  for (const { c } of named) {
    if (results.length >= Math.min(NAME_CAP, cap)) {
      truncated = true;
      break;
    }
    results.push({ kind: "name", slug: c.slug, name: c.name, path: c.path, version: c.version });
  }

  scan: for (const c of candidates) {
    let body: string | null = null;
    try {
      body = read(c);
    } catch {
      body = null;
    }
    if (body === null) continue;
    const room = cap - results.length;
    const hits = searchText(body, q, Math.min(PER_DOC, room) + 1);
    for (const [i, h] of hits.entries()) {
      if (i >= PER_DOC || results.length >= cap) {
        truncated = true;
        if (results.length >= cap) break scan;
        break;
      }
      results.push({
        kind: "text",
        slug: c.slug,
        name: c.name,
        path: c.path,
        version: c.version,
        line: h.line,
        column: h.column,
        from: h.from,
        to: h.to,
        snippet: h.snippet,
        snippetFrom: h.snippetFrom,
        snippetTo: h.snippetTo,
      });
    }
  }
  return { query: q, results, count: results.length, truncated };
}

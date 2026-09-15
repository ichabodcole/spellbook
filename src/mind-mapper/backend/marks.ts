// V1.x Claim B — `mark <docId> --status <s> [--note <t>]` backing: an
// append-only stigmergic trail on docs; the latest row per doc is the live
// mark. Status vocabulary is deliberately freeform (analyzed/read/skimmed/…)
// and `note` carries the judgment INCLUDING null results ("nothing worth
// extracting" is a finding). doc_mtime snapshots the doc file's mtime at
// mark time so staleness is read-time-computed (current mtime > marked
// mtime; missing file → stale) — the Operator indexedAt partial-index-trust
// principle. `stale` lives in /state only, never in the doc.marked event.

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";

// The event payload shape (full mark inline — marks are small and
// append-only; thin-refetch is for mutable entities). No `stale` here.
interface DocMark {
  author: string;
  note: string | null;
  status: string;
  ts: number;
}

interface MarkInput {
  docId: string;
  author: string;
  status: string;
  note?: string;
}

interface MarkRow {
  doc_id: string;
  author: string;
  note: string | null;
  status: string;
  doc_mtime: number | null;
  ts: number;
}

function docFileMtime(projectDir: string, relPath: string): number | null {
  try {
    return Math.floor(statSync(join(projectDir, relPath)).mtimeMs);
  } catch {
    return null;
  }
}

// Pure staleness rule, stated once: unknown mtimes read as stale (a mark on
// a file we can't see anymore vouches for nothing).
function isStale(markedMtime: number | null, currentMtime: number | null): boolean {
  if (markedMtime === null || currentMtime === null) return true;
  return currentMtime > markedMtime;
}

// Pure latest-per-doc reduction over an append-only trail. Rows must arrive
// in insertion order (rowid) — ts alone is second-granular and can tie.
function latestPerDoc(rows: MarkRow[]): Map<string, MarkRow> {
  const latest = new Map<string, MarkRow>();
  for (const row of rows) latest.set(row.doc_id, row);
  return latest;
}

function markDoc(db: Database, bus: EventBus, projectDir: string, input: MarkInput): DocMark {
  if (!SLUG_RE.test(input.docId)) throw new Error(`invalid doc id: ${input.docId}`);
  const doc = db.query("SELECT path FROM docs WHERE id = ?").get(input.docId) as {
    path: string;
  } | null;
  if (!doc) throw new Error(`unknown doc: ${input.docId}`);
  if (typeof input.status !== "string" || input.status.length === 0) {
    throw new Error("mark requires a non-empty status");
  }
  const docMtime = docFileMtime(projectDir, doc.path);
  const ts = Math.floor(Date.now() / 1000);
  db.run(
    "INSERT INTO doc_marks (id, doc_id, author, note, status, doc_mtime, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      crypto.randomUUID(),
      input.docId,
      input.author,
      input.note ?? null,
      input.status,
      docMtime,
      ts,
    ],
  );
  const mark: DocMark = {
    author: input.author,
    note: input.note ?? null,
    status: input.status,
    ts,
  };
  bus.emit("doc.marked", { docId: input.docId, mark: mark as unknown as Record<string, unknown> });
  return mark;
}

// The /state merge: latest mark per doc with read-time stale. `mtimeOf`
// resolves a doc's CURRENT file mtime — null when the project root is
// unknown or the file is gone (both read as stale, honestly).
function readDocMarks(
  db: Database,
  mtimeOf: (docId: string) => number | null,
): Map<string, DocMark & { stale: boolean }> {
  const rows = db
    .query("SELECT doc_id, author, note, status, doc_mtime, ts FROM doc_marks ORDER BY rowid")
    .all() as MarkRow[];
  const out = new Map<string, DocMark & { stale: boolean }>();
  for (const [docId, row] of latestPerDoc(rows)) {
    out.set(docId, {
      author: row.author,
      note: row.note,
      status: row.status,
      stale: isStale(row.doc_mtime, mtimeOf(docId)),
      ts: row.ts,
    });
  }
  return out;
}

export type { DocMark, MarkInput, MarkRow };
export { docFileMtime, isStale, latestPerDoc, markDoc, readDocMarks };

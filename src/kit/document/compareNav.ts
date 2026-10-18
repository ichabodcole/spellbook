// Finding your way between the changes in a comparison: where each change's rows
// are, which row holds a line of the active version, what a change says in a
// picker, and where its mark sits on the minimap. DOM-free, so each rule is a
// unit test rather than something to eyeball; `CompareView` does the scrolling.

import type { DiffHunk } from "../workspace/protocol";
import type { Row } from "./CompareView.tsx";

/** A change's rows in the comparison: `[start, end)`, indices into the rows. */
export type RowSpan = { start: number; end: number };

/** Each hunk's rows, by hunk id, in the order the comparison draws them. */
export function hunkSpans(rows: readonly Row[]): Map<number, RowSpan> {
  const out = new Map<number, RowSpan>();
  rows.forEach((row, i) => {
    if (row.kind !== "change") return;
    const span = out.get(row.hunk);
    if (span) span.end = i + 1;
    else out.set(row.hunk, { start: i, end: i + 1 });
  });
  return out;
}

/** The row drawing 0-based line `line` of the active version (the left side), or the nearest one. */
export function rowOfLine(rows: readonly Row[], line: number): number {
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const a = row.kind === "same" ? row.line.a : row.del?.a;
    if (a === undefined) continue;
    if (a === line) return i;
    // Past it: the line has no row of its own, so the nearest row before it stands in.
    if (a > line) return best === -1 ? i : best;
    best = i;
  }
  return Math.max(0, best);
}

/**
 * What a change says in the picker: its first line with words in it, from the
 * active version's side when it has one (that is the text being read), else
 * the other side's. Flattened and cut, so a long paragraph is one short line.
 */
export function hunkSummary(h: Pick<DiffHunk, "del" | "add">, max = 48): string {
  const first = [...h.del, ...h.add].find((l) => l.trim() !== "") ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  if (flat === "") return "blank lines";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The 1-based line a change is at, as the gutter numbers the active side. */
export function hunkLine(h: Pick<DiffHunk, "aFrom">): number {
  return h.aFrom + 1;
}

/**
 * Where a change's mark sits on the minimap, in percent of its height. `tops`
 * are the measured tops of every row and `height` the content's height, when
 * the view has been laid out; without them (no layout yet, or a test DOM) the
 * rows are taken as equally tall. A mark is never thinner than `minPct`, so a
 * one-line change in a long document can still be seen and clicked.
 */
export function markPlace(
  span: RowSpan,
  total: number,
  measured?: { tops: readonly number[]; height: number } | null,
  minPct = 0.6,
): { top: number; height: number } {
  if (total <= 0) return { top: 0, height: minPct };
  let top: number;
  let bottom: number;
  const m = measured && measured.height > 0 && measured.tops.length === total ? measured : null;
  if (m) {
    top = ((m.tops[span.start] ?? 0) / m.height) * 100;
    bottom = span.end < total ? ((m.tops[span.end] ?? m.height) / m.height) * 100 : 100;
  } else {
    top = (span.start / total) * 100;
    bottom = (span.end / total) * 100;
  }
  const height = Math.max(minPct, bottom - top);
  return { top: Math.min(top, 100 - height), height };
}

// Comparing two texts, and taking part of one into the other (E36).
//
// ⛔ ONE DIFF, COMPUTED IN THE DAEMON. `@codemirror/merge` was measured first
// and it is bundle-clean — its only dependencies are `@codemirror/language`,
// `state`, `view` and `@lezer/highlight`, every one of which the surface
// already ships, so ward 1b has nothing to say about it. It is not used
// anyway, and the reason is not weight: it would give the SURFACE its own
// diff while the `diff` CLI verb used this module's, and a hunk the human
// accepts would then be a hunk a different engine found. Two diff engines over
// one document is the lockstep-mirror drift this repo has already paid for
// once. The surface renders the hunks the daemon computed, and `merge` applies
// the same ones — so a mismatch is not a bug that can be written here.
//
// What this deliberately is not: a semantic or syntactic diff. It compares
// LINES, then refines inside paired lines by WORD, which is what a prose
// reader wants — moved paragraphs read as a delete and an add, and that is
// the honest answer rather than a wrong clever one.
import type { Diff, DiffHunk, DiffLine, DiffSpan } from "./protocol";

/**
 * Splitting on "\n" and joining on "\n" round-trips exactly, INCLUDING the
 * trailing empty string a file ending in a newline produces. That empty line
 * is real as far as this module is concerned, which is what keeps a merge from
 * quietly adding or dropping a final newline.
 */
export function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * The cap on Myers' D — the number of edits it will walk before giving up.
 * Two texts differing by more than this are not something a human reads hunk
 * by hunk anyway, and the quadratic worst case is what the cap exists to keep
 * out of a daemon serving a surface.
 */
const MAX_EDITS = 3000;

/**
 * Myers' greedy O(ND) diff over lines. Returns the trace of V arrays, or null
 * when the texts differ by more than `MAX_EDITS`.
 */
function myersTrace(a: string[], b: string[]): Int32Array[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const size = 2 * max + 1;
  const offset = max;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Take the longer of the two reachable paths: down (an insertion) when
      // k is at the lower edge or the down-neighbour has come further.
      const down = v[offset + k + 1] as number;
      const right = v[offset + k - 1] as number;
      let x: number;
      if (k === -d || (k !== d && right < down)) x = down;
      else x = right + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return trace;
    }
    v = v.slice();
  }
  return null;
}

/** Walk the trace backwards into a list of line operations, front to back. */
function backtrack(a: string[], b: string[], trace: Int32Array[]): DiffLine[] {
  const offset = Math.min(a.length + b.length, MAX_EDITS);
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number)))
      prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ op: "same", a: x, b: y, text: a[x] as string });
    }
    if (d === 0) break;
    if (x > prevX) {
      x--;
      out.push({ op: "del", a: x, text: a[x] as string });
    } else {
      y--;
      out.push({ op: "add", b: y, text: b[y] as string });
    }
  }
  out.reverse();
  return out;
}

/** Every line as one replacement — the honest answer when Myers gives up. */
function coarseLines(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text, i) => ({ op: "del" as const, a: i, text })),
    ...b.map((text, i) => ({ op: "add" as const, b: i, text })),
  ];
}

/** Group the line ops into contiguous hunks, numbered from 1. */
function collect(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let i = 0;
  let id = 1;
  while (i < lines.length) {
    if ((lines[i] as DiffLine).op === "same") {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && (lines[i] as DiffLine).op !== "same") i++;
    const run = lines.slice(start, i);
    const del = run.filter((l) => l.op === "del");
    const add = run.filter((l) => l.op === "add");
    // Where the hunk sits in each text: the index of the first line it touches,
    // and for a pure insertion, the point it is inserted AT.
    const aFrom = del.length ? ((del[0] as DiffLine).a as number) : nextIndex(lines, start, "a");
    const bFrom = add.length ? ((add[0] as DiffLine).b as number) : nextIndex(lines, start, "b");
    hunks.push({
      id: id++,
      aFrom,
      aTo: aFrom + del.length,
      bFrom,
      bTo: bFrom + add.length,
      del: del.map((l) => l.text),
      add: add.map((l) => l.text),
    });
  }
  return hunks;
}

/**
 * The index a pure insertion or deletion sits at: the line number of the next
 * `same` line on that side, or the end of that text when there is none.
 */
function nextIndex(lines: DiffLine[], from: number, side: "a" | "b"): number {
  for (let i = from; i < lines.length; i++) {
    const at = (lines[i] as DiffLine)[side];
    if (at !== undefined) return at;
  }
  let last = -1;
  for (const l of lines) {
    const at = l[side];
    if (at !== undefined && at > last) last = at;
  }
  return last + 1;
}

/** Words, whitespace runs and punctuation runs, kept separate so spans align. */
export function words(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];
}

/** The word-level diff of one line pair, as spans over each side. */
export function refine(before: string, after: string): { del: DiffSpan[]; add: DiffSpan[] } {
  const a = words(before);
  const b = words(after);
  const trace = myersTrace(a, b);
  if (!trace)
    return { del: [{ text: before, changed: true }], add: [{ text: after, changed: true }] };
  const ops = backtrack(a, b, trace);
  const del: DiffSpan[] = [];
  const add: DiffSpan[] = [];
  for (const op of ops) {
    if (op.op === "same") {
      push(del, op.text, false);
      push(add, op.text, false);
    } else if (op.op === "del") push(del, op.text, true);
    else push(add, op.text, true);
  }
  return { del, add };
}

/** Append, merging into the previous span when it carries the same verdict. */
function push(spans: DiffSpan[], text: string, changed: boolean): void {
  const last = spans[spans.length - 1];
  if (last && last.changed === changed) last.text += text;
  else spans.push({ text, changed });
}

/**
 * Refine a hunk's lines when they can be PAIRED. A hunk replacing three lines
 * with three is paired line by line; a 1-for-many hunk is not, and gets no
 * spans rather than an arbitrary pairing — showing a word-level diff against
 * the wrong line is worse than showing none.
 */
function refineHunk(lines: DiffLine[], hunk: DiffHunk): void {
  if (hunk.del.length !== hunk.add.length || hunk.del.length === 0) return;
  const dels = lines.filter((l) => l.op === "del" && inRange(l.a, hunk.aFrom, hunk.aTo));
  const adds = lines.filter((l) => l.op === "add" && inRange(l.b, hunk.bFrom, hunk.bTo));
  for (let i = 0; i < dels.length && i < adds.length; i++) {
    const d = dels[i] as DiffLine;
    const ad = adds[i] as DiffLine;
    const { del, add } = refine(d.text, ad.text);
    d.spans = del;
    ad.spans = add;
  }
}

function inRange(at: number | undefined, from: number, to: number): boolean {
  return at !== undefined && at >= from && at < to;
}

/** Compare two texts by line, refined by word inside paired lines. */
export function diffText(before: string, after: string): Diff {
  if (before === after) {
    const lines = splitLines(before).map((text, i) => ({
      op: "same" as const,
      a: i,
      b: i,
      text,
    }));
    return { lines, hunks: [], same: true, coarse: false };
  }
  const a = splitLines(before);
  const b = splitLines(after);
  const trace = myersTrace(a, b);
  const coarse = trace === null;
  const lines = trace ? backtrack(a, b, trace) : coarseLines(a, b);
  const hunks = collect(lines);
  for (const h of hunks) refineHunk(lines, h);
  return { lines, hunks, same: false, coarse };
}

/**
 * Take hunks from the right side into the left. `take` is the ids to apply;
 * every hunk not named is left as the left side has it.
 *
 * ⛔ APPLIED BACK TO FRONT, so an earlier hunk's line numbers are still the
 * ones the diff reported when it is reached. Applying front to back would
 * shift every later hunk by the size of the change just made — the classic way
 * a multi-hunk merge lands its last hunk in the wrong place.
 */
export function applyHunks(before: string, hunks: DiffHunk[], take: number[]): string {
  const wanted = new Set(take);
  const chosen = hunks.filter((h) => wanted.has(h.id)).sort((x, y) => y.aFrom - x.aFrom);
  const lines = splitLines(before);
  for (const h of chosen) lines.splice(h.aFrom, h.aTo - h.aFrom, ...h.add);
  return lines.join("\n");
}

/** Unified-diff text, for the agent's `diff` verb. `context` lines either side. */
export function unified(
  diff: Diff,
  opts: { from: string; to: string; context?: number } = { from: "a", to: "b" },
): string {
  if (diff.same) return "";
  const context = opts.context ?? 3;
  const out: string[] = [`--- ${opts.from}`, `+++ ${opts.to}`];
  // Hunks closer together than 2× context share one header, the way every
  // other diff tool joins them — otherwise the context lines print twice.
  const groups: DiffHunk[][] = [];
  for (const h of diff.hunks) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && h.aFrom - prev.aTo <= context * 2) (last as DiffHunk[]).push(h);
    else groups.push([h]);
  }
  const a = splitLines(sideText(diff, "a"));
  const b = splitLines(sideText(diff, "b"));
  for (const group of groups) {
    const first = group[0] as DiffHunk;
    const last = group[group.length - 1] as DiffHunk;
    const aStart = Math.max(0, first.aFrom - context);
    const aEnd = Math.min(a.length, last.aTo + context);
    const bStart = Math.max(0, first.bFrom - context);
    const bEnd = Math.min(b.length, last.bTo + context);
    out.push(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@`);
    let at = aStart;
    for (const h of group) {
      for (; at < h.aFrom; at++) out.push(` ${a[at]}`);
      for (const line of h.del) out.push(`-${line}`);
      for (const line of h.add) out.push(`+${line}`);
      at = h.aTo;
    }
    for (; at < aEnd; at++) out.push(` ${a[at]}`);
  }
  return `${out.join("\n")}\n`;
}

/** Rebuild one side's text from the line ops — used by `unified` for context. */
function sideText(diff: Diff, side: "a" | "b"): string {
  const skip = side === "a" ? "add" : "del";
  return diff.lines
    .filter((l) => l.op !== skip)
    .map((l) => l.text)
    .join("\n");
}

/**
 * The shared import-specifier enumerator for the boundary wards (R6).
 *
 * Extracted as a module for the same reason `entry-points.ts` was: three wards
 * (1a, 1b, 2) ask three different questions of ONE population, and three
 * hand-rolled scans are three denominators that cannot all be right while all
 * staying green.
 *
 * ── ⛔ WHY THIS IS TEXT AND NOT `Bun.Transpiler` ────────────────────────────
 * The obvious implementation is `new Bun.Transpiler({loader:"tsx"}).scan(src)`,
 * which is a real parser and has none of a regex's string/comment hazards. It
 * was built and rejected, and the reason is not taste — MEASURED 2026-08-31:
 *
 *     import type { A } from "./x"      ->  []      ERASED
 *     import type A from "./x"          ->  []      ERASED
 *     import { type A } from "./x"      ->  []      ERASED
 *     export type { A } from "./x"      ->  []      ERASED
 *     const x = require("./x")          ->  []      NOT SEEN
 *     import { type A, B } from "./x"   ->  ["./x"] kept (one value specifier)
 *
 * The transpiler erases type-only imports BY DESIGN and no option restores them
 * (`trimUnusedImports:false`, `deadCodeElimination:false`, loader `ts` vs `tsx`
 * — all four tried, all four erase). A ward built on it would be structurally
 * blind to `import type { ServerWebSocket } from "bun"` — which is FOUR of the
 * files R6's ward-1b exemption was measured against, so the exemption would
 * become a dead clause guarding nothing, and a NEW type-only relative escape
 * into `src/` would pass ward 1a green.
 *
 * ⚠ A parser is not automatically the better instrument. It is better at the
 * thing it parses, and this one deliberately does not represent the construct
 * these wards are about.
 *
 * ── HOW THE TEXT SCAN IS KEPT HONEST ───────────────────────────────────────
 * The failure mode of a text scan is the opposite of the parser's: it can MISS
 * an import because it mis-tracked a string or comment. So the ward file runs a
 * CROSS-CHECK cell over the whole real population — every specifier the
 * transpiler finds must also be found here. The transpiler cannot be the
 * enumerator, but it is an excellent independent auditor of one, and it is a
 * frame this scanner's author did not choose.
 *
 * ⛔ WHAT THIS SCANNER CANNOT SEE — read before hanging a rule on it.
 *   • `.ts` / `.tsx` only. A `<script src="../../x.js">` inside a hand-authored
 *     `.html` surface is an import by any reasonable definition and is invisible
 *     here. Those files are the blind set (`gate-blind-set.ts`), and the two
 *     blind spots are the same one seen from two angles.
 *   • A specifier that is not a literal — `import(someVariable)`,
 *     `import(`./${name}`)`. Nothing recovers those without evaluating.
 *   • `require()` is matched, but only in its literal-argument form.
 *   • The `type` / `dynamic` split for `import()` is a HEURISTIC — see
 *     `isTypePosition`, which also records why its imprecision cannot cost a
 *     missed escape.
 *   • Regex literals are detected by a previous-significant-character
 *     heuristic, not by parsing. A pathological `/` could in principle desync
 *     the string state; the cross-check cell is what would catch it.
 */

import { readFileSync } from "node:fs";

export type ImportKind = "static" | "dynamic" | "type";

export type ImportRef = {
  /** The specifier exactly as written. */
  spec: string;
  /**
   * `static`  an `import`/`export … from` statement, type-only ones INCLUDED.
   * `type`    `import("x")` in a TYPE position — a type query, not a call.
   * `dynamic` `import()` / `require()` in a VALUE position — resolved at call
   *           time, not at load time.
   *
   * ⛔ THE AXIS IS *WHEN THE SPECIFIER IS RESOLVED*, NOT *WHETHER IT EMITS*.
   * `static` deliberately holds `import type`, which emits nothing — that is why
   * this scanner exists instead of `Bun.Transpiler` (see the header). So "it
   * emits nothing at runtime" cannot be the test for exempting a construct from
   * the path wards, or it would exempt `import type` too and collapse this
   * module back into the parser it was written to avoid. `type` is split out
   * from `dynamic` for one narrow reason: the DYNAMIC-ESCAPE INVENTORY's subject
   * is imports DEFERRED TO A CALL, and a type query is never called.
   */
  kind: ImportKind;
  /** 1-based line of the statement's specifier. */
  line: number;
  /**
   * TRUE when this reference emits NO runtime specifier — `import type` /
   * `export type`, an all-`type` brace clause, or a type query.
   *
   * ⛔ THIS IS NOT A SYNONYM FOR `kind`, AND KEEPING THEM SEPARATE IS THE POINT.
   * `kind` says WHEN the specifier resolves (load time / call time / never);
   * `erased` says WHETHER it survives compilation. A ward picks the axis its
   * question needs — and the cross-check needs this one, because comparing a
   * mixed population against a parser's value-only one is what forced a
   * `>=` and left slack for a real loss to hide in.
   */
  erased: boolean;
};

/**
 * Is the `import(` at `idx` a TYPE QUERY rather than a call?
 *
 * Two narrow rules, both matched against real constructs in this tree:
 *   1. the preceding significant character is `<`, `:`, `|` or `&`
 *      — `new Set<import("bun").ServerWebSocket<unknown>>()`
 *      — `function f(db: import("bun:sqlite").Database)`
 *   2. the enclosing statement opens with `type` / `interface` / `declare`
 *      (optionally `export`-prefixed) — `export type X = import("../y").Z`
 *
 * ⚠ KNOWN IMPRECISION, AND WHAT NOW AUDITS IT. `Record<string, import("x").T>`
 * (a type argument after a COMMA) still reads as `dynamic`; `,` is not in the
 * preceder set because a value dynamic import in an argument list wears the
 * same costume. That misclassification is now CHEAP AND WATCHED, not merely
 * tolerated:
 *   • ward 1b no longer consults `kind` at all, so it cannot cause a false
 *     green there — the defect that made this worth fixing;
 *   • ward 1a's two cells partition every relative specifier, so it moves a
 *     finding between cells and never removes one;
 *   • a cell in `import-boundary-wards.test.ts` asserts this classification
 *     against `Bun.Transpiler` across all 317 files, so the day a comma-position
 *     type query is written, a cell reddens instead of a number drifting.
 *
 * ⚠ Rule 1 also fires on a
 * value dynamic import in an object-literal or ternary value position
 * (`{ mod: import("./x") }`, `c ? a : import("./x")`). That is a real
 * misclassification — and it is SAFE HERE, because ward 1a checks
 * `static` + `type` for escapes and checks `dynamic` against the pinned
 * inventory. A relative escape is therefore caught on ONE side or the OTHER
 * whichever way this call goes; the classification decides WHICH CELL reports
 * it, never WHETHER it is reported. Do not remove that property when tuning
 * these rules — it is the only reason a heuristic is acceptable here.
 */
function isTypePosition(src: string, idx: number): boolean {
  let i = idx - 1;
  // `?? ""` rather than `!`: `i >= 0` already proves the index is in range, so
  // this is a TYPE obligation, not a runtime one, and an empty string exits the
  // loop the same way a non-space would.
  while (i >= 0 && /\s/.test(src[i] ?? "")) i--;
  const prev = i >= 0 ? src[i] : "";
  if (prev === "<" || prev === ":" || prev === "|" || prev === "&") return true;
  // `typeof import("x")` — the standard type-query idiom. A value-position
  // `typeof` applied to the import()'s promise is legal and absurd; the type
  // reading is the only one that occurs.
  if (/\btypeof\s*$/.test(src.slice(Math.max(0, idx - 12), idx))) return true;
  const stmtStart =
    Math.max(
      src.lastIndexOf(";", idx),
      src.lastIndexOf("{", idx),
      src.lastIndexOf("}", idx),
      src.lastIndexOf("\n", idx),
    ) + 1;
  return /^\s*(?:export\s+)?(?:type|interface|declare)\b/.test(src.slice(stmtStart, idx));
}

/**
 * The byte ranges every `//` and every block comment occupies, delimiters
 * INCLUDED, in source order and non-overlapping.
 *
 * ⛔ ONE WALK, TWO ANSWERS — do not grow a second scanner for the other half.
 * `blankComments` (code kept) and `blankCode` (comments kept) are the SAME
 * partition read from opposite sides, and the only way they can be trusted to
 * be complementary is to come from one traversal. A ward that strips comments
 * with this and then re-finds them with a private `/\/\*[\s\S]*?\*\//g` has two
 * denominators: that regex knows nothing of strings, templates or regex
 * literals, so `const s = "/* not a comment *\/"` moves between the halves
 * depending on which instrument is asked.
 */
function commentRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  const n = src.length;
  // The last non-whitespace character seen in CODE context. It is what
  // distinguishes a regex literal (`= /re/`) from a division (`a / b`).
  let lastSignificant = "";
  const REGEX_PRECEDERS = new Set([
    "",
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "~",
    "^",
    "<",
    ">",
    "\n",
  ]);
  // Template-literal nesting: a `${ … }` re-enters code context, and the code
  // inside may open another template. A depth counter is not enough — track a
  // stack so `}` only closes what `${` opened.
  const stack: Array<"template" | "expr"> = [];

  while (i < n) {
    const c = src[i] ?? "";
    const next = src[i + 1];
    const inTemplate = stack[stack.length - 1] === "template";

    if (inTemplate) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "$" && next === "{") {
        stack.push("expr");
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // ── code context ──
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      ranges.push([i, j]);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      ranges.push([i, Math.min(j + 2, n)]);
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c || src[j] === "\n") break;
        j++;
      }
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === "`") {
      stack.push("template");
      i++;
      continue;
    }
    if (c === "}" && stack[stack.length - 1] === "expr") {
      stack.pop();
      i++;
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.has(lastSignificant)) {
      // A regex literal. Skip it wholesale — its contents may hold `"` or `//`
      // and reading them as code is how a scanner desyncs for the rest of a file.
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        else if (src[j] === "\n") break;
        j++;
      }
      i = j + 1;
      lastSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    else if (c === "\n") lastSignificant = "\n";
    i++;
  }
  return ranges;
}

/**
 * Replace every character inside `ranges` with a space, keeping `\n` so byte
 * offsets AND line numbers survive.
 */
function blankRanges(src: string, ranges: Array<[number, number]>): string {
  const out = src.split("");
  for (const [from, to] of ranges) {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  }
  return out.join("");
}

/**
 * Blank out comments so a specifier-looking string inside one cannot be read as
 * code, while leaving every other character (and so every offset) in place.
 * Offsets are preserved because line numbers are computed from them afterwards.
 */
export function blankComments(src: string): string {
  return blankRanges(src, commentRanges(src));
}

/**
 * The INVERSE: keep the comments, blank the code. Offsets and line numbers are
 * preserved the same way, so a finding can name the line it was read from.
 *
 * ⛔ THIS EXISTS BECAUSE ONE HOUSE RULE RUNS THE OTHER WAY. Every other ward
 * strips comments so prose cannot satisfy an assertion about code. Tailwind
 * makes prose LOAD-BEARING in the opposite direction — it scans source as
 * literal text and never parses it, so a class name written in a comment inside
 * a scanned directory becomes a real CSS rule in every consuming spell
 * (measured, `grimoire/kit-prose-ward.test.ts`). Asking "what is ONLY in the
 * prose" needs the complement of `blankComments`, and taking it from the same
 * walk is what makes the two halves provably a partition rather than two
 * scanners that agree until they don't.
 */
export function blankCode(src: string): string {
  const comments = commentRanges(src);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const [from, to] of comments) {
    if (from > cursor) gaps.push([cursor, from]);
    cursor = to;
  }
  if (cursor < src.length) gaps.push([cursor, src.length]);
  return blankRanges(src, gaps);
}

/**
 * Does this `import`/`export … from` statement erase completely?
 *
 * Two forms: the `type` KEYWORD (`import type X`, `export type { … }`), and a
 * brace clause whose specifiers are ALL inline-`type`. A mixed clause
 * (`{ type A, B }`) keeps `B` and therefore emits — getting that case wrong in
 * the permissive direction is what would silently shrink the value population
 * the cross-check compares.
 */
function isErasedClause(match: string): boolean {
  const head = match.slice(0, match.lastIndexOf("from"));
  if (/^\s*(?:import|export)\s+type\b/.test(head)) return true;
  const braces = /\{([^}]*)\}/.exec(head);
  if (!braces) return false;
  const parts = (braces[1] ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.every((x) => /^type\s/.test(x));
}

/** `import … from "x"`, `export … from "x"`, bare `import "x"` — type-only included. */
const STATIC_RE = /\b(?:import|export)\b[^;()]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
const SIDE_EFFECT_RE = /(?:^|[\n;}])\s*import\s*(["'])([^"'\n]+)\1/g;
const DYNAMIC_RE = /\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/** Every literal module specifier in one source file. */
export function scanSpecifiers(source: string): ImportRef[] {
  const src = blankComments(source);
  const lineOf = (index: number) => src.slice(0, index).split("\n").length;
  const refs: ImportRef[] = [];
  // ⛔ DEDUPED BY BYTE OFFSET, NOT BY LINE. A line-keyed dedupe silently
  // COLLAPSES two statements that share a line and a specifier — and the
  // cross-check cell downstream compares MULTIPLICITY, so a collapse there
  // would hide exactly the drift it exists to find.
  const seen = new Set<number>();
  // `spec` is `string | undefined` because a regex capture group is only
  // provably present at runtime, not to the type checker. Dropping an
  // undefined one is correct AND honest: a match without its capture group is
  // not a specifier, and silently coercing it to "" would put a phantom empty
  // path into the population every ward downstream trusts.
  const push = (spec: string | undefined, kind: ImportKind, index: number, erased: boolean) => {
    if (spec === undefined) return;
    if (seen.has(index)) return;
    seen.add(index);
    refs.push({ spec, kind, line: lineOf(index), erased });
  };
  // The keyword's own offset, not the match's: SIDE_EFFECT_RE anchors on the
  // preceding `\n`/`;`/`}`, so `m.index` sits one line EARLY and the reported
  // line would name the statement above the import.
  const at = (m: RegExpExecArray | RegExpMatchArray) =>
    (m.index ?? 0) + Math.max(0, m[0].search(/\b(?:import|export|require)\b/));
  for (const m of src.matchAll(STATIC_RE)) push(m[2], "static", at(m), isErasedClause(m[0]));
  // A side-effect `import "x"` has no clause and always emits.
  for (const m of src.matchAll(SIDE_EFFECT_RE)) push(m[2], "static", at(m), false);
  for (const m of src.matchAll(DYNAMIC_RE)) {
    const idx = at(m);
    const type = isTypePosition(src, idx);
    push(m[2], type ? "type" : "dynamic", idx, type);
  }
  return refs.sort((a, b) => a.line - b.line || a.spec.localeCompare(b.spec));
}

/** Same, read from disk. */
export function scanFile(absPath: string): ImportRef[] {
  return scanSpecifiers(readFileSync(absPath, "utf8"));
}

/** Relative specifiers are the ones the path wards govern; everything else is bare. */
export const isRelative = (spec: string): boolean => spec.startsWith(".");

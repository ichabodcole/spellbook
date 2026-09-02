// ⛔ THE WARD FOR A LEAK THAT TRAVELS THROUGH COMMENTS.
//
// Tailwind scans source as LITERAL TEXT and never parses it, so it cannot tell
// a class name in code from a class name in a sentence about code. `src/kit/`
// is inside the `@source "../"` that `src/kit/theme/base.css` declares, which
// means EVERY comment in the kit is a content source for EVERY spell that
// adopts the kit. Kit prose launders classes between adopting spells.
//
// Measured by cassandra (seams, Amendment to Contract 21, finding 3): removing
// three class names from a COMMENT in `src/kit/ui/Dot.tsx` removed `.bg-muted`
// from imago's shipped stylesheet — imago's own source never spells it.
// Re-measured here from the other side before this ward was written, with a
// positive control on every number (2026-09-01, probe classes chosen because
// they occur nowhere in the tree; imago rebuilt between each):
//
//   probe in Dot.tsx code (the control)          -> emitted   ✓ instrument live
//   probe in a Dot.tsx `/** … */` comment        -> emitted   ← the leak
//   probe in a cn.ts `//` comment                -> emitted   ← the leak
//   probe in a base.css `/* … */` comment        -> NOT emitted
//   probe in an UNIMPORTED src/kit/**.css        -> NOT emitted
//   probe in a src/kit/NOTES.md                  -> emitted   ← the leak
//   probe in a src/kit/ui/fixture.html           -> emitted   ← the leak
//   every probe, in the three spells that do NOT import the kit stylesheet
//                                                -> NOT emitted ✓ scoped
//
// ⚠ SO `.css` IS NOT A TAILWIND CONTENT SOURCE, AND src/kit/theme/base.css SAYS
// IT IS. That file's own warning ("a class written here in prose stays emitted
// after the component stops using it") is FALSE — its two probes emitted
// nothing, imported and unimported alike, while the same probe in a `.md` in
// the same directory emitted. The sentence is left in place for a non-author to
// re-measure rather than corrected by the seat that found it; the `.css`
// exclusion below is keyed on the measurement, not on that sentence.
//
// ── THE PREDICATE, AND WHY IT NEEDS NO LIST AND NO BUILD ────────────────────
//
//     candidates(kit PROSE) − candidates(kit CODE)   MUST BE EMPTY
//
// A class-shaped token that appears ONLY in prose is prose-only by definition.
// If it also appears in code it is emitted anyway, so the set difference is
// exactly the leak and nothing else. Nothing here is maintained as the kit
// grows: the population is the directory, and the vocabulary that decides
// "class-shaped" is derived from the roster's own markup (below).
//
// ⛔ THE UNION IS KIT-WIDE, NOT PER FILE, AND THAT IS THE MECHANISM'S GRAIN.
// `@source "../"` names the DIRECTORY; Tailwind takes the union of its text.
// So a class used in `Dot.tsx`'s code and mentioned in `cn.ts`'s comment is
// emitted for a reason that has nothing to do with the comment, and a per-file
// difference would red on it. A ward that reds where no mechanism exists is a
// ward the next person weakens. The failure message still names the file the
// prose was read from, because that is where the repair goes.
//
// ── THE ALTERNATIVE WAS CHECKED AND REJECTED — DO NOT RE-ADOPT IT ───────────
//
// Tailwind v4 documents `@source not inline("…")`, a first-party candidate
// BLOCKLIST. It is the wrong instrument: it blocks a candidate, not a
// candidate's SOURCE, so it cannot tell prose from markup. Measured —
// blocklisting the three classes named in Dot.tsx's warning would strip 11
// legitimate `bg-accent` rules from imago's shipped CSS and 3 `bg-popover` from
// mind-mapper's. If you find yourself reaching for a blocklist or a safelist,
// that is the signal you have taken a wrong turn.
//
// ── WHERE THE CLASS-SHAPED LINE IS DRAWN ───────────────────────────────────
//
// This is the whole difficulty, and a naive implementation is NOISY and then
// gets weakened by the next person who meets it. Kit prose is full of ordinary
// hyphenated English (`hand-written`, `load-bearing`, `line-delimited`),
// file paths (`src/kit/theme/base.css`), import specifiers, URLs and version
// numbers — every one of which is Tailwind-candidate-SHAPED. Measured on the
// live kit AFTER this ward's own remediation: 50 candidate-shaped tokens in the
// prose, exactly ONE of which is a class — `rounded-full`, which the code
// places. BEFORE it: eight, and three of those were live rules in a shipped
// stylesheet (see the diff in route 1).
//
// A token is class-shaped here when BOTH hold:
//   (1) it has the Tailwind utility SHAPE — the same `CLASS_TOKEN` grammar the
//       sibling kit-adoption ward uses, so the two agree on what a class looks
//       like; and
//   (2) its END SEGMENTS are drawn from the vocabulary this repo's own markup
//       uses in class positions — its LEADING segment from the set of leading
//       segments, its LAST segment from the set of following segments (or a
//       number / an arbitrary value, which are open by construction). Why the
//       last and not all of them is measured at `isClassShaped`.
//
// (2) is DERIVED FROM THE TREE, never listed: it is read out of `className` /
// `class` attributes and `cn`/`clsx`/`cva`/`tv`/`twMerge` calls across every
// spell surface and the kit itself, comment-stripped. It grows the day a spell
// uses a new utility family, and it is what separates `bg-muted` (leading `bg`
// ✓, last `muted` ✓ — imago writes `text-muted`) from `line-delimited` (leading
// `line` ✓ — mind-mapper writes `line-through` — last `delimited` ✗).
//
// ⭐ AND THIS IS WHY THE VOCABULARY IS SEGMENTS AND NOT TOKENS. `bg-muted` is
// NOT recoverable from the roster's class TOKENS — nothing in the tree spells
// it, which is exactly why cassandra's finding is a finding. A token-level
// vocabulary would have called the one class this ward exists for English.
//
// ⛔ WHAT THIS CANNOT SEE — a predicate's blind set is part of its result.
//   • A leaked class whose LAST segment is novel (`bg-chartreuse` before any
//     spell writes a `chartreuse`-suffixed utility) reads as English and is
//     missed. A numeric or arbitrary tail is always caught, so the stock
//     palette — `bg-teal-500` &c — is not in this hole. The repair is not a
//     wider grammar: the day a spell uses that suffix, the ward starts catching
//     it retroactively.
//   • A single-word utility (`flex`, `underline`) has no structural marker and
//     is not candidate-shaped by (1). Inherited from the sibling ward
//     deliberately: the two must agree, or "class" means two things in one
//     directory.
//   • Validity is NOT checked, and must not be. `bg-popover` emits in
//     mind-mapper (which defines `--color-popover`) and emits NOTHING in imago
//     (which does not) — measured. Validity is a property of the RECEIVING
//     spell's theme, so a validity filter would make a rule about the kit
//     depend on a downstream spell. The rule is syntactic on purpose: kit prose
//     does not spell class names.
//
// ── HOW A NON-AUTHOR BREAKS THIS WARD (each route hits a different cell) ────
//   1. Add a class-shaped token to any kit comment that kit code does not use
//      (e.g. a stock-palette fill in a `//` line in cn.ts) -> the PROSE cell
//      reds, naming the file and the token. No rebuild; this reads only source.
//   2. A class used in BOTH code and a comment -> STAYS GREEN. Live in the
//      tree: `rounded-full` is spelled in Dot.tsx's header AND placed by its
//      code, kept that way on purpose so this route is not fiction. A red here
//      is a defect in this ward.
//   3. Ordinary hyphenated English, file paths, import specifiers, URLs and
//      version numbers in kit prose -> STAY GREEN, and the PROSE cell's second
//      assertion proves they were SEEN and REJECTED rather than never reached.
//      Run with a paragraph of each: 49 of 50 shaped tokens rejected, the one
//      survivor being a class the code places. The exception — English whose
//      every segment is also Tailwind vocabulary (`left-to-right`) — is a known
//      false positive, asserted in the VOCABULARY cell rather than left to be
//      discovered.
//   4. Break the prose extraction — make `blankCode` return "" or make the
//      classifier reject everything -> the INSTRUMENT and VOCABULARY cells red.
//      A ward whose extractor finds nothing and a kit with clean prose produce
//      the identical empty offender list; those cells are what tell them apart.
//   5. Drop a file type into src/kit/ that this ward has no prose model for ->
//      the POPULATION cell reds rather than the file being silently ungoverned.
//
// ⛔ WHAT THIS FILE MAY NOT WRITE. kit-styling-ward.test.ts asserts its sentinel
// utility appears in NO tracked text file outside `src/kit/` — this one
// included. Fixtures below use ordinary palette utilities and never that class.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { blankCode, blankComments } from "./lib/import-graph";

const REPO_ROOT = join(import.meta.dir, "..");
const SRC = join(REPO_ROOT, "src");
const KIT = join(SRC, "kit");

const rel = (abs: string): string => relative(REPO_ROOT, abs).replaceAll("\\", "/");

/**
 * How a file's text splits into CODE and PROSE. `null` prose model means the
 * file is not a Tailwind content source at all and is skipped.
 */
type ProseModel = "js" | "markdown" | "not-scanned";

/**
 * ⛔ MEASURED, NOT ASSUMED — see the probe table in the header. `.css` is the
 * one text extension in this directory Tailwind does NOT scan (imported or
 * not); `.md` and `.html` ARE scanned, so a kit README is a content source and
 * every class-shaped word in it ships. `.html` has no entry because the kit has
 * no HTML today and a wrong prose model is worse than a loud gap: the
 * POPULATION cell reds if one arrives.
 */
const PROSE_MODEL: Record<string, ProseModel> = {
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mts": "js",
  ".cts": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".md": "markdown",
  ".mdx": "markdown",
  ".css": "not-scanned",
};

/**
 * A Tailwind-SHAPED token: lowercase-initial, optionally negated, carrying at
 * least one structural marker. Kept character-for-character identical to
 * kit-adoption-ward.test.ts's `CLASS_TOKEN` — two wards over one directory that
 * disagree about what a class looks like are worse than one ward.
 */
const CLASS_TOKEN = /^-?[a-z][a-z0-9]*(?:[-:/[][^\s]*)+$/;

/**
 * Everything OUTSIDE Tailwind's candidate character set is a token boundary —
 * the same set the spell-css-scope ward matches with, MINUS the two characters
 * measured below.
 *
 * ⛔ MEASURED AGAINST TAILWIND, NOT REASONED. Probe classes planted in a
 * Dot.tsx comment, imago rebuilt between each, a known-good probe in the same
 * run as the positive control (2026-09-01):
 *
 *     .p-83  x>p-99                                    EMITTED
 *     p-92.  docs/p-94  a,p-95  [p-96]  a_p-97  a#p-98 not emitted
 *     a<p-84  a+p-85  a~p-86  a*p-87  a&p-88  a!p-89  a%p-90   not emitted
 *     (p-74)                                          not emitted
 *
 * So `.` and `>` — the two CSS combinators — RESTART a candidate mid-span, and
 * nothing else in the charset does. A leading `.` is the realistic prose form:
 * a class written in its SELECTOR spelling. This ward's first draft used the
 * plain charset split, and its own remediation text in Dot.tsx then wrote
 * `.bg-muted` — which sailed past the ward and kept the rule in imago's
 * stylesheet. The ward was blind to exactly the class it had just been written
 * to remove.
 *
 * ⚠ `<` and `>` are treated as BOUNDARIES here, which is stricter than the
 * measurement in one direction: `<bg-accent>` does not emit and this ward would
 * still flag it. That is deliberate. The alternative — keeping `<` inside the
 * span — makes `<span>bg-accent</span>` invisible, and a silent miss is worse
 * than an over-strict reading of a rule that says "do not spell classes in kit
 * prose" in the first place.
 */
const BOUNDARY = /[^A-Za-z0-9_:/.\-[\]!%()#,*&+~@$]+/;

/** A candidate's segments — `bg-ink-faint` -> `bg`, `ink`, `faint`. */
const segmentsOf = (token: string): string[] =>
  (token.startsWith("-") ? token.slice(1) : token).split(/[-:/[\]]/).filter((s) => s !== "");

/**
 * SENTENCE punctuation hugging a token, stripped before the shape is judged.
 *
 * ⚠ THIS IS THE ONE PLACE THIS WARD IS DELIBERATELY STRICTER THAN THE
 * MECHANISM, and the divergence is measured rather than guessed. Probed the
 * same way as the table on BOUNDARY: a candidate ending in `.` or `,` or `)`
 * emits NOTHING (`p-61.` `p-62,` `p-63)` -> 0 each, control `.p-65` -> 1), and
 * `(p-74)` emits nothing either. So Tailwind would let a class name pass if a
 * full stop happened to follow it. Two reasons this ward will not:
 *   • the rule is "kit prose does not spell class names", not "kit prose does
 *     not emit class names" — a sentence-final `bg-accent.` becomes a live leak
 *     the moment someone rewords around it;
 *   • the extractor is an implementation detail of one Tailwind version. A ward
 *     tuned exactly to today's backtracking opens silently when that changes.
 * Being stricter is safe in a way that being looser is not: this ward is never
 * WEAKER than the measured extractor. Cost, measured on the live kit: zero —
 * no token in the difference set arrives with sentence punctuation attached.
 * A trailing `:` is NOT stripped: it is the one trailing character that leaves
 * the candidate live (Contract 21's `transform:` finding, same direction).
 */
const trimSentence = (span: string): string => span.replace(/^\(+/, "").replace(/[.,)]+$/, "");

/**
 * Every candidate-SHAPED token in a blob, before any vocabulary judgement —
 * each span, plus every suffix a `.` restarts inside it. Suffixes only: a
 * trailing `.` does not hand Tailwind the prefix, so `w-2.5` yields itself and
 * `5`, never a spurious `w-2`.
 */
function shapedTokens(text: string): string[] {
  const out: string[] = [];
  const take = (raw: string) => {
    const t = trimSentence(raw);
    if (t !== "" && CLASS_TOKEN.test(t)) out.push(t);
  };
  for (const span of text.split(BOUNDARY)) {
    if (span === "") continue;
    take(span);
    for (let i = 0; i < span.length; i++) {
      if (span[i] === ".") take(span.slice(i + 1));
    }
  }
  return out;
}

/**
 * String literals sitting in a class-PLACEMENT site. The vocabulary must come
 * from text the repo actually puts into markup — reading every string literal
 * in the tree would admit `application/json` and `node:fs` and hand the
 * classifier a vocabulary wide enough to call English a class.
 */
function classLiterals(code: string): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    if (s !== undefined && s !== "") out.push(s);
  };
  for (const m of code.matchAll(/\b(?:className|class)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    push(m[2] ?? m[3]);
  }
  // `className={…}` and the composition helpers: scan the balanced region and
  // take every literal inside it. A regex cannot match a nested expression, and
  // a shallow one would miss the ternaries that hold most of the roster's
  // conditional classes.
  for (const m of code.matchAll(
    /\b(?:className|class)\s*=\s*\{|\b(?:cn|clsx|cva|tv|twMerge)\s*\(/g,
  )) {
    const start = (m.index ?? 0) + m[0].length;
    const open = m[0].endsWith("{") ? "{" : "(";
    const close = open === "{" ? "}" : ")";
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === open) depth++;
      else if (c === close) depth--;
      i++;
    }
    for (const lm of code.slice(start, i - 1).matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      push(lm[1] ?? lm[2] ?? lm[3]);
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(join(dir, e.name), out);
    } else {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

/** Every spell surface plus the kit — DERIVED, so a fifth spell widens the
 *  vocabulary the day it lands (Contract 19). */
function vocabularyRoots(): string[] {
  const roots = readdirSync(SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(SRC, e.name, "surface"))
    .filter((d) => existsSync(d));
  roots.push(KIT);
  return roots;
}

type Vocabulary = { lead: Set<string>; follow: Set<string>; files: number };

/**
 * The roster's own class vocabulary, split by POSITION. Comment-stripped on the
 * way in: prose must never be able to widen the vocabulary that decides whether
 * prose is a class, or the leak defines its own legitimacy.
 */
function vocabulary(): Vocabulary {
  const lead = new Set<string>();
  const follow = new Set<string>();
  let files = 0;
  for (const root of vocabularyRoots()) {
    for (const file of walk(root)) {
      const ext = extname(file);
      const isJs = PROSE_MODEL[ext] === "js";
      if (!isJs && ext !== ".html") continue;
      files++;
      const raw = readFileSync(file, "utf8");
      for (const literal of classLiterals(isJs ? blankComments(raw) : raw)) {
        for (const token of shapedTokens(literal)) {
          const segs = segmentsOf(token);
          const head = segs.at(0);
          if (head !== undefined) lead.add(head);
          for (const s of segs.slice(1)) follow.add(s);
        }
      }
    }
  }
  return { lead, follow, files };
}

/**
 * Class-shaped: the utility SHAPE, spelled out of the roster's own segments —
 * LEADING segment from the leading set, LAST segment from the following set.
 *
 * ⛔ THE LAST SEGMENT, NOT ALL OF THEM, AND THE DIFFERENCE WAS MEASURED RATHER
 * THAN ARGUED. Requiring EVERY following segment to be known missed
 * `bg-teal-500` — `teal` is a stock palette hue no surface here uses — which is
 * the first thing a non-author reaches for when breaking this ward, and it
 * stayed green under exactly that route. Requiring only the LAST catches it
 * (`500` is numeric) while `self-relative`, `line-delimited` and `border-box`
 * stay green on their own last segment. The cost was counted, not assumed:
 * across 1,463 candidate-shaped tokens in the comments of every `.ts`/`.tsx`
 * under `src/`, `every` flags 43 and `last` flags 44 — one extra token in the
 * whole tree, and none of it in `src/kit/`. `some` flags 45 and is strictly
 * worse than `last` for the same recall.
 *
 * A number or an arbitrary value is always accepted: Tailwind's spacing and
 * sizing scales are unbounded, so no derived set could enumerate them.
 */
function isClassShaped(token: string, vocab: Vocabulary): boolean {
  if (!CLASS_TOKEN.test(token)) return false;
  const segs = segmentsOf(token);
  const head = segs.at(0);
  if (head === undefined || !vocab.lead.has(head)) return false;
  const last = segs.at(-1);
  if (segs.length < 2 || last === undefined) return false;
  return vocab.follow.has(last) || /^\d/.test(last);
}

type KitFile = { path: string; model: ProseModel; code: string; prose: string };

/** The kit, split. `not-scanned` files keep empty halves rather than being
 *  dropped, so the POPULATION cell can still see them. */
function kitFiles(): KitFile[] {
  return walk(KIT).map((path) => {
    const model = PROSE_MODEL[extname(path)];
    if (model === undefined) return { path, model: "not-scanned" as const, code: "", prose: "" };
    if (model === "not-scanned") return { path, model, code: "", prose: "" };
    const raw = readFileSync(path, "utf8");
    if (model === "markdown") return { path, model, code: "", prose: raw };
    return { path, model, code: blankComments(raw), prose: blankCode(raw) };
  });
}

describe("kit prose ward", () => {
  const vocab = vocabulary();
  const files = kitFiles();

  test("POPULATION: every file in src/kit/ has a prose model or a measured exemption", () => {
    // ⛔ ZERO-GUARD FIRST. An empty walk and a clean kit produce the same empty
    // offender list.
    expect(files.length).toBeGreaterThan(0);
    const unmodelled = files
      .filter((f) => PROSE_MODEL[extname(f.path)] === undefined)
      .map((f) => rel(f.path));
    // A `.md` and an `.html` in src/kit/ were BOTH measured to put their text
    // into every adopting spell's stylesheet (header). So a new extension here
    // is not a formality — it is an ungoverned content source until someone
    // decides how its text splits into code and prose.
    expect(unmodelled).toEqual([]);
    // …and the modelled population is not vacuous.
    expect(files.filter((f) => f.model === "js").length).toBeGreaterThan(0);
  });

  test("INSTRUMENT: code and prose PARTITION the source, and the prose half is non-empty", () => {
    // Route 4. Without this cell, "the kit's prose is clean" and "the extractor
    // stopped extracting" are the same output.
    const js = files.filter((f) => f.model === "js");
    expect(js.length).toBeGreaterThan(0);
    let proseChars = 0;
    let filesWithProse = 0;
    // Collected and asserted ONCE rather than per character: a per-character
    // `expect` in a 50 kB directory is 16,000 assertions whose failure output is
    // a wall, and the first mismatch is the only one anybody reads.
    const lost: string[] = [];
    const doubled: string[] = [];
    for (const f of js) {
      const raw = readFileSync(f.path, "utf8");
      expect(f.code.length).toBe(raw.length);
      expect(f.prose.length).toBe(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i] ?? "";
        const inCode = f.code[i] === ch;
        const inProse = f.prose[i] === ch;
        // Every character survives in at least one half…
        if (!inCode && !inProse) lost.push(`${rel(f.path)}@${i} ${JSON.stringify(ch)}`);
        // …and in BOTH only when it is whitespace, which both halves keep so
        // offsets and line numbers stay usable.
        else if (inCode && inProse && !/\s/.test(ch)) {
          doubled.push(`${rel(f.path)}@${i} ${JSON.stringify(ch)}`);
        }
      }
      const n = f.prose.replace(/\s/g, "").length;
      proseChars += n;
      if (n > 0) filesWithProse++;
    }
    expect(lost.slice(0, 5)).toEqual([]);
    expect(doubled.slice(0, 5)).toEqual([]);
    expect(filesWithProse).toBe(js.length); // every kit module is commented
    expect(proseChars).toBeGreaterThan(2000);

    // Both comment syntaxes, and a string that merely LOOKS like one. The
    // string case is why this uses the shared walker and not a private regex.
    const src = 'const s = "/* not a comment */";\n// bg-emerald-500\n/* bg-sky-500 */\n';
    expect(shapedTokens(blankCode(src))).toEqual(["bg-emerald-500", "bg-sky-500"]);
    expect(blankComments(src)).toContain('"/* not a comment */"');
    expect(shapedTokens(blankCode(src)).includes("not")).toBe(false);

    // ⛔ THE SELECTOR SPELLING. Tailwind restarts a candidate after `.` and `>`;
    // this ward's first draft did not, and wrote `.bg-muted` into the very
    // comment it had just cleaned. See the note on BOUNDARY for the probe table.
    expect(shapedTokens(".bg-teal-500")).toEqual(["bg-teal-500"]);
    expect(shapedTokens("li>bg-teal-500")).toEqual(["bg-teal-500"]);
    // Sentence punctuation is stripped, so the shape survives it — see
    // `trimSentence` for why this is deliberately stricter than the extractor.
    expect(shapedTokens("bg-teal-500.")).toEqual(["bg-teal-500"]);
    expect(shapedTokens("(bg-teal-500)")).toEqual(["bg-teal-500"]);
    // …and the shapes that must NOT be manufactured by any of that:
    expect(shapedTokens("w-2.5")).toEqual(["w-2.5"]); // a real class holds its dot
    expect(shapedTokens("src/kit/theme/base.css")).toEqual(["src/kit/theme/base.css"]);
    expect(shapedTokens("v4.3.0")).toEqual([]);
  });

  test("VOCABULARY: derived from the roster, non-empty, and it discriminates", () => {
    // A classifier that calls nothing a class produces an empty offender list
    // and a green ward. These are its failure modes, asserted.
    expect(vocab.files).toBeGreaterThan(50);
    expect(vocab.lead.size).toBeGreaterThan(20);
    expect(vocab.follow.size).toBeGreaterThan(50);

    const shaped = (t: string) => isClassShaped(t, vocab);

    // ── the shapes that MUST be recognised ──
    // The three the ward was written for. None of them is spelled by any
    // spell's markup as a whole token; all three are reachable from segments.
    expect(shaped("bg-accent")).toBe(true);
    expect(shaped("bg-popover")).toBe(true);
    expect(shaped("bg-muted")).toBe(true);
    // A numeric scale value — unbounded, so never in a derived set. The last
    // two are the stock-palette shape a non-author reaches for first, whose
    // MIDDLE segment is deliberately not required to be known.
    expect(shaped("w-2")).toBe(true);
    expect(shaped("h-2")).toBe(true);
    expect(shaped("bg-teal-500")).toBe(true);
    expect(shaped("ring-fuchsia-500/40")).toBe(true);
    // An arbitrary value and a variant-prefixed class.
    expect(shaped("hover:bg-surface")).toBe(true);

    // ── the shapes that MUST NOT be, and each is live in kit prose today ──
    // Ordinary hyphenated English whose LEADING segment is a real utility
    // family. This is the case a namespace-only filter gets wrong.
    expect(shaped("line-delimited")).toBe(false); // `line-through` is real
    expect(shaped("self-relative")).toBe(false); // `self-start` is real
    expect(shaped("border-box")).toBe(false); // `border-edge` is real
    // Ordinary hyphenated English with no utility family at all.
    expect(shaped("hand-written")).toBe(false);
    expect(shaped("load-bearing")).toBe(false);
    expect(shaped("zero-guard")).toBe(false);
    // A file path, an import specifier, a URL, a version, a CSS property name.
    expect(shaped("src/kit/theme/base.css")).toBe(false);
    expect(shaped("lucide-react")).toBe(false);
    expect(shaped("https://tailwindcss.com/docs")).toBe(false);
    expect(shaped("v4.3.0")).toBe(false);
    expect(shaped("box-sizing")).toBe(false);
    // A bare word has no structural marker and is out of scope by shape.
    expect(shaped("flex")).toBe(false);

    // ── ⚠ THE NOISE SET, ASSERTED RATHER THAN DISCOVERED BY THE NEXT PERSON ──
    // English whose every segment is ALSO real Tailwind vocabulary is
    // indistinguishable from a class by any syntactic rule, and these are the
    // ones that exist. They are FALSE POSITIVES; the repair when one lands in
    // kit prose is to reword (`left to right`, `the top-left corner` -> `the
    // upper left corner`), not to widen the ward. Counted rather than feared:
    // over 1,463 candidate-shaped tokens in the comments of every `.ts`/`.tsx`
    // under `src/`, this classifier flags 44, of which about five are English
    // of this kind — and ZERO of them are inside `src/kit/`, the only directory
    // this ward governs.
    expect(shaped("left-to-right")).toBe(true);
    expect(shaped("top-left")).toBe(true);
    // These cells exist so that a future tightening has something to move: if
    // one of them flips to false, the rule got sharper and this comment is the
    // record of what it used to cost.
  });

  test("PROSE: no class-shaped token appears in kit prose that kit code does not use", () => {
    const code = new Set<string>();
    for (const f of files) {
      for (const t of shapedTokens(f.code)) if (isClassShaped(t, vocab)) code.add(t);
    }
    // ⛔ THE DENOMINATOR, ASSERTED. If the kit's CODE contributes no classes the
    // difference below is every prose token there is — or, if the classifier is
    // broken, none. Dot.tsx is what makes this non-empty today.
    expect(code.size).toBeGreaterThan(0);

    // ⭐ POSITIVE CONTROL ON THE GREEN ROUTE. The route that matters most here
    // is the one that must NOT red, and "green" has two causes: the classifier
    // judged correctly, or it never saw anything. This separates them — the
    // kit's prose is full of candidate-SHAPED tokens, and the classifier is
    // rejecting the great majority of them rather than finding nothing.
    const shapedInProse = new Set(files.flatMap((f) => shapedTokens(f.prose)));
    const classedInProse = [...shapedInProse].filter((t) => isClassShaped(t, vocab));
    expect(shapedInProse.size).toBeGreaterThan(30);
    // The number REJECTED, not a ratio: a ratio is satisfiable by a classifier
    // that finds nothing, and "found nothing" is the failure this cell exists
    // for. Live: 50 shaped, 1 classed, 49 rejected.
    expect(shapedInProse.size - classedInProse.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const f of files) {
      const leaked = [...new Set(shapedTokens(f.prose))]
        .filter((t) => isClassShaped(t, vocab) && !code.has(t))
        .sort();
      if (leaked.length > 0) {
        offenders.push(
          `${rel(f.path)}: prose names ${leaked.join(", ")} — no kit code uses ` +
            `${leaked.length === 1 ? "it" : "them"}, so Tailwind emits ` +
            `${leaked.length === 1 ? "it" : "them"} into every spell that imports the kit ` +
            `stylesheet. Say it in words, not in the class's own spelling.`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

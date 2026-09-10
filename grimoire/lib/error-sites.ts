/**
 * The shared enumerator for CLI-FAILURE RAISE SITES — one population, derived,
 * for every rule the house hangs on the error envelope (register A1).
 *
 * `src/kit/wire/errors.ts` is the house's one failure contract, and its
 * machine-readable half is `choices` — *what WOULD have been accepted*. A rule
 * about `choices` needs to know where a spell raises, and eight spells spell
 * that eight ways: `die`, an aliased `raise`, a `usageError` factory, a
 * `dieApi` HTTP shim, a `reportUsage` envelope writer, and a bare
 * `throw new CliError`. A ward that greps for `die(` sees roughly half of them.
 *
 * ── HOW THE POPULATION IS DERIVED, AND WHY IT IS NOT A LIST OF NAMES ────────
 *
 * The seed is the CONTRACT, not a vocabulary:
 *
 *  1. **The error classes.** `CliError` from the kit, under whatever local name
 *     the import clause gives it (`CliError as KitCliError` — mind-mapper), plus
 *     any local class that `extends` one of those. A spell's private
 *     `UsageError` joins only if it reaches the kit's class; a parser's own
 *     `UsageError extends Error` does not, and is picked up at the boundary
 *     where it is converted into a `die` instead.
 *  2. **The raisers.** The kit's `die` under its local alias (also read off the
 *     import clause: `die as kitDie`, `die as raise`), then a FIXPOINT over
 *     local functions: a function joins only when it cannot return normally —
 *     an annotated `: never`, an arrow whose whole body is a construction of an
 *     error class or a call to a raiser, or a body that writes an
 *     `errorEnvelope(` itself (mind-mapper's `reportUsage`, which is the one
 *     raiser in the roster that returns an exit code rather than throwing).
 *  3. **The sites.** Every call to a raiser and every construction of an error
 *     class, with its argument text brace-matched so a multi-line raise is one
 *     site rather than five.
 *
 * The fixpoint's narrowness is the load-bearing part. `main` and `dispatch`
 * call `die` too; admitting them would make every call to `dispatch` a raise
 * site and the population would be the whole file.
 *
 * ── ⛔ WHAT THIS ENUMERATOR CANNOT SEE — read before hanging a rule on it ────
 *
 *  - **A raiser in a shape rule 2 does not recognise is INVISIBLE**, and no pin
 *    downstream can tell that from a file with fewer raises. A helper that
 *    throws a `CliError` from inside a multi-statement body with no `: never`
 *    annotation is the concrete gap. It is stated here rather than guessed at:
 *    the roster has none today (verified by comparing this enumerator's answer
 *    against a hand audit of all eight backends, 2026-09-10), and the day one
 *    appears the honest report is **"not looked at"**, not a green.
 *  - **`.ts` ONLY, backend ONLY.** Daemon-side HTTP JSON bodies are not the CLI
 *    envelope (the register's A1 measurement excludes them by name) and neither
 *    are surface files. Those are outside the population, not clean.
 *  - **It reads SOURCE, not behaviour.** A site inside dead code counts; a site
 *    reached only through a swallowing `catch` counts. Reachability is the
 *    audit `errors.ts`'s header prescribes, and it is a different question.
 *  - **It cannot tell whether a closed set EXISTS at a site.** That is the
 *    judgment A1's ruling makes, and no regex makes it. What the census ward
 *    does with this population is assert the two closed sets that ARE
 *    structural (the parser's flag map, the dispatcher's verb roster) and
 *    forbid the shape a hand-typed set takes; the rest is ruled, not measured.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backendSources } from "./entry-points.ts";

export const REPO_ROOT = join(import.meta.dir, "..", "..");

/** One raise site: where it is, and the whole of what it raises. */
export type RaiseSite = {
  /** `<spell>/backend/<file>.ts`, the key `backendSources()` uses. */
  file: string;
  line: number;
  /** The raiser's local name, or the constructed class's. */
  raiser: string;
  /** The argument text, parens included, brace/paren-matched. */
  args: string;
  /** Does this site carry a `choices` property? */
  hasChoices: boolean;
  /** Does it carry a `hint`? */
  hasHint: boolean;
};

/**
 * Blank comments and template/quoted strings' CONTENT is deliberately KEPT —
 * arm 1 of the census ward reads message literals — but comment bodies are
 * blanked, because a comment quoting an old rejection is not a rejection.
 * Line count is preserved so a reported line is the real one.
 */
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  const keepNewlines = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const q = src[i] as string;
      let j = i + 1;
      while (j < src.length && src[j] !== q) {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

/** Paren-matched argument text starting at the `(` index. Quote-aware. */
function parenBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Brace-matched block starting at the `{` index. */
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Rule 1 — the error classes reachable in this source, by local name. */
export function errorClassesOf(src: string): Set<string> {
  const classes = new Set<string>();
  // The kit's class, under whatever the import clause calls it.
  for (const m of src.matchAll(
    /\bCliError\s+as\s+([A-Za-z_$][\w$]*)|(?<![\w$.])(CliError)(?=\s*[,}\n])/g,
  )) {
    const name = m[1] ?? m[2];
    if (name !== undefined) classes.add(name);
  }
  // Locals extending one of them, to a fixpoint (one `extends` hop is all the
  // roster uses; the loop makes a second hop free rather than special).
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)/g)) {
      const [, child, parent] = m;
      if (child && parent && classes.has(parent) && !classes.has(child)) {
        classes.add(child);
        grew = true;
      }
    }
  }
  return classes;
}

/** Rule 2 — the raisers, seeded on the kit's `die` and closed to a fixpoint. */
export function raisersOf(src: string, classes: Set<string>): Set<string> {
  const raisers = new Set<string>();
  // The kit's `die`, under its local alias.
  for (const m of src.matchAll(/\bdie\s+as\s+([A-Za-z_$][\w$]*)/g))
    if (m[1] !== undefined) raisers.add(m[1]);
  if (/\bdie\s*[,}]/.test(src) && /kit\/wire\/errors/.test(src)) raisers.add("die");

  for (let grew = true; grew; ) {
    grew = false;
    // (a) `function name(...): never { … }` and `const name = (…): never =>`
    for (const m of src.matchAll(
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([\s\S]{0,600}?\)\s*:\s*never\b|\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]{0,200})?=\s*\([\s\S]{0,600}?\)\s*:\s*never\s*=>/g,
    )) {
      const name = m[1] ?? m[2];
      if (name !== undefined && !raisers.has(name)) {
        raisers.add(name);
        grew = true;
      }
    }
    // (b) `const name = <raiser>;` — a bare alias (bounty's `const die = kitDie`).
    for (const m of src.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g,
    )) {
      const [, name, alias] = m;
      if (name && alias && raisers.has(alias) && !raisers.has(name)) {
        raisers.add(name);
        grew = true;
      }
    }
    // (c) An ARROW FACTORY whose body IS the raise — the whole body, not its
    //     first line: mind-mapper's `usageError` is
    //     `const usageError = (message, extra?) =>\n  new CliError("usage", …)`,
    //     and a first-line test for `=>` misses it and takes eleven `choices`
    //     sites with it (measured: mind-mapper reported 4 sites and 0 choices
    //     against a hand count of 64 and 11 — the whole spell went dark).
    for (const m of src.matchAll(
      /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=\n]{0,200})?=\s*(?:async\s*)?\((?:[^()]|\([^()]*\))*\)\s*(?::\s*[^=\n]{0,200})?=>\s*/g,
    )) {
      const name = m[1];
      if (name === undefined || raisers.has(name)) continue;
      const bodyStart = m.index + m[0].length;
      const head = src.slice(bodyStart, bodyStart + 240);
      const isRaise =
        [...classes].some((c) => new RegExp(`^new\\s+${c}\\s*\\(`).test(head)) ||
        [...raisers].some((r) => new RegExp(`^${r}\\s*\\(`).test(head));
      if (isRaise) {
        raisers.add(name);
        grew = true;
      }
    }
    // (d) A braced body whose ONLY job is the envelope (mind-mapper's
    //     `reportUsage`, the one raiser in the roster that returns a code
    //     instead of throwing).
    for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (name === undefined || raisers.has(name)) continue;
      // ⛔ SKIP THE SIGNATURE'S PARENS FIRST. `function reportUsage(message:
      // string, extra?: { hint?: string; choices?: string[] }): number {` has
      // its first `{` inside a PARAMETER TYPE, so a naive `indexOf("{")` reads
      // the param object as the body — measured: mind-mapper's one
      // envelope-writing raiser went undetected for exactly that reason.
      const sigOpen = m.index + m[0].length - 1;
      const sig = parenBlock(src, sigOpen);
      const brace = src.indexOf("{", sigOpen + sig.length);
      if (brace === -1) continue;
      const body = braceBlock(src, brace);
      if (/\berrorEnvelope\s*\(/.test(body) && body.split("\n").length <= 8) {
        raisers.add(name);
        grew = true;
      }
    }
  }
  return raisers;
}

/** Rule 3 — every raise site in one source. */
export function raiseSitesIn(file: string, rawSource: string): RaiseSite[] {
  const src = blankComments(rawSource);
  const classes = errorClassesOf(src);
  const raisers = raisersOf(src, classes);
  const sites: RaiseSite[] = [];
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const seen = new Set<number>();

  const record = (name: string, callAt: number, parenAt: number) => {
    if (seen.has(parenAt)) return;
    seen.add(parenAt);
    const args = parenBlock(src, parenAt);
    sites.push({
      file,
      line: lineOf(callAt),
      raiser: name,
      args,
      hasChoices: /\bchoices\s*:/.test(args),
      hasHint: /\bhint\s*:/.test(args),
    });
  };

  for (const name of raisers) {
    // ⛔ A DECLARATION IS NOT A SITE. `function die(msg): never {` matches the
    // call shape exactly, so the declaration keyword is excluded explicitly —
    // without this every raiser contributes one phantom site, in every spell.
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*\\(`, "g"))) {
      const before = src.slice(Math.max(0, m.index - 40), m.index);
      if (/\b(?:function|const|let|var)\s+$/.test(before)) continue;
      record(name, m.index, m.index + m[0].length - 1);
    }
  }
  for (const c of classes) {
    for (const m of src.matchAll(new RegExp(`\\bnew\\s+${c}\\s*\\(`, "g"))) {
      record(c, m.index, m.index + m[0].length - 1);
    }
  }
  // ⛔ AND THE ENVELOPE ITSELF IS A RAISE SITE. magpie and mind-mapper do not
  // always go through a raiser: they write `errorEnvelope(…)` to stderr and
  // return a code, which is the same act with no throw in it. Leaving these
  // out cost magpie its three ROOT rejections — the verb roster and the
  // per-verb flag set, the two most valuable `choices` in the spell — and the
  // census would have reported 1 where the truth is 4.
  for (const m of src.matchAll(/(?<![\w$.])errorEnvelope\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(?:function|const|let|var)\s+$/.test(before)) continue;
    record("errorEnvelope", m.index, m.index + m[0].length - 1);
  }
  return sites.sort((a, b) => a.line - b.line);
}

/** Every raise site in the roster's backends, keyed by spell. */
export function raiseSitesBySpell(): Map<string, RaiseSite[]> {
  const bySpell = new Map<string, RaiseSite[]>();
  for (const rel of backendSources()) {
    const spell = rel.split("/")[0] as string;
    const abs = join(REPO_ROOT, "src", rel.replace("/backend/", "/backend/"));
    const sites = raiseSitesIn(rel, readFileSync(abs, "utf8"));
    bySpell.set(spell, [...(bySpell.get(spell) ?? []), ...sites]);
  }
  return bySpell;
}

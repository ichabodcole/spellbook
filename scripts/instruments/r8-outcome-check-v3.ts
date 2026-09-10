#!/usr/bin/env bun
// g1 / r8 check v3 — make the check's SILENCE mean something.
//
// v1: 186/380 (49%) — no brace matching, branches bled into file tail. Junk.
// v2: 6/302 (2.0%) — brace-matched, keyed on CAPTURED-and-dropped. Convicts the
//     red arm, but BLIND to every non-capturing call, and that blind set holds
//     BOTH the best behaviour in the house (bounty task.add) and the most
//     complete drop (magpie element.add). So a v2 GREEN meant nothing.
//
// v3 REFRAMES THE PREDICATE, which collapses both of g1's axes into one:
//
//     DOES THE CALLER'S ANSWER DEPEND ON WHAT ACTUALLY HAPPENED?
//
// Not "is the return captured" (a code-shape question that groups bounty with
// magpie), but "can this branch produce more than one distinguishable outcome".
// That is the sprint thesis stated as a predicate, and it is what the harm
// actually is.
//
//   bounty task.add   if (!applyTaskAdd(…)) return {applied:false, error:…}   -> GREEN
//   imago context.add const id = addContextEntry(…); …; uniform envelope       -> RED
//   magpie element.add addElement(state, msg.element);   bare, uniform          -> RED  (v2 missed)
//   glamour style.save const style = saveStyle(…); push; uniform               -> RED  (lost-value)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ⛔ THE ROOT: AN ENV OVERRIDE WITH A DERIVED DEFAULT, AND IT USED TO BE A
// HARDCODED ABSOLUTE PATH TO ONE MACHINE'S CHECKOUT — pointed, moreover, at
// `plugins/spellbook/skills`, which the backend convergence emptied of
// dispatchers. Every one of the three r8 copies therefore exited 1 with
// `ZERO-DENOMINATOR — verdict withheld` (type-debt Phase 1, T10): live,
// self-calibrating logic aimed at a tree that had moved out from under it, and
// unrunnable on any other machine besides.
//
// The default is DERIVED from this file's own location, so the instrument runs
// wherever the checkout is; `R8_ROOT` is the house override idiom
// (`gate-blind-set.ts` takes `ROOT_DIR`, `type-debt-census.ts`
// `TYPE_DEBT_ROOT`, `canon-ledger-ward.ts` `CANON_DIR`) and is what points it
// at the OLD tree, or at a fixture, without editing a specimen.
//
// ⚠ AND THE REPORT IS BYTE-IDENTICAL TO THE PRE-CHANGE FILE RUN AGAINST THE
// SAME ROOT — verified for all three copies before and after `biome --write`,
// which is `c4d669eb`'s own discipline for touching these files. The only thing
// that changed is which tree the instrument can find.
const ROOT = resolve(process.env.R8_ROOT ?? join(import.meta.dir, "..", "..", "src"));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// ⛔ R3, MADE LOCAL: READ THE POSSIBLY-UNDEFINED, AND DIE NAMING THE INVARIANT.
// `x!` and `?? fallback` both make the type error vanish and only one of those
// is honest. In an INSTRUMENT `?? fallback` is the worse one, and
// `if (!x) continue` is worse still: a skipped element lowers a DENOMINATOR
// with nothing said, which is D64's defect exactly — a coverage count going
// down is not a failure, so nothing reds and a shipped number is quietly false.
// An instrument that crashes gets repaired; one that counts less ships a lie.
//
// ⚠ THIS HELPER IS DUPLICATED PER INSTRUMENT ON PURPOSE. Every file under
// `scripts/instruments/` imports node builtins and nothing else — each is
// runnable and copyable on its own — and the three r8 files are CALIBRATED
// SPECIMENS whose independence is their evidentiary value (c4d669eb verified
// each byte-identical to its own baseline). A shared module would let one edit
// move all three specimens at once, silently.
function must<T>(v: T | undefined, invariant: string): T {
  if (v === undefined) throw new Error(`INVARIANT VIOLATED — ${invariant}`);
  return v;
}

function blockAfter(src: string, from: number, hardEnd: number): string {
  let i = from;
  while (i < hardEnd && src[i] !== "{" && src[i] !== "\n") i++;
  if (src[i] !== "{") return src.slice(from, Math.min(hardEnd, from + 1500));
  let depth = 0;
  const start = i;
  for (; i < hardEnd; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start, hardEnd);
}

const MARK =
  /(?:else\s+)?if\s*\(\s*([A-Za-z_$][\w$.]*)\s*===\s*"([\w.-]+)"\s*\)|case\s+"([\w.-]+)"\s*:/g;
// AXIS A: a mutator call, CAPTURED or BARE. `(?:const|let)\s+x\s*=\s*)?` optional.
const MUTATOR =
  /(?:(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*)?(?:await\s+)?\b((?:\w+\.)?(?:add|create|make|mint|insert|put|upsert|register|save|apply|set|push)[A-Za-z]*)\s*\(/g;

// Does the branch produce MORE THAN ONE distinguishable answer to the caller?
// A distinguishing return names a failure//reason vocabulary; a uniform one does not.
const DISTINGUISHING =
  /return\s*\{[^}]*(?:applied\s*:\s*false|error\s*:|ok\s*:\s*false|reason\s*:)/s;

type Row = {
  file: string;
  verb: string;
  local: string | null;
  callee: string;
  distinguishing: boolean;
};

const files = walk(ROOT);
const rows: Row[] = [];
let branches = 0;
const dispatchers = new Set<string>();

for (const f of files) {
  const src = readFileSync(f, "utf8");
  MARK.lastIndex = 0;
  const marks: { disc: string; verb: string; start: number; end: number }[] = [];
  for (const m of src.matchAll(MARK))
    marks.push({
      disc: m[1] ?? "«case»",
      // MARK is two alternatives; group 2 rides the `if` form and group 3 the
      // `case` form, so a match sets exactly one. (`disc: m[1] ?? "«case»"`
      // above is NOT this shape — group 1 is genuinely absent for `case`, and
      // that sentinel is an honest alternative, which is why it never typed as
      // an error.)
      verb: must(m[2] ?? m[3], "MARK matched with neither verb group set"),
      start: m.index,
      end: m.index + m[0].length,
    });

  let i = 0;
  while (i < marks.length) {
    // ⚠ `head` IS `group[0]` BY CONSTRUCTION — `marks.slice(i, …)[0]` is
    // `marks[i]` — so naming it once removes the indexed read at both sites
    // WITHOUT hiding one behind a parameter (D64's route). The grouping walk is
    // rewritten as a `for(;;)` so the end-of-array case is a NAMED terminal
    // (`next === undefined`, past the last mark) rather than a length
    // comparison the type system cannot connect to the read.
    const head = must(marks[i], `marks[${i}] absent inside 0..${marks.length}`);
    let j = i;
    for (;;) {
      const next = marks[j + 1];
      if (next === undefined || next.disc !== head.disc) break;
      j++;
    }
    const group = marks.slice(i, j + 1);
    if (group.length >= 3) {
      dispatchers.add(f);
      for (let k = 0; k < group.length; k++) {
        const g = must(group[k], `group[${k}] absent inside 0..${group.length}`);
        // ⚠ `group[k + 1]` is legitimately absent on the dispatcher's last
        // branch; that `??` is the terminal case and stays.
        const body = blockAfter(src, g.end, group[k + 1]?.start ?? src.length);
        branches++;
        const dist = DISTINGUISHING.test(body);
        const seen = new Set<string>();
        for (const c of body.matchAll(MUTATOR)) {
          // ⭐ MUTATOR's group 1 IS OPTIONAL — `(?:(?:const|let)\s+(…)\s*=\s*)?`
          // — because a BARE mutator call has nothing to capture, and seeing
          // those is exactly what v3 added over v2. So `local` is GENUINELY
          // `string | undefined` and the two `?? ""` / `?? null` below are real
          // alternatives, not silencings. Group 2 (the callee) is mandatory.
          const local = c[1];
          const callee = must(c[2], "MUTATOR matched without its `callee` group");
          const key = `${callee}|${local ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            file: f.replace(`${ROOT}/`, ""),
            verb: g.verb,
            local: local ?? null,
            callee,
            distinguishing: dist,
          });
        }
      }
    }
    i = j + 1;
  }
}

const FILTERS_APPLIED = [
  "walk(): SKIPS `node_modules` and `dist`",
  "files: NON-TEST `.ts` only — every `*.test.ts` is excluded",
  "dispatcher: requires >=3 branches sharing ONE discriminant (a 1-2 branch conditional is not a dispatch)",
  "branch body: BRACE-MATCHED",
  "mutator: BY NAME, now including `push|set` — this is the dominant false-positive source; the RED count is inflated and is NOT a defect count",
  "distinguishing-return: detected BY NAME (applied:false|error:|ok:false|reason:) — a spell using other vocabulary reads RED",
];

console.log("=== DENOMINATOR ===");
console.log(
  "FILTERS APPLIED (published — an unpublished filter makes a correct result unreproducible):",
);
for (const f of FILTERS_APPLIED) console.log(`  - ${f}`);
console.log(`non-test .ts:        ${files.length}`);
console.log(`dispatch files:      ${dispatchers.size}`);
console.log(`dispatch branches:   ${branches}`);
console.log(`mutator call sites:  ${rows.length}`);
if (!branches || !rows.length) {
  console.log("ZERO-DENOMINATOR — verdict withheld.");
  process.exit(1);
}

const red = rows.filter((r) => !r.distinguishing);
const green = rows.filter((r) => r.distinguishing);
console.log(`\n=== GREEN (branch CAN answer differently): ${green.length} ===`);
for (const r of green)
  console.log(
    `  ${r.file.padEnd(28)} ${r.verb.padEnd(18)} ${(r.local ?? "«bare»").padEnd(12)} <- ${r.callee}()`,
  );

console.log(`\n=== RED (uniform envelope regardless of outcome): ${red.length} ===`);
for (const r of red)
  console.log(
    `  ${r.file.padEnd(28)} ${r.verb.padEnd(18)} ${(r.local ?? "«bare»").padEnd(12)} <- ${r.callee}()`,
  );

const find = (f: string, v: string, arr: Row[]) =>
  arr.some((r) => r.file.startsWith(f) && r.verb === v);
console.log("\n=== THREE-WAY CALIBRATION (this is what v2 could not do) ===");
console.log(
  `RED  arm  imago  context.add  convicted : ${find("imago/", "context.add", red) ? "✅" : "❌"}`,
);
console.log(
  `GREEN arm bounty task.add     cleared   : ${find("bounty/", "task.add", green) ? "✅" : find("bounty/", "task.add", red) ? "❌ CONVICTED (wrong)" : "❌ INVISIBLE"}`,
);
console.log(
  `v2-BLIND  magpie element.add  now seen  : ${find("magpie/", "element.add", red) ? "✅" : "❌"}`,
);

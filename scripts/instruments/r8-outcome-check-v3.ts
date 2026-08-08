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
import { join } from "node:path";

const SKILLS = "/Users/colereed/Projects/Spellbook/plugins/spellbook/skills";

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

const files = walk(SKILLS);
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
      verb: m[2] ?? m[3],
      start: m.index,
      end: m.index + m[0].length,
    });

  let i = 0;
  while (i < marks.length) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1].disc === marks[i].disc) j++;
    const group = marks.slice(i, j + 1);
    if (group.length >= 3) {
      dispatchers.add(f);
      for (let k = 0; k < group.length; k++) {
        const body = blockAfter(src, group[k].end, group[k + 1]?.start ?? src.length);
        branches++;
        const dist = DISTINGUISHING.test(body);
        const seen = new Set<string>();
        for (const c of body.matchAll(MUTATOR)) {
          const [, local, callee] = c;
          const key = `${callee}|${local ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            file: f.replace(`${SKILLS}/`, ""),
            verb: group[k].verb,
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

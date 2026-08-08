#!/usr/bin/env bun
// r8 v2 — same question, an instrument that actually bounds its branches.
//
// v1 DEFECT (found by implausibility, not care): branch bodies were sliced from
// one mark to the next with a 4000-char cap and no brace matching, so the LAST
// branch of every dispatcher swallowed unrelated file tail, and any `x === "s"`
// comparison counted as a dispatch. Result: 186/380 captures "convicted" (~49%)
// with verbs like `cancel` owning `url.searchParams.get()`. A 49% hit rate is
// not a check, it is a coin flip with citations.
//
// v2: group marks by DISCRIMINANT identifier, require >=3 in a group, and
// brace-match each branch body. Report the denominator at every stage.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKILLS = "/Users/colereed/Projects/Spellbook/plugins/spellbook/skills";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// Body of the block starting at/after `from`, by brace matching. Handles the
// `if (...) { ... }` and `case "x": ... break;` shapes.
function blockAfter(src: string, from: number, hardEnd: number): string {
  let i = from;
  while (i < hardEnd && src[i] !== "{" && src[i] !== "\n") i++;
  if (src[i] !== "{") return src.slice(from, Math.min(hardEnd, from + 1200)); // case-style
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
const CAPTURE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(/g;
const ESCAPE_FNS =
  "emitEvent|emit|broadcast\\w*|reply|respond|Response|send\\w*|printJson|console\\.log";

type Hit = { file: string; verb: string; local: string; callee: string; reason: string };

const files = walk(SKILLS);
const hits: Hit[] = [];
const dispatchers: { file: string; disc: string; n: number }[] = [];
let branchCount = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  MARK.lastIndex = 0;
  const marks: { disc: string; verb: string; end: number; start: number }[] = [];
  for (const m of src.matchAll(MARK)) {
    marks.push({
      disc: m[1] ?? "«case»",
      verb: m[2] ?? m[3],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  // Group CONSECUTIVE marks sharing a discriminant — that is a dispatcher.
  let i = 0;
  while (i < marks.length) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1].disc === marks[i].disc) j++;
    const group = marks.slice(i, j + 1);
    if (group.length >= 3) {
      dispatchers.push({ file: f.replace(`${SKILLS}/`, ""), disc: group[0].disc, n: group.length });
      for (let k = 0; k < group.length; k++) {
        const hardEnd = group[k + 1]?.start ?? src.length;
        const body = blockAfter(src, group[k].end, hardEnd);
        branchCount++;
        CAPTURE.lastIndex = 0;
        for (const c of body.matchAll(CAPTURE)) {
          const [, local, callee] = c;
          const esc = new RegExp(`(?:${ESCAPE_FNS})\\s*\\([^;]{0,300}?\\b${local}\\b`, "s");
          const ret = new RegExp(`return[^;]{0,200}?\\b${local}\\b`, "s");
          if (esc.test(body) || ret.test(body)) continue;
          // Does the capture carry an OUTCOME the envelope cannot express?
          // Proxy: the callee is a mutation/creation verb, not a parse/lookup.
          const mutator =
            /^(add|create|make|new|mint|insert|put|upsert|register|save|write|apply|set)/i.test(
              callee.replace(/^.*\./, ""),
            );
          hits.push({
            file: f.replace(`${SKILLS}/`, ""),
            verb: group[k].verb,
            local,
            callee,
            reason: mutator ? "MUTATOR-DROPPED" : "dropped(non-mutator)",
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
  "mutator: detected BY NAME (add|create|make|mint|insert|put|upsert|register|save|apply|set) — violates house-style 'enumerate by behaviour, never by a name', stated as a known cost",
  "BLIND: a mutator called WITHOUT capturing its return is invisible (this is why v2 GREEN means nothing)",
];

console.log("=== DENOMINATOR (behaviour-enumerated, printed before any verdict) ===");
console.log(
  "FILTERS APPLIED (published — an unpublished filter makes a correct result unreproducible):",
);
for (const f of FILTERS_APPLIED) console.log(`  - ${f}`);
console.log(`non-test .ts under skills:   ${files.length}`);
console.log(`dispatchers (>=3 same disc): ${dispatchers.length}`);
console.log(`dispatch branches:           ${branchCount}`);
if (!dispatchers.length || !branchCount) {
  console.log("ZERO-DENOMINATOR — verdict withheld.");
  process.exit(1);
}
for (const d of dispatchers)
  console.log(`  ${d.file.padEnd(36)} on \`${d.disc}\`  (${d.n} branches)`);

const mut = hits.filter((h) => h.reason === "MUTATOR-DROPPED");
console.log(`\n=== captures dropped: ${hits.length}   of which MUTATOR-dropped: ${mut.length} ===`);
for (const h of mut) {
  console.log(
    `${h.file.padEnd(30)} ${String(h.verb).padEnd(20)} ${h.local.padEnd(12)} <- ${h.callee}()`,
  );
}

const red = mut.find((h) => h.file.startsWith("imago/") && h.verb === "context.add");
console.log("\n=== CALIBRATION ===");
console.log(
  `RED arm  imago context.add : ${red ? `CONVICTED ✅  (${red.local} <- ${red.callee}())` : "MISSED ❌"}`,
);
console.log(
  `signal-to-noise: ${mut.length} flagged of ${branchCount} branches (${((mut.length / branchCount) * 100).toFixed(1)}%)`,
);

#!/usr/bin/env bun
// r8 — can "a mutation on an add path that does not report its outcome" be
// found MECHANICALLY, by a check that does not know about imago?
//
// THE SIGNATURE (derived from the confirmed instance, then generalised):
//   a command-dispatch branch that CAPTURES a return value into a local, where
//   that local NEVER escapes into an outbound payload (event / response /
//   broadcast / return). The outcome existed, and the handler dropped it.
//
// WHY NOT "outcome absent from the envelope": imago's /cmd returns a HARDCODED
//   '{"ok":true,"applied":true}' and handleAgentMsg returns Promise<boolean>.
//   The envelope is one bit for EVERY verb, so that predicate convicts ~30
//   verbs per spell and discriminates nothing. The capture-and-drop is the part
//   that separates a handler with an outcome available from one without.
//
// DENOMINATOR: enumerated by BEHAVIOUR (files containing a command dispatch),
//   never by filename. Printed, and asserted non-zero, before any verdict.

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

// A dispatch branch: `if/else if (t === "verb")` OR `case "verb":`.
// Anchored on the DISPATCH SHAPE, not on a function name — bounty/glamour/imago/
// magpie all spell the dispatcher differently.
const BRANCH = /(?:else\s+)?if\s*\(\s*(?:\w+)\s*===\s*"([\w.-]+)"\s*\)|case\s+"([\w.-]+)"\s*:/g;
const CAPTURE = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$.]*)\s*\(/g;
const ESCAPE_FNS =
  "emitEvent|emit|broadcast\\w*|reply|respond|Response|JSON\\.stringify|send\\w*|push\\w*";

type Hit = {
  file: string;
  verb: string;
  local: string;
  callee: string;
  escapes: boolean;
  reason: string;
};

const files = walk(SKILLS);
const dispatchFiles: string[] = [];
const hits: Hit[] = [];
let branchCount = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  BRANCH.lastIndex = 0;
  const marks: { verb: string; start: number }[] = [];
  for (const m of src.matchAll(BRANCH))
    marks.push({ verb: m[1] ?? m[2], start: m.index + m[0].length });
  if (marks.length < 3) continue; // a dispatcher has several branches; 1-2 is an ordinary conditional
  dispatchFiles.push(f);

  for (let i = 0; i < marks.length; i++) {
    const body = src.slice(
      marks[i].start,
      marks[i + 1]?.start ?? Math.min(src.length, marks[i].start + 4000),
    );
    branchCount++;
    CAPTURE.lastIndex = 0;
    for (const c of body.matchAll(CAPTURE)) {
      const [, local, callee] = c;
      // Does the captured local reach anything outbound, or get returned?
      const esc = new RegExp(`(?:${ESCAPE_FNS})\\s*\\([^;]{0,300}?\\b${local}\\b`, "s");
      const ret = new RegExp(`return[^;]{0,200}?\\b${local}\\b`, "s");
      const objField = new RegExp(`\\b${local}\\s*[,}]|:\\s*${local}\\b`);
      const escapes = esc.test(body) || ret.test(body);
      // objField alone is weak evidence; recorded but not treated as escape.
      hits.push({
        file: f.replace(`${SKILLS}/`, ""),
        verb: marks[i].verb,
        local,
        callee,
        escapes,
        reason: escapes ? "escapes" : objField.test(body) ? "obj-field-only" : "dropped",
      });
    }
  }
}

const FILTERS_APPLIED = [
  "walk(): SKIPS `node_modules` and `dist`",
  "files: NON-TEST `.ts` only — every `*.test.ts` is excluded",
  "dispatcher: requires >=3 branches sharing ONE discriminant (a 1-2 branch conditional is not a dispatch)",
  "branch body: mark-to-next-mark, 4000-char cap, NO brace matching  <- THE DEFECT; see header",
];

console.log("=== DENOMINATOR (enumerated by behaviour, printed before any verdict) ===");
console.log(
  "FILTERS APPLIED (published — an unpublished filter makes a correct result unreproducible):",
);
for (const f of FILTERS_APPLIED) console.log(`  - ${f}`);
console.log(`non-test .ts under skills:      ${files.length}`);
console.log(`files with a DISPATCH (>=3 br): ${dispatchFiles.length}`);
console.log(`dispatch branches scanned:      ${branchCount}`);
console.log(`captures found in branches:     ${hits.length}`);
if (dispatchFiles.length === 0 || branchCount === 0) {
  console.log("ZERO-DENOMINATOR — the scan did not run over anything. Verdict withheld.");
  process.exit(1);
}
console.log("\ndispatch files:");
for (const f of dispatchFiles) console.log(`  ${f.replace(`${SKILLS}/`, "")}`);

const dropped = hits.filter((h) => !h.escapes);
console.log(
  `\n=== CONVICTIONS: captured-and-dropped = ${dropped.length} of ${hits.length} captures ===`,
);
for (const h of dropped) {
  console.log(
    `${h.file.padEnd(34)} ${String(h.verb).padEnd(22)} ${h.local.padEnd(14)} <- ${h.callee}()  [${h.reason}]`,
  );
}

const redArm = dropped.find((h) => h.file.startsWith("imago/") && h.verb === "context.add");
console.log("\n=== CALIBRATION ===");
console.log(
  `RED  arm (imago context.add, the confirmed instance): ${redArm ? "CONVICTED ✅" : "MISSED ❌"}`,
);
if (redArm) console.log(`     ${redArm.local} <- ${redArm.callee}()`);

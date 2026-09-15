// TYPE-SENTINEL PROBE — s5-R arm 2, "`null` not `0` when you cannot answer".
//
// ⛔ VERDICT: THIS PREDICATE DOES NOT WORK. Kept as a corpse with a cause of
// death so the next person to reach for the type-level route finds a measurement
// instead of an untried idea. Ruled NOT RATIFIABLE, sprint 05; the rule goes to
// sprint 06 with this evidence attached (spellbook comms #988/#991).
//
// THE PREDICATE: among functions containing a catch clause that RETURNS a value,
// a scalar return type must admit a non-domain sentinel (`null`/`undefined`).
//
// MEASURED over the two files the rule was DERIVED from (bounty/backend/server.ts,
// grapevine/backend/cli.ts — both relocated by the backend convergence since; the
// measurement is of those modules, not of those addresses):
//
//     IN DOMAIN 7 · CONVICTED 2 · DECLARED BLIND 26 · TRUE POSITIVES 0
//
// Both convictions are `main(): Promise<number>` returning an EXIT CODE — a closed
// domain with no cannot-answer state, so returning 2 from a catch is correct.
// 100% of its output is false positives; 79% of the scalar functions are outside
// its decidable domain.
//
// WHY IT FAILS, stated so nobody re-derives it: the predicate cannot distinguish
// "returns number and can always answer" from "returns number and sometimes
// cannot". That is the INTENT the roadmap named as the obstacle, met exactly where
// the roadmap said it would be. The control (type-sentinel-arms.ts) is calibrated
// in both directions and on annotated AND inferred code — and the verdict is still
// worthless. A calibrated control is not a licensed conclusion.
//
// ⚠ SCOPE FENCE (prospero, #991): this reads tsc's type INFORMATION as an
// instrument. Any use of tsc that would FAIL A BUILD is the typecheck gate, which
// Cole ruled out of sprint 05. Do not grow this into one. (Superseded 2026-09-10:
// once the repo reached zero, Cole ruled the typecheck gate IN — type-debt T37,
// `grimoire/type-check-ward.test.ts`. The fence still stands for THIS file: the
// gate is that ward, not a grown version of this probe.)
//
// ⛔ IT USED TO BE MACHINE-BOUND ON PURPOSE, AND THAT DECISION OUTLIVED ITS
// WORLD — which is the more useful scar. This file hardcoded absolute paths into
// one checkout (the `typescript` import specifier and the repo constant) and
// declared that ACCEPTED, because it is a corpse kept for its VERDICT and its
// method, not for reuse, and nobody should be running it in CI or on a fresh
// clone. (A cold reader who could not tell "deliberate" from "broken" is why it
// said so.)
//
// ⛔ THEN THE TYPECHECK GATE WAS RULED IN — four days later, noted in the fence
// above — and `scripts/` BECAME A MEASURED AREA. An unresolvable import is a
// type error, so the ward reds on this file everywhere the hardcoded path does
// not exist. It stayed green on the author's laptop and ONLY there: the gate's
// first run on a real release PR failed with
// `TS2307: Cannot find module '/Users/…/node_modules/typescript/lib/typescript.js'`
// (2026-09-14). **A green gate that depends on one machine's directory layout is
// not a gate.**
//
// So the two paths are portable now — a bare `typescript` specifier and a repo
// root derived from this file's own location. ⚠ THAT IS NOT AN ENDORSEMENT: the
// predicate still does not work, the verdict below still stands, and this is
// still not something to run in CI. Portable means it can be TYPE-CHECKED like
// every other committed file, not that it is worth executing. The general rule
// it earned: **"this file is exempt because nobody runs it" stops being true the
// moment something starts reading it, and nothing tells you when that happens.**
//
// Run:  bun scripts/instruments/type-sentinel-probe.ts <file.ts> [...]
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** This checkout, from this file's own location — `scripts/instruments/` is two down. */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cfg = ts.readConfigFile(`${repo}/tsconfig.json`, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, repo);
const files = process.argv.slice(2);
const program = ts.createProgram(files, parsed.options);
const checker = program.getTypeChecker();

// PREDICATE E — domain: functions containing a CATCH CLAUSE THAT RETURNS A VALUE.
// Blind by construction to guard-shaped collapses (`exists ? n : 0`) — undecidable
// without intent, declared rather than silently skipped.
let inDomain = 0,
  convicted = 0,
  blindGuards = 0;
for (const f of files) {
  const sf = program.getSourceFile(f);
  if (!sf) {
    console.log("NO SOURCE FILE:", f);
    continue;
  }
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body) {
      let catchReturns = false;
      const scan = (n: ts.Node) => {
        if (ts.isCatchClause(n)) {
          const hasRet = (m: ts.Node): boolean =>
            ts.isReturnStatement(m) && m.expression ? true : (ts.forEachChild(m, hasRet) ?? false);
          if (hasRet(n.block)) catchReturns = true;
        }
        ts.forEachChild(n, scan);
      };
      scan(node.body);
      const sig = checker.getSignatureFromDeclaration(node);
      if (sig) {
        const rt = checker.typeToString(checker.getReturnTypeOfSignature(sig));
        const scalar = /\bnumber\b|\bstring\b|\bboolean\b/.test(rt);
        if (catchReturns && scalar) {
          inDomain++;
          const honest = /null|undefined/.test(rt);
          if (!honest) {
            convicted++;
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            console.log(
              `⛔ ${f.replace(`${repo}/`, "")}:${line + 1}  ${(node.name?.getText() ?? "<anon>").padEnd(24)} -> ${rt}`,
            );
          }
        } else if (!catchReturns && scalar && !/null|undefined/.test(rt)) blindGuards++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(`\nIN DOMAIN (catch-returns + scalar): ${inDomain}   CONVICTED: ${convicted}`);
console.log(
  `DECLARED BLIND (scalar, no returning catch — guard-shaped, undecidable): ${blindGuards}`,
);

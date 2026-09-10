/**
 * ⛔ READ A POSSIBLY-UNDEFINED VALUE, AND DIE NAMING THE INVARIANT.
 *
 * The type-debt project's R3: `arr[i]!` and `?? fallback` both make the error
 * disappear and only one of them is honest. This is the third option, and in a
 * WARD it is the only defensible one.
 *
 * WHY NOT `x!`. It asserts the invariant to the compiler and to nobody else. If
 * the invariant is ever false the ward reads `undefined` as a value, compares it
 * against something, and reports a verdict computed from it — a wrong answer
 * delivered with the same confidence as a right one.
 *
 * ⛔ WHY NOT `?? fallback`, AND WHY NOT `if (!x) continue` — THIS IS THE ONE
 * THAT MATTERS. In a ward, an element skipped or defaulted is an element that
 * left the DENOMINATOR. That is D64 exactly: a de-duplication took the
 * spawn-path ward's `pins` from 6 to 5, nothing about the spell's behaviour
 * changed, and NO INSTRUMENT REDDENED — because a coverage count going down is
 * not a failure. Three shipped documents then quoted a number that had been
 * false since the commit they shipped in. A ward that quietly examines less is
 * the defect class this repo has now paid for four times (D27, D43, D64, C10).
 *
 * So: state the invariant at the call site, and if it is ever violated, throw
 * with it. A ward that crashes gets repaired in the same hour. A ward that
 * counts less ships a green that means nothing.
 *
 * ⚠ IT IS NOT FOR EVERY `undefined`. Plenty of reads are LEGITIMATELY absent —
 * the element past the end of an array, an exhausted pool, an optional regex
 * group. Those deserve an explicit named branch, not this. Telling the two
 * apart, read by read, IS R3; `must()` is only the half where absence is
 * impossible.
 *
 * ⚠ `scripts/instruments/*` DELIBERATELY DOES NOT IMPORT THIS and carries its
 * own copies. Every file there imports node builtins and nothing else, so each
 * instrument stays runnable and copyable on its own — and the three
 * `r8-outcome-check-v{1,2,3}.ts` files are CALIBRATED SPECIMENS whose
 * independence is their evidentiary value (c4d669eb verified each byte-identical
 * to its own baseline). A shared module would let one edit move all three at
 * once, silently.
 */
export function must<T>(v: T | undefined, invariant: string): T {
  if (v === undefined) throw new Error(`INVARIANT VIOLATED — ${invariant}`);
  return v;
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Card a4 — the stable key. Every rule in house-style.md carries a machine-
// readable id, so canon can be ADDRESSED rather than matched by title.
//
// WHY IT EXISTS: criterion 2 clause (ii) requires every rule to name the check
// that enforces it and every check to cite the rule it enforces. That is
// unimplementable by title — the decay ledger keys its rows on hand-abbreviated
// paraphrases, and EXACT title matches are 0 of 17 against a CORRECT ledger.
//
// ⛔ WHAT THIS WARD CANNOT SEE — read this before trusting a green:
//   · It does NOT check that an id is a GOOD name, or that it still describes
//     the rule after the rule's wording changes. An id that has drifted from
//     its heading is invisible here and always will be.
//   · It does NOT pair rules against ledger rows. That is g3's ward (cassandra),
//     which keys on the ids this one guarantees. Deliberately not duplicated:
//     two wards asserting one fact is how they drift apart.
//   · It does NOT know which headings are "the rules" in any semantic sense. It
//     asserts over a SYNTACTIC set — every heading at depth 3-4 — precisely
//     because "the rules" has no single correct denominator: the count is a
//     function of the question asked. Two behaviour-shaped enumerators over this
//     same file returned 17 and 18 on one afternoon, both correct for their own
//     question, neither complete for the other's.
//   · A heading that is NOT a rule but sits at depth 3-4 would be required to
//     carry an id here. There are none today; if one appears, this ward is the
//     thing that will complain, and that complaint is the signal to decide what
//     the heading is — not to add an id to silence it.

const HOUSE_STYLE = join(import.meta.dir, "house-style.md");

type Heading = { line: number; depth: number; title: string; id: string | null };

function parseHeadings(): Heading[] {
  const lines = readFileSync(HOUSE_STYLE, "utf8").split("\n");
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{3,4}) (.+)$/.exec(lines[i]);
    if (!m) continue;
    // The id rides in an HTML comment in the next few lines: invisible when
    // rendered, so it imposes no reading cost on a human.
    let id: string | null = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const idm = /^<!-- rule-id: (.+?) -->$/.exec(lines[j].trim());
      if (idm) {
        id = idm[1];
        break;
      }
      if (/^#{1,6} /.test(lines[j])) break;
    }
    out.push({ line: i + 1, depth: m[1].length, title: m[2], id });
  }
  return out;
}

// A — THE DENOMINATOR GUARD. A sweep that fails to run reports the same thing as
// a sweep that found nothing wrong, so this ward must prove it examined a real
// population before any of its greens mean anything.
test("a4: the ward examined a non-empty population of rule headings", () => {
  const headings = parseHeadings();
  expect(headings.length).toBeGreaterThan(10);
  // Assert the shape too: a parse that found only depth-3 or only depth-4 has
  // almost certainly regexed wrong, and a bare count cannot tell you that.
  expect(headings.some((h) => h.depth === 3)).toBe(true);
  expect(headings.some((h) => h.depth === 4)).toBe(true);
});

// B — PRESENCE.
test("a4: every rule heading carries a rule-id", () => {
  const missing = parseHeadings()
    .filter((h) => h.id === null)
    .map((h) => `L${h.line} (h${h.depth}) ${h.title}`);
  expect({ missing, count: missing.length }).toEqual({ missing: [], count: 0 });
});

// C — UNIQUENESS. An id that resolves to two rules is worse than no id: a check
// citing it would silently enforce against whichever the reader found first.
test("a4: rule-ids are unique", () => {
  const seen = new Map<string, string[]>();
  for (const h of parseHeadings()) {
    if (!h.id) continue;
    seen.set(h.id, [...(seen.get(h.id) ?? []), `L${h.line} ${h.title}`]);
  }
  const dupes = [...seen.entries()].filter(([, v]) => v.length > 1);
  expect(dupes).toEqual([]);
});

// D — NAMESPACE INTEGRITY. A clause's id must be namespaced under its parent
// rule, so an id alone tells a consumer whether it is addressing a whole rule or
// one clause of one. This is what lets g3 pair the 17 top-level rules against 17
// ledger rows while the 3 clauses are correctly rowless.
test("a4: clause ids are namespaced under their parent rule", () => {
  const headings = parseHeadings();
  const problems: string[] = [];
  let parent: string | null = null;
  for (const h of headings) {
    if (h.depth === 3) {
      parent = h.id;
      if (h.id?.includes(".")) problems.push(`L${h.line} top-level id is dotted: ${h.id}`);
      continue;
    }
    if (!h.id) continue; // B owns the missing case
    if (!parent) problems.push(`L${h.line} clause with no parent rule: ${h.id}`);
    else if (!h.id.startsWith(`${parent}.`))
      problems.push(`L${h.line} clause id "${h.id}" is not under parent "${parent}"`);
  }
  expect(problems).toEqual([]);
});

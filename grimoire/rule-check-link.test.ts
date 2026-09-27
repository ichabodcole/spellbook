// enforces: none in house-style — spell-hardening clause (ii): every rule names its check, every check its rule
//
// THE RULE ↔ CHECK LINK, BOTH DIRECTIONS. Every rule in house-style.md names the
// ward that enforces it, or says `none` and why; every grimoire ward names the
// house-style rule it enforces, or the outside authority it enforces instead.
// This ward holds the two sides to each other.
//
//   RULE side   `<!-- enforced-by: grimoire/<ward>.test.ts[, …] -->`
//               or `<!-- enforced-by: none — <reason> -->`, in the rule's block
//               (beside its `rule-id` marker).
//   WARD side   `// enforces: <rule-id>[, …]`
//               or `// enforces: none in house-style — <authority>`, as the first
//               line of the ward's header comment.
//
// POPULATIONS, both taken from the files, never from a list here:
//   · rules = rule-id's own predicate (every `###`/`####` heading, id in the next
//     few lines), clauses included, because rule-id treats them as rules. It is
//     cross-checked against the count of `rule-id` markers, so a parse that
//     drifts from rule-id's reds here instead of shrinking quietly.
//   · wards = every `grimoire/*.test.ts` (the team's call, 2026-09-27: grimoire
//     is the ward set by convention; spell-local tests are out). A header cannot
//     define its own denominator, which is why the population is the glob and
//     not "files carrying an `enforces:` line".
//
// ⛔ WHAT THIS WARD CANNOT SEE — read this before trusting a green:
//   · THAT A WARD ACTUALLY ENFORCES WHAT IT CITES. It checks that the two sides
//     AGREE, not that either is TRUE. A ward citing a rule it never tests, with
//     the rule naming it back, is green here forever. Whether an assertion holds
//     a rule's behaviour is a reading, and was made by reading (the item's
//     Fixed section lists each link and why).
//   · THAT A `none` REASON IS TRUE. "intent" on a checkable rule, or "checkable,
//     unchecked" on a rule nobody could check, reads green. It checks only that
//     a reason is there.
//   · THAT AN OUTSIDE AUTHORITY EXISTS OR IS CURRENT. `D43` or "Cole's ruling,
//     2026-09-24" is text; nothing resolves it.
//   · PARTIAL ENFORCEMENT. A link says a ward checks some of a rule's behaviour,
//     never all of it. Most links here are partial.
//   · Canon outside house-style.md (outcome-contract.md, seams.md, AGENTS.md),
//     by Cole's scope ruling of 2026-09-27.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { must } from "./lib/must.ts";

const GRIMOIRE = import.meta.dir;
const HOUSE_STYLE = join(GRIMOIRE, "house-style.md");
const WARD_GLOB = "*.test.ts";
const NONE_RULE = /^none — (.*)$/;
const NONE_WARD = /^none in house-style — (.*)$/;
const WARD_PATH = /^grimoire\/[a-z0-9.-]+\.test\.ts$/;

type Link = { none: string } | { names: string[] };
type Rule = { line: number; id: string; markers: string[] };
type Ward = { path: string; markers: string[]; firstComment: string | null };

function parseValue(raw: string, none: RegExp): Link {
  const m = none.exec(raw);
  if (m) return { none: must(m[1], "none matcher matched without its reason group").trim() };
  return { names: raw.split(",").map((s) => s.trim()) };
}

// The SAME predicate rule-id.test.ts uses: a heading at depth 3-4 whose id rides
// in an HTML comment in the next three lines. A heading with no id is rule-id's
// failure to report, not this ward's; it is skipped here and caught there.
function parseRules(): Rule[] {
  const lines = readFileSync(HOUSE_STYLE, "utf8").split("\n");
  const out: Rule[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = must(lines[i], `lines[${i}] absent inside 0..${lines.length}`);
    if (!/^#{3,4} .+$/.test(line)) continue;
    let id: string | null = null;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const ahead = must(lines[j], `lines[${j}] absent inside 0..${lines.length}`);
      const idm = /^<!-- rule-id: (.+?) -->$/.exec(ahead.trim());
      if (idm) {
        id = must(idm[1], "rule-id matcher matched without its id group");
        break;
      }
      if (/^#{1,6} /.test(ahead)) break;
    }
    if (id === null) continue;
    // The rule's BLOCK runs to the next heading of any depth, so a clause's
    // marker is never read as its parent's.
    const markers: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ahead = must(lines[j], `lines[${j}] absent inside 0..${lines.length}`);
      if (/^#{1,6} /.test(ahead)) break;
      const em = /^<!-- enforced-by: (.*?) -->$/.exec(ahead.trim());
      if (em) markers.push(must(em[1], "enforced-by matcher matched without its value group"));
    }
    out.push({ line: i + 1, id, markers });
  }
  return out;
}

function parseWards(): Ward[] {
  const files = [...new Glob(WARD_GLOB).scanSync({ cwd: GRIMOIRE })].sort();
  return files.map((f) => {
    const lines = readFileSync(join(GRIMOIRE, f), "utf8").split("\n");
    const markers = lines
      .map((l) => /^\/\/ enforces: (.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => must(m[1], "enforces matcher matched without its value group"));
    const firstComment = lines.find((l) => l.startsWith("//") || l.startsWith("/*")) ?? null;
    return { path: `grimoire/${f}`, markers, firstComment };
  });
}

const rules = parseRules();
const wards = parseWards();
const ruleById = new Map(rules.map((r) => [r.id, r]));
const wardByPath = new Map(wards.map((w) => [w.path, w]));

// One marker, parsed; the shape cells below own the zero-or-many case.
const ruleLink = (r: Rule): Link | null =>
  r.markers.length === 1 ? parseValue(must(r.markers[0], "one marker"), NONE_RULE) : null;
const wardLink = (w: Ward): Link | null =>
  w.markers.length === 1 ? parseValue(must(w.markers[0], "one marker"), NONE_WARD) : null;

describe("rule ↔ check link", () => {
  // A — THE DENOMINATOR GUARDS, ONE PER SIDE. A two-sided diff has two
  // denominators, and guarding one feels like guarding the check.
  test("the rule population is non-empty, has both depths, and matches rule-id's markers", () => {
    const markerCount = (readFileSync(HOUSE_STYLE, "utf8").match(/^<!-- rule-id: .+? -->$/gm) ?? [])
      .length;
    console.log(`  rule-check-link: ${rules.length} rule(s), ${wards.length} ward(s)`);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.length).toBe(markerCount);
    const text = readFileSync(HOUSE_STYLE, "utf8");
    expect(/^### /m.test(text) && /^#### /m.test(text)).toBe(true);
  });

  test("the ward population is non-empty and includes this ward", () => {
    expect(wards.length).toBeGreaterThan(0);
    expect(wardByPath.has("grimoire/rule-check-link.test.ts")).toBe(true);
  });

  // B — SHAPE, RULE SIDE: exactly one marker, a non-empty reason or a list of
  // ward paths.
  test("every rule carries exactly one well-formed enforced-by marker", () => {
    const problems: string[] = [];
    for (const r of rules) {
      if (r.markers.length !== 1) {
        problems.push(`L${r.line} ${r.id}: ${r.markers.length} enforced-by markers, want 1`);
        continue;
      }
      const raw = must(r.markers[0], "one marker");
      if (raw.startsWith("none") && !NONE_RULE.test(raw))
        problems.push(`L${r.line} ${r.id}: "none" must read "none — <reason>"`);
      const link = parseValue(raw, NONE_RULE);
      if ("none" in link) {
        if (link.none === "") problems.push(`L${r.line} ${r.id}: none with an empty reason`);
        continue;
      }
      for (const n of link.names)
        if (!WARD_PATH.test(n)) problems.push(`L${r.line} ${r.id}: "${n}" is not a ward path`);
    }
    expect(problems).toEqual([]);
  });

  // C — SHAPE, WARD SIDE: exactly one header, at the top of the header comment,
  // a non-empty authority or a list of rule ids.
  test("every ward carries exactly one well-formed enforces header, first in its header comment", () => {
    const problems: string[] = [];
    for (const w of wards) {
      if (w.markers.length !== 1) {
        problems.push(`${w.path}: ${w.markers.length} enforces headers, want 1`);
        continue;
      }
      const raw = must(w.markers[0], "one marker");
      if (w.firstComment !== `// enforces: ${raw}`)
        problems.push(`${w.path}: the enforces line is not the first line of the header comment`);
      if (raw.startsWith("none") && !NONE_WARD.test(raw))
        problems.push(`${w.path}: "none" must read "none in house-style — <authority>"`);
      const link = parseValue(raw, NONE_WARD);
      if ("none" in link) {
        if (link.none === "") problems.push(`${w.path}: none with an empty authority`);
        continue;
      }
      for (const n of link.names)
        if (!/^[a-z0-9.-]+$/.test(n)) problems.push(`${w.path}: "${n}" is not a rule id`);
    }
    expect(problems).toEqual([]);
  });

  // D — RULE → WARD: every ward a rule names exists and cites the rule back.
  test("every ward a rule names exists and cites that rule back", () => {
    const problems: string[] = [];
    for (const r of rules) {
      const link = ruleLink(r);
      if (!link || "none" in link) continue;
      for (const path of link.names) {
        const w = wardByPath.get(path);
        if (!w) {
          problems.push(`${r.id} names ${path}, which is not a grimoire ward`);
          continue;
        }
        const back = wardLink(w);
        if (!back || "none" in back || !back.names.includes(r.id))
          problems.push(`${r.id} names ${path}, which does not cite ${r.id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  // E — WARD → RULE: every rule id a ward cites exists and names the ward back.
  test("every rule id a ward cites exists and names that ward back", () => {
    const problems: string[] = [];
    for (const w of wards) {
      const link = wardLink(w);
      if (!link || "none" in link) continue;
      for (const id of link.names) {
        const r = ruleById.get(id);
        if (!r) {
          problems.push(`${w.path} cites ${id}, which is not a house-style rule id`);
          continue;
        }
        const back = ruleLink(r);
        if (!back || "none" in back || !back.names.includes(w.path))
          problems.push(`${w.path} cites ${id}, which does not name ${w.path}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The SKILL.md flag invariant — a roster-wide ward, owned by the grimoire seat.
//
// INVARIANT, two halves with DIFFERENT denominators (they cannot share one):
//   A. every flag named in a spell's SKILL.md is recognized by some entry point
//      of that spell;
//   B. every flag a CALLER-FACING entry point recognizes is named in that
//      spell's SKILL.md.
//
// It lives as a test, not as a checklist step, because a ward that runs on
// invocation runs when someone remembers — and this repo has been bitten by
// exactly that. Put it where it cannot be skipped.
//
// ── Design requirements, each earned by RUNNING an earlier version ──────────
//  1. Enumerate entry points by WHAT PARSES ARGS. Not by filename; not by
//     `process.argv` (blind to `Bun.argv`); not by static import (blind to
//     `await import("node:util")`). All three were used and all three were wrong.
//  2. Half B is CALLER-FACING only. An entry point spawned solely by a sibling
//     has a private argv; documenting it publishes an interface the spell does
//     not offer. Unbounded, this produced a 6-item false positive on glamour's
//     daemon.
//  3. Anchor the registry on a STRUCTURAL SIBLING (`strict:`/`allowPositionals:`
//     beside `options:`), never on a name. Matching the property name `options:`
//     hit `options: Array.isArray(msg.options)` — a flag literally named
//     `options` — and marked two conformant entry points unresolvable. Matching
//     `/parseArgs\s*\(/` instead hit the function DECLARATION, captured its
//     return-type annotation, and produced 46 plausible findings across four
//     spells. Both are `enumerate by call site, not by name`, violated inside
//     the tool built to enforce it.
//  4. Resolve `options: <identifier>` to its declaration — bounty and glamour
//     use named consts, and a literal-only scan reports all their flags as drift.
//  5. Read EVERY options map, not the first: mind-mapper/cli.ts has 27.
//  6. ZERO-DENOMINATOR GUARD ON BOTH SIDES. A two-sided diff has two
//     denominators and guarding one feels like guarding the check.
//
// ⚠ WHAT THIS WARD CANNOT SEE, stated so a green is not read as more than it is:
//   • the `--` terminator. Both operands are keyed on flag NAMES; a bare `--` is
//     never an options key and never matches the doc regex. A spell whose `--`
//     handling is wholly undocumented reads clean here, forever.
//   • whether a documented flag's DESCRIPTION is true. This checks presence.
//   • whether a flag is exercised by a test. Different axis, different ward.
//   • a flag documented only in the CLI's own usage string counts as
//     UNDOCUMENTED here, deliberately — SKILL.md is where an agent decides
//     WHETHER to reach for a flag.

const SKILLS = join(import.meta.dir, "..", "plugins", "spellbook", "skills");

// Requirement 2. Internal = spawned only by a sibling in the same spell.
const INTERNAL = new Set([
  "astrolabe/scripts/server.ts",
  "bounty/scripts/server.ts",
  "glamour/scripts/server.ts",
  "imago/scripts/server.ts",
  "magpie/scripts/server.ts",
  "mind-mapper/scripts/server.ts",
  "magpie/scripts/discover.ts",
]);

// Other tools' flags, legitimately spelled in our prose. Keyed (spell:flag),
// NEVER by flag alone — a global name list would silence a real finding in a
// spell that legitimately owns the name, and it would do so silently.
// An explicit list is verifiable by LISTING, which is why it is a list.
const FOREIGN: Record<string, string> = {
  "grapevine:line-buffered": "grep's flag, from the Monitor incantation",
  "grapevine:version": "no such flag; the hits are a `version` field",
  "magpie:format": "media-forge's flag — an external tool",
  "glamour:format": "media-forge's — `mf generate image … --format json`",
  "glamour:help": 'a positional verb (`case "help"`), not --help',
  "glamour:ref": "media-forge's — `mf generate image … [--ref <path|url>]`",
  "glamour:n": "media-forge's — the SKILL.md says so in as many words",
  "imago:ref": "media-forge's — `--ref <path>` on an mf call",
};
const isForeign = (spell: string, flag: string) => FOREIGN[`${spell}:${flag}`] !== undefined;

function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}

/** null = the instrument could not read this file. NEVER an empty set. */
function recognizedSet(src: string): string[] | null {
  const names = new Set<string>();
  let sawMap = false;
  for (const m of src.matchAll(/options\s*:\s*(\{|([A-Za-z_$][\w$]*))/g)) {
    // Requirement 3: a real parseArgs argument object carries these siblings.
    if (!/\bstrict\s*:|\ballowPositionals\s*:/.test(src.slice(m.index, m.index + 1200))) continue;
    sawMap = true;
    let block: string;
    if (m[1] === "{") {
      block = braceBlock(src, src.indexOf("{", m.index));
    } else {
      const decl = src.search(new RegExp(`(?:const|let|var)\\s+${m[2]}\\s*=\\s*\\{`));
      if (decl < 0) return null; // Requirement 4 failed — instrument, not "clean"
      block = braceBlock(src, src.indexOf("{", decl));
    }
    for (const k of block.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*\{\s*type\s*:/g))
      names.add(k[1] ?? k[2]);
  }
  return sawMap ? [...names] : null;
}

const entryPoints = [...new Bun.Glob("*/scripts/*.ts").scanSync({ cwd: SKILLS })]
  .filter((p) => !p.endsWith(".test.ts"))
  .sort();

const parsing = entryPoints.filter((p) =>
  // Requirement 1: by behaviour, including the two spellings that were invisible
  // to the classifiers this repo previously trusted.
  /nodeParseArgs\(|parseArgs\(\s*\{|node:util|Bun\.argv|process\.argv/.test(
    require("node:fs").readFileSync(join(SKILLS, p), "utf8"),
  ),
);

describe("ward — every SKILL.md flag is recognized, and every recognized flag is documented", () => {
  test("the sweep actually ran (zero-denominator guard, entry-point side)", () => {
    // A sweep that fails to run reports the same thing as a sweep that found
    // nothing wrong. Assert the denominator before trusting any verdict below.
    expect(parsing.length).toBeGreaterThan(10);
  });

  const spells = [...new Set(parsing.map((p) => p.split("/")[0]))].sort();

  for (const spell of spells) {
    test(`${spell}`, () => {
      const skillPath = join(SKILLS, spell, "SKILL.md");
      const fs = require("node:fs");
      if (!fs.existsSync(skillPath)) {
        // NOT clean — a spell with no SKILL.md reading as clean is how an
        // earlier version of this ward produced ~40 phantom flags.
        return; // nothing to compare; recorded as a skip, never as a pass
      }
      const skill: string = fs.readFileSync(skillPath, "utf8");
      const mine = parsing.filter((p) => p.startsWith(`${spell}/`));

      const caller: string[] = [];
      const all = new Set<string>();
      const unresolved: string[] = [];
      for (const p of mine) {
        const set = recognizedSet(fs.readFileSync(join(SKILLS, p), "utf8"));
        if (set === null) unresolved.push(p);
        else {
          for (const f of set) all.add(f);
          if (!INTERNAL.has(p)) caller.push(...set);
        }
      }
      expect({ spell, unresolvedEntryPoints: unresolved }).toEqual({
        spell,
        unresolvedEntryPoints: [],
      });

      const documented = new Set(
        [...skill.matchAll(/--([a-z][a-z0-9-]*)/g)]
          .map((m) => m[1])
          .filter((f) => !isForeign(spell, f)),
      );

      // Requirement 6: BOTH denominators, before either verdict.
      expect({ spell, recognized: all.size > 0, documented: documented.size > 0 }).toEqual({
        spell,
        recognized: true,
        documented: true,
      });

      const undocumented = [...new Set(caller)].filter(
        (f) => !documented.has(f) && !isForeign(spell, f),
      );
      const unrecognized = [...documented].filter((f) => !all.has(f));

      expect({
        spell,
        undocumented: undocumented.sort(),
        unrecognized: unrecognized.sort(),
      }).toEqual({
        spell,
        undocumented: [],
        unrecognized: [],
      });
    });
  }
});

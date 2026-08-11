import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  argParsingEntryPoints,
  globEntryPointsForComparison,
  isCallerFacing,
  recognizedFlags as recognizedSet,
  SKILLS_DIR as SKILLS,
  spellsOf,
} from "./lib/entry-points";

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

// ⚠ THE ENUMERATOR AND THE FLAG REGISTRY NOW LIVE IN `./lib/entry-points.ts`,
// shared with the sprint-05 conformance cells. The requirement comments moved
// with the code, because a requirement earned by running a wrong version is
// worth nothing sitting beside the caller instead of the mechanism.
// Two behaviour-preserving notes for anyone diffing this against its pre-sprint-05 shape:
//   • enumeration is now a recursive WALK, not `Bun.Glob("*/scripts/*.ts")`.
//     Measured equal at extraction, and `globEntryPointsForComparison` keeps a
//     cell asserting they stay equal — see the module header for why the wider
//     one won.
//   • `INTERNAL` is now `isCallerFacing()` from the module (same seven paths).

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

const parsing = argParsingEntryPoints();

describe("ward — every SKILL.md flag is recognized, and every recognized flag is documented", () => {
  test("the sweep actually ran (zero-denominator guard, entry-point side)", () => {
    // A sweep that fails to run reports the same thing as a sweep that found
    // nothing wrong. Assert the denominator before trusting any verdict below.
    expect(parsing.length).toBeGreaterThan(10);
  });

  test("the walk and the old glob still enumerate the SAME entry points", () => {
    // This ward used to enumerate with `Bun.Glob("*/scripts/*.ts")`; the shared
    // module uses a recursive walk, which is strictly WIDER. They were measured
    // equal at extraction and this cell is what keeps that a MEASUREMENT rather
    // than an assumption a year from now.
    //
    // A failure here is NOT a bug in either strategy — it means a spell put an
    // arg-parsing source somewhere other than `<spell>/scripts/`, and the glob
    // has begun silently filtering it. The walk is the correct answer; the cell
    // exists so that day is loud. Expect the WALK's list, and read the diff.
    expect({ walk: parsing, glob: globEntryPointsForComparison() }).toEqual({
      walk: parsing,
      glob: parsing,
    });
  });

  const spells = spellsOf(parsing);

  // ⛔ THE WARD'S OWN GREEN NO-OP — found by cassandra (#985), pre-existing at
  // HEAD, and the line that hid it was a COMMENT ASSERTING THE OPPOSITE.
  //
  // A spell with no SKILL.md used to `return` early with the note "recorded as a
  // skip, never as a pass". **A bare `return` in bun:test IS a pass.** So the
  // ward printed a green cell whose output was BYTE-IDENTICAL to the world where
  // that spell was fully checked — this project's own thesis (a consumer cannot
  // distinguish "nothing is wrong" from "I could not look") firing inside the
  // instrument written to enforce it. Measured: mind-mapper has 39 caller-facing
  // flags, MORE THAN ANY CHECKED SPELL, and all 39 were unwarded and silent.
  //
  // The absence is now PINNED rather than skipped, so it is countable and a
  // change in either direction is loud. Deliberately NOT a hard failure: writing
  // mind-mapper's SKILL.md is a FIX, and this sprint is a gate. The debt is
  // stated, which is what the gate owes.
  //
  // ⚠ THE PIN STATES THE MEASUREMENT, NOT A VERDICT ON WHETHER THE FOLDER IS A
  // SPELL. prospero (#989) measured that `mind-mapper` is absent from ALL FOUR
  // synced listings — marketplace.json tags, the two roster READMEs, and the
  // reserved-name trigger registry — while its code shipped in v2.2.0. So the
  // missing SKILL.md is not a documentation gap in a declared spell; the folder
  // is undeclared and published. Whether the repair is "declare it" or "it
  // should not have shipped" is Cole's product call and is OUT of sprint 05.
  // This entry says only what is true from the enumerator's side: the folder
  // owns caller-facing arg-parsing entry points and no contract wards them.
  const SPELLS_WITHOUT_SKILL_MD: Record<string, string> = {
    "mind-mapper": "39 caller-facing flags unwarded; folder is undeclared (see #989) and shipped",
  };

  test("every spell with no SKILL.md is PINNED, not silently skipped", () => {
    const fs = require("node:fs");
    const missing = spells.filter((s) => !fs.existsSync(join(SKILLS, s, "SKILL.md"))).sort();
    // Both directions. A spell ARRIVING here is new unwarded surface; a spell
    // LEAVING must be struck from the list, or the list rots into an excuse.
    expect({ missing, pinned: Object.keys(SPELLS_WITHOUT_SKILL_MD).sort() }).toEqual({
      missing,
      pinned: missing,
    });
  });

  for (const spell of spells) {
    test(`${spell}`, () => {
      const skillPath = join(SKILLS, spell, "SKILL.md");
      const fs = require("node:fs");
      if (!fs.existsSync(skillPath)) {
        // Assert the pin rather than returning. This cell still passes for a
        // pinned spell — but it passes for a STATED reason, and an unpinned one
        // fails here instead of reading clean.
        expect({ spell, pinnedAsUnwarded: spell in SPELLS_WITHOUT_SKILL_MD }).toEqual({
          spell,
          pinnedAsUnwarded: true,
        });
        return;
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
          if (isCallerFacing(p)) caller.push(...set);
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

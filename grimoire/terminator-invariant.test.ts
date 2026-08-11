import { describe, expect, test } from "bun:test";
import { parseArgs } from "node:util";
import {
  allowsPositionals,
  argParsingEntryPoints,
  isCallerFacing,
  readEntryPoint,
} from "./lib/entry-points";

// ROW 2 of the sprint-05 conformance table — "free text never promoted to a flag
// name" — and its inverse, which is the half that actually bites us.
//
// It is a SIBLING ward rather than a cell inside `flag-invariant.test.ts`, and
// that is deliberate: flag-invariant's own header states it CANNOT see the `--`
// terminator, because both its operands are keyed on flag NAMES and a bare `--`
// is never an options key. Bolting this rule onto that ward would inherit the
// exact blindness the ward declares.
//
// ── THE TWO DIRECTIONS, because only one of them is solved ──────────────────
//
//  PROMOTION  free text -> flag name.  `bounty add write the --draft section`
//             truncated the title to "write the" at exit 0.
//             SOLVED, by `strict: true`: node:util throws on the unknown flag.
//
//  DEMOTION   flag -> free text.  `bounty update t1 -- --session-key K`
//             NOT SOLVED, and silent. After `--`, node:util moves every token
//             into `positionals`, so a REAL, RECOGNISED flag is swallowed whole.
//             Nothing throws, nothing warns, and the value is simply gone.
//
// ── THE SCAR (card c1 / `t-2df67738`), reproduced 2026-08-10 ────────────────
// Driven against a bounty board in an isolated BOUNTY_HOME *and* TMPDIR — both,
// because bounty's session discovery escapes BOUNTY_HOME through a machine-global
// pointer in the temp dir, so isolating only the first aims the drive at whatever
// board is live on the machine.
//
//   A  update t1 --status doing --session-key ZZZ-nonexistent     exit 2
//      "no running bounty session"      <- never resolved a board. CORRECT.
//   B  update t1 --status doing -- --session-key ZZZ-nonexistent  exit 1
//      "no such task t1"                <- resolved a board and SEARCHED it.
//
// ⭐ THE DISCRIMINATOR IS WHICH NOUN THE ERROR NAMES. A fails on a *session*;
// B fails on a *task*, which it could only reach by resolving a board — and the
// only board it could resolve is the ambient one. The `--session-key` did not
// error, did not warn, and appeared nowhere in the output.
//
// ⚠ NOT CLAIMED: the c1 card says the write then LANDS at exit 0. This ward
// pins the retargeting, which is the mechanism. The completed wrong write was
// not observed — the drive's task seed never reached the spawned process, so B
// died at task lookup. One seed away, and not run.

const entryPoints = argParsingEntryPoints();
const positional = entryPoints.filter((p) => allowsPositionals(readEntryPoint(p)));

/**
 * Entry points where free text and flags coexist, so a `--` in caller-supplied
 * prose can silently demote a real flag. PINNED, not asserted-to-zero: fixing
 * sixteen call sites is a FIX and this sprint is a GATE. The debt is stated so
 * it is countable, and an ADDITION is loud.
 *
 * ⚠ THIS LIST IS NOT A DEFECT LIST. Every entry is a place the hazard APPLIES.
 * Whether each one guards it is UNVERIFIED and is the verify seat's to
 * calibrate — the only scan attempted for a guard was name-based
 * (`startsWith("--")`, `looksLikeFlag`), which is precisely the enumerate-by-name
 * mistake this repo has paid for three times. A zero from that scan was not
 * trusted and is not recorded here.
 */
const HAZARD_APPLIES: Record<string, string> = {
  "astrolabe/scripts/cli.ts": "caller-facing; verbs take free-text operands",
  "bounty/scripts/cli.ts": "caller-facing; the c1 scar itself (`--session-key` eaten)",
  "glamour/scripts/cli.ts": "caller-facing; prompt text is a positional",
  "grapevine/scripts/cli.ts": "caller-facing; message bodies are prose positionals",
  "imago/scripts/cli.ts": "caller-facing; prompt text is a positional",
  "magpie/scripts/cli.ts": "caller-facing",
  "magpie/scripts/discover.ts": "internal (sibling-spawned argv), hazard still structural",
  "mind-mapper/scripts/cli.ts": "caller-facing; send bodies are prose positionals",
};

describe("ward — the `--` terminator silently demotes flags to free text", () => {
  test("the sweep actually ran (zero-denominator guard)", () => {
    // A dead sweep and a clean sweep are indistinguishable without this.
    expect(entryPoints.length).toBeGreaterThan(10);
    expect(positional.length).toBeGreaterThan(0);
  });

  test("THE MECHANISM ITSELF — a recognised flag after `--` is swallowed, silently", () => {
    // The ward's premise, executable rather than described. If node:util ever
    // changes this, the prose above becomes false and THIS cell says so — the
    // alternative is a comment asserting a runtime behaviour nobody re-runs,
    // which is the defect this very sprint found in a sibling ward.
    const options = { "session-key": { type: "string" } } as const;
    const shared = { options, strict: true, allowPositionals: true } as const;

    const before = parseArgs({ args: ["update", "t1", "--session-key", "K"], ...shared });
    const after = parseArgs({ args: ["update", "t1", "--", "--session-key", "K"], ...shared });

    expect({
      before: before.values,
      after: after.values,
      afterPositionals: after.positionals,
    }).toEqual({
      before: { "session-key": "K" },
      // The flag is GONE from values — not defaulted, not errored. Gone.
      after: {},
      // ...and reappears as inert free text, which nothing downstream reads.
      afterPositionals: ["update", "t1", "--session-key", "K"],
    });

    // And the promotion direction IS solved, pinned here so a regression in the
    // half that works cannot hide behind the half that does not.
    expect(() =>
      parseArgs({ args: ["add", "write", "the", "--draft", "section"], ...shared }),
    ).toThrow();
  });

  test("every entry point accepting positionals is PINNED as hazard-bearing", () => {
    // Both directions. An ARRIVING entry point is new exposure; a DEPARTING one
    // must be struck from the list, or the pin rots into an excuse that nobody
    // re-examines (outcome-contract Boundary 3).
    expect({ measured: positional, pinned: Object.keys(HAZARD_APPLIES).sort() }).toEqual({
      measured: positional,
      pinned: positional,
    });
  });

  test("the pin PRINTS its unit — a bare count cannot say which question it answered", () => {
    // ⛔ THE UNIT IS THE FINDING (cassandra, #1006), and it is this module's own
    // requirement 5 arriving at the DENOMINATOR instead of the parser: "read
    // EVERY options map, not the first — mind-mapper/cli.ts has 27."
    //
    // The `--` hazard bites PER parseArgs CALL SITE, not per file. A per-file
    // count reports mind-mapper's 16 positional-accepting commands as ONE, so
    // the file unit understates real exposure by an order of magnitude on the
    // largest spell. Both units are defensible; a BARE number is not, because a
    // reader cannot tell which was meant. So all three are asserted and printed.
    //
    // ⚠ Her headline said "your 8 is 7". Measured, both numbers are right and
    // they are DIFFERENT UNITS: 8 counts every file, 7 counts the caller-facing
    // subset, and the cell already published both. Same for 22 vs 23 — hers
    // excludes magpie/discover.ts (internal), mine includes it. That two seats
    // produced a unit mismatch inside a message ABOUT a unit mismatch is the
    // reason this cell now prints the unit rather than the number alone.
    const callerFacing = positional.filter(isCallerFacing);
    const callSites = (rel: string) =>
      [...readEntryPoint(rel).matchAll(/allowPositionals\s*:\s*true/g)].length;
    const sitesAll = positional.reduce((n, p) => n + callSites(p), 0);
    const sitesCallerFacing = callerFacing.reduce((n, p) => n + callSites(p), 0);

    expect({
      filesAll: positional.length,
      filesCallerFacing: callerFacing.length,
      callSitesAll: sitesAll,
      callSitesCallerFacing: sitesCallerFacing,
      guardsVerified: 1, // bounty only — cassandra drove it, #1006 §4. 6 of 7 UNVERIFIED.
    }).toEqual({
      filesAll: 8,
      filesCallerFacing: 7,
      callSitesAll: 23,
      callSitesCallerFacing: 22,
      // Driven A/B on bounty: `add -- --session-key` is byte-identical to
      // `add -- ordinaryword`, exit 0, valuesIgnored:null, and the flag becomes
      // the card's TITLE. No guard. The other six are not driven and this number
      // says so rather than rounding to zero-or-all.
      guardsVerified: 1,
    });
  });
});

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

  test("the pin records exposure, and reports the caller-facing subset honestly", () => {
    // Stated as a number the gate PRINTS rather than a claim in prose: how much
    // of the hazard set is reachable by a caller typing a command, versus
    // sibling-spawned argv where the operands are the spell's own.
    const callerFacing = positional.filter(isCallerFacing);
    expect({
      hazardBearing: positional.length,
      callerFacing: callerFacing.length,
      guardsVerified: 0, // UNVERIFIED BY CONSTRUCTION — see HAZARD_APPLIES.
    }).toEqual({
      hazardBearing: 8,
      callerFacing: 7,
      guardsVerified: 0,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { parseArgs } from "node:util";
import { argParsingEntryPoints, parseArgsInvocations, readEntryPoint } from "./lib/entry-points";

// ROW 1 of the sprint-05 conformance table — "`--flag=value` parses; unknown
// flags refuse." NOTE: node:util already refuses by DEFAULT (measured in the
// mechanism cell). This ward pins the explicit convention and guards the one
// spelling that genuinely opens the parser, `strict: false`.
//
// ── WHY THIS IS A STRUCTURAL PIN PLUS A MECHANISM CELL, AND NOT THE
//    "BEHAVIOURAL DRIVE OVER THE 16 ENTRY POINTS" THE ROADMAP ASKED FOR ───────
//
// The roadmap specified a drive that spawns each entry point as a process. That
// was the right call when it was written and it is the wrong call now, for a
// reason measured DURING this sprint:
//
//   cassandra (#1006, #1010): a spell's home env var is NOT isolation while a
//   daemon is up — a RUNNING DAEMON OUTRANKS IT. She set BOUNTY_HOME to a
//   throwaway dir, ran two probe writes, and both landed on the TEAM'S LIVE
//   BOARD. 4 of 7 daemon spells do not isolate on their home var; glamour has
//   no home var at all.
//
// A cell in the shared suite that spawns real CLIs would inherit exactly that.
// `bun test` runs on developer machines with live daemons, so the drive could
// write to whatever board, vine or session happens to be up — and this suite is
// four seats' land gate. **A gate that can mutate the state it is run beside is
// not a gate.** So the drive stays out of the suite, and what goes in is:
//
//   1. a STRUCTURAL pin over every parseArgs invocation (no processes), and
//   2. a MECHANISM cell that drives `node:util` DIRECTLY — real behaviour, zero
//      spawn, because the thing row 1 asserts is a property of the parser rather
//      than of any one spell.
//
// The per-spell behavioural drive is still worth doing; it belongs in an
// instrument run deliberately, not in the shared gate. Stated so nobody reads
// this cell as claiming coverage it does not have.

const entryPoints = argParsingEntryPoints();
const invocations = entryPoints.flatMap((p) =>
  parseArgsInvocations(readEntryPoint(p)).map((argObject) => ({ file: p, argObject })),
);

describe("ward — every parseArgs invocation refuses unknown flags", () => {
  test("the sweep actually ran (zero-denominator guard)", () => {
    // A dead sweep and a clean sweep report the same thing without this.
    // Threshold 30 → 10: mind-mapper's acc L0 lane C consolidated ~27 inline
    // per-verb parses into ONE registry-driven invocation (CLI_OPTIONS +
    // VERB_SPEC, magpie's two-stage shape) — the population legitimately
    // SHRANK because the registry pattern has one call site per CLI, and a
    // shrinking denominator here is that refactor, not a dead sweep.
    expect(entryPoints.length).toBeGreaterThan(10);
    expect(invocations.length).toBeGreaterThan(10);
  });

  test("EVERY invocation sets `strict: true` EXPLICITLY — a convention pin, not a safety net", () => {
    // ⛔ READ THE MECHANISM CELL BELOW BEFORE TRUSTING ANY CLAIM ABOUT WHY THIS
    // MATTERS. This cell was first written with the comment "node:util's strict
    // DEFAULTS TO FALSE, so the absence of the property is the defect."
    // **THAT IS FALSE. `strict` defaults to TRUE**, measured — omitting it still
    // throws on an unknown flag. The false claim was caught within minutes by
    // the mechanism cell below, which is the entire argument for writing runtime
    // behaviour as an executable assertion rather than as prose: this ward's
    // sibling landed an hour earlier specifically because a comment asserting a
    // runtime property is a comment nobody re-runs, and its author then wrote
    // one here.
    //
    // So what this cell actually pins is EXPLICITNESS, which is worth less than
    // the original framing implied and is still worth something: a reader of any
    // call site sees the refusal contract stated rather than inherited, and a
    // future `strict: false` is a visible diff against a uniform convention
    // instead of a lone omission among mixed styles.
    //
    // The filter below is `not strict:true`, so it catches BOTH spellings — the
    // omission (harmless, default is true) and `strict: false` (the genuinely
    // permissive one). It cannot report which; a failure here must be read, not
    // counted. That is deliberate: the two need different responses, and a cell
    // that lumped them would tell a reader "conformance" when it meant "style".
    const notStrict = invocations
      .filter(({ argObject }) => !/strict\s*:\s*true/.test(argObject))
      .map(({ file, argObject }) => `${file}: ${argObject.replace(/\s+/g, " ").slice(0, 80)}`);

    // Report the denominator beside the verdict — a bare `[]` cannot distinguish
    // "all 17 are strict" from "the scan matched nothing".
    // 42 → 43 → 17: lane A added mind-mapper's strict `help` parse; lane C then
    // consolidated mind-mapper's ~27 inline per-verb parses into the
    // registry-driven two-stage parse (CLI_OPTIONS + VERB_SPEC), leaving that
    // CLI with two invocations (parseVerbArgs stage 1 + the doc-path probe).
    // The pin moves WITH the population — both directions are the ward working.
    expect({ notStrict, invocationsChecked: invocations.length }).toEqual({
      notStrict: [],
      invocationsChecked: 17,
    });
  });

  test("THE MECHANISM ITSELF — strict refuses the unknown flag and `=` parses", () => {
    // The property row 1 actually asserts, executable rather than described.
    // Both halves were real silent defects in this repo before `strict: true`:
    //   --owner=alice   became a boolean key named `owner=alice`, value DROPPED,
    //                   so a read filter matched nothing and returned the WHOLE
    //                   BOARD instead of a subset
    //   --totally-bogus accepted, exit 0, verb ran anyway
    const options = { owner: { type: "string" } } as const;
    const strict = { options, strict: true, allowPositionals: true } as const;

    expect(parseArgs({ args: ["--owner=alice"], ...strict }).values).toEqual({ owner: "alice" });
    expect(() => parseArgs({ args: ["--totally-bogus"], ...strict })).toThrow();

    // ⭐ THE DEFAULT, MEASURED RATHER THAN ASSUMED — this assertion is the one
    // that corrected this file's own header. Omitting `strict` does NOT open the
    // parser: it defaults to TRUE and still refuses. Anyone about to write "the
    // default is permissive" (as this file did) is refuted here, by running it.
    expect(() =>
      parseArgs({ args: ["--totally-bogus"], options, allowPositionals: true }),
    ).toThrow();

    // And the genuinely permissive shape, so the convention pin above has a real
    // hazard behind it: `strict: false` is the only way to accept an unknown
    // flag, and it does so silently at exit 0 — which is why the cell above
    // checks for that spelling and not merely for the property's presence.
    const loose = parseArgs({
      args: ["--totally-bogus"],
      options,
      strict: false,
      allowPositionals: true,
    });
    expect(loose.values).toEqual({ "totally-bogus": true });
  });
});

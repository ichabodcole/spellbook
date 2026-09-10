import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";

// ── THE SIXTH EDIT WARD ──────────────────────────────────────────────────────
//
// The spells' daemon spine is ONE DESIGN IMPLEMENTED SIX TIMES. Nobody chose
// that; the backends cannot share code until they build (seams Contract 3), so
// every daemon carries its own copy of the event bus, the dist serving, the
// discovery write and the idle lifecycle. The copying is not even hidden — the
// same explanatory comments appear verbatim across files that share no code,
// and magpie's discovery write is annotated "as imago does it".
//
// ⛔ THE COST IS NOT THE DUPLICATED LINES. IT IS THAT A FIX COSTS SIX EDITS AND
//    RELIABLY GETS ONE TO FOUR OF THEM.
//
// Measured, 2026-09-08 (docs/investigations/2026-09-08-backend-duplication-recon.md):
// four spells had hit the missing-idleTimeout wall and fixed it, three had not.
// Two more defects were roster-wide until 2026-09-07, when a branch scoped to a
// flaky glamour test fixed glamour's copy alone — turning two shared defects
// into two inconsistencies.
//
// So this ward does not assert a style. It asserts the three properties whose
// last violations were REAL BUGS, over every spell at once, so the edit that
// gets forgotten fails here instead of surfacing as an incident months later in
// whichever spell was missed.
//
// ⚠ THIS IS A STOPGAP AND SHOULD BE DELETED, NOT GROWN. It is a text scan, and
// a text scan over six copies is what you build when you cannot have one
// implementation. When the backends build and share a spine, these properties
// become true by construction and this file's whole job disappears. Adding a
// fourth clause here is a signal to go do that instead.
//
// ── ⛔ THE DELETION WAS ASKED FOR, MEASURED, AND DECLINED — 2026-09-09, AT THE
//    LAST PORT (register F2; backend convergence D87) ─────────────────────────
//
// mind-mapper was the eighth and last backend to move under `src/`, so the
// condition the paragraph above states — "when the backends build and share a
// spine" — is now literally met, and the register carried the deletion as a
// deliverable of the roll rather than a side effect of it. **It is not deleted,
// because the condition as WRITTEN and the condition as REASONED disagree, and
// the reasoned one is the one that matters:** the request rests on "these
// properties become true by construction", and that is true of ONE of the three
// clauses. Measured at the last port, clause by clause:
//
//   1 · `idleTimeout`  ⛔ NOT by construction, and it is the clause whose last
//       violation was the real bug. Seven daemons pass the option at their OWN
//       `Bun.serve` call and NO kit module owns it: `kit/wire/heartbeat.ts`
//       supplies the constant (`MAX_IDLE_TIMEOUT_SEC`), the parse
//       (`idleTimeoutSec`) and the beat/timeout clamp, and it cannot supply the
//       option, because the kit does not call `Bun.serve`. A ninth daemon that
//       omits `idleTimeout` is still expressible and still drops every SSE
//       client at ten seconds. **This clause survives the spine intact.**
//   2 · the atomic pointer write  ✅ BY CONSTRUCTION, and therefore the clause
//       now has an EMPTY POPULATION: all seven pointer-writing daemons call
//       `writeFileAtomic` from `kit/wire/discovery.ts`, so the predicate below
//       (`writeFileSync(sessionFile|latestFile)`) matches nothing anywhere. ⚠
//       That makes it D42's own shape — a scan whose absence of a finding is
//       spelled exactly like absence of a subject — and it wants a coverage
//       cell or a deletion. **FILED, not done here:** D44 forbids the
//       instrument that guards a port being repaired BY that port, and
//       removing an assertion is more than repairing one.
//   3 · `readSession`'s ENOENT branch  ⛔ NOT by construction: four CLIs still
//       carry their own `readSession` (bounty, glamour, imago, magpie) and the
//       kit has no session reader at all — nothing converged here, so nothing
//       became true by construction.
//
// **So the ward stays, and this note is the answer rather than the absence of
// one** (D56: a reasoned absence must not be spelled like a skipped step). What
// changed is that the deletion is no longer PENDING on the backends building —
// it is pending on clause 1 finding a home that owns the `Bun.serve` options,
// which is a kit question and not a port's. Nothing in this file's assertions
// was touched at the last port; only this paragraph was added.

const SKILLS = join(import.meta.dir, "..", "plugins", "spellbook", "skills");

function read(rel: string): string {
  return readFileSync(join(SKILLS, rel), "utf8");
}

/** Every backend file that calls `Bun.serve`, ACROSS BOTH ROOTS.
 *
 *  ⛔ THE SECOND ROOT IS NOT OPTIONAL, and this ward proved it the loud way.
 *  Phase 1b moved astrolabe's and magpie's DAEMON SOURCE to
 *  `src/<spell>/backend/server.ts` and left a launcher at the old address. A
 *  scan of `skills/` alone went 7 -> 5 and the population zero-guard below
 *  reddened — which is the ward working (seams Contract 19: the pin is what
 *  converts a silent shrink into a loud failure). The repair is to EXTEND THE
 *  WALK, never to lower the floor: `clis()` below already had both roots for
 *  exactly this reason, one function away. */
function daemons(): { spell: string; file: string; text: string }[] {
  const out: { spell: string; file: string; text: string }[] = [];
  for (const rel of new Glob("*/scripts/*.ts").scanSync(SKILLS)) {
    if (rel.endsWith(".test.ts")) continue;
    const text = read(rel);
    if (!text.includes("Bun.serve(")) continue;
    out.push({ spell: rel.split("/")[0], file: `skills/${rel}`, text });
  }
  const srcRoot = join(import.meta.dir, "..", "src");
  for (const rel of new Glob("*/backend/*.ts").scanSync(srcRoot)) {
    if (rel.endsWith(".test.ts")) continue;
    const text = readFileSync(join(srcRoot, rel), "utf8");
    if (!text.includes("Bun.serve(")) continue;
    out.push({ spell: rel.split("/")[0], file: `src/${rel}`, text });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Every backend CLI, including the two authored under `src/` because they
 *  ship built. A census scoped to `skills/` is blind to exactly those two —
 *  the mistake seams Contract 19 is named for. */
function clis(): { spell: string; file: string; text: string }[] {
  const out: { spell: string; file: string; text: string }[] = [];
  for (const rel of new Glob("*/scripts/cli.ts").scanSync(SKILLS)) {
    out.push({ spell: rel.split("/")[0], file: `skills/${rel}`, text: read(rel) });
  }
  const srcRoot = join(import.meta.dir, "..", "src");
  for (const rel of new Glob("*/backend/cli.ts").scanSync(srcRoot)) {
    out.push({
      spell: rel.split("/")[0],
      file: `src/${rel}`,
      text: readFileSync(join(srcRoot, rel), "utf8"),
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

describe("daemon lifecycle ward", () => {
  test("the ward has a population — an empty scan is not a pass", () => {
    // Without this, a rename or a moved folder turns every cell below into a
    // vacuous green. The counts are deliberately lower bounds, not pins: a new
    // spell should not have to edit this file.
    expect(daemons().length).toBeGreaterThanOrEqual(7);
    expect(clis().length).toBeGreaterThanOrEqual(7);
  });

  test("a daemon that holds a long-lived connection sets idleTimeout", () => {
    // ⛔ THE BUG THIS REPLACES. Bun's default request idleTimeout is 10s and a
    // server-sent heartbeat does NOT reset it, so glamour, imago and magpie ran
    // a 15s `: hb` keepalive against a connection that was already dead at 10s
    // — the keepalive arrived five seconds after the thing it was keeping
    // alive. Every SSE client on those three daemons dropped at ten seconds.
    //
    // Scoped to daemons that actually HOLD a connection: digestify serves a
    // one-shot page with no SSE and no socket, and must not be dragged in.
    const offenders = daemons()
      .filter((d) =>
        /ReadableStreamDefaultController|ServerWebSocket|text\/event-stream/.test(d.text),
      )
      .filter((d) => !/idleTimeout\s*:/.test(d.text))
      .map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  test("a session-pointer write is atomic", () => {
    // ⛔ THE BUG THIS REPLACES. Four spells wrote the discovery pointer as a
    // bare pair of writeFileSync calls, so a CLI reading while the daemon wrote
    // could observe a half-written file — which the CLI then reported as "no
    // running session". glamour was fixed 2026-09-07 and the other three stayed
    // broken for a day, which is this ward's whole reason to exist.
    const offenders = daemons()
      .filter((d) => /writeFileSync\(\s*(sessionFile|latestFile)\b/.test(d.text))
      .map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  test("readSession returns null ONLY for a genuinely absent pointer", () => {
    // ⛔ THE BUG THIS REPLACES. `catch { return null }` over the whole read made
    // every failure — corrupt pointer, EACCES, any transient under load —
    // indistinguishable from "there is no session". Callers act on that null:
    // two report not_found, and a tail loop reads it as "the pinned session
    // went away" and exits 0, reporting a resource failure as a successful end
    // of watch. It surfaced as a flaky contract cell in glamour, fixed
    // 2026-09-07; three siblings still carried it a day later.
    //
    // The property: the function must branch on ENOENT. Crude on purpose — it
    // cannot prove the branch is correct, only that the conflation is gone, and
    // it fails loudly the moment someone reinstates the bare catch.
    //
    // ⚠ COMMENTS ARE STRIPPED FIRST, and that is not tidiness. Every one of
    // these functions now carries a docstring explaining the ENOENT rule, so a
    // scan over raw text would be satisfied by the PROSE ABOUT the fix in a
    // function that had been reverted — the ward would pass on an explanation
    // of the bug it was meant to catch. Found while calibrating this cell: the
    // first attempt to break it deleted the word from the docstring and the
    // ward stayed green, which looked like a working calibration.
    const offenders = clis()
      .filter((c) => /function readSession\b/.test(c.text))
      .filter((c) => {
        const body = c.text.slice(c.text.indexOf("function readSession"), undefined);
        const code = body
          .slice(0, 1500)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/[^\n]*/g, "");
        return !code.includes("ENOENT");
      })
      .map((c) => c.file);
    expect(offenders).toEqual([]);
  });

  test("the three clauses above each had a real violation, named", () => {
    // A ward whose clauses never fired is a ward nobody can calibrate. These
    // are the files each clause was written from, so a future reader can go
    // look at the fix rather than trusting the prose. Verified by the
    // orchestrator, not taken from the recon agent's report.
    const fixed = {
      idleTimeout: ["glamour", "imago", "magpie"],
      atomicWrite: ["bounty", "imago", "magpie"],
      readSession: ["bounty", "imago", "magpie"],
    };
    for (const spells of Object.values(fixed)) expect(spells.length).toBe(3);
    expect(basename(import.meta.file)).toBe("daemon-lifecycle-ward.test.ts");
  });
});

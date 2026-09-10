import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Glob } from "bun";
import { must } from "./lib/must.ts";

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
//
// ── ⛔ AND THEN CLAUSE 1 WAS FOUND TO BE SATISFIED BY A COMMENT — 2026-09-10,
//    D100 (`fix/wards-that-pass-on-prose`) ──────────────────────────────────
//
// The paragraph above rests clause 1's survival on its being a TEXT SCAN, which
// makes the scan the only thing standing behind the bug it replaces. It was not
// standing behind it. `!/idleTimeout\s*:/.test(d.text)` read the file as
// WRITTEN, and glamour, imago and bounty each carry a comment discussing
// `idleTimeout: 255` beside their one real setting — so deleting the real
// setting from any of the three left this ward GREEN (driven in type-debt Phase
// 1, T13 #1, and re-driven three ways here). **Two of the three spells the
// `fixed.idleTimeout` list below names as this clause's founding cases could not
// be convicted by it.**
//
// ⭐ THE FIX WAS ALREADY IN THIS FILE, ONE CLAUSE OVER, AND HAD BEEN SINCE THE
//    MONTH'S FIRST WARD WORK. `readSession`'s ENOENT clause strips comments
//    before scanning, because a calibration there once produced a FALSE PASS by
//    editing a docstring. The same discipline is now applied at the ROW
//    (`stripComments`), so every clause gets it and a fourth cannot be added
//    without it. Two neighbouring clauses, one written against prose and one
//    written against code, and nothing reconciled them for a month: **the
//    lesson is that a false-pass fix belongs at the shared read, not in the
//    cell that found it.**
//
// ⚠ D87'S RULING IS UNCHANGED IN OUTCOME AND STRENGTHENED IN REASONING. Clause
// 1 is still not true by construction (no kit module owns the `Bun.serve`
// option), so the ward still stays — but D87 kept it partly on the strength of
// a clause that could convict one of its three subjects. It can now convict all
// six connection-holding daemons, and the population it asserts over is pinned
// per clause rather than counted as a file total.

const SKILLS = join(import.meta.dir, "..", "plugins", "spellbook", "skills");

function read(rel: string): string {
  return readFileSync(join(SKILLS, rel), "utf8");
}

/** ⛔ EVERY TEXT-SCAN CLAUSE READS THIS, NOT THE RAW FILE — AND THE FILE YOU ARE
 *  READING CONTAINED ITS OWN ANSWER FOR A MONTH.
 *
 *  The `readSession` clause below has stripped comments since the first ward
 *  work of the month, after a calibration attempt deleted the word `ENOENT`
 *  from a DOCSTRING and the ward stayed green — a false pass that looked like a
 *  working drive. The `idleTimeout` clause, one cell over, kept scanning raw
 *  text, and 2026-09-10's mutation pass found the same defect there: glamour's
 *  real `idleTimeout: IDLE_TIMEOUT_SEC` deleted, ward GREEN, because line 408 of
 *  that file DISCUSSES `idleTimeout: 255` in prose. bounty and imago carry the
 *  same prose (`server.ts:1103`, `server.ts:839`) — **two of the three spells
 *  this ward's own `fixed.idleTimeout` list says clause 1 was written from.**
 *  astrolabe's two mentions have no colon, which is the only reason it could be
 *  driven red at all.
 *
 *  A clause satisfiable by prose ABOUT the fix is not standing behind the fix.
 *  Applied here at the row, once, so a fourth clause cannot be added without it.
 *
 *  ⚠ It is a stripper, not a parser: `//` inside a string literal takes the
 *  rest of that line with it. Measured on all eight daemons and all fourteen
 *  CLIs — no clause's population and no clause's verdict moves except the three
 *  prose shields it was added to remove. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** One scanned backend file. `code` is the file with its comments removed, and
 *  it is the ONLY text any predicate below sees — see `stripComments`. `spell`
 *  is what the population census prints, so a shrink is reported as *which
 *  spell left* rather than as an integer.
 *
 *  ⚠ THERE IS NO RAW `text` FIELD, AND THAT IS DELIBERATE. Keeping the file as
 *  written beside the stripped copy would have left a field no cell reads —
 *  which is exactly the defect type-debt Phase 1 found here (`spell`, computed
 *  twice and read nowhere, holding four of `grimoire`'s fourteen type errors).
 *  A repair that leaves a dead field behind has not finished. */
type Backend = { spell: string; file: string; code: string };

/** Every backend file that calls `Bun.serve`, ACROSS BOTH ROOTS.
 *
 *  ⛔ THE SECOND ROOT IS NOT OPTIONAL, and this ward proved it the loud way.
 *  Phase 1b moved astrolabe's and magpie's DAEMON SOURCE to
 *  `src/<spell>/backend/server.ts` and left a launcher at the old address. A
 *  scan of `skills/` alone went 7 -> 5 and the population guard below reddened
 *  (a floor then, an exact pin now) — which is the ward working (seams Contract 19: the pin is what
 *  converts a silent shrink into a loud failure). The repair is to EXTEND THE
 *  WALK, never to lower the pin: `clis()` below already had both roots for
 *  exactly this reason, one function away. */
function daemons(): Backend[] {
  const out: Backend[] = [];
  for (const rel of new Glob("*/scripts/*.ts").scanSync(SKILLS)) {
    if (rel.endsWith(".test.ts")) continue;
    // ⚠ THE MEMBERSHIP TEST READS THE STRIPPED COPY TOO, so a `Bun.serve(` that
    // only appears in a comment cannot enrol a non-daemon. Measured: the
    // population is 8 either way today.
    const code = stripComments(read(rel));
    if (!code.includes("Bun.serve(")) continue;
    // `String.split` always yields at least one element, so index 0 is a
    // `noUncheckedIndexedAccess` artifact rather than a real absence — stated
    // here instead of silenced with `!`, because if the glob ever hands back a
    // shape with no leading segment this ward must die rather than attribute a
    // daemon to the spell named `undefined`.
    out.push({
      spell: must(rel.split("/")[0], `no leading path segment in "${rel}"`),
      file: `skills/${rel}`,
      code,
    });
  }
  const srcRoot = join(import.meta.dir, "..", "src");
  for (const rel of new Glob("*/backend/*.ts").scanSync(srcRoot)) {
    if (rel.endsWith(".test.ts")) continue;
    const code = stripComments(readFileSync(join(srcRoot, rel), "utf8"));
    if (!code.includes("Bun.serve(")) continue;
    out.push({
      spell: must(rel.split("/")[0], `no leading path segment in "${rel}"`),
      file: `src/${rel}`,
      code,
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Every backend CLI, including the two authored under `src/` because they
 *  ship built. A census scoped to `skills/` is blind to exactly those two —
 *  the mistake seams Contract 19 is named for. */
function clis(): Backend[] {
  const out: Backend[] = [];
  for (const rel of new Glob("*/scripts/cli.ts").scanSync(SKILLS)) {
    out.push({
      spell: must(rel.split("/")[0], `no leading path segment in "${rel}"`),
      file: `skills/${rel}`,
      code: stripComments(read(rel)),
    });
  }
  const srcRoot = join(import.meta.dir, "..", "src");
  for (const rel of new Glob("*/backend/cli.ts").scanSync(srcRoot)) {
    out.push({
      spell: must(rel.split("/")[0], `no leading path segment in "${rel}"`),
      file: `src/${rel}`,
      code: stripComments(readFileSync(join(srcRoot, rel), "utf8")),
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Clause 1's SUBJECTS: a daemon that HOLDS a connection. digestify serves a
 *  one-shot page with no SSE and no socket and must not be dragged in. */
const holdsConnection = (d: Backend): boolean =>
  /ReadableStreamDefaultController|ServerWebSocket|text\/event-stream/.test(d.code);

/** Clause 2's SUBJECTS: a daemon that writes the discovery pointer AT ALL —
 *  either through the kit's `writeFileAtomic` (the fix) or as the bare pair the
 *  clause convicts (the defect). Both spellings, deliberately, because the
 *  subject is "writes a pointer" and the clause only asks HOW.
 *
 *  ⚠ AND THE RESIDUE, STATED: a THIRD spelling — a bare `writeFileSync` onto a
 *  differently-named variable — is in neither set, so it is neither a subject
 *  nor an offender. That is the class C9 names and it is not closed by this
 *  cell; what this cell closes is the concrete blindness, that clause 2's empty
 *  offender list was indistinguishable from an empty world. */
const writesPointer = (d: Backend): boolean =>
  /writeFileAtomic\(/.test(d.code) || barePointerWrite(d);

const barePointerWrite = (d: Backend): boolean =>
  /writeFileSync\(\s*(sessionFile|latestFile)\b/.test(d.code);

/** Clause 3's SUBJECTS: a CLI that carries its own `readSession`. */
const hasReadSession = (c: Backend): boolean => /function readSession\b/.test(c.code);

/** The BRACE-MATCHED body of a named function in comment-stripped code.
 *
 *  ⚠ REPLACES A 1,500-CHARACTER WINDOW, and the window was not merely crude —
 *  it OVERRAN. Measured 2026-09-10: `readSession` is 503–514 characters in all
 *  four CLIs that carry it, so a fixed 1,500 read a third of the way into the
 *  functions that follow, and an `ENOENT` in a NEIGHBOUR satisfied the clause.
 *  Driven: with the branch reverted in glamour's `readSession` and the word
 *  planted in the next function down, the window clause passed and this one
 *  convicts. Scoped to the function, the clause asserts what its name says. */
function functionBody(code: string, name: string): string {
  const at = code.indexOf(`function ${name}`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = code.indexOf("{", at); i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(at, i + 1);
    }
  }
  // Unbalanced braces after the declaration: the file does not parse as this
  // ward assumes. Loud, never a quiet whole-file fallback — a fallback here
  // would hand the clause the REST OF THE FILE and pass on any sibling's
  // ENOENT, which is the defect this function exists to remove.
  throw new Error(`daemon-lifecycle-ward: unterminated body for function ${name}`);
}

describe("daemon lifecycle ward", () => {
  test("the population is PINNED per clause, and a shrink names the spell that left", () => {
    // ⛔ THIS CELL USED TO BE TWO FLOORS AT THE WRONG GRAIN (register C11, and
    // Phase 1's mutation pass, T13 #4): `>= 7` against actuals of 8 and 14, so
    // a walk that lost SIX CLIs passed silently — the D64 shape living inside
    // the guard written to catch it. Worse, both floors counted the FILE SCAN,
    // while every clause below runs over a SUBSET of it: when D87 measured
    // clause 2's population as EMPTY, these two numbers were 8 and 14 and this
    // cell was green. A guard that cannot see a clause go vacuous is not
    // guarding the clauses.
    //
    // So: exact pins, at the grain each clause actually asserts over.
    //
    // ⚠ A NEW SPELL EDITS FIVE PINS HERE — two counts and three subject lists —
    // AND THAT IS THE POINT. The old comment said "a new spell should not have
    // to edit this file" and bought that convenience with silence in the other
    // direction. seams Contract 19: the pin is what converts a silent shrink
    // into a loud failure — and the failure message below says which of the two
    // it is looking at.
    const ds = daemons();
    const cs = clis();
    console.log(`  daemon lifecycle: ${ds.length} daemon(s) — ${ds.map((d) => d.spell).join(" ")}`);
    console.log(`  daemon lifecycle: ${cs.length} cli(s) — ${cs.map((c) => c.spell).join(" ")}`);
    const census = {
      daemons: ds.length,
      clis: cs.length,
      holdsConnection: ds.filter(holdsConnection).map((d) => d.spell),
      writesPointer: ds.filter(writesPointer).map((d) => d.spell),
      readSession: cs.filter(hasReadSession).map((c) => c.spell),
    };
    console.log(`  daemon lifecycle: clause subjects ${JSON.stringify(census)}`);
    expect(census).toEqual({
      daemons: 8,
      clis: 14,
      // clause 1 — the SSE/socket holders. digestify and mind-mapper are out.
      holdsConnection: ["astrolabe", "bounty", "glamour", "grapevine", "imago", "magpie"],
      // clause 2 — every pointer writer. All seven go through the kit today,
      // which is why the clause's OFFENDER list is empty (C9); the subjects are
      // pinned here so that empty list cannot come to mean "nobody writes a
      // pointer any more" without this cell saying so.
      writesPointer: [
        "astrolabe",
        "bounty",
        "glamour",
        "grapevine",
        "imago",
        "magpie",
        "mind-mapper",
      ],
      // clause 3 — the four CLIs that still carry their own reader.
      readSession: ["bounty", "glamour", "imago", "magpie"],
    });
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
    //
    // ⛔ AND IT IS `d.code`, NOT `d.text`, WHICH IS THE WHOLE REPAIR OF
    //    2026-09-10. Over raw text this clause was satisfied by PROSE: glamour's
    //    real setting deleted, ward green, on the strength of a comment
    //    discussing `idleTimeout: 255` — and bounty and imago carry the same
    //    shield, so the clause could not convict two of the three spells its own
    //    `fixed.idleTimeout` list below says it was written from. The fix was
    //    already in this file, one clause down: `readSession` has stripped
    //    comments since the day a docstring edit produced a false pass there.
    const offenders = daemons()
      .filter(holdsConnection)
      .filter((d) => !/idleTimeout\s*:/.test(d.code))
      .map((d) => d.file);
    expect(offenders).toEqual([]);
  });

  test("a session-pointer write is atomic", () => {
    // ⛔ THE BUG THIS REPLACES. Four spells wrote the discovery pointer as a
    // bare pair of writeFileSync calls, so a CLI reading while the daemon wrote
    // could observe a half-written file — which the CLI then reported as "no
    // running session". glamour was fixed 2026-09-07 and the other three stayed
    // broken for a day, which is this ward's whole reason to exist.
    //
    // ⚠ ITS POPULATION IS EMPTY OF OFFENDERS BY CONSTRUCTION (D87, register C9)
    // — all seven pointer writers call the kit's `writeFileAtomic`. The SUBJECT
    // count is pinned in the population cell above, so this `[]` now means
    // "seven daemons write a pointer and none writes it bare" rather than "the
    // scan found nothing", which is what it meant until 2026-09-10.
    const offenders = daemons()
      .filter(barePointerWrite)
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
    // ⚠ THE STRIP NOW HAPPENS AT THE ROW (`stripComments`, applied by both
    // enumerators) so that clause 1 gets it too — and the window it used to
    // read is now the BRACE-MATCHED function, because the window overran into
    // the neighbours (see `functionBody`).
    const offenders = clis()
      .filter(hasReadSession)
      .filter((c) => !functionBody(c.code, "readSession").includes("ENOENT"))
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

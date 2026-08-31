// GATE HONESTY WARD — s5-P. `bun run check` prints "Checked N files" and says
// NOTHING about the shipped, hand-authored files it structurally cannot read.
// That is not coverage; it is a gate that cannot state what it cannot see. A hard
// JS syntax error injected into a shipped surface passes BOTH arms green
// (circe, spellbook comms #978).
//
// This ward does NOT close the blind set — closing it is a FIX and was ruled out
// of sprint 05 twice, once against its own author's proposal. It makes the blind
// set IMPOSSIBLE TO NOT NOTICE: printed on every suite run, and pinned so that a
// change to it fails until someone re-declares it.
//
// ⛔ IT CONSUMES circe's `scripts/instruments/gate-blind-set.ts` BY INVOKING IT,
// and deliberately does not re-implement its predicate. A second predicate for
// one fact is free to drift from the first, and then neither side is wrong. That
// instrument owns the question ("of the SHIPPED, HAND-AUTHORED files under
// plugins/spellbook/skills/, which can `bun run check` not read AT ALL?"); this
// ward owns only whether the answer has moved without anyone saying so.
//
// ⛔ WHICH GATE THIS ACTUALLY RUNS UNDER — correcting a landed commit subject
// FORWARD, because rewording it would rebase shas the project's own docs cite —
// MEASURED at 11 of this branch's 37 commits (`git rev-list <base>..HEAD`, each
// sha grepped across tracked *.md/*.ts), NOT the "eight" this comment first
// claimed. That eight was inherited from a channel message and repeated here
// without being run; the true number is higher, so the conclusion is
// strengthened, not weakened. Recorded rather than quietly swapped, because the
// same wrong figure is now immutable in `25f07b2`'s commit message. `ababf0b`'s subject says "`bun run check` now says what it cannot see."
// IT DOES NOT:
//
//     bun run check   is biome alone  ->  "Checked 356 files", SILENT about the 16
//     bun test        runs this ward  ->  the blind set is printed here, and only here
//
// So the honest statement is: the SUITE says what the LINT GATE cannot see. A
// seat who runs only `bun run check` still gets a green that is silent about
// 4,166 lines. **On a branch whose thesis is that an instrument must not report
// what it did not earn, that subject line claimed a delivery that did not
// happen** — found by a cold reader given the tree and nothing else.
//
// ⛔ WHAT THIS WARD CANNOT SEE:
//   1. It inherits EVERY blind spot of the instrument it calls, including its
//      question. "Which files are UNGATED" is a different question with a
//      different correct answer, and this ward is silent about it.
//   2. It checks the SET and the PER-FILE LINE COUNTS, not the CONTENT. A blind
//      file can be rewritten wholesale without this failing, as long as its line
//      count holds.
//   3. It cannot tell a blind file that is FINE from one that is broken. Nothing
//      here reads a single line of them; that is the point of calling them blind.
//   4. THE `lines` UNIT IS `wc -l` (newline count), per the instrument. It was
//      `split("\n").length` until 2026-08-10 — one higher per file, 4182 vs 4166
//      over this set — and THIS WARD IS WHAT CAUGHT THE CHANGE: the re-declare
//      cell went red within minutes, naming all 16 files and the direction. That
//      is the cell working, not a defect; the declaration below is the
//      re-declaration it demanded.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ⛔ THE DECLARED BLIND SET — pinned DEBT, not an exemption. Every entry is a
// shipped, hand-authored file that `bun run check` does not read at all.
// Re-declare deliberately when it changes; do not "fix" a failure by pasting the
// new numbers in without asking which direction it moved and why.
//
// A file LEAVING this set is good news (it became gateable). A file ENTERING it
// is new unreadable surface shipping to consumers. Both fail this cell, on
// purpose — the point is that neither happens silently.
//
// ⛔ RE-DECLARED 2026-08-31 FOR R5's SECOND ROOT — 16 files / 4,166 lines →
// 19 / 4,442. The three additions are NOT new blindness and the direction is the
// opposite of what an entering file usually means: `src/mind-mapper/`'s
// stylesheet, entry HTML and bunfig were ALREADY blind and already shipped-from
// when mind-mapper relocated under Contract 4. They left the report silently,
// and the total went DOWN, which reads as progress. This declaration is the
// RECOVERY of a loss that already happened — written by hand, per the rule
// above, not pasted from the instrument's new output.
//
// ⛔ RE-DECLARED 2026-08-31 FOR PHASE 1a's RELOCATION — PATHS ONLY, and the
// total is the check. astrolabe's `surface/` + `bunfig.toml` moved to
// `src/astrolabe/` under Contract 4, so its three entries change path and
// nothing else: `surface/styles.css` 93, `surface/index.html` 35,
// `bunfig.toml` 2, now rooted at `src/astrolabe/`. The set stays at 19 files /
// 4,442 lines — a relocation between the instrument's two roots is a no-op for
// this ward, and if the total had moved, something OTHER than the relocation
// moved with it. Nothing entered and nothing left.
// ⛔ RE-DECLARED 2026-08-31 FOR PHASE 1c's RELOCATION — PATHS ONLY, second
// instance of the same no-op. imago's `surface/` + `bunfig.toml` moved to
// `src/imago/` under Contract 4, so its three entries change path and nothing
// else: `surface/styles.css` 151, `surface/index.html` 13, `bunfig.toml` 2, now
// rooted at `src/imago/`. The set stays at 19 files / 4,442 lines, for the same
// reason astrolabe's move did: both paths are inside this instrument's two
// roots, so a relocation between them moves no file in or out. If the total had
// changed, something OTHER than the relocation moved with it.
const DECLARED_BLIND: Record<string, number> = {
  "plugins/spellbook/skills/digestify/scripts/template.html": 1505,
  "plugins/spellbook/skills/bounty/scripts/template.html": 1003,
  "plugins/spellbook/skills/grapevine/scripts/watch.html": 1000,
  "src/mind-mapper/surface/styles.css": 220,
  "plugins/spellbook/skills/magpie/surface/styles.css": 175,
  "src/imago/surface/styles.css": 151,
  "plugins/spellbook/skills/magpie/scripts/remove.py": 145,
  "src/astrolabe/surface/styles.css": 93,
  "src/astrolabe/surface/index.html": 35,
  "src/mind-mapper/surface/index.html": 52,
  "plugins/spellbook/skills/glamour/surface/index.html": 13,
  "src/imago/surface/index.html": 13,
  "plugins/spellbook/skills/magpie/surface/index.html": 13,
  "plugins/spellbook/skills/glamour/surface/styles.css": 12,
  "src/mind-mapper/bunfig.toml": 4,
  "src/astrolabe/bunfig.toml": 2,
  "plugins/spellbook/skills/glamour/bunfig.toml": 2,
  "src/imago/bunfig.toml": 2,
  "plugins/spellbook/skills/magpie/bunfig.toml": 2,
};

type BlindReport = {
  roots: string[];
  tracked: number;
  handAuthored: number;
  gated: number;
  docs: number;
  blind: number;
  blindLines: number;
  files: { file: string; lines: number }[];
};

/** The roots this ward is ABOUT. Named here so the report cell can assert that
 *  the instrument measured them, rather than measuring whatever it was pointed at. */
const REAL_ROOTS = ["plugins/spellbook/skills", "src"];

async function deriveBlindSet(): Promise<BlindReport> {
  // ⛔ THE ROOT OVERRIDES ARE STRIPPED, AND THAT IS A DEFECT FIX, NOT HYGIENE.
  // `SKILLS_DIR` / `SRC_DIR` are calibration hooks, and a test process inherits
  // the ambient environment — so a seat with either exported in their shell
  // STEERED THIS WARD'S POPULATION. Measured before the fix: with both pointed
  // at a two-file throwaway repo, this ward printed
  //     "reads 2 of 2 hand-authored files … BLIND to 0 files / 0 lines"
  // and the report cell PASSED. Its `> 0` guards cannot tell a 352-file world
  // from a 2-file one, and only the pin noticed. That is a green this ward did
  // not earn, in the file whose entire subject is a gate reporting what it has
  // not earned. The calibration route is unaffected — it uses `deriveIn`, which
  // sets the hooks deliberately.
  const { SKILLS_DIR: _s, SRC_DIR: _r, ...cleanEnv } = process.env;
  const proc = Bun.spawn(["bun", "scripts/instruments/gate-blind-set.ts"], {
    env: cleanEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // "no envelope" is a THIRD state (outcome-contract, the failure-side section):
  // a non-zero exit here may carry its explanation on stderr with nothing on
  // stdout, so name that case rather than letting JSON.parse throw for the wrong
  // reason.
  if (code !== 0 || out.trim() === "") {
    throw new Error(
      `gate-blind-set did not produce a report (exit ${code}, ${out.length} stdout bytes): ${err.slice(0, 400)}`,
    );
  }
  return JSON.parse(out) as BlindReport;
}

describe("gate honesty ward", () => {
  test("STATES WHAT `bun run check` CANNOT SEE (clause i)", async () => {
    const r = await deriveBlindSet();
    console.warn(
      [
        "",
        `  GATE HONESTY — \`bun run check\` reads ${r.gated} of ${r.handAuthored} hand-authored files across two roots (skills + src).`,
        `  ⛔ BLIND to ${r.blind} files / ${r.blindLines} lines — not linted, not type-checked, not parsed.`,
        `     largest: ${r.files
          .slice(0, 3)
          .map((f) => `${f.file.replace("plugins/spellbook/skills/", "")} (${f.lines})`)
          .join(" · ")}`,
        "  A green from the gate is a green over the readable subset, never over the roster.",
        "",
      ].join("\n"),
    );
    // Zero-guard on the POPULATION, not on the finding: an instrument that
    // enumerated nothing would report a blind set of 0 and read as perfect
    // coverage.
    expect(r.handAuthored).toBeGreaterThan(0);
    expect(r.gated).toBeGreaterThan(0);
    // ⛔ AND A GUARD ON WHICH WORLD WAS MEASURED. `> 0` cannot distinguish this
    // repo from a two-file fixture; the roots can. Asserting them is what makes
    // a steered population impossible to not notice.
    expect(r.roots).toEqual(REAL_ROOTS);
  });

  test("the blind set has not moved without being re-declared", async () => {
    const r = await deriveBlindSet();
    const derived = Object.fromEntries(r.files.map((f) => [f.file, f.lines]));
    // Compared as a whole object so the failure names WHICH file and WHICH
    // direction, rather than reporting that two counts differ.
    expect(derived).toEqual(DECLARED_BLIND);
  });

  test("the declaration is not empty — the zero-guard on the pin itself", () => {
    // A pin that silently emptied would make every future blind file invisible
    // AND make this ward pass. Guarding the finding's own denominator.
    expect(Object.keys(DECLARED_BLIND).length).toBeGreaterThan(0);
  });
});

// ── CALIBRATION ──────────────────────────────────────────────────────────────
// Proves the ward's answer is DERIVED FROM THE WORLD rather than echoed from its
// own declaration — the failure where a pin and a "check" agree because the check
// never looked.
//
// ⛔ THE FIXTURE MUST BE ITS OWN GIT REPO, and that is not fastidiousness.
// `gate-blind-set` enumerates with `git ls-files`, so its documented
// `SKILLS_DIR=/some/fixture` hook CANNOT reach an out-of-repo fixture — git exits
// 128 ("outside repository") and the instrument dies before printing. A fixture
// inside this repo is no better: `ls-files` lists TRACKED paths, so an uncommitted
// fixture is invisible too. Minting a throwaway repo is the only route that
// exercises the real enumerator. (Reported to its owner; not worked around in the
// instrument, which is not mine.)
//
// Mutations never touch the shared tree: a seat mutating to calibrate is
// indistinguishable, to every other seat, from a broken tree, and this sprint
// needs dozens of such windows.
//
// ⚠ The fixture is minted under the OS temp dir and removed in `finally`. A
// mkdtemp'd dir cannot COLLIDE and is never REMOVED unless someone removes it —
// one predicate, two harms, and the exemption was written for the first. (951
// leaked dirs from that exact gap are on record in this repo.)
describe("gate honesty ward — calibration", () => {
  const INSTRUMENT = join(process.cwd(), "scripts/instruments/gate-blind-set.ts");
  const BIOME = join(process.cwd(), "biome.json");

  // ⛔ THE FIXTURE MINTS BOTH ROOTS, AND THAT IS NOT TIDINESS (R5).
  // The instrument enumerates each root with `git -C <root> ls-files` and does
  // not catch a missing directory — a fixture with only root 1 makes it exit
  // non-zero with an empty stdout, which arrives here as `fixture derive failed`
  // and turns BOTH calibration arms red for a reason that has nothing to do with
  // what they test.
  //
  // ⛔ AND THE OTHER WAY OUT IS WORSE: making root 2 optional under the test
  // hook would ship root 2 UNCALIBRATED — a guard exempted from the only thing
  // that proves it works. That is verbatim the "check that cannot fail in the
  // failing case" the instrument's own header records having shipped once, in
  // this same file's subject matter. Both roots are minted, and both roots get a
  // mutation arm.
  function mintFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "gate-honesty-cal-"));
    mkdirSync(join(dir, "skills", "spell", "scripts"), { recursive: true });
    writeFileSync(join(dir, "skills", "spell", "scripts", "cli.ts"), "export const a = 1;\n");
    // Root 2 — the `src/` analogue. A DIFFERENT shape from root 1 on purpose
    // (a surface dir, not a scripts dir), so an arm that plants here cannot be
    // satisfied by root 1's tree by accident.
    mkdirSync(join(dir, "buildsrc", "spell", "surface"), { recursive: true });
    writeFileSync(join(dir, "buildsrc", "spell", "surface", "main.ts"), "export const b = 2;\n");
    return dir;
  }

  function commitAll(dir: string): void {
    const git = (args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["-c", "user.email=cal@local", "-c", "user.name=cal", "commit", "-qm", "fixture"]);
  }

  function deriveIn(dir: string): BlindReport {
    const proc = Bun.spawnSync(["bun", INSTRUMENT], {
      cwd: dir,
      // BOTH root hooks are overridden. Leaving SRC_DIR at its default would
      // point root 2 at a `src/` that does not exist in the fixture — the
      // failure mintFixture's comment describes.
      env: { ...process.env, SKILLS_DIR: "skills", SRC_DIR: "buildsrc", BIOME_CONFIG: BIOME },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    if (proc.exitCode !== 0 || out.trim() === "") {
      throw new Error(
        `fixture derive failed (exit ${proc.exitCode}): ${proc.stderr.toString().slice(0, 300)}`,
      );
    }
    return JSON.parse(out) as BlindReport;
  }

  test("MUTATION — ROOT 1: a new unreadable file in the world is detected, and the control arm is empty", () => {
    const dir = mintFixture();
    try {
      commitAll(dir);
      // CONTROL ARM. Without it, the mutation arm proves only that the instrument
      // returns something — not that it DISCRIMINATES.
      const before = deriveIn(dir);
      expect({ blind: before.blind, blindLines: before.blindLines }).toEqual({
        blind: 0,
        blindLines: 0,
      });

      writeFileSync(
        join(dir, "skills", "spell", "scripts", "surface.html"),
        "<p>1</p>\n<p>2</p>\n",
      );
      commitAll(dir);
      const after = deriveIn(dir);

      // 2 for a two-line file — `wc -l` semantics. Pinned to the INSTRUMENT's
      // convention rather than a second one of this ward's own: two conventions
      // for one number is the drift this ward exists to prevent.
      expect({ blind: after.blind, blindLines: after.blindLines }).toEqual({
        blind: 1,
        blindLines: 2,
      });
      expect(after.files.map((f) => f.file)).toEqual(["skills/spell/scripts/surface.html"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ⛔ THE SECOND ARM IS THE POINT OF R5, NOT A COPY OF THE FIRST. The defect it
  // exists to catch is an instrument that enumerates root 1 and merely CLAIMS
  // root 2 — which is what the report looked like for the whole time
  // `src/mind-mapper/`'s 276 blind lines were missing from it. Arm 1 passing is
  // no evidence at all about root 2: the two roots share no code path below
  // `trackedIn`, and the union hides a root that contributes nothing.
  //
  // It plants a `.css` where arm 1 plants an `.html`, so a scanner that somehow
  // matched only the first arm's extension cannot pass this one by accident.
  test("MUTATION — ROOT 2: a blind file planted in the SECOND root is detected, and the control arm is empty", () => {
    const dir = mintFixture();
    try {
      commitAll(dir);
      const before = deriveIn(dir);
      // The control also proves root 2 is REACHED, not just tolerated: its
      // gated `main.ts` is in the denominator before anything is planted.
      expect({ blind: before.blind, blindLines: before.blindLines, gated: before.gated }).toEqual({
        blind: 0,
        blindLines: 0,
        gated: 2,
      });

      writeFileSync(
        join(dir, "buildsrc", "spell", "surface", "styles.css"),
        ":root {\n  --a: 1;\n}\n",
      );
      commitAll(dir);
      const after = deriveIn(dir);

      expect({ blind: after.blind, blindLines: after.blindLines }).toEqual({
        blind: 1,
        blindLines: 3,
      });
      // Named by its ROOT-2 path. A merged report that dropped the root prefix
      // would pass the scalar assertions above and be wrong here.
      expect(after.files.map((f) => f.file)).toEqual(["buildsrc/spell/surface/styles.css"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MUTATION — a second GATED file is not counted as blind (the false-positive direction)", () => {
    const dir = mintFixture();
    try {
      writeFileSync(join(dir, "skills", "spell", "scripts", "more.ts"), "export const b = 2;\n");
      commitAll(dir);
      // A ward that called EVERYTHING blind would pass the arm above and be
      // useless.
      const r = deriveIn(dir);
      // gated 3, not 2: root 1's `cli.ts` + the planted `more.ts` + ROOT 2's
      // `main.ts`. The scalars are sums across roots (R5), and this number is
      // the cheapest place that fact is asserted rather than described.
      expect({ blind: r.blind, gated: r.gated }).toEqual({ blind: 0, gated: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

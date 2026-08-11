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
// ⛔ WHAT THIS WARD CANNOT SEE:
//   1. It inherits EVERY blind spot of the instrument it calls, including its
//      question. "Which files are UNGATED" is a different question with a
//      different correct answer, and this ward is silent about it.
//   2. It checks the SET and the PER-FILE LINE COUNTS, not the CONTENT. A blind
//      file can be rewritten wholesale without this failing, as long as its line
//      count holds.
//   3. It cannot tell a blind file that is FINE from one that is broken. Nothing
//      here reads those 4,182 lines; that is the point of calling them blind.
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
const DECLARED_BLIND: Record<string, number> = {
  "plugins/spellbook/skills/digestify/scripts/template.html": 1506,
  "plugins/spellbook/skills/bounty/scripts/template.html": 1004,
  "plugins/spellbook/skills/grapevine/scripts/watch.html": 1001,
  "plugins/spellbook/skills/magpie/surface/styles.css": 176,
  "plugins/spellbook/skills/imago/surface/styles.css": 152,
  "plugins/spellbook/skills/magpie/scripts/remove.py": 146,
  "plugins/spellbook/skills/astrolabe/surface/styles.css": 94,
  "plugins/spellbook/skills/astrolabe/surface/index.html": 36,
  "plugins/spellbook/skills/glamour/surface/index.html": 14,
  "plugins/spellbook/skills/imago/surface/index.html": 14,
  "plugins/spellbook/skills/magpie/surface/index.html": 14,
  "plugins/spellbook/skills/glamour/surface/styles.css": 13,
  "plugins/spellbook/skills/astrolabe/bunfig.toml": 3,
  "plugins/spellbook/skills/glamour/bunfig.toml": 3,
  "plugins/spellbook/skills/imago/bunfig.toml": 3,
  "plugins/spellbook/skills/magpie/bunfig.toml": 3,
};

type BlindReport = {
  tracked: number;
  handAuthored: number;
  gated: number;
  docs: number;
  blind: number;
  blindLines: number;
  files: { file: string; lines: number }[];
};

async function deriveBlindSet(): Promise<BlindReport> {
  const proc = Bun.spawn(["bun", "scripts/instruments/gate-blind-set.ts"], {
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
        `  GATE HONESTY — \`bun run check\` reads ${r.gated} of ${r.handAuthored} shipped hand-authored files.`,
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

  function mintFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "gate-honesty-cal-"));
    mkdirSync(join(dir, "skills", "spell", "scripts"), { recursive: true });
    writeFileSync(join(dir, "skills", "spell", "scripts", "cli.ts"), "export const a = 1;\n");
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
      env: { ...process.env, SKILLS_DIR: "skills", BIOME_CONFIG: BIOME },
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

  test("MUTATION — a new unreadable file in the world is detected, and the control arm is empty", () => {
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

      // ⚠ 3, not 2, for a two-line file: the instrument's `lines` unit is
      // `split("\n").length`, which counts the empty fragment after the final
      // newline. So its counts run ONE HIGHER PER FILE than `wc -l` — verified
      // against the real tree (`astrolabe/bunfig.toml` reports 3, `wc -l` says 2).
      // Pinned to ITS convention deliberately: this ward consumes that
      // instrument's predicate and must not mint a second one. Reported to its
      // owner as a UNIT question, not corrected here.
      expect({ blind: after.blind, blindLines: after.blindLines }).toEqual({
        blind: 1,
        blindLines: 3,
      });
      expect(after.files.map((f) => f.file)).toEqual(["skills/spell/scripts/surface.html"]);
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
      expect({ blind: r.blind, gated: r.gated }).toEqual({ blind: 0, gated: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

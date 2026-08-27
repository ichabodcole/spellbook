// P0f — the exit-site inventory ward.
//
// WHAT THIS PINS, AND WHAT IT CANNOT SEE (read this before trusting a green):
//
//   It pins the INVENTORY, not the JUDGMENT. It recomputes the enumeration of
//   `process.exit(` sites and diffs it against the map below. A site that is
//   ADDED, REMOVED, or whose text CHANGED fails the suite and names itself.
//
//   ⛔ It CANNOT tell you a family assignment is CORRECT. A misclassified site,
//   once pinned, stays misclassified and stays GREEN. The classification was
//   made by reading all 37 sites (sprint 03, card t-a0c6c34a); this ward only
//   guarantees nobody moved the ground under that reading.
//
//   ⛔ It is keyed on the literal `process.exit(`. A future exit spelled any
//   other way (`Bun.exit`, a helper that wraps it, a re-exported `die`) is
//   invisible to it. `Bun.exit` was swept for at 9cff395: zero hits repo-wide.
//
//   ⛔ It reads NON-TEST `.ts` under the skills tree only. Exits inside
//   `*.test.ts` are deliberately out of scope (a test may exit however it likes).
//
// UPDATING THE MAP AFTER AN INTENTIONAL CHANGE — the sanctioned route.
//
//   A pinned map is a maintenance burden unless there is a way to update it that
//   is not hand-transcription. There is, and it is deliberately NOT automatic:
//
//     bun test grimoire/exit-site-inventory.test.ts
//
//   The failure prints `added` (in the tree, not pinned) and `removed` (pinned,
//   not in the tree). Move each line across BY HAND, and for anything in
//   `added`, OPEN THE SITE AND ASSIGN ITS FAMILY BY READING IT.
//
//   ⛔ Do NOT regenerate this map from the tree. A map derived from what it
//   checks agrees with it by construction and guards nothing. The whole value
//   is that a human read each site once; regeneration silently discards that
//   and leaves a green test behind.
//
//   Worked example, sprint 03: the funnel routed two hardcoded signal exits
//   (`process.exit(143)` / `process.exit(130)`) through one shared
//   `process.exit(code)`. The ward fired and named all four lines -- while
//   `foundTotal` and `pinnedTotal` both stayed 37. A count-based guard passes
//   that change. A same-count substitution is exactly what this shape catches
//   and a total cannot.
//
// THE ZERO-GUARD: a sweep that fails to RUN reports the same thing as a sweep
// that found nothing. This asserts a non-zero denominator BEFORE comparing, so
// a broken cwd/glob fails loudly instead of passing vacuously.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT =
  process.env.SPELLBOOK_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(REPO_ROOT, "plugins", "spellbook", "skills");

/** The pinned texts quote real source lines that contain a template
 *  placeholder. Writing `$`+`{payload}` keeps the digraph out of this file, so
 *  biome's noTemplateCurlyInString (a rule aimed at someone who MEANT to
 *  interpolate) does not fire on data that is deliberately literal. A blanket
 *  suppression would silence the rule everywhere in this file, including on a
 *  future genuine mistake; this does not. */
const PH = `${"$"}{payload}`;

type Family = "A-drain" | "B-noemit" | "C-signal" | "D-die" | "E-terminal" | "F-live";

/** The pinned inventory: relative path -> normalised source line -> family. */
const PINNED: Array<{ file: string; text: string; family: Family }> = [
  // A — remediated: the exit is the callback of the write it drains (sprint 02).
  {
    file: "astrolabe/scripts/cli.ts",
    text: `if (emit) process.stdout.write(\`${PH}\\n\`, () => process.exit(0));`,
    family: "A-drain",
  },
  {
    file: "bounty/scripts/cli.ts",
    text: `if (emit) process.stdout.write(\`${PH}\\n\`, () => process.exit(0));`,
    family: "A-drain",
  },
  {
    file: "glamour/scripts/cli.ts",
    text: `process.stdout.write(\`${PH}\\n\`, () => process.exit(0));`,
    family: "A-drain",
  },
  {
    file: "imago/scripts/cli.ts",
    text: `process.stdout.write(\`${PH}\\n\`, () => process.exit(0));`,
    family: "A-drain",
  },
  {
    file: "magpie/scripts/cli.ts",
    text: `process.stdout.write(\`${PH}\\n\`, () => process.exit(0));`,
    family: "A-drain",
  },
  // B — the no-emit sibling of an A site: nothing was written, so nothing can be undrained.
  { file: "astrolabe/scripts/cli.ts", text: "else process.exit(0);", family: "B-noemit" },
  { file: "bounty/scripts/cli.ts", text: "else process.exit(0);", family: "B-noemit" },
  // C — signal / shutdown. As of 2cc513d, ZERO of these are defects: the two
  // that were (SIGTERM/SIGINT pre-empting the teardown) were fixed by the funnel
  // lane, and the third (uncaughtException) was ruled and kept with its reason
  // in the code. Was 'THREE OF THESE ARE DEFECTS' before that land.
  {
    file: "astrolabe/scripts/cli.ts",
    text: "const stop = () => process.exit(0);",
    family: "C-signal",
  },
  { file: "bounty/scripts/cli.ts", text: "process.exit(0);", family: "C-signal" },
  { file: "glamour/scripts/cli.ts", text: "process.exit(0);", family: "C-signal" },
  { file: "imago/scripts/cli.ts", text: "process.exit(0);", family: "C-signal" },
  { file: "magpie/scripts/cli.ts", text: "process.exit(0);", family: "C-signal" },
  { file: "grapevine/scripts/cli.ts", text: "process.exit(0);", family: "C-signal" },
  { file: "grapevine/scripts/daemon.ts", text: "process.exit(code),", family: "C-signal" },
  { file: "grapevine/scripts/daemon.ts", text: "process.exit(code);", family: "C-signal" },
  { file: "grapevine/scripts/daemon.ts", text: "process.exit(0);", family: "C-signal" },
  // bounty/server.ts, RE-READ at 2cc513d after the funnel (t-1b9424ab). The two
  // hardcoded signal exits (143/130) are GONE -- routed into the teardown. What
  // remains are three exits that are correct BY CONSTRUCTION, each read at its
  // own site rather than inherited from the previous shape:
  //   :685  uncaughtException -- deliberately NOT routed. The teardown WRITES
  //         THE SNAPSHOT, so flushing possibly-corrupt state over a good one is
  //         "#73 with extra steps". A ruled exception with its reasoning in the
  //         code, not an oversight. (This is the site I reported at comms #473
  //         as a third defect; the owner ruled it and kept it.)
  //   :673  the pre-init fallback inside onFatal -- fires only while
  //         requestShutdown is unassigned. Nothing is pending that early, and a
  //         signal during startup MUST still kill the process.
  //   :860  the shutdown WATCHDOG -- force-exits if the teardown does not
  //         finish. It exists so termination is guaranteed by construction
  //         rather than by the teardown being correct.
  // NOTE: :673 and :860 are BYTE-IDENTICAL ("process.exit(code);"), so the
  // (file, text) key CANNOT tell them apart. Both are pinned; this comment is
  // the only thing that distinguishes them. If one is ever removed, the ward
  // reports one `removed` and cannot say which -- go read both.
  { file: "bounty/scripts/server.ts", text: "process.exit(1);", family: "C-signal" },
  { file: "bounty/scripts/server.ts", text: "process.exit(code);", family: "C-signal" },
  { file: "bounty/scripts/server.ts", text: "process.exit(code);", family: "C-signal" },
  // D — die(): one short stderr write, then exit. Safe ONLY while the payload
  // fits the 64 KiB pipe buffer — stderr truncates exactly like stdout (measured).
  { file: "astrolabe/scripts/cli.ts", text: "process.exit(2);", family: "D-die" },
  { file: "bounty/scripts/cli.ts", text: "process.exit(2);", family: "D-die" },
  { file: "glamour/scripts/cli.ts", text: "process.exit(2);", family: "D-die" },
  { file: "imago/scripts/cli.ts", text: "process.exit(2);", family: "D-die" },
  // magpie's die() picks its code from the acc exit-code taxonomy (usage 2,
  // internal 1, not_found 5, conflict 6) rather than always 2 — same family and
  // same one-short-write shape, variable code, as grapevine's below.
  { file: "magpie/scripts/cli.ts", text: "process.exit(EXIT_FOR[kind]);", family: "D-die" },
  { file: "mind-mapper/scripts/cli.ts", text: "process.exit(2);", family: "D-die" },
  { file: "grapevine/scripts/cli.ts", text: "process.exit(code);", family: "D-die" },
  // E — terminal main exit: teardown already ran inside main().
  { file: "astrolabe/scripts/server.ts", text: "process.exit(exitCode);", family: "E-terminal" },
  { file: "bounty/scripts/join.ts", text: "process.exit(exitCode);", family: "E-terminal" },
  { file: "bounty/scripts/server.ts", text: "process.exit(exitCode);", family: "E-terminal" },
  { file: "imago/scripts/server.ts", text: "process.exit(exitCode);", family: "E-terminal" },
  { file: "magpie/scripts/server.ts", text: "process.exit(exitCode);", family: "E-terminal" },
  { file: "glamour/scripts/server.ts", text: "process.exit(res.code);", family: "E-terminal" },
  {
    file: "mind-mapper/scripts/server.ts",
    text: "process.exit(await main(process.argv.slice(2)));",
    family: "E-terminal",
  },
  // F — live: an in-function exit with stdout pending upstream of it.
  {
    file: "glamour/scripts/cli.ts",
    text: "if (grounded) process.exit(0); // pinned session went away → done",
    family: "F-live",
  },
  {
    file: "imago/scripts/cli.ts",
    text: "if (grounded) process.exit(0); // our pinned session went away → done",
    family: "F-live",
  },
  {
    file: "magpie/scripts/cli.ts",
    text: "if (grounded) process.exit(0); // our pinned session went away → done",
    family: "F-live",
  },
  {
    file: "magpie/scripts/cli.ts",
    text: 'if (e.code === "EPIPE") process.exit(0);',
    family: "F-live",
  },
];

/** Walk for non-test .ts — by BEHAVIOUR (recursive), never a fixed depth or a
 *  per-spell layout guess. Five spells keep code in scripts/, three in tests/;
 *  a hand-written glob is a silent filter (house-style, the 63-vs-37 scar). */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "dist") continue;
      walk(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function enumerate(): Array<{ file: string; text: string }> {
  const found: Array<{ file: string; text: string }> = [];
  for (const abs of walk(SKILLS)) {
    const rel = abs.slice(SKILLS.length + 1);
    const lines = readFileSync(abs, "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes("process.exit(")) continue;
      if (isCommentLine(line)) continue;
      found.push({ file: rel, text: line.trim().replace(/\s+/g, " ") });
    }
  }
  return found;
}

const key = (s: { file: string; text: string }) => `${s.file}\t${s.text}`;

describe("P0f — the exit-site inventory is pinned", () => {
  test("the sweep actually ran (zero-guard: a dead sweep and a clean sweep look identical)", () => {
    const files = walk(SKILLS);
    expect(files.length).toBeGreaterThan(20);
    expect(enumerate().length).toBeGreaterThan(0);
  });

  test("no exit site was added, removed, or reworded without updating the map", () => {
    const found = enumerate().map(key).sort();
    const pinned = PINNED.map(key).sort();
    const added = found.filter((k) => !pinned.includes(k));
    const removed = pinned.filter((k) => !found.includes(k));
    // Report BOTH directions with their denominators — a count alone cannot
    // distinguish "nothing drifted" from "the sweep looked at the wrong set".
    expect({ added, removed, foundTotal: found.length, pinnedTotal: pinned.length }).toEqual({
      added: [],
      removed: [],
      foundTotal: pinned.length,
      pinnedTotal: pinned.length,
    });
  });
});

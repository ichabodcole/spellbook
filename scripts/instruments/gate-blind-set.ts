#!/usr/bin/env bun
// gate-blind-set — which shipped, hand-authored files can `bun run check` not read?
//
// ⛔ DELIBERATELY NOT A `.test.ts`, and for a SECOND reason beyond the usual one.
// The usual one holds (a test file is COLLECTED the moment it exists, so an
// in-progress ward turns a PEER's live gate red). The second is the point of this
// instrument: IT REPORTS, IT DOES NOT GATE. Closing the blind set is a FIX and this
// is a gate sprint — ruled out twice, once against its own author's proposal.
// Run it explicitly:
//
//     bun scripts/instruments/gate-blind-set.ts          # exits 1 ONLY if its own arithmetic breaks
//     SKILLS_DIR=/path/to/a/git/repo SRC_DIR=/path/to/another bun scripts/instruments/gate-blind-set.ts
//
// ── TWO ROOTS, AND WHY THE SECOND ONE IS NOT OPTIONAL (R5) ─────────────────
// It enumerates `plugins/spellbook/skills/` AND `src/`, merged into ONE flat
// `files[]`. The second root is not a bridge for a migration in progress — it is
// the steady state. Contract 4 relocates every buildable surface to
// `src/<spell>/`, where CSS and HTML stay outside biome's reach exactly as they
// were before they moved. Root 1 can never empty either (`magpie/scripts/remove.py`
// is a permanent resident: backend Python, in the shipped tree, that no surface
// migration relocates).
//
// ⛔ THE REASON THIS EXISTS IS RETROACTIVE, AND IT IS THE FINDING: when
// mind-mapper relocated to `src/`, 3 files / 276 lines LEFT THIS REPORT AND
// NOTHING SAID SO. The blind set did not shrink; it moved somewhere the
// instrument was not looking, and the number went DOWN — which reads as
// progress. An instrument that loses sight of files when they move is the
// silent filter this repo keeps scarring on, and this one exists specifically
// to stop blindness going unnoticed.
//
// ⛔ A MISSING ROOT IS A HARD FAILURE, ON PURPOSE. `git -C <root> ls-files`
// throws if the root is not there, this script does not catch it, and the exit
// is non-zero with nothing on stdout. Do NOT "improve" that into a skip: a root
// that silently contributes zero is the same defect as the one above, wearing a
// tolerance for a missing directory as its costume. A calibration fixture must
// therefore mint BOTH roots — see `gate-honesty.test.ts`'s `mintFixture`.
//
// ⛔ THE FIXTURE HOOK MUST POINT AT A GIT REPO, AND THAT IS NOT A QUIRK — IT IS
// THE UNIT. "Shipped" means TRACKED, so the enumerator is `git ls-files` and an
// untracked directory is not a smaller version of the question, it is a
// different one. Mint a throwaway repo (`git init` + `git add`) to calibrate.
// The first version of this line documented `SKILLS_DIR=/some/fixture` and the
// hook EXITED 128 before printing (`git ls-files` refuses a path outside the
// repo) — found by thoth, who could only find it by building a consumer and
// insisting on calibrating it against a mutated world.
// ⚠ **And that dead hook is why the tautological self-check below survived to be
// committed: it was caught by READING, and could not have been caught by RUNNING,
// because the route that would let you mutate a world and watch the check react
// did not work.** A missing calibration route and an uncalibrated check are the
// same fact.
//
// LINE COUNTS ARE `wc -l` SEMANTICS — the count of newline characters. The first
// version used `split("\n").length`, which counts the empty fragment after the
// final newline and so ran exactly ONE HIGH PER FILE (16 files -> a total of
// 4,182 where `wc -l` says 4,166). No argument anywhere depended on the
// difference; the defect was the UNIT, since "lines" to a reader means `wc -l`.
//
// ── THE QUESTION, STATED FIRST, BECAUSE THE QUESTION PICKS THE UNIT ─────────
// Of the SHIPPED-OR-SHIPPED-FROM, HAND-AUTHORED files under
// `plugins/spellbook/skills/` and `src/`, which can `bun run check` not read AT ALL?
//
// ⚠ "SHIPPED" GOT ONE WORD WIDER WHEN THE SECOND ROOT ARRIVED, and pretending
// otherwise is how the union quietly becomes two questions. A `src/<spell>/`
// stylesheet does not ship — its BUILD OUTPUT does. It is in the population
// because it is hand-authored, unreadable by the check arm, and the artifact is
// derived from it, so a syntax error in it is a syntax error in what ships.
//
// It is NOT "which files are ungated" — a different question with a different
// correct answer (it would pull in the 10 `.md`, and the four `bunfig.toml`
// matter for a reason `.md` does not). Two behaviour-shaped predicates over one
// tree can BOTH be correct for different questions and silently wrong for each
// other's — house-style's `enumerate-roster-behaviour-never`, boundary 3. If you
// need the other question, that is a NEW predicate, not a tweak to this one.
//
// ── WHY IT EXISTS ──────────────────────────────────────────────────────────
// biome's `files.includes` is an ALLOW-LIST (ts/tsx/json/jsonc). Asked about a
// single blind path it is loud and exits 1:
//
//     $ bunx biome check plugins/spellbook/skills/bounty/scripts/template.html
//       Checked 0 files.  x No files were processed in the specified paths.
//       i These paths were provided but ignored: ...          exit=1
//
// It goes SILENT only in the repo-wide `.` invocation the gate actually runs,
// where the blind files are merely absent from "Checked N files" and nothing says
// so. Measured: a hard JS syntax error injected into `grapevine/scripts/watch.html`
// passes BOTH arms green (`bun run check` rc=0; grapevine suite 107 pass / 0 fail).
//
// ── THE SELF-CHECK, AND THE ONE IT REPLACED ────────────────────────────────
// ⛔ This instrument first shipped a partition assertion — `gated + docs + blind
// === handAuthored` — advertised to a peer as "the field I would keep if you keep
// nothing else". IT IS TAUTOLOGICAL. `blind` is DEFINED as the complement of
// `gated ∪ docs`, and `.md` can never match the ts/tsx/json/jsonc list, so the
// three are disjoint-and-exhaustive BY CONSTRUCTION and the sum cannot come out
// wrong. It is a check that cannot fail in the failing case — principles.md's
// "anti-correlated with the thing it tests", committed by someone who had read it
// that same session and was quoting the denominator rule while writing it.
//
// THE REAL FAILURE MODE IS DRIFT, and it is a live one: `GATED` below is a COPY
// of biome's `files.includes`. If biome.json gains `**/*.css` tomorrow, every
// number here silently overstates the blind set and nothing says so. So the
// self-check READS biome.json and asserts the copy still matches the original.
// That check CAN fail, fails exactly when the instrument goes wrong, and is the
// only thing that exits non-zero — a large blind set is a finding to report,
// never an error to raise.
//
// ── WHAT THIS INSTRUMENT CANNOT SEE ────────────────────────────────────────
//   • ⚠ ROOT 1 IS `plugins/spellbook/skills/`, ONE LEVEL BELOW THE BOUNDARY THE
//     IMPORT WARDS USE (`plugins/spellbook/`). Two instruments in this repo
//     enumerate two different things and both call it "the plugin". MEASURED
//     2026-08-31: the difference is exactly one file,
//     `plugins/spellbook/.claude-plugin/plugin.json` — 255 tracked vs 254 — so
//     `tracked` and `handAuthored` here are ONE LOW against the artifact the
//     marketplace actually copies. `blind` is UNAFFECTED, because that file is
//     `.json` and therefore gated.
//     ⛔ LEFT AS IS DELIBERATELY, NOT OVERLOOKED. Widening root 1 would move
//     `tracked`/`handAuthored` for no gain to this instrument's question, and
//     those scalars are read by `gate-honesty.test.ts`. Recorded so the next
//     person to reconcile the two denominators knows the size of the gap and
//     that it was priced, not missed. (Raised by cassandra, calibration round 2.)
//   • ANY THIRD ROOT. The two are named literally below; a future build-input
//     tree outside both is invisible until someone adds it here. The blind spot
//     is now "a root nobody declared" rather than "a directory nobody looked in".
//   • ROOT 2 GOING EMPTY. The zero-guard in `gate-honesty.test.ts` is on the
//     UNION (`handAuthored > 0`), and root 1 alone satisfies it, so an emptied
//     `src/` would not trip it. That is deliberate and it is covered elsewhere:
//     the DECLARED_BLIND pin names root-2 files by path, so losing them fails
//     the re-declare cell. The zero-guard's job is only "the instrument
//     enumerated nothing at all"; the pin is what guards each root's contents.
//   • The generated `dist/` (54,185 lines of JS + 7,691 CSS in mind-mapper).
//     Excluded as GENERATED, not as gated — nothing checks it either.
//   • Whether any of these files is actually WRONG. This is a COVERAGE set and
//     never a defect count. Zero of them have been classified.
//   • The blind set is NOT UNIFORM and this instrument does not say so: digestify
//     has a real syntax-parse cell, bounty has 5 literal-string assertions and no
//     parse, grapevine's 1,000 lines have nothing. 3 cells over 3,508 lines of
//     hand-written surface. "Unseen" and "unseen AND unguarded" are different.
//     (Both figures `wc -l`. This bullet previously read "1,001" beside "3,508" —
//     a split-count and a `wc -l` in ONE SENTENCE, left behind when the code's
//     unit was fixed and the prose in the same file was not. Fixing a unit means
//     fixing every place it is QUOTED, not just where it is COMPUTED.)
//   • Line counts, not weight. A 3-line `bunfig.toml` carries Contract 5's
//     silent-Tailwind-skip; a 176-line stylesheet carries no logic at all.

// ── WHICH ARM OF THE GATE THIS IS ABOUT ────────────────────────────────────
// ⛔ `bun run check` and `bun test` are TWO ARMS and only one is blind. This
// instrument's own commit subject (32d1cae) says "THE GATE cannot read 16
// shipped files", and that is an overstatement:
//
//     bun run check   biome, allow-list ts/tsx/json/jsonc   -> blind to all 16
//     bun test        spawns the daemons, reads served output
//                     -> digestify/review.test.ts names template.html  x2
//                        bounty/server.test.ts    names template.html  x3
//
// The honest claim is "the CHECK arm cannot read them"; the test arm is
// PARTIALLY sighted. Found by a cold reader given the branch and no team context
// (`sprints/05-the-gate/cold-read.md`, finding 5), which also convicted the same
// overstatement in a peer's commit subject.
//
// Corrected FORWARD rather than by rewording the commit. The reason, with the
// citations ACTUALLY MEASURED (`git grep 32d1cae`) rather than the two this
// author asserted from memory and had wrong twice on the wire:
//     .anthill/dev/circe.md:87, :208   ·   sprints/05-the-gate/cold-read.md:47
// A rebase-to-reword changes every subsequent sha and breaks those.
//
// ⚠ The rule this violated was already landed in this author's own seat doc
// ("Say which ARM of the gate is blind, never 'the gate'"), amended there after
// making the identical error one sprint earlier. A seat re-grounds from its doc
// at JOIN and never again, so a lesson landed mid-session is inert for the
// session that produced it — which is why the cold reader caught it and four
// seats did not.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// execFileSync (argv array, no shell) rather than execSync — there is no
// interpolation here today, and a shell-string form is the wrong thing to leave
// where the next instrument's author will copy it.
// Enumerate from INSIDE the target with `git -C`, so the fixture hook reaches any
// git repo rather than only paths inside this one. Paths come back relative to
// the target and are re-joined for reading and display.
// TWO named roots rather than one delimited list (R5). A list read from one env
// var has a trap this shape does not: `"".split(",")` is `[""]`, and
// `git -C "" ls-files` silently enumerates the CURRENT directory — a wrong
// answer that looks like a right one. Each root gets its own override so a
// fixture names what it is replacing.
const SKILLS_DIR = process.env.SKILLS_DIR ?? join("plugins", "spellbook", "skills");
const SRC_DIR = process.env.SRC_DIR ?? "src";
const ROOTS = [SKILLS_DIR, SRC_DIR];

const BINARY = /\.(webp|png|jpg|jpeg|gif|svg|ico)$/;
const GENERATED = /(^|\/)dist\//;
const DOC = /\.md$/;

// A COPY of biome's allow-list. Kept as a literal so the predicate is readable —
// and re-validated against biome.json below, because a copy is exactly the thing
// that rots silently.
const GATED_EXTS = ["ts", "tsx", "json", "jsonc"] as const;
const GATED = new RegExp(`\\.(${GATED_EXTS.join("|")})$`);

/** The extensions biome's `files.includes` actually allows, read from the config. */
function biomeGatedExts(configPath: string): string[] {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    files?: { includes?: string[] };
  };
  const includes = config.files?.includes ?? [];
  return includes
    .filter((glob) => !glob.startsWith("!")) // `!!**/node_modules` etc. are exclusions
    .map((glob) => /\.([A-Za-z0-9]+)$/.exec(glob)?.[1])
    .filter((ext): ext is string => Boolean(ext))
    .sort();
}

/** Every tracked path under one root, re-joined to the root for reading and display. */
function trackedIn(root: string): string[] {
  return execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((rel) => join(root, rel));
}

// ONE FLAT UNION, not a per-root breakdown. `gate-honesty.test.ts` pins the
// union and the scalars below are sums across roots; splitting the report would
// be a different envelope for the same question.
const tracked = ROOTS.flatMap(trackedIn);

const handAuthored = tracked.filter((f) => !BINARY.test(f) && !GENERATED.test(f));
const gated = handAuthored.filter((f) => GATED.test(f));
const docs = handAuthored.filter((f) => DOC.test(f));
const blind = handAuthored.filter((f) => !GATED.test(f) && !DOC.test(f));

// `wc -l` semantics: the number of newline characters. NOT `split("\n").length`,
// which counts the empty fragment after a trailing newline and runs one high per file.
const lineCount = (f: string): number => readFileSync(f, "utf8").split("\n").length - 1;
const blindLines = blind.reduce((n, f) => n + lineCount(f), 0);

// The self-check that CAN fail: is our copy of biome's allow-list still the real one?
const BIOME_CONFIG = process.env.BIOME_CONFIG ?? "biome.json";
const declared = biomeGatedExts(BIOME_CONFIG);
const copied = [...GATED_EXTS].sort();
const allowListMatches =
  declared.length === copied.length && declared.every((ext, i) => ext === copied[i]);

console.log(
  JSON.stringify(
    {
      roots: ROOTS,
      tracked: tracked.length,
      handAuthored: handAuthored.length,
      gated: gated.length,
      docs: docs.length,
      blind: blind.length,
      blindLines,
      allowListMatches,
      gatedExtsDeclared: declared,
      gatedExtsUsedHere: copied,
      files: blind
        .map((file) => ({ file, lines: lineCount(file) }))
        .sort((a, b) => b.lines - a.lines),
    },
    null,
    2,
  ),
);

// The ONLY failure condition: our copy of biome's allow-list has drifted from the
// real one, so `blind` is measuring against a gate that no longer exists and every
// number above is unusable. A large blind set is a finding to REPORT, never an
// error to raise — that distinction is this instrument's whole remit and the
// reason it is not a cell.
if (!allowListMatches) {
  console.error(
    `gate-blind-set: ALLOW-LIST DRIFT — ${BIOME_CONFIG} gates [${declared.join(", ")}], this instrument assumes [${copied.join(", ")}]. Every number above is measured against the wrong gate; update GATED_EXTS and re-run.`,
  );
  process.exit(1);
}

// R6 ward 1c — A SHIPPED SKILL.md POINTS AT NOTHING THAT DOES NOT SHIP.
//
// ⛔ WHY PROSE NEEDS ITS OWN WARD. Ward 1a already holds that the published
// artifact resolves no relative path outside itself — but it scans
// `.ts`/`.tsx`/`.js` only, so the ONE file a user actually reads is the one
// nothing was checking. A skill reaches people through a marketplace as a
// folder: `SKILL.md`, `scripts/`, `dist/`, and nothing else. No `docs/`, no
// `grimoire/`, no repo. A sentence pointing at `src/kit/wire/errors.ts` is a
// dead end for every reader outside this repository. (Cole, setting the scope
// of the finalization branch: "the skill has to stand on its own… other types
// of systems will only include what's in that skill folder.")
//
// ⛔ AND IT FIRES ON EVIDENCE, NOT ON SHAPE — which is the whole design, and
// Cole's one caveat: "just making sure that it's not too brittle… we're not
// getting false positives or false negatives."
//
// A token is a violation ONLY when it RESOLVES to something that really exists
// in this repository and does not exist inside the skill folder. That single
// rule separates the two cases that actually occur:
//
//   `src/kit/wire/errors.ts`  → exists in the repo, absent from the folder → RED
//   `docs/<slug>/vN.md`       → exists nowhere; a runtime path with a
//                               placeholder in it → ignored, correctly
//
// Matching on shape would have flagged the second, because it begins with
// `docs/` exactly like a repo path does. Nothing here guesses what a string
// MEANS; it asks the filesystem what a string IS.
//
// ⚠ WHAT IT DELIBERATELY CANNOT SEE: a reference to a repo path that does not
// exist — a typo, or a file deleted after the sentence was written. Those are
// dead links either way and a different ward's job; this one is about the
// SHIPPING BOUNDARY, and buying that coverage would mean guessing from shape
// again and taking the false positives with it.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_ROOT = join(REPO_ROOT, "plugins", "spellbook", "skills");

/** Every shipped SKILL.md, by the index — what is committed is what ships. */
function shippedSkills(): string[] {
  return execFileSync("git", ["-C", REPO_ROOT, "ls-files", "plugins/spellbook/skills/*/SKILL.md"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/**
 * Path-ish tokens worth testing: the targets of markdown links, and the
 * contents of backticked spans.
 *
 * ⚠ Both, because the real violation was in a BACKTICKED span rather than a
 * link — `(src/kit/wire/errors.ts)` inside a sentence — and a ward that only
 * read links would have passed it.
 */
export function candidates(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) if (m[1]) out.add(m[1]);
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) if (m[1]) out.add(m[1].trim());
  return [...out].filter((t) => {
    if (t === "") return false;
    // A URL, an anchor, an absolute path or a home-relative one is not a
    // reference to a repo file.
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#") || t.startsWith("/")) return false;
    if (t.startsWith("~")) return false;
    // A placeholder is not a path anyone can resolve — and it is exactly the
    // false positive this ward must not produce.
    if (t.includes("<") || t.includes(">")) return false;
    // Prose in backticks, a command line, or a fragment with spaces.
    if (/\s/.test(t)) return false;
    // Must at least look like a path with a directory in it; a bare word in
    // backticks is a verb or a field name, not a file.
    return t.includes("/");
  });
}

/**
 * Does this token resolve to a real FILE, allowing a few missing extensions?
 *
 * ⛔ A FILE, NOT A DIRECTORY, AND A FALSE POSITIVE TAUGHT THAT. digestify's
 * skill advises writing scratch content to `.agents/…`, "gitignored in this
 * repo" — meaning the READER's repo. The directory happens to exist here too,
 * because we use the same convention, so a rule that accepted directories
 * called it a dangling reference. It is not one: the sentence is about the
 * user's project, not ours.
 *
 * Naming a specific FILE is a promise that the file is there. Naming a
 * directory is usually a convention, an example, or a place to put something.
 * The narrower rule keeps the true positive and drops the noise — at the price
 * of not catching a reference to a repo DIRECTORY, which is the trade this
 * ward takes deliberately rather than guessing from shape again.
 */
function resolvesUnder(root: string, token: string): boolean {
  const base = join(root, token);
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  if (isFile(base)) return true;
  // `src/kit/wire/errors` names a file whose extension the prose left off.
  return [".ts", ".tsx", ".js", ".md", ".json"].some((ext) => isFile(base + ext));
}

/**
 * References a shipped skill makes that will not be there for its reader.
 * Exported so the cell below can run it against a fixture and prove it bites.
 */
export function danglingReferences(markdown: string, skillDir: string, repoRoot: string): string[] {
  return candidates(markdown).filter(
    (t) => !resolvesUnder(skillDir, t) && resolvesUnder(repoRoot, t),
  );
}

describe("R6 ward 1c — a shipped SKILL.md points at nothing that does not ship", () => {
  const skills = shippedSkills();

  test("the sweep actually ran (zero-guard: no skills and no findings look alike)", () => {
    expect(skills.length).toBeGreaterThan(5);
    // And the extraction is finding something to test, or the rule below passes
    // for the wrong reason.
    const seen = skills.flatMap((f) => candidates(readFileSync(join(REPO_ROOT, f), "utf8")));
    expect(seen.length).toBeGreaterThan(20);
  });

  test("⛔ THE INSTRUMENT BITES — proven on a fixture, not only on today's tree", () => {
    // The case that motivated the ward, as a string rather than as whatever
    // happens to be in bounty's file this week.
    const bad = "The exits are the house taxonomy (`src/kit/wire/errors.ts`), and…";
    expect(danglingReferences(bad, join(SKILLS_ROOT, "bounty"), REPO_ROOT)).toEqual([
      "src/kit/wire/errors.ts",
    ]);
  });

  test("⚠ AND IT DOES NOT BITE THE THINGS IT MUST NOT", () => {
    const dir = join(SKILLS_ROOT, "scriptorium");
    // A runtime path with a placeholder — begins with `docs/` exactly like a
    // repo path, and is not one. This is the false positive the shape-matching
    // version produced.
    expect(danglingReferences("`docs/<slug>/vN.md`", dir, REPO_ROOT)).toEqual([]);
    // Something that DOES ship, referenced from the skill folder.
    expect(danglingReferences("`scripts/cli.ts`", dir, REPO_ROOT)).toEqual([]);
    expect(danglingReferences("`dist/server.js`", dir, REPO_ROOT)).toEqual([]);
    // A URL, an anchor, a home path, a bare verb, prose with a slash in it.
    expect(
      danglingReferences(
        "[docs](https://x.dev/docs/a) and `~/.scriptorium` and `version-new` and `and/or`",
        dir,
        REPO_ROOT,
      ),
    ).toEqual([]);
    // A path that exists NOWHERE is not this ward's business.
    expect(danglingReferences("`src/nothing/here.ts`", dir, REPO_ROOT)).toEqual([]);
    // ⛔ THE FALSE POSITIVE THAT NARROWED THE RULE, kept as the real sentence.
    // digestify tells the reader to write scratch content into THEIR project's
    // `.agents/`; the directory exists here too, and this is not a reference to
    // ours. A directory is a convention, not a promise about a file.
    expect(
      danglingReferences(
        "write it to `.agents/digestify-questions.md` — `.agents/` is gitignored in this repo",
        join(SKILLS_ROOT, "digestify"),
        REPO_ROOT,
      ),
    ).toEqual([]);
  });

  test("no shipped skill points outside its own folder", () => {
    const violations = skills.flatMap((f) => {
      const dir = join(REPO_ROOT, dirname(f));
      return danglingReferences(readFileSync(join(REPO_ROOT, f), "utf8"), dir, REPO_ROOT).map(
        (t) => `${f} -> ${t}`,
      );
    });
    expect(violations.sort()).toEqual([]);
  });
});

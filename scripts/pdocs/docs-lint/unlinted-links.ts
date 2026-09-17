// PORTED VERBATIM from agent-cli-conformance @ 1255a5d1c1010414bfbdb3c82bf01cdc44d0d2eb
// (github.com/ichabodcole/agent-cli-conformance, MIT, same author) — file:
// `scripts/docs-lint/unlinted-links.ts`.
//
// Copied, not shared. There is no package behind this yet and three repos is
// too few to abstract across; the copy is the honest state until a fourth one
// wants it. Keep this file byte-identical to its source so a future extraction
// is a move, not a merge: project-specific behaviour goes in the consuming
// repo's rules layer — `scripts/pdocs/lint/rules.ts` here — through the
// `extraChecks` seam, never in here.
//
// EXCEPTION: `ALREADY_LINTED`, `GENERATED`, and the module comment
// that describes them are this repo's layout rather than the source's. The code
// below them is the source, plus an `export` on `trackedMarkdown` so the entry
// point can filter the corpus without a second policy living in here.

// Link and anchor resolution for the authored Markdown no other lint reads.
//
// The rules layer walks all of `docs/`. This reads EVERYTHING ELSE git tracks — not a named list
// of root documents. The corpus is `git ls-files -- '*.md'` minus that prefix, the build product
// and the scaffold payload (below) and the generated CHANGELOG.md, so README.md, AGENTS.md,
// CLAUDE.md, every page under `plugins/project-docs/` — skills, commands, agents, migration
// guides — and the repo-local `.claude/skills/` are all in it, and a markdown file added anywhere
// new joins on `git add` rather than by being listed here.
//
// The plugin pages are the reason this matters here. They are the shipped product: a skill that
// links a moved playbook is a broken instruction in someone else's repository, and nothing else
// in this project reads them.
//
// The direction that was missing is the one that helps least to leave out. A page's own
// cross-references are the live hazard: rename a heading in AGENTS.md and its same-file anchors
// break silently, while an inbound citation from a skill would have been caught.
//
// WHAT IT DOES NOT REACH. `checkLinks` reads inline `](target)` links only. Reference-style links
// — `[text][ref]` with a `[ref]: target` definition — are invisible to it in both directions,
// including the same-file-anchor direction named above as the live hazard. That is a property of
// the shared helper, not of this module, and it is stated here because the corpus this widens to
// is prose written by people and agents who use that syntax freely. No gated file uses it today.
//
// This imposes nothing else. No frontmatter, no `type`, no catalog reachability: those are
// contracts about documents that complete, and these documents do not.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { checkLinks } from "./index.ts";

/** Prefixes already walked by a lint that resolves their links. Excluded to avoid double reporting. */
const ALREADY_LINTED = ["docs/"];

/**
 * `CHANGELOG.md` IS WRITTEN BY release-please AND MUST NOT BE GATED.
 *
 * A link the generator emits that did not resolve would fail this check with no hand fix
 * available — correct it and the next release regenerates whatever you corrected. The release
 * skill's rule is to exempt the generated artifact rather than lint or format it, and a gate that
 * can only be satisfied by editing a file you do not own is a wedged release.
 *
 * `README.md` is also touched by release-please, through `extra-files` in
 * `release-please-config.json`. It stays gated deliberately: the generator only substitutes
 * version literals inside `x-release-please-version` markers, so it authors no links, and the
 * file is hand-maintained everywhere else.
 */
const GENERATED = new Set(["CHANGELOG.md"]);

/**
 * THE CORPUS IS WHAT GIT TRACKS, not a hand-maintained list of directories to avoid.
 *
 * An exclusion list has to name every place working material can appear, and it is wrong the
 * moment one is added. Worse, it makes the check's verdict depend on untracked local state: a
 * scratch directory nobody named, or a transient file a documented process writes into the
 * repository root — the release flow leaves `note.md`, `changelog.md` and `release-body.md`
 * there — would be gated on a contributor's machine and absent in CI, and `.husky/pre-commit`
 * runs the gate, so one stray file locks every commit in a shared tree.
 *
 * Tracked-or-staged is the honest boundary: it is identical locally and in CI, it needs no
 * second spelling of "what is not ours" to keep in step with `version-literals.ts`, and a new
 * document joins the gate at `git add` — before the commit that would publish it.
 */
export function trackedMarkdown(repoRoot: string): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], { cwd: repoRoot });
  if (!out.success) return [];
  return new TextDecoder()
    .decode(out.stdout)
    .split("\0")
    .filter((p) => p.length > 0);
}

/**
 * PURE over its inputs, so the selection and the resolution can be tested apart. `paths` are
 * repository-relative; the caller supplies them.
 *
 * Trees this check should not reach at all — a build product whose findings are
 * really findings in its source, or a template payload whose relative links
 * resolve against some other repository's root — are filtered by the CALLER,
 * from `lint.exclude` in `.project-docs.json`. They used to be a constant here,
 * which put one repository's directory names inside a file shipped to every
 * other one. Data belongs in the config; this file is the code.
 */
export function linkProblemsFor(repoRoot: string, paths: string[]): string[] {
  const problems: string[] = [];
  for (const rel of paths) {
    if (GENERATED.has(rel)) continue;
    if (ALREADY_LINTED.some((p) => rel.startsWith(p))) continue;
    const abs = `${repoRoot}/${rel}`;
    for (const bad of checkLinks(abs, readFileSync(abs, "utf8")).problems) {
      problems.push(
        bad.kind === "MISSING FILE"
          ? `MISSING FILE  ${rel}: ${bad.target}`
          : `MISSING ANCHOR  ${rel}: ${bad.target}  (#${bad.anchor} not a heading)`,
      );
    }
  }
  return problems;
}

export function unlintedLinkProblems(repoRoot: string): string[] {
  return linkProblemsFor(
    repoRoot,
    trackedMarkdown(repoRoot).map((p) => relative("", p)),
  );
}

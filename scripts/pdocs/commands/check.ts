// `pdocs check` — the gate.
//
// This is the command the pre-commit hook and CI run,
// and its TEXT rendering is a byte-for-byte inheritance from `docs/lint.ts`'s
// `main()`. That is not sentiment: `scripts/pdocs/lint/golden.test.ts` asserts
// the whole of stdout against transcripts recorded before this file existed, so
// a change here that reads as a harmless tidy-up fails the guard rather than
// quietly rewording the gate every project in the scaffold's fleet reads.
// One line is this file's own and not inherited: the count of tracked pages
// outside the docs root, under the workbench summary.
//
// The JSON rendering is NEW output and covered by tests of its own.

import {
  type Advisory,
  advisoryLines,
  reviewAdvisory,
  templateHeaderAdvisory,
} from "../advisories.ts";
import type { Command, Invocation } from "../cli.ts";
import { docsLintSummary } from "../docs-lint/index.ts";
import { ExitCode, Outcome, UsageError, printEnvelope } from "../envelope.ts";
import { type LintReport, collect } from "../lint/collect.ts";
import { refExists } from "../lint/work.ts";

/** One problem, and which tier found it. */
export interface CheckProblem {
  tier: "library" | "workbench";
  message: string;
}

/** `data` in the envelope. `clean` is the answer; `ok` on the envelope is only
 *  whether the run itself worked. */
export interface CheckData {
  clean: boolean;
  /** `lint.adopting` in `.project-docs.json`: problems are reported and the
   *  gate still exits 0. Visible so a caller can tell "clean" from "clean
   *  because this project said not to fail yet". */
  adopting: boolean;
  total: number;
  problems: CheckProblem[];
  /** Tracked markdown pages outside the docs root, read for their LINKS ONLY —
   *  no frontmatter, no tier. A `workbench` problem naming a path that is not
   *  under the docs root came from one of these; `lint.exclude` takes one out. */
  outside: number;
  /** What the lint decided NOT to look at: every file under the docs root it
   *  skipped as a template, repo-relative. A skip that wrongly catches a real
   *  page leaves no other trace, so the list is the only way to see it. */
  templates: string[];
  /**
   * What the gate reports and does not fail on by itself: the
   * `work-item-review` advisory, over every item the review rule finds, then
   * the `template-header` advisory, over every document that still holds a
   * template's header comment. Empty when there is nothing to say. Under
   * `checks.workItemReview.mode: strict` the review items are also
   * `UNREVIEWED` problems.
   */
  advisories: Advisory[];
}

/** The advisories `pdocs check` attaches. An invalid setting is a `BAD CONFIG`
 *  problem here, not a `bad-config` advisory. */
export function checkAdvisories(report: LintReport, ctx: Invocation["ctx"]): Advisory[] {
  const review = reviewAdvisory(report.reviews, ctx.config.checks.workItemReview.mode);
  const header = templateHeaderAdvisory(report.templateHeaders);
  return [...(review ? [review] : []), ...(header ? [header] : [])];
}

export function checkData(report: LintReport, advisories: Advisory[] = []): CheckData {
  const problems: CheckProblem[] = [
    ...report.library.fieldProblems.map((message) => ({
      tier: "library" as const,
      message,
    })),
    ...report.library.graph.problems.map((message) => ({
      tier: "library" as const,
      message,
    })),
    ...report.workbench.map((message) => ({
      tier: "workbench" as const,
      message,
    })),
  ];
  return {
    clean: report.total === 0,
    adopting: report.adopting,
    total: report.total,
    problems,
    outside: report.outside,
    templates: report.templates,
    advisories,
  };
}

/**
 * What `bun docs/lint.ts` printed, verbatim, plus the outside-corpus line.
 *
 * Do not reflow, retitle or re-punctuate anything below without re-recording
 * the goldens and reading the diff.
 */
function renderText(report: LintReport, docsRoot: string): void {
  console.log(`── library (graph tier) ────────────────────────────────`);
  for (const p of report.library.fieldProblems) console.log(p);
  for (const p of report.library.graph.problems) console.log(p);
  console.log(docsLintSummary(report.library.graph));
  if (report.library.fieldProblems.length)
    console.log(
      `\n${report.library.fieldProblems.length} frontmatter problem(s) in the library.`
    );

  console.log(`\n── workbench (thin tier) ───────────────────────────────`);
  for (const p of report.workbench) console.log(p);
  console.log(
    report.workbench.length
      ? `\n${report.workbench.length} problem(s).`
      : "OK — no problems."
  );
  // The one line `docs/lint.ts` never printed. It read this corpus without
  // saying so, and a problem row naming `DEV_KICKOFF.md` at the repository root
  // then reads as a docs-root path that does not exist. Problems found there
  // are already listed above; this says where they came from.
  console.log(
    `${report.outside} tracked page(s) outside ${docsRoot}/, links only  (\`lint.exclude\` takes one out)`
  );

  if (report.total === 0) {
    console.log(`\ndocs-lint: clean`);
    return;
  }

  if (report.adopting) {
    console.log(
      `\ndocs-lint: ${report.total} problem(s), exiting 0 — \`lint.adopting\` is true in ` +
        `.project-docs.json.\n` +
        `           This project is mid-adoption. Work the list with \`pdocs report\`,\n` +
        `           then set \`lint.adopting\` to false; it is not a permanent setting.`
    );
    return;
  }

  console.log(`\ndocs-lint: ${report.total} problem(s)`);
}

export const check: Command = {
  name: "check",
  summary: "Lint the documentation tree. Exit 9 if it is dirty.",
  usage: "pdocs check [--root <path>] [--format text|json] [--against <ref>]",
  options: [
    {
      flag: "--against",
      metavar: "<ref>",
      summary:
        "The git ref an item may not silently leave (default HEAD). In CI, name the base.",
    },
  ],

  run({ ctx, format, flags }: Invocation): number {
    const against = flags["--against"];
    if (against === true) throw new UsageError("--against needs a ref.");
    if (against !== undefined) {
      const exists = refExists(ctx, against);
      if (exists !== true)
        throw new UsageError(
          exists === null
            ? `--against ${against}: ${ctx.repoRoot} is not a git repository.`
            : `--against: \`${against}\` does not name a commit.`,
          { token: against }
        );
    }
    const report = collect(against === undefined ? ctx : { ...ctx, against });

    const advisories = checkAdvisories(report, ctx);
    if (format === "json") printEnvelope("check", checkData(report, advisories));
    else {
      renderText(report, ctx.config.docsRoot);
      // After the verdict, as every view prints its advice: the inherited
      // transcript above is unchanged when there is nothing to say.
      if (advisories.length > 0) console.log("");
      for (const l of advisoryLines(advisories)) console.log(l);
    }

    // Clean, or dirty in a project that has declared itself mid-adoption.
    if (report.total === 0 || report.adopting) return ExitCode.Success;

    // An OUTCOME, not an error: the run succeeded and the answer is negative.
    // Non-zero because that is what a harness which does not parse JSON reads.
    return Outcome.Dirty;
  },
};

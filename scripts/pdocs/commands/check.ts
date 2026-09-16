// `pdocs check` — the gate.
//
// This is the command the pre-commit hook and CI run,
// and its TEXT rendering is a byte-for-byte inheritance from `docs/lint.ts`'s
// `main()`. That is not sentiment: `scripts/pdocs/lint/golden.test.ts` asserts
// the whole of stdout against transcripts recorded before this file existed, so
// a change here that reads as a harmless tidy-up fails the guard rather than
// quietly rewording the gate every project in the scaffold's fleet reads.
//
// The JSON rendering is NEW output and covered by tests of its own.

import type { Command, Invocation } from "../cli.ts";
import { docsLintSummary } from "../docs-lint/index.ts";
import { ExitCode, Outcome, printEnvelope } from "../envelope.ts";
import { type LintReport, collect } from "../lint/collect.ts";

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
  /** What the lint decided NOT to look at: every file under the docs root it
   *  skipped as a template, repo-relative. A skip that wrongly catches a real
   *  page leaves no other trace, so the list is the only way to see it. */
  templates: string[];
}

export function checkData(report: LintReport): CheckData {
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
    templates: report.templates,
  };
}

/**
 * What `bun docs/lint.ts` printed, verbatim.
 *
 * Do not reflow, retitle or re-punctuate anything below without re-recording
 * the goldens and reading the diff.
 */
function renderText(report: LintReport): void {
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
  usage: "pdocs check [--root <path>] [--format text|json]",
  options: [],

  run({ ctx, format }: Invocation): number {
    const report = collect(ctx);

    if (format === "json") printEnvelope("check", checkData(report));
    else renderText(report);

    // Clean, or dirty in a project that has declared itself mid-adoption.
    if (report.total === 0 || report.adopting) return ExitCode.Success;

    // An OUTCOME, not an error: the run succeeded and the answer is negative.
    // Non-zero because that is what a harness which does not parse JSON reads.
    return Outcome.Dirty;
  },
};

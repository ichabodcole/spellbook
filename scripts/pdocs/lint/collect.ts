// The gate, assembled: every rule run once, and the findings handed back.
//
// This is what `main()` used to do inline, minus the printing. It is separated
// for one reason — the assembly is the part that can silently stop calling a
// rule, and a caller that both assembles and prints cannot be tested for that
// without capturing stdout. `collect` returns data; its caller — `pdocs check`
// — decides what a person sees.
//
// It takes a `Ctx` rather than deriving a root. A root derived inside a moved
// file is the failure this layering exists to avoid: get it wrong and the walk
// finds nothing, and a lint that walks nothing reports clean.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocsLintReport } from "../docs-lint/index.ts";
import {
  linkProblemsFor,
  trackedMarkdown,
} from "../docs-lint/unlinted-links.ts";
import {
  type Ctx,
  excluder,
  frontmatterSyntaxProblems,
  graphTier,
  libraryFieldChecks,
  schemaTableChecks,
  templatePaths,
  templateProblems,
  templateTest,
  thinTier,
} from "./rules.ts";

/** Everything one run of the gate found, in the order a reader is shown it. */
export interface LintReport {
  library: {
    /** Frontmatter problems on library pages, read on the document's own terms. */
    fieldProblems: string[];
    /** The ported core's findings, plus the knowledge graph it walked to get them. */
    graph: DocsLintReport;
  };
  /** The workbench tier, the syntax check, the SCHEMA.md table, and the links outside `docs/`. */
  workbench: string[];
  /** `library.fieldProblems` + `library.graph.problems` + `workbench`. */
  total: number;
  /** Repo-relative paths under the docs root the lint skipped as templates. */
  templates: string[];
  /** `lint.adopting` in `.project-docs.json`: problems are reported and do not fail the gate. */
  adopting: boolean;
}

/**
 * Run every check against one tree.
 *
 * Two library passes, because they answer different questions. `graphTier`
 * walks the links, the catalog and the `related` edges — the obligations a page
 * has BECAUSE it is in the library. `libraryFieldChecks` reads the frontmatter
 * of each page on its own terms, which is what the workbench gets too and what
 * the library went without until a cold read tried `status: approved` on a
 * memory and the gate said `clean`.
 */
export function collect(ctx: Ctx): LintReport {
  const fieldProblems = libraryFieldChecks(ctx);
  const graph = graphTier(ctx);
  const isTpl = templateTest(ctx);

  const workbench = [
    ...thinTier(ctx),
    ...frontmatterSyntaxProblems(ctx),
    ...schemaTableChecks(readFileSync(join(ctx.docsRoot, "SCHEMA.md"), "utf8")),
    // Two checks of the tooling's own configuration rather than of any
    // document: the contract against the code, and the registry's declared
    // template paths against the disk. They are grouped with the workbench
    // findings only because the report has one place to put a problem — see
    // `templateProblems` for why neither belongs to a tier.
    ...templateProblems(ctx),
    // Everything git tracks outside the docs root: README, AGENTS, and the
    // shipped plugin pages, where a link to a moved playbook is a broken
    // instruction in someone else's repository.
    ...linkProblemsFor(
      ctx.repoRoot,
      trackedMarkdown(ctx.repoRoot).filter(
        (p) => !isTpl(p) && !excluder(ctx)(p)
      )
    ),
  ];

  return {
    library: { fieldProblems, graph },
    workbench,
    total: fieldProblems.length + graph.problems.length + workbench.length,
    templates: templatePaths(ctx),
    adopting: ctx.config.lint.adopting,
  };
}

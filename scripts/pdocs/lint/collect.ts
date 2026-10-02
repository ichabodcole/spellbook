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

import { existsSync, readFileSync } from "node:fs";
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
  gitEnv,
  graphTier,
  libraryFieldChecks,
  schemaTableChecks,
  templateHeaderPaths,
  templatePaths,
  templateProblems,
  templateTest,
  thinReport,
} from "./rules.ts";
import type { ReviewItem } from "../advisories.ts";
import { configProblems, deletedItems, reviewFindings, reviewProblems, workProblems } from "./work.ts";

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
  /**
   * How many tracked pages OUTSIDE the docs root were read, for links only.
   * Their problems are in `workbench`; this is what says the corpus exists, so
   * a row naming a file nobody put under the docs root reads as what it is.
   */
  outside: number;
  /** `library.fieldProblems` + `library.graph.problems` + `workbench`. */
  total: number;
  /** Repo-relative paths under the docs root the lint skipped as templates. */
  templates: string[];
  /** `lint.adopting` in `.project-docs.json`: problems are reported and do not fail the gate. */
  adopting: boolean;
  /**
   * Items the review rule finds: started work, or the active cycle's unstarted
   * work, whose document is not `stable`. Reported as an advisory in either
   * mode; in `workbench` as well, as `UNREVIEWED`, only when
   * `checks.workItemReview.mode` is `strict`.
   */
  reviews: ReviewItem[];
  /**
   * Documents under the docs root, not templates, that still hold a template's
   * header comment, repo-relative. Reported as the `template-header` advisory;
   * never a problem, never counted in `total`.
   */
  templateHeaders: string[];
}

/**
 * Of the tracked pages, the ones `linkProblemsFor` reads.
 *
 * Not the docs root: the two tiers walk it, and a page handed to both is
 * reported twice. `unlinted-links.ts` skips that for itself only when the docs
 * root is spelled `docs/` — a private constant of a file ported verbatim — so
 * the caller takes the real one out here. Its other two skips are restated to
 * COUNT by and for nothing else: the generated CHANGELOG, and that same literal
 * `docs/`, which under a docs root of another name means a tracked `docs/`
 * folder is read by nobody. `collect — the outside corpus` in `rules.test.ts`
 * holds the count to what is read.
 */
function readOutside(ctx: Ctx, rel: string): boolean {
  return (
    rel !== "CHANGELOG.md" &&
    !rel.startsWith("docs/") &&
    !rel.startsWith(`${ctx.config.docsRoot}/`)
  );
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

  // Everything git tracks outside the docs root: README, AGENTS, and the
  // shipped plugin pages, where a link to a moved playbook is a broken
  // instruction in someone else's repository. `lint.exclude` takes a file out.
  // A tracked path that is not on disk is one being deleted: in a commit hook
  // `ls-files` reads the real index (`gitEnv` drops the one being committed),
  // which still lists what `git commit -a` is removing, and outside a hook it
  // is an unstaged `rm`. There is nothing to read, so it is not in the corpus.
  const excluded = excluder(ctx);
  const tracked = trackedMarkdown(ctx.repoRoot, gitEnv()).filter(
    (p) =>
      !isTpl(p) &&
      !excluded(p) &&
      !p.startsWith(`${ctx.config.docsRoot}/`) &&
      existsSync(join(ctx.repoRoot, p))
  );

  // The thin pass and the work-taxonomy corpus rules share one read of the
  // workbench: `workProblems` takes the documents the thin pass already parsed.
  const thin = thinReport(ctx);
  const reviews = reviewFindings(ctx, thin.documents);
  const workbench = [
    ...thin.problems,
    ...configProblems(ctx),
    ...workProblems(ctx, thin.documents),
    ...(ctx.config.checks.workItemReview.mode === "strict" ? reviewProblems(reviews) : []),
    ...deletedItems(ctx, ctx.against ?? "HEAD", thin.documents),
    ...frontmatterSyntaxProblems(ctx),
    ...schemaTableChecks(readFileSync(join(ctx.docsRoot, "SCHEMA.md"), "utf8")),
    // Two checks of the tooling's own configuration rather than of any
    // document: the contract against the code, and the registry's declared
    // template paths against the disk. They are grouped with the workbench
    // findings only because the report has one place to put a problem — see
    // `templateProblems` for why neither belongs to a tier.
    ...templateProblems(ctx),
    ...linkProblemsFor(ctx.repoRoot, tracked),
  ];

  return {
    library: { fieldProblems, graph },
    workbench,
    outside: tracked.filter((p) => readOutside(ctx, p)).length,
    total: fieldProblems.length + graph.problems.length + workbench.length,
    templates: templatePaths(ctx),
    adopting: ctx.config.lint.adopting,
    reviews,
    templateHeaders: templateHeaderPaths(ctx),
  };
}

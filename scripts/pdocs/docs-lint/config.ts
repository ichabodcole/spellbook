// `.project-docs.json` — the one place a project states where its documentation
// lives and which folders belong to which lint tier.
//
// NOT ported from agent-cli-conformance; that repo hardcodes its roots because
// it has exactly one layout. This scaffold generates other people's
// repositories, so every path it would otherwise assume has to be a value
// somebody can change. `docs/` is only the default.
//
// The file is optional. A project that has never seen it gets the defaults
// below, which are this scaffold's own layout — so the lint runs on a
// pre-config project, and `migrate-v2.6-to-v2.7` can write the file rather than
// requiring it to exist first.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LintConfig {
  /**
   * Report problems but exit 0.
   *
   * A project adopting this layer has a corpus that predates it: every document
   * is missing frontmatter until the backfill has run, so a gate that fails on
   * day one fails on every commit of the work that fixes it. The honest options
   * were `--no-verify` on every commit (which trains the habit that removes the
   * gate) or a state the project can declare — this is the state.
   *
   * Set it to false the moment `--report` is empty. It is not a permanent
   * setting, and the lint says so on every run.
   */
  adopting: boolean;
  /**
   * Path globs, relative to the repository root, for `.md` files that are not
   * documentation at all. Matched files are invisible to every tier: no
   * frontmatter, no links, no graph.
   *
   * Distinct from `skip`, which is directory NAMES matched at any depth and
   * prunes whole subtrees during the walk. This filters individual files, and
   * the two are kept apart because expressing "`_archive` anywhere" as a glob
   * would mean giving up that pruning.
   *
   * The case that motivated it: a Slidev or Marp deck is a `.md` file whose
   * frontmatter (`theme`, `paginate`, `layout`) belongs to the slide renderer,
   * not to this schema. It is a program that happens to be Markdown, and the
   * honest thing is to say so rather than to widen the vocabulary until it fits.
   *
   * Syntax is `Bun.Glob`: `*` within a segment, `**` across segments, `?`, and
   * `{a,b}` alternation — so a literal `{` in a path must be escaped `\{`.
   */
  exclude: string[];
  /** Folders under `docsRoot` that hold living pages: the graph tier. */
  durable: string[];
  /** Folders under `docsRoot` that hold work in progress: the thin tier. */
  workbench: string[];
  /** Directory names skipped entirely, at any depth. */
  skip: string[];
  /**
   * Folders this project declares itself, mapped to the `type` their pages
   * carry: `{ "runbooks": "runbook" }`. The scaffold ships no template for
   * these, so `pdocs new` will not create one — but the lint accepts them.
   * List the folder in `durable` or `workbench` too, to pick its tier.
   */
  types: Record<string, string>;
}

export interface ProjectDocsConfig {
  /** Repository-relative path to the documentation root. */
  docsRoot: string;
  /** The scaffold version this project's docs are on. Release-please bumps it. */
  version: string | null;
  lint: LintConfig;
}

export const DEFAULT_CONFIG: ProjectDocsConfig = {
  docsRoot: "docs",
  version: null,
  lint: {
    adopting: false,
    exclude: [],
    durable: [
      "architecture",
      "specifications",
      "interaction-design",
      "playbooks",
      "lessons-learned",
      "memories",
    ],
    workbench: ["backlog", "briefs", "investigations", "projects", "reports", "fragments", "cycles"],
    types: {},
    skip: ["_archive", "superpowers"],
  },
};

export const CONFIG_FILENAME = ".project-docs.json";

/**
 * Read `.project-docs.json` from `repoRoot`, filling anything absent from the
 * defaults.
 *
 * A malformed file THROWS rather than falling back. Silently linting the
 * default layout because a comma was missing is how a project discovers, weeks
 * later, that its gate has been checking the wrong tree.
 */
export function loadConfig(repoRoot: string): ProjectDocsConfig {
  const path = join(repoRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${CONFIG_FILENAME} must contain a JSON object`);

  const o = parsed as Record<string, unknown>;
  const lint = (o.lint ?? {}) as Record<string, unknown>;

  /** `{ folder: type }`, keeping only string-valued entries. */
  const typeMap = (v: unknown): Record<string, string> =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(
            ([, t]) => typeof t === "string"
          )
        ) as Record<string, string>)
      : {};

  const strings = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;

  return {
    docsRoot: typeof o.docsRoot === "string" ? o.docsRoot : DEFAULT_CONFIG.docsRoot,
    version: typeof o.version === "string" ? o.version : DEFAULT_CONFIG.version,
    lint: {
      adopting: typeof lint.adopting === "boolean" ? lint.adopting : DEFAULT_CONFIG.lint.adopting,
      exclude: strings(lint.exclude, DEFAULT_CONFIG.lint.exclude),
      durable: strings(lint.durable, DEFAULT_CONFIG.lint.durable),
      workbench: strings(lint.workbench, DEFAULT_CONFIG.lint.workbench),
      skip: strings(lint.skip, DEFAULT_CONFIG.lint.skip),
      types: typeMap(lint.types),
    },
  };
}

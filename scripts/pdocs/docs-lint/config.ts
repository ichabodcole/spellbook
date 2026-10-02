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
  /**
   * The names a work item's `scope:` may take — one value per item, and only a
   * declared one. A second vocabulary beside `types`, read by the same parser.
   * Empty by default: a project names its own areas.
   */
  scopes: string[];
}

/**
 * Advisory checks: conditions `pdocs` reports and the calling workflow acts on
 * with the user. Separate from `lint`, whose settings decide what the gate
 * fails on.
 */
export interface ChecksConfig {
  archive: {
    /**
     * How many unarchived finished entities of one type — `done`/`dropped`
     * items, `done`/`dropped` features, `closed`/`abandoned` cycles — a live
     * view tolerates before it suggests archiving. The advisory fires when a
     * type's count is strictly GREATER than this. A nonnegative integer; `0`
     * advises whenever any finished work of a type is unarchived.
     */
    threshold: number;
  };
  workItemReview: {
    /**
     * What a work item that needs review does at a start. `warn` (the default)
     * reports it; `strict` refuses a start or a cycle join that would leave an
     * unreviewed item in started work, and `pdocs check` fails on one.
     */
    mode: ReviewMode;
  };
}

/** `checks.workItemReview.mode`'s values. */
export const REVIEW_MODES = ["warn", "strict"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/** `checks.workItemReview.mode` when the setting, or its section, is omitted. */
export const DEFAULT_REVIEW_MODE: ReviewMode = "warn";

/**
 * An explicit setting that failed validation. It is never silently replaced:
 * `pdocs check` reports it as `BAD CONFIG`, and a view that reads the setting
 * reports it as a `bad-config` advisory in place of the advice it would have
 * given. The value in `checks` is the default meanwhile, so nothing reads a
 * half-valid number.
 */
export interface ConfigIssue {
  /** The dotted key: `checks.archive.threshold`. */
  key: string;
  /** What the file holds there. */
  value: unknown;
  /** What it should hold, as a phrase a fix can follow. */
  expected: string;
  /**
   * `unknown-section` on a `checks.<name>` this version does not take. Set
   * where the issue is made, so nothing has to parse `key` back — a section
   * name may itself contain a dot.
   */
  kind?: "unknown-section";
}

/** An issue's value as written in the file. */
export const issueValue = (i: ConfigIssue): string =>
  i.value === undefined ? "undefined" : JSON.stringify(i.value);

/** An issue as one line: `checks.archive.threshold is -1  (expected …)`. */
export const describeIssue = (i: ConfigIssue): string =>
  `${i.key} is ${issueValue(i)}  (expected ${i.expected})`;

export interface ProjectDocsConfig {
  /** Repository-relative path to the documentation root. */
  docsRoot: string;
  /** The scaffold version this project's docs are on. Release-please bumps it. */
  version: string | null;
  lint: LintConfig;
  checks: ChecksConfig;
  /** Explicit `checks` settings that are invalid. Empty when all are valid. */
  issues: ConfigIssue[];
}

/** `checks.archive.threshold` when the setting, or its section, is omitted. */
export const DEFAULT_ARCHIVE_THRESHOLD = 25;

export const DEFAULT_CONFIG: ProjectDocsConfig = {
  docsRoot: "docs",
  version: null,
  lint: {
    adopting: false,
    exclude: [],
    durable: ["architecture", "specifications", "interaction-design", "playbooks"],
    workbench: ["features", "items", "cycles"],
    types: {},
    scopes: [],
    // `_archive` is linted, not skipped: the terminal-state rule (only done
    // or dropped work sits there) has to see it.
    skip: ["superpowers"],
  },
  checks: {
    archive: { threshold: DEFAULT_ARCHIVE_THRESHOLD },
    workItemReview: { mode: DEFAULT_REVIEW_MODE },
  },
  issues: [],
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The `checks` section: each setting, validated, defaulted when omitted, and
 * every invalid explicit value recorded as an issue rather than ignored.
 *
 * Each section is read on its own by its own reader, so a new one is a new
 * entry in `SECTIONS` and nothing else. Both key sets are closed: a misspelt
 * key inside a section is an issue, and so is a section `SECTIONS` does not
 * name. A project carries its own copy of pdocs, and an upgrade moves pdocs
 * and `.project-docs.json` together — a renamed setting is rewritten by that
 * upgrade's migration. So a section this copy does not know is a typo or a
 * version mismatch, and either way the user should hear about it. It changes
 * nothing else: the sections this copy knows are still read.
 */
function readChecks(raw: unknown): { checks: ChecksConfig; issues: ConfigIssue[] } {
  const checks = structuredClone(DEFAULT_CONFIG.checks);
  const issues: ConfigIssue[] = [];
  if (raw === undefined) return { checks, issues };
  if (!isObject(raw)) {
    issues.push({ key: "checks", value: raw, expected: "an object" });
    return { checks, issues };
  }
  for (const [name, read] of Object.entries(SECTIONS)) {
    const section = raw[name];
    if (section === undefined) continue;
    const key = `checks.${name}`;
    if (!isObject(section)) {
      issues.push({ key, value: section, expected: "an object" });
      continue;
    }
    read(section, checks, issues);
  }
  for (const [name, value] of Object.entries(raw))
    // Own keys only: `valueOf`, `constructor` and `__proto__` are not sections.
    if (!Object.hasOwn(SECTIONS, name)) issues.push(unknownSection(name, value));
  return { checks, issues };
}

/** The issue for a `checks.<name>` this version does not know. */
function unknownSection(name: string, value: unknown): ConfigIssue {
  const known = CHECK_SECTIONS;
  // Case-insensitive, then a slip of up to two characters.
  const near = known.find((k) => editDistance(k.toLowerCase(), name.toLowerCase()) <= 2);
  return {
    key: `checks.${name}`,
    value,
    kind: "unknown-section",
    expected:
      `no such section; checks takes ${known.join(", ")}` +
      (near === undefined ? "" : ` — did you mean \`${near}\`?`),
  };
}

/** Levenshtein distance: enough to catch a slip of one or two characters. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    prev = row;
  }
  return prev[b.length] as number;
}

/** One `checks.<name>` section's reader: fills `checks`, records `issues`. */
type SectionReader = (
  section: Record<string, unknown>,
  checks: ChecksConfig,
  issues: ConfigIssue[]
) => void;

/** Unknown keys in a section whose key set is closed. */
function unknownKeys(
  name: string,
  section: Record<string, unknown>,
  known: readonly string[],
  issues: ConfigIssue[]
): void {
  for (const [k, v] of Object.entries(section))
    if (!known.includes(k))
      issues.push({
        key: `checks.${name}.${k}`,
        value: v,
        expected: `no such key; checks.${name} takes ${known.join(", ")}`,
      });
}

const SECTIONS: Record<string, SectionReader> = {
  archive(section, checks, issues) {
    unknownKeys("archive", section, ["threshold"], issues);
    const threshold = section.threshold;
    if (threshold === undefined) return;
    if (typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold >= 0)
      checks.archive.threshold = threshold;
    else
      issues.push({
        key: "checks.archive.threshold",
        value: threshold,
        expected: `a nonnegative integer; omit it for the default, ${DEFAULT_ARCHIVE_THRESHOLD}`,
      });
  },
  workItemReview(section, checks, issues) {
    unknownKeys("workItemReview", section, ["mode"], issues);
    const mode = section.mode;
    if (mode === undefined) return;
    if ((REVIEW_MODES as readonly unknown[]).includes(mode)) checks.workItemReview.mode = mode as ReviewMode;
    else
      issues.push({
        key: "checks.workItemReview.mode",
        value: mode,
        expected: `"warn" or "strict"; omit it for the default, "${DEFAULT_REVIEW_MODE}"`,
      });
  },
};

/** The sections `checks` takes, in the order an issue lists them. */
export const CHECK_SECTIONS: readonly string[] = Object.keys(SECTIONS);

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

  const { checks, issues } = readChecks(o.checks);

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
      scopes: strings(lint.scopes, DEFAULT_CONFIG.lint.scopes),
    },
    checks,
    issues,
  };
}

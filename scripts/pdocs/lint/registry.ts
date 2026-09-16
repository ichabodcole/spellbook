// The type registry: one row per document type, and the three source tables it
// unifies.
//
// Until this file existed the type system was spread across three tables that
// disagreed about what they carried. `SPEC` had `lifecycle` and `extra`;
// `PROJECT_SPEC` had `lifecycle` and no `extra` field at all; `DURABLE_TYPE` and
// `ROOT_PAGE_TYPE` were folder-to-type string maps carrying neither. Every
// reader had to know which table its type came from, and `documentProblems`
// read `extra` from `SPEC` alone — so the eight project-scoped types could not
// declare an extra field even in principle, and nothing said so.
//
// `buildRegistry` is the one place that assembles them, and it is a FUNCTION
// rather than a module-level const on purpose. User-declared folders and types
// (docs/backlog/2026-09-04-user-defined-document-types.md) become a merge step
// inside this function rather than a rewrite of everything that touches the
// tables. It costs nothing now.
//
// The tables themselves live here rather than in `rules.ts` so the dependency
// runs one way: `rules.ts` consumes the registry, the registry consumes
// nothing. `rules.ts` re-exports all five names, because the v2.6-to-v2.7
// codemod's test imports them from there to prove its own copies are equal.

import type { ProjectDocsConfig } from "../docs-lint/config.ts";
import { DEFAULT_CONFIG } from "../docs-lint/config.ts";
// The portable core, and the only direction the dependency may run: `pdocs`
// reads `docs-lint`, never the reverse. `yamlList` is the parser the lint uses
// for every list-valued field, so a validator reads `scope` exactly the way the
// gate would read it.
import { yamlList } from "../docs-lint/index.ts";

// ---------------------------------------------------------------------------------------
// The source tables
// ---------------------------------------------------------------------------------------

/** Library folders, and the `type` each one's pages carry.
 *  Exported: the template test and the v2.6-to-v2.7 codemod read the same map. */
export const DURABLE_TYPE: Record<string, string> = {
  architecture: "architecture",
  specifications: "specification",
  "interaction-design": "interaction",
  playbooks: "playbook",
  "lessons-learned": "lesson",
  memories: "memory",
};

/** Library pages that live at the docs root rather than in a folder. */
export const ROOT_PAGE_TYPE: Record<string, string> = {
  "PROJECT_MANIFESTO.md": "manifesto",
  "PROJECT-SUMMARY.md": "summary",
  "index.md": "index",
};

/**
 * A project folder's type is decided by FILENAME, because a project is one
 * feature's whole record and its documents are of different kinds.
 * Anything unrecognised is an `artifact` — a findings note, a review, a
 * prototype writeup — which is what those files are.
 */
export const PROJECT_FILE_TYPE: Record<string, string> = {
  "proposal.md": "proposal",
  "plan.md": "plan",
  "design-resolution.md": "design-resolution",
  "test-plan.md": "test-plan",
  // A kickoff briefs the START of implementation; a handoff lists what
  // shipping needs AFTER it. Two documents, two types — they were one type
  // until 2026-09-04, when neither file existed to prove otherwise.
  "DEV_KICKOFF.md": "kickoff",
  "handoff.md": "handoff",
};

/**
 * The workbench contract, folder by folder.
 *
 * `lifecycle: null` means the type carries no lifecycle and writing one is an
 * error — a frozen record whose only date is `generated.at`. See SCHEMA.md's
 * "Lifecycle by type" table, which `schemaTableChecks` proves equal to this.
 */
export const SPEC: Record<
  string,
  { type: string; lifecycle: string[] | null; extra?: string[] }
> = {
  // `done` is not in the proposal's vocabulary and should have been. The
  // backlog README describes the real path as open → work it → archive, and
  // "promoted" is the rarer outcome where an item turns out to need a project.
  // Without `done` the common case had no word, which is the same failure that
  // produced `Approved (in flight)` on the proposals.
  backlog: {
    type: "backlog",
    lifecycle: ["open", "done", "promoted", "dropped"],
  },
  fragments: { type: "fragment", lifecycle: ["open", "promoted", "dropped"] },
  briefs: { type: "brief", lifecycle: ["active", "spent"] },
  investigations: { type: "investigation", lifecycle: ["active", "concluded"] },
  cycles: {
    type: "cycle",
    lifecycle: ["planned", "active", "closed", "abandoned"],
    extra: ["scope", "after", "appetite", "started", "closed"],
  },
  reports: { type: "report", lifecycle: null },
};

/** Types a project folder can hold, and their vocabularies. */
export const PROJECT_SPEC: Record<string, { lifecycle: string[] | null }> = {
  proposal: {
    lifecycle: [
      "draft",
      "approved",
      "deferred",
      "implemented",
      "withdrawn",
      "superseded",
    ],
  },
  plan: { lifecycle: ["draft", "active", "completed", "abandoned"] },
  // Both of these were stateless in the first draft of SCHEMA.md, on the
  // reasoning that they follow their proposal or plan. The templates they
  // replace disagreed: each carried its own `**Status:**` line, because a
  // design question is open until it is answered and a scenario list is
  // written before it is run. Dropping those axes would have deleted
  // information the tree already tracked.
  "design-resolution": { lifecycle: ["draft", "resolved", "superseded"] },
  "test-plan": { lifecycle: ["draft", "ready", "active", "completed"] },
  kickoff: { lifecycle: null },
  handoff: { lifecycle: null },
  session: { lifecycle: null },
  artifact: { lifecycle: null },
};

// ---------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------

/**
 * How a type's filename is built.
 *
 * Everything a writer has to remember about naming, stated once. `pdocs new`
 * reads this and nothing else; a type it cannot express is a type the registry
 * has failed to declare, and the fix is a new member here rather than a branch
 * in the command.
 */
export type FilenameShape =
  /**
   * `[YYYY-MM-DD-]<slug>[-<suffix>].md`. `date` says whether a date prefix is
   * written and at what precision — `month` is the cycles convention, and it is
   * a precision rather than a format because that is the only thing that
   * differs.
   */
  | { kind: "slug"; date: "day" | "month" | "none"; suffix?: string }
  /**
   * `NN-<slug>.md` — a numbered prefix giving reading order. The next number is
   * the highest already in the folder plus one, zero-padded to two.
   */
  | { kind: "numbered" }
  /** One name, always: the type is a singleton wherever it lives. */
  | { kind: "fixed"; name: string }
  /** No grammar at all — whatever the writer names it. Never creatable. */
  | { kind: "freeform" };

/**
 * One document type, completely.
 *
 * `scope` decides how `folder` is read, and it is the only thing a caller has
 * to switch on — never the type name.
 */
export interface RegistryRow {
  type: string;
  /** Which tier's obligations the document carries. See SCHEMA.md. */
  tier: "library" | "workbench";
  /**
   * `docs` — `folder` is docs-root-relative.
   * `project` — the document lives under `projects/<project>/`, and `folder` is
   *   relative to THAT: `""` for the fixed-name project documents, `sessions`
   *   for a session, `artifacts` for an artifact.
   * `root` — a singleton at the docs root; `folder` is `""`.
   */
  scope: "docs" | "project" | "root";
  /** See `scope`. Empty for root pages and for the fixed project documents. */
  folder: string;
  filename: FilenameShape;
  /**
   * Repository-root-relative template path(s). `null` = no template exists.
   * An array is a variant set, chosen by `--variant` — `specification` is the
   * only one today.
   */
  template: string | string[] | null;
  /**
   * True when `template` names a path outside the documentation tree that this
   * repository need not contain. Only `kickoff`: its template ships with the
   * `dev-kickoff` plugin skill, and a generated project has no `plugins/`
   * directory at all. `templateProblems` skips these, because a check that
   * fails on every scaffolded project is a check that gets deleted.
   */
  externalTemplate: boolean;
  /** The `lifecycle` vocabulary, or `null` for a frozen record. */
  lifecycle: string[] | null;
  /** Frontmatter keys beyond REQUIRED + OPTIONAL + `lifecycle`. */
  extra: string[];
  /** Whether `pdocs new` will create one. */
  creatable: boolean;
  /** Why not, when `creatable` is false. This string is what `new` tells the caller. */
  uncreatableReason?: string;
  /**
   * Invariants this type has that the FILESYSTEM cannot express.
   *
   * "The file is not already there" is universal and lives in `new`; this is
   * for the rest. `cycle` is the only row that declares one today, and it
   * declares two: a `scope` entry must name a document that exists, and opening
   * a second `active` cycle is the state a cycle exists to prevent.
   *
   * Runs after the frontmatter is resolved and BEFORE anything is written, so a
   * refusal leaves the tree exactly as it was. `new` calls `row.validate?.(…)`
   * without knowing which type it is holding.
   */
  validate?: Validator;
}

// ---------------------------------------------------------------------------------------
// Pre-write validation
// ---------------------------------------------------------------------------------------

/** A document that is already in the tree, as a validator needs to see it. */
export interface ExistingDocument {
  /** Repo-relative. */
  path: string;
  /**
   * EVERY address this document answers to, and empty where it answers to none.
   *
   * A list rather than one `key`, because a document can be addressed in more
   * than one vocabulary and the project folder proves it: `pages.ts` keys a
   * proposal as `proposal/proposal` — true, useless, identical for every
   * project — and as `project/<folder>`, which is the form the cycle template,
   * the migration guide and `pdocs new project` all use. A validator matching
   * against a single key could only ever accept the useless one.
   */
  keys: string[];
  /** The type the document's POSITION says it carries. */
  type: string;
  lifecycle: string | null;
}

/**
 * What a validator is handed: the document as it is ABOUT to be written, and
 * the tree as it stands.
 *
 * `fields` rather than the raw flags, deliberately. A predicate that read
 * `--lifecycle` would be blind to a template that ships `lifecycle: active` of
 * its own, and the invariant is about the document, not about how the caller
 * happened to spell it.
 */
export interface ValidationInput {
  /** The row's own `type`, so a predicate never has to name itself. */
  type: string;
  /** The frontmatter about to be written, parsed. */
  fields: ReadonlyMap<string, string>;
  documents: readonly ExistingDocument[];
}

/**
 * `usage` — the invocation named something wrong and retrying it unchanged will
 * fail identically. `conflict` — the invocation is well-formed and the tree is
 * in a state this document may not be added to.
 */
export interface ValidationProblem {
  kind: "usage" | "conflict";
  message: string;
}

export type Validator = (input: ValidationInput) => ValidationProblem[];

// ---------------------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------------------

/**
 * A name a caller may type that is not itself a type.
 *
 * `pdocs new project oauth-upgrade` is the grammar the design resolution
 * approved, and a project is not a document — it is a FOLDER whose first
 * document is a `proposal`. That is data, not a branch: the alias says which
 * row the name resolves to and that the positional names the scope owner rather
 * than the document's slug, and `new` reads both without knowing the word
 * "project".
 */
export interface TypeAlias {
  /** The registry row this name resolves to. */
  type: string;
  /**
   * True when the positional `<name>` names the SCOPE OWNER — the project
   * folder — instead of the document's own slug, and `new` creates that folder
   * rather than requiring it to exist. Only meaningful on a row whose `scope`
   * is `project`, whose slug is fixed anyway.
   */
  namesScope: boolean;
}

export const TYPE_ALIAS: Record<string, TypeAlias> = {
  project: { type: "proposal", namesScope: true },
};

/**
 * The folder that holds project folders.
 *
 * Not derived from `lint.workbench` — that array says which folders are linted
 * as workbench, not which one is the project tree, and reading a position out
 * of it would break the moment somebody reorders their config.
 */
export const PROJECTS_FOLDER = "projects";

// ---------------------------------------------------------------------------------------
// Building it
// ---------------------------------------------------------------------------------------

/**
 * The part of a row that is not in any source table: where the file goes, what
 * it is called, and which template seeds it.
 *
 * Everything else — tier, lifecycle, extra, and every fixed filename — is
 * derived below from `SPEC`, `PROJECT_SPEC`, `DURABLE_TYPE`, `ROOT_PAGE_TYPE`
 * and `PROJECT_FILE_TYPE`, so a change to one of those cannot leave the
 * registry stating something else.
 */
type Creation = {
  filename: FilenameShape;
  /** Docs-root-relative, joined with `config.docsRoot` below. `null` = none. */
  template: string | string[] | null;
  /** Set only where the template is not under the docs root. */
  externalTemplate?: boolean;
  uncreatableReason?: string;
};

/**
 * Filename grammar and template per type, verified against the folder READMEs
 * and against the tree.
 *
 * `architecture`'s README offers `-architecture` OR `-flow` for a file that
 * documents a flow rather than a system. Only `-architecture` is declared: that
 * folder is empty in this repository, so a variant mechanism for it would be
 * inventing a convention rather than recording one. Add the second member the
 * day a real file needs it.
 */
const CREATION: Record<string, Creation> = {
  // Workbench, dated.
  backlog: { filename: { kind: "slug", date: "day" }, template: "backlog/TEMPLATE.md" },
  fragment: { filename: { kind: "slug", date: "day" }, template: "fragments/TEMPLATE.md" },
  brief: {
    filename: { kind: "slug", date: "day" },
    template: "briefs/TEMPLATES/BRIEF.template.md",
  },
  investigation: {
    filename: { kind: "slug", date: "day", suffix: "investigation" },
    template: "investigations/YYYY-MM-DD-TEMPLATE-investigation.md",
  },
  report: {
    filename: { kind: "slug", date: "day", suffix: "report" },
    template: "reports/YYYY-MM-DD-TEMPLATE-report.md",
  },
  // A cycle is named for the month it runs in, not the day it opened.
  cycle: { filename: { kind: "slug", date: "month" }, template: "cycles/TEMPLATE.md" },

  // Library folders.
  architecture: {
    filename: { kind: "slug", date: "none", suffix: "architecture" },
    template: "architecture/TEMPLATE.md",
  },
  interaction: {
    filename: { kind: "slug", date: "none", suffix: "flow" },
    template: "interaction-design/TEMPLATE.md",
  },
  playbook: {
    filename: { kind: "slug", date: "none", suffix: "playbook" },
    template: "playbooks/TEMPLATE.md",
  },
  lesson: {
    filename: { kind: "slug", date: "none" },
    template: "lessons-learned/TEMPLATE.md",
  },
  memory: { filename: { kind: "slug", date: "day" }, template: "memories/TEMPLATE.md" },
  specification: {
    filename: { kind: "numbered" },
    template: [
      "specifications/TEMPLATE-overview.md",
      "specifications/TEMPLATE-domain.md",
    ],
  },

  // Root pages. Two of the three ship in every generated scaffold, so `new`
  // could only ever collide with a file that is already there.
  manifesto: {
    filename: { kind: "fixed", name: "PROJECT_MANIFESTO.md" },
    template: null,
    uncreatableReason:
      "the scaffold ships PROJECT_MANIFESTO.md; the project-manifesto skill fills it in",
  },
  summary: {
    filename: { kind: "fixed", name: "PROJECT-SUMMARY.md" },
    template: null,
    uncreatableReason:
      "PROJECT-SUMMARY.md is synthesized from the whole repository by the project-summary skill",
  },
  index: {
    filename: { kind: "fixed", name: "index.md" },
    template: null,
    uncreatableReason: "the scaffold ships index.md; entries are added to it, not the file",
  },

  // Project-scoped. The filenames come from `PROJECT_FILE_TYPE` below.
  proposal: { filename: fixedProjectFile("proposal"), template: "projects/TEMPLATES/PROPOSAL.template.md" },
  plan: { filename: fixedProjectFile("plan"), template: "projects/TEMPLATES/PLAN.template.md" },
  "design-resolution": {
    filename: fixedProjectFile("design-resolution"),
    template: "projects/TEMPLATES/DESIGN-RESOLUTION.template.md",
  },
  "test-plan": {
    filename: fixedProjectFile("test-plan"),
    template: "projects/TEMPLATES/TEST-PLAN.template.md",
  },
  handoff: {
    filename: fixedProjectFile("handoff"),
    template: "projects/TEMPLATES/HANDOFF.template.md",
  },
  kickoff: {
    filename: fixedProjectFile("kickoff"),
    // Outside the docs tree, and outside the cookiecutter payload: a generated
    // project has no `plugins/` directory. The row exists so the lint can type
    // `DEV_KICKOFF.md`; the `dev-kickoff` skill owns creating it.
    template:
      "plugins/project-docs/skills/dev-kickoff/templates/DEV_KICKOFF.template.md",
    externalTemplate: true,
    uncreatableReason:
      "its template ships with the dev-kickoff plugin skill, outside the docs tree, where pdocs cannot reach it",
  },
  session: {
    filename: { kind: "slug", date: "day" },
    template: "projects/TEMPLATES/YYYY-MM-DD-SESSION.template.md",
  },
  artifact: {
    filename: { kind: "freeform" },
    template: null,
    uncreatableReason:
      "an artifact is freeform by design — it has no filename grammar and no template",
  },
};

/**
 * The pre-write invariants, per type.
 *
 * One entry today. It is a table rather than a field on `CREATION` because
 * `CREATION` is about naming and seeding a file and this is about the corpus —
 * and because a reader looking for "what can refuse a `pdocs new`" should find
 * every answer in one place.
 */
const VALIDATION: Record<string, Validator> = {
  // Both halves of the proposal's success criterion: "`pdocs new cycle`
  // refuses to open a second active cycle, and refuses a scope entry that does
  // not resolve."
  //
  // `scope` is checked against the same `type/slug` vocabulary `related:` uses,
  // so a cycle cannot open over work the tree does not contain — which is the
  // failure that makes a cycle index worse than no index. The lint has no
  // opinion on `scope` after the fact: it is an `extra` field and nothing
  // resolves it, so this is the only gate it gets.
  cycle: ({ type, fields, documents }) => {
    const problems: ValidationProblem[] = [];

    const byKey = new Map<string, string[]>();
    for (const d of documents)
      for (const key of d.keys)
        byKey.set(key, [...(byKey.get(key) ?? []), d.path]);

    for (const entry of yamlList(fields.get("scope"))) {
      const matches = byKey.get(entry) ?? [];
      if (matches.length === 0)
        problems.push({
          kind: "usage",
          message:
            `--scope: \`${entry}\` matches no document (expected \`project/<name>\` ` +
            `for a project, or \`type/slug\` — e.g. \`backlog/2026-09-04-a-thing\`). ` +
            `A cycle over work that is not there is worse than no cycle.`,
        });
      // A key that names several documents is not scope, it is a category.
      // `proposal/proposal` is the one that turns up in practice: every project
      // folder holds a `proposal.md`, so the key matches all of them and
      // identifies none. `project/<name>` is what the caller meant.
      else if (matches.length > 1)
        problems.push({
          kind: "usage",
          message:
            `--scope: \`${entry}\` names ${matches.length} documents ` +
            `(${matches.slice(0, 3).join(", ")}${matches.length > 3 ? ", …" : ""}) — ` +
            `it identifies none of them. Name a project as \`project/<name>\`.`,
        });
    }

    if (fields.get("lifecycle") === "active") {
      const open = documents.filter(
        (d) => d.type === type && d.lifecycle === "active"
      );
      if (open.length)
        problems.push({
          kind: "conflict",
          message:
            `${open.map((d) => d.path).join(", ")} is already \`lifecycle: active\` — ` +
            `at most one ${type} is active at a time. Close it first, or create this ` +
            `one \`planned\`.`,
        });
    }

    return problems;
  },
};

/** The fixed name `PROJECT_FILE_TYPE` already states for this type. */
function fixedProjectFile(type: string): FilenameShape {
  const entry = Object.entries(PROJECT_FILE_TYPE).find(([, t]) => t === type);
  if (!entry)
    throw new Error(`registry: no PROJECT_FILE_TYPE entry names \`${type}\``);
  return { kind: "fixed", name: entry[0] };
}

/** Where a project-scoped type sits INSIDE its project folder. */
const PROJECT_SUBFOLDER: Record<string, string> = {
  session: "sessions",
  artifact: "artifacts",
};

/**
 * Every document type, as one list.
 *
 * Order is stable and deliberate: library folders, root pages, workbench
 * folders, then project-scoped — the order SCHEMA.md's table uses, so a reader
 * comparing the two is not also diffing an ordering.
 */
export function buildRegistry(config: ProjectDocsConfig): RegistryRow[] {
  const rows: RegistryRow[] = [];

  const creation = (type: string): Creation => {
    const c = CREATION[type];
    if (!c) throw new Error(`registry: no filename or template declared for \`${type}\``);
    return c;
  };

  /** Docs-root-relative template paths become repository-relative here — the
   *  one place `config.docsRoot` enters the registry. */
  const resolveTemplate = (c: Creation): string | string[] | null => {
    if (c.template === null) return null;
    if (c.externalTemplate) return c.template;
    const under = (p: string) => `${config.docsRoot}/${p}`;
    return Array.isArray(c.template)
      ? c.template.map(under)
      : under(c.template);
  };

  const push = (
    type: string,
    tier: RegistryRow["tier"],
    scope: RegistryRow["scope"],
    folder: string,
    lifecycle: string[] | null,
    extra: string[]
  ): void => {
    const c = creation(type);
    rows.push({
      type,
      tier,
      scope,
      folder,
      filename: c.filename,
      template: resolveTemplate(c),
      externalTemplate: c.externalTemplate === true,
      lifecycle,
      extra,
      creatable: c.uncreatableReason === undefined,
      ...(c.uncreatableReason === undefined
        ? {}
        : { uncreatableReason: c.uncreatableReason }),
      ...(VALIDATION[type] === undefined
        ? {}
        : { validate: VALIDATION[type] }),
    });
  };

  // Library folders. `DURABLE_TYPE` is a folder-to-type map and carries no
  // lifecycle, because a living page is current or it is not.
  for (const [folder, type] of Object.entries(DURABLE_TYPE))
    push(type, "library", "docs", folder, null, []);

  // Root pages: singletons at a fixed path, no folder, no template.
  for (const type of Object.values(ROOT_PAGE_TYPE))
    push(type, "library", "root", "", null, []);

  // Workbench folders.
  for (const [folder, spec] of Object.entries(SPEC))
    push(spec.type, "workbench", "docs", folder, spec.lifecycle, spec.extra ?? []);

  // Project-scoped. `PROJECT_SPEC` has no `extra` field at all — which is
  // exactly why this registry exists — so every one of these declares `[]`
  // here rather than being unable to declare anything.
  for (const [type, spec] of Object.entries(PROJECT_SPEC))
    push(
      type,
      "workbench",
      "project",
      PROJECT_SUBFOLDER[type] ?? "",
      spec.lifecycle,
      []
    );

  // Folders this project declared in `.project-docs.json`. The scaffold ships
  // no template for them, so they are lintable but not creatable — the same
  // shape the root pages already use. A declaration that collides with a
  // built-in folder or type is ignored: the scaffold's own row wins.
  for (const [folder, type] of Object.entries(config.lint.types)) {
    if (rows.some((r) => r.folder === folder || r.type === type)) continue;
    rows.push({
      type,
      // The LINT's rule, not the inverse of it: `graphTier` skips `workbench`
      // and `skip`, so everything else is library. Choosing on `durable`
      // membership instead registered a folder listed in neither array as
      // workbench while the lint held it to the catalog obligation.
      tier: config.lint.workbench.includes(folder) ? "workbench" : "library",
      scope: "docs",
      folder,
      filename: { kind: "slug", date: "none" },
      template: null,
      externalTemplate: false,
      lifecycle: null,
      extra: [],
      creatable: false,
      uncreatableReason: `\`${type}\` is declared in this project's .project-docs.json; the scaffold ships no template for it`,
    });
  }

  return rows;
}

/** The registry keyed by type, for the readers that look one row up at a time. */
export function registryIndex(
  config: ProjectDocsConfig
): Map<string, RegistryRow> {
  return new Map(buildRegistry(config).map((row) => [row.type, row]));
}

/**
 * The index a caller gets when it has no config to hand.
 *
 * Only `lifecycle` and `extra` are read through this, and neither depends on
 * configuration — `docsRoot` reaches nothing but the template paths. Built once
 * because `documentProblems` is called per document.
 */
let defaults: Map<string, RegistryRow> | null = null;
export function defaultRegistryIndex(): Map<string, RegistryRow> {
  defaults ??= registryIndex(DEFAULT_CONFIG);
  return defaults;
}

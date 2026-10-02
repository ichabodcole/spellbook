// Advisories: conditions a view REPORTS and the calling workflow acts on with
// the user. An advisory never changes what a view lists, never writes, and
// never fails the command — the view exits 0 with it attached.
//
// Every advisory has the same outer shape, so a caller handles them in one
// place: a stable `id` to branch on, a `message` that says what is the case,
// and an `action` that says what to do next. Each kind adds its own fields
// beside those. Settings live under `checks` in `.project-docs.json`.
//
// The archive advisory is the first. One threshold (`checks.archive.threshold`,
// default 25) is held against each type a view lists, counted on its own:
// unarchived `done`/`dropped` items, unarchived `done`/`dropped` features, and
// unarchived `closed`/`abandoned` cycles. A type over the threshold — strictly
// greater — is named; a view gets ONE advisory naming every such type, never a
// warning per entity.
//
// A setting a view reads that is INVALID never takes the view down: the view
// lists as usual and carries a `bad-config` advisory, naming the key, the value
// and what was expected, in place of the advice it could not compute.

import {
  CONFIG_FILENAME,
  type ConfigIssue,
  type ReviewMode,
  issueValue,
} from "./docs-lint/config.ts";
import { CYCLE_ENDS } from "./lint/registry.ts";
import type { Ctx } from "./lint/rules.ts";
import type { WorkEntity, WorkModel } from "./work.ts";

/** What every advisory carries. */
export interface Advisory {
  /** Stable and machine-readable: branch on this, never on `message`. */
  id: string;
  /** What is the case, in one or two sentences. */
  message: string;
  /** What to do about it. */
  action: string;
  /**
   * The references a caller can act on — `item/<slug>`, `feature/<slug>`,
   * `cycle/<slug>` — when the advisory is about particular entities, or the
   * repo-relative paths when it is about particular files (`template-header`).
   * The one field a caller reads to know WHICH, whatever the advisory's kind.
   */
  refs?: string[];
}

/** The `bad-config` advisory's `id`. */
export const BAD_CONFIG_ADVISORY = "bad-config";

/** An invalid setting a view needed, reported instead of the advice it feeds. */
export interface BadConfigAdvisory extends Advisory {
  id: typeof BAD_CONFIG_ADVISORY;
  /** Each invalid setting: its dotted `key`, the `value` written, and what is `expected`. */
  issues: ConfigIssue[];
}

/** The archive advisory's `id`. */
export const ARCHIVE_ADVISORY = "archive-threshold";

/** The setting the archive advisory reads. */
export const ARCHIVE_SETTING = "checks.archive.threshold";

type Entity = WorkEntity["entity"];

/** The lifecycles that count as finished, per type: what `_archive/` may hold. */
export const FINISHED: Readonly<Record<Entity, readonly string[]>> = {
  item: ["done", "dropped"],
  feature: ["done", "dropped"],
  cycle: CYCLE_ENDS,
};

/** Why archiving helps, as a view that lists finished work says it. The default. */
export const ARCHIVE_WHY_LIVE = "Consider archiving them to shorten this view.";

/** Why archiving helps, as a view that already leaves finished work out says it
 *  (`view portfolio`): the view is short already, and its `--all` lists past
 *  work archived or not — what archiving still shortens is the live folders. */
export const ARCHIVE_WHY_HIDDEN =
  "This view already leaves them out; archiving moves them out of the live folders.";

/** How a view words the archive advisory. */
export interface ArchiveWording {
  /** The sentence saying why archiving helps here. Defaults to `ARCHIVE_WHY_LIVE`. */
  why?: string;
}

/** One type over the threshold. */
export interface ArchiveTypeCount {
  type: Entity;
  /** Unarchived entities of this type in a finished lifecycle. */
  count: number;
  threshold: number;
  /** The lifecycles counted. */
  lifecycles: string[];
  /** The next action for this type, as prose. */
  remediation: string;
  /**
   * The references `pdocs archive` takes, oldest first: what a selection is
   * chosen from. Data for the caller; the text rendering never lists them.
   */
  candidates: string[];
}

export interface ArchiveAdvisory extends Advisory {
  id: typeof ARCHIVE_ADVISORY;
  /** Every type's `candidates`, in type order. */
  refs: string[];
  setting: typeof ARCHIVE_SETTING;
  threshold: number;
  /** Every type over the threshold, in the order the view asked for them. */
  types: ArchiveTypeCount[];
}

const list: Record<Entity, (m: WorkModel) => WorkEntity[]> = {
  item: (m) => m.items,
  feature: (m) => m.features,
  cycle: (m) => m.cycles,
};

const plural = (type: Entity, n: number) => `${n} finished ${type}${n === 1 ? "" : "s"}`;

/** `a`, `a and b`, `a, b and c`. */
const joined = (parts: string[]): string =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** Oldest first by `generated.at`, then path — the order a selection reads in. */
const oldestFirst = (a: WorkEntity, b: WorkEntity): number => {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(a.date ?? "9999-99-99", b.date ?? "9999-99-99") || cmp(a.path, b.path);
};

/** Unarchived entities of `type` in a finished lifecycle. */
export function unarchivedFinished(model: WorkModel, type: Entity): WorkEntity[] {
  const finished = FINISHED[type];
  return list[type](model).filter(
    (e) => !e.archived && e.lifecycle !== null && finished.includes(e.lifecycle)
  );
}

/**
 * The archive advisory for the types a view lists, or `null` when none is over
 * `threshold`. Pure: a function of the model, so a UI gets exactly what the
 * CLI prints.
 */
export function archiveAdvisory(
  model: WorkModel,
  types: readonly Entity[],
  threshold: number,
  wording: ArchiveWording = {}
): ArchiveAdvisory | null {
  const over: ArchiveTypeCount[] = [];
  for (const type of types) {
    const finished = unarchivedFinished(model, type).sort(oldestFirst);
    if (finished.length <= threshold) continue;
    over.push({
      type,
      count: finished.length,
      threshold,
      lifecycles: [...FINISHED[type]],
      remediation:
        `Choose which of the ${plural(type, finished.length)} to archive, confirm that selection ` +
        `with the user, then run \`pdocs archive ${type}/<slug>\` for each.`,
      candidates: finished.map((e) => `${type}/${e.slug}`),
    });
  }
  if (over.length === 0) return null;
  const counts = joined(over.map((t) => plural(t.type, t.count)));
  return {
    id: ARCHIVE_ADVISORY,
    setting: ARCHIVE_SETTING,
    threshold,
    message:
      `${counts} ${over.length === 1 && over[0]!.count === 1 ? "is" : "are"} not archived, ` +
      `over the threshold of ${threshold} (${ARCHIVE_SETTING}). ` +
      `${wording.why ?? ARCHIVE_WHY_LIVE} Archiving preserves their records and updates links.`,
    action:
      "Offer the user a concrete selection, then run `pdocs archive <ref>` for each one they agree to; " +
      "`--format json` lists the candidates. Nothing is archived automatically.",
    refs: over.flatMap((t) => t.candidates),
    types: over,
  };
}

/** The issues that make `checks.<name>` unreadable: its own, or a `checks`
 *  that is not an object at all. */
const sectionIssues = (issues: readonly ConfigIssue[], name: string) =>
  issues.filter(
    (i) =>
      i.kind !== "unknown-section" &&
      (i.key === "checks" || i.key === `checks.${name}` || i.key.startsWith(`checks.${name}.`))
  );

/** What happens meanwhile, by what an invalid setting belongs to. */
const MEANWHILE = {
  archive: "until then the advice it governs is not computed.",
  workItemReview:
    "until then the work item review advice is still given, under the default policy, `warn`.",
  both:
    "until then the archive advice is not computed, and the work item review advice is still " +
    "given under the default policy, `warn`.",
  /** A `checks` section this version does not know, and nothing else wrong. */
  unknown: "until then it is ignored, and the sections this version knows still apply.",
} as const;

/** The same, after another section's promise. */
const UNKNOWN_TAIL = "A `checks` section this version does not know is ignored; the ones it knows still apply.";

/** What an invalid setting belongs to. */
type BadConfigKind = "archive" | "workItemReview" | "unknown";

/** The promise for every kind present, as one clause. */
function meanwhileFor(kinds: ReadonlySet<BadConfigKind>): string {
  const archive = kinds.has("archive");
  const review = kinds.has("workItemReview");
  const base =
    archive && review ? MEANWHILE.both : archive ? MEANWHILE.archive : review ? MEANWHILE.workItemReview : null;
  if (base === null) return MEANWHILE.unknown;
  return kinds.has("unknown") ? `${base} ${UNKNOWN_TAIL}` : base;
}

/** What each `bad-config` advisory was made for, so a merge keeps every promise. */
const KINDS = new WeakMap<Advisory, ReadonlySet<BadConfigKind>>();

const badConfigAction = (n: number, meanwhile: string) =>
  `Fix or remove ${n === 1 ? "that setting" : "those settings"} in ${CONFIG_FILENAME}; ` +
  `${meanwhile} \`pdocs check\` reports it as BAD CONFIG.`;

/**
 * The `bad-config` advisory for `issues`, or `null` when there are none.
 * Not a refusal: a read-only view stays usable whatever the file says, and
 * `pdocs check` reports the same issues as `BAD CONFIG`. `kind` says what
 * the action promises meanwhile: the archive advice is not computed; the
 * review advice is, under the default policy; an unknown section is ignored.
 */
export function badConfigAdvisory(
  issues: readonly ConfigIssue[],
  kind: BadConfigKind = "archive"
): BadConfigAdvisory | null {
  if (issues.length === 0) return null;
  const advisory: BadConfigAdvisory = {
    id: BAD_CONFIG_ADVISORY,
    message: issues
      .map(
        (i) =>
          `${CONFIG_FILENAME}: \`${i.key}\` is ${issueValue(i)}, expected ${i.expected}` +
          // A suggestion already ends its sentence: "did you mean `x`?".
          (i.expected.endsWith("?") ? "" : ".")
      )
      .join(" "),
    action: badConfigAction(issues.length, meanwhileFor(new Set([kind]))),
    issues: issues.map((i) => ({ ...i })),
  };
  KINDS.set(advisory, new Set([kind]));
  return advisory;
}

/**
 * Issues naming a `checks` section this version does not know. They take no
 * advice down — the sections it knows are read as usual — but every view that
 * reads `checks` reports them.
 */
const unknownSectionIssues = (issues: readonly ConfigIssue[]) =>
  issues.filter((i) => i.kind === "unknown-section");

/** The `bad-config` advisory for unknown sections, as a list. */
const adviseUnknownSections = (ctx: Ctx): Advisory[] => {
  const bad = badConfigAdvisory(unknownSectionIssues(ctx.config.issues), "unknown");
  return bad ? [bad] : [];
};

/**
 * What a view attaches as `advisories` for archiving the `types` it lists:
 * the archive advisory, or nothing, or — when `checks.archive` is invalid —
 * the `bad-config` advisory in its place. The one call a view makes.
 */
export function adviseArchive(
  ctx: Ctx,
  model: WorkModel,
  types: readonly Entity[],
  wording: ArchiveWording = {}
): Advisory[] {
  const unknown = adviseUnknownSections(ctx);
  const bad = badConfigAdvisory(sectionIssues(ctx.config.issues, "archive"));
  if (bad) return combineAdvisories([bad], unknown);
  const advisory = archiveAdvisory(model, types, ctx.config.checks.archive.threshold, wording);
  return [...unknown, ...(advisory ? [advisory] : [])];
}

// ---------------------------------------------------------------------------------------
// The review advisory
// ---------------------------------------------------------------------------------------
//
// A work item's `status` says whether its own content — the description and
// definition of done — has been reviewed: `draft` until a person has, `stable`
// once they approve it. Work should not start on content nobody has approved.
//
// THE RULE, stated once: an unarchived item whose `status` is not `stable`
// (`draft`, `deprecated`, missing or invalid) is a VIOLATION when it is
//
//   - `started`: `active` or `review`, in a cycle or not; or
//   - `active-cycle`: unstarted (`triage`, `backlog`, `ready`) and a member of
//     the `active` cycle.
//
// Finished items (`done`, `dropped`) never are: old finished drafts are the
// audit's (`pdocs view unreviewed`), not every run's. Members of a `planned`
// cycle are not either: preparing a cycle is drafting.
//
// A read-only view that lists what is about to start (`view ready`, a planned
// cycle) also reports its unreviewed unstarted items as `on-start`: not a
// violation, never counted by `pdocs check`, never refused — a prompt to review
// before the start rather than after it.
//
// `checks.workItemReview.mode` decides what a violation does. `warn` (the
// default) reports it everywhere. `strict` also refuses a `set` or `new` that
// INTRODUCES one — evaluated on the proposed state, so a start that carries
// `--status stable` succeeds — and fails `pdocs check` on every one. A change
// that leaves an existing violation as it was, or repairs it, is never refused.

/** The review advisory's `id`. */
export const REVIEW_ADVISORY = "work-item-review";

/** The setting the review advisory reads. */
export const REVIEW_SETTING = "checks.workItemReview.mode";

/** The one status that counts as reviewed. `deprecated` does not. */
export const REVIEWED_STATUS = "stable";

/** Why an item is in the review advisory. */
export type ReviewReason = "started" | "active-cycle" | "on-start";

/** The reasons, in the order a message names them. */
const REVIEW_REASONS: readonly ReviewReason[] = ["started", "active-cycle", "on-start"];

/** How a message names the items with each reason. */
const REASON_PHRASE: Record<ReviewReason, string> = {
  started: "started",
  "active-cycle": "in the active cycle",
  "on-start": "not started yet",
};

/** One item that needs review. */
export interface ReviewItem {
  /** `item/<slug>`. */
  ref: string;
  path: string;
  status: string | null;
  lifecycle: string | null;
  cycle: string | null;
  reason: ReviewReason;
}

export interface ReviewAdvisory extends Advisory {
  id: typeof REVIEW_ADVISORY;
  setting: typeof REVIEW_SETTING;
  /** The effective policy. */
  mode: ReviewMode;
  /** Every item's `ref`. */
  refs: string[];
  items: ReviewItem[];
}

/** The slugs of the cycles that are `active` (and live). */
export const activeCycles = (model: WorkModel): Set<string> =>
  new Set(model.cycles.filter((c) => !c.archived && c.lifecycle === "active").map((c) => c.slug));

/**
 * Why `item` violates the review rule, or `null` when it does not. `active`
 * defaults to the model's active cycles; pass it when asking about many items.
 */
export function reviewViolation(
  model: WorkModel,
  item: WorkEntity,
  active: ReadonlySet<string> = activeCycles(model)
): "started" | "active-cycle" | null {
  if (item.archived || item.status === REVIEWED_STATUS) return null;
  if (item.group === "started") return "started";
  if (item.group === "unstarted" && item.cycle !== null && active.has(item.cycle)) return "active-cycle";
  return null;
}

const reviewItem = (e: WorkEntity, reason: ReviewReason): ReviewItem => ({
  ref: `item/${e.slug}`,
  path: e.path,
  status: e.status,
  lifecycle: e.lifecycle,
  cycle: e.cycle,
  reason,
});

/**
 * The review findings among `items` — work items; a caller hands it nothing
 * else. A violation is always one; with
 * `prospective`, an unreviewed unstarted item is one too, as `on-start`.
 */
export function reviewItems(
  model: WorkModel,
  items: readonly WorkEntity[],
  opts: { prospective?: boolean } = {}
): ReviewItem[] {
  const active = activeCycles(model);
  const out: ReviewItem[] = [];
  for (const e of items) {
    const v = reviewViolation(model, e, active);
    if (v) out.push(reviewItem(e, v));
    else if (
      opts.prospective &&
      !e.archived &&
      e.group === "unstarted" &&
      e.status !== REVIEWED_STATUS
    )
      out.push(reviewItem(e, "on-start"));
  }
  return out;
}

/** Every violation in the tree, in path order. */
export const reviewViolations = (model: WorkModel): ReviewItem[] => reviewItems(model, model.items);

/** How one item reads in a message: `item/x (draft, ready in active cycle c)`. */
export function describeReviewItem(i: ReviewItem): string {
  const status = i.status ?? "no status";
  const where =
    i.reason === "active-cycle"
      ? `${i.lifecycle ?? "no lifecycle"} in active cycle ${i.cycle}`
      : (i.lifecycle ?? "no lifecycle");
  return `${i.ref} (${status}, ${where})`;
}

/** At most `max` items named, then `and N more`. */
function named(items: readonly ReviewItem[], max = 5): string {
  const shown = items.slice(0, max).map(describeReviewItem);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : joined(shown);
}

/** What to do about an item that needs review. One sentence for every touch point. */
export const REVIEW_ACTION =
  "Show the user each item's description and definition of done; once they approve that content " +
  "(approval already given in this conversation counts), run `pdocs set item/<slug> --status stable`, " +
  "on its own or in the same command as the start. Never set it without that review.";

/**
 * The review advisory over `items`, or `null` when there are none. Pure, like
 * the archive advisory: what a UI gets is what the CLI prints.
 */
export function reviewAdvisory(items: readonly ReviewItem[], mode: ReviewMode): ReviewAdvisory | null {
  if (items.length === 0) return null;
  const n = items.length;
  // Said so it is true of every item named: started, in the active cycle, or
  // only about to start.
  const where = REVIEW_REASONS.filter((r) => items.some((i) => i.reason === r)).map((r) => REASON_PHRASE[r]);
  const kinds = where.length < 2 ? (where[0] ?? "") : `${where.slice(0, -1).join(", ")} or ${where.at(-1)}`;
  return {
    id: REVIEW_ADVISORY,
    setting: REVIEW_SETTING,
    mode,
    message:
      `${n} item${n === 1 ? "" : "s"} ${kinds} ${n === 1 ? "has" : "have"} no reviewed document ` +
      `(\`status: ${REVIEWED_STATUS}\`): ${named(items)}.`,
    action:
      mode === "strict"
        ? `${REVIEW_ACTION} Strict (${REVIEW_SETTING}): a start or a join to the active cycle that leaves an item unreviewed is refused, and \`pdocs check\` fails on every item started or in the active cycle without one.`
        : REVIEW_ACTION,
    refs: items.map((i) => i.ref),
    items: [...items],
  };
}

/**
 * What a view or command attaches for the review findings `items`: the review
 * advisory, and — when `checks.workItemReview` is invalid — a `bad-config`
 * advisory beside it. Unlike archiving, the advice does not depend on the
 * setting, so it is still given, under the default policy.
 */
export function adviseReview(ctx: Ctx, items: readonly ReviewItem[]): Advisory[] {
  const bad = badConfigAdvisory(sectionIssues(ctx.config.issues, "workItemReview"), "workItemReview");
  const out = combineAdvisories(bad ? [bad] : [], adviseUnknownSections(ctx));
  const advisory = reviewAdvisory(items, ctx.config.checks.workItemReview.mode);
  if (advisory) out.push(advisory);
  return out;
}

// ---------------------------------------------------------------------------------------
// The template-header advisory
// ---------------------------------------------------------------------------------------
//
// Every template opens with a header comment whose first line is
// `OWNERSHIP (of this template file`, and `pdocs new` copies it in as guidance
// for filling the document. A filled document that still holds it is reported
// by `pdocs check` only, as ONE advisory naming every such document. It never
// fails the gate; templates themselves are never reported.

/** The template-header advisory's `id`. */
export const TEMPLATE_HEADER_ADVISORY = "template-header";

export interface TemplateHeaderAdvisory extends Advisory {
  id: typeof TEMPLATE_HEADER_ADVISORY;
  /** Each document's path, repo-relative. */
  refs: string[];
}

/** At most `max` paths named, then `and N more`. */
function namedPaths(paths: readonly string[], max = 5): string {
  const shown = paths.slice(0, max);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : joined(shown);
}

/**
 * The template-header advisory over `paths`, repo-relative, or `null` when
 * there are none. Pure, like the others.
 */
export function templateHeaderAdvisory(paths: readonly string[]): TemplateHeaderAdvisory | null {
  if (paths.length === 0) return null;
  const n = paths.length;
  return {
    id: TEMPLATE_HEADER_ADVISORY,
    message:
      `${n} document${n === 1 ? "" : "s"} still ${n === 1 ? "holds" : "hold"} ` +
      `${n === 1 ? "its" : "their"} template's header comment: ${namedPaths(paths)}.`,
    action:
      "Delete the whole comment block that starts `OWNERSHIP (of this template file` from each, " +
      "from its `<!--` to its `-->`; leave the rest of the document as it is.",
    refs: [...paths],
  };
}

/**
 * Several advice lists as one: every `bad-config` advisory folded into the
 * first, its issues once each, so a `checks` that is broken as a whole is
 * reported once rather than per section.
 */
export function combineAdvisories(...lists: Advisory[][]): Advisory[] {
  const out: Advisory[] = [];
  const issues: ConfigIssue[] = [];
  const kinds = new Set<BadConfigKind>();
  let badAt = -1;
  for (const a of lists.flat()) {
    if (a.id !== BAD_CONFIG_ADVISORY) {
      out.push(a);
      continue;
    }
    if (badAt === -1) {
      badAt = out.length;
      out.push(a);
    }
    for (const k of KINDS.get(a) ?? ["archive" as const]) kinds.add(k);
    for (const i of (a as BadConfigAdvisory).issues)
      if (!issues.some((j) => j.key === i.key)) issues.push(i);
  }
  if (badAt === -1) return out;
  // Each kind keeps its own promise in the one merged action.
  const merged = badConfigAdvisory(issues) as BadConfigAdvisory;
  merged.action = badConfigAction(issues.length, meanwhileFor(kinds));
  KINDS.set(merged, kinds);
  out[badAt] = merged;
  return out;
}

/** The text rendering: two lines per advisory, never one per entity. */
export function advisoryLines(advisories: readonly Advisory[]): string[] {
  return advisories.flatMap((a) => [`advisory (${a.id}): ${a.message}`, `  next: ${a.action}`]);
}

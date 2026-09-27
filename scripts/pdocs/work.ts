// The work model: features, items and cycles, read once, and the one way a
// reference to any of them is resolved.
//
// Everything that asks "which entity does this string name" asks here — the
// lint's corpus rules (`lint/work.ts`), `pdocs new`'s `--parent`, `--owner` and
// `--blocked-by`, `set`, `promote`, `archive` and `view`. A second resolver is
// how the writer and the checker come to disagree about the same tree.
//
// Built on the documents the thin lint pass already reads (`workbenchDocuments`)
// rather than on `collectPages`: the model needs every frontmatter field, a
// `Page` carries a fixed handful, and the lint hands its own read straight in
// so the gate still walks the tree once.

import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parseGenerated, yamlList } from "./docs-lint/index.ts";
import { UsageError } from "./envelope.ts";
import {
  ENTITY_FILE,
  FEATURES_FOLDER,
  ITEMS_FOLDER,
  PRIORITIES,
  STATE_GROUP,
  type StateGroup,
} from "./lint/registry.ts";
import {
  type Ctx,
  type WorkbenchDocument,
  workbenchDocuments,
} from "./lint/rules.ts";
import { UUID_RE, isUuid } from "./uuid.ts";

export const ARCHIVE = "_archive";

/** A scalar with any surrounding quotes removed. */
export const scalar = (v: string | undefined): string =>
  (v ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");

/** One feature, item or cycle. */
export interface WorkEntity {
  entity: "feature" | "item" | "cycle";
  /** Repo-relative path of the entity file. */
  path: string;
  /** The same, relative to the docs root, `/`-separated. */
  docsPath: string;
  /** The folder name, or the file name without `.md` for a single-file item
   *  and a cycle. */
  slug: string;
  archived: boolean;
  /** The entity's folder, docs-root-relative (`items/_archive/x`), when it has
   *  one. `null` for a single-file item and for a cycle. */
  folder: string | null;
  fields: ReadonlyMap<string, string>;
  title: string | null;
  lifecycle: string | null;
  /** `STATE_GROUP[lifecycle]`, or `null` for a state outside the vocabulary. */
  group: StateGroup | null;
  /** An item's `id`, as written (quotes removed). */
  id: string | null;
  /** An item's `kind`. */
  kind: string | null;
  parent: string | null;
  cycle: string | null;
  scope: string | null;
  from: string | null;
  blockedBy: string[];
  priority: string | null;
  assignee: string | null;
  releasedIn: string | null;
  /** `generated.at`. */
  date: string | null;
}

export interface WorkModel {
  features: WorkEntity[];
  items: WorkEntity[];
  cycles: WorkEntity[];
  /** Items by `id` exactly as written. A duplicate id lists every holder. */
  itemsById: ReadonlyMap<string, WorkEntity[]>;
  featuresBySlug: ReadonlyMap<string, WorkEntity[]>;
  itemsBySlug: ReadonlyMap<string, WorkEntity[]>;
  cyclesBySlug: ReadonlyMap<string, WorkEntity[]>;
}

/**
 * Where a document under an owner folder sits: the owner (`features` or
 * `items`), whether it is under `_archive/`, and the segments below that.
 * `null` for anything outside the two owners.
 *
 * Read relative to the RESOLVED docs root, never the configured string: a
 * `docsRoot` spelled `./docs` or `docs/` is the same folder.
 */
export function ownerPosition(
  ctx: Ctx,
  rel: string
): { owner: string; archived: boolean; segs: string[] } | null {
  const within = relative(ctx.docsRoot, join(ctx.repoRoot, rel));
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return null;
  const segs = within.split(sep);
  const owner = segs[0] as string;
  if (owner !== FEATURES_FOLDER && owner !== ITEMS_FOLDER) return null;
  let rest = segs.slice(1);
  const archived = rest[0] === ARCHIVE && rest.length > 1;
  if (archived) rest = rest.slice(1);
  return { owner, archived, segs: rest };
}

function opt(fields: ReadonlyMap<string, string>, key: string): string | null {
  const v = scalar(fields.get(key));
  return v === "" ? null : v;
}

function entityOf(ctx: Ctx, doc: WorkbenchDocument): WorkEntity | null {
  if (doc.misplaced) return null;
  const docsPath = relative(ctx.docsRoot, join(ctx.repoRoot, doc.rel))
    .split(sep)
    .join("/");
  let entity: WorkEntity["entity"];
  let slug: string;
  let archived = false;
  let folder: string | null = null;

  if (doc.type === "cycle") {
    entity = "cycle";
    slug = basename(doc.rel, ".md");
  } else if (doc.type === "feature" || doc.type === "item") {
    const pos = ownerPosition(ctx, doc.rel);
    if (!pos) return null;
    entity = doc.type;
    archived = pos.archived;
    if (pos.segs.length === 1) slug = basename(pos.segs[0] as string, ".md");
    else {
      slug = pos.segs[0] as string;
      folder = `${pos.owner}/${archived ? `${ARCHIVE}/` : ""}${slug}`;
    }
  } else return null;

  const f = doc.fields;
  const lifecycle = opt(f, "lifecycle");
  return {
    entity,
    path: doc.rel,
    docsPath,
    slug,
    archived,
    folder,
    fields: f,
    title: opt(f, "title"),
    lifecycle,
    group: (lifecycle && STATE_GROUP[lifecycle]) || null,
    id: opt(f, "id"),
    kind: opt(f, "kind"),
    parent: opt(f, "parent"),
    cycle: opt(f, "cycle"),
    scope: opt(f, "scope"),
    from: opt(f, "from"),
    blockedBy: yamlList(f.get("blocked_by"))
      .map((b) => scalar(b))
      .filter(Boolean),
    priority: opt(f, "priority"),
    assignee: opt(f, "assignee"),
    releasedIn: opt(f, "released_in"),
    date: parseGenerated(f.get("generated"))?.at ?? null,
  };
}

const byPath = (a: WorkEntity, b: WorkEntity) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function index(
  list: readonly WorkEntity[],
  key: (e: WorkEntity) => string | null
): Map<string, WorkEntity[]> {
  const out = new Map<string, WorkEntity[]>();
  for (const e of list) {
    const k = key(e);
    if (k) out.set(k, [...(out.get(k) ?? []), e]);
  }
  return out;
}

/**
 * The model over a set of documents. `documents` defaults to a fresh read; the
 * lint passes the ones its thin pass already has.
 */
export function workModel(
  ctx: Ctx,
  documents: readonly WorkbenchDocument[] = workbenchDocuments(ctx)
): WorkModel {
  const all = documents
    .map((d) => entityOf(ctx, d))
    .filter((e): e is WorkEntity => e !== null)
    .sort(byPath);
  const features = all.filter((e) => e.entity === "feature");
  const items = all.filter((e) => e.entity === "item");
  const cycles = all.filter((e) => e.entity === "cycle");
  return {
    features,
    items,
    cycles,
    itemsById: index(items, (e) => e.id),
    featuresBySlug: index(features, (e) => e.slug),
    itemsBySlug: index(items, (e) => e.slug),
    cyclesBySlug: index(cycles, (e) => e.slug),
  };
}

/** The model over the tree as it stands. */
export function collectWork(ctx: Ctx): WorkModel {
  return workModel(ctx);
}

/** The shortest id prefix `resolveRef` accepts (D6). */
export const MIN_PREFIX = 8;

/**
 * The fewest characters of an id `pdocs` PRINTS for a person or an agent to
 * copy (D25): views, refusal and ambiguity messages, `new` and `set` text
 * output. JSON always carries the full id, and a reference still needs only 8.
 */
export const SHORT_ID = 12;

/**
 * An id as `pdocs` prints it (D25): the shortest prefix no other id in `ids`
 * shares, and never fewer than `SHORT_ID` characters — git's rule. Twelve
 * characters are exactly UUIDv7's 48-bit timestamp, so ids minted in one
 * burst share all twelve; a fixed length would print them alike.
 */
export function shortId(id: string, ids: Iterable<string> = []): string {
  const others = [...ids].filter((o) => o !== id);
  let n = SHORT_ID;
  while (n < id.length && others.some((o) => o.startsWith(id.slice(0, n)))) n++;
  return id.slice(0, n);
}

/** Every item id in the model: what a printed id must be unique among. */
export const modelIds = (model: WorkModel): string[] => [...model.itemsById.keys()];

/** `text` with every full UUID in it shortened against `ids` (D25). */
export const shortenIds = (text: string, ids: Iterable<string> = []): string => {
  const all = [...ids];
  return text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) =>
    shortId(id, all)
  );
};

const FORMS =
  "a full item id, a unique id prefix of 8+ characters, `item/<slug>`, `feature/<slug>` or `cycle/<slug>`";

/**
 * The entity a reference names, in any form D6 accepts as INPUT:
 *
 * - a full UUID, any case;
 * - a unique prefix of at least 8 characters of one;
 * - `item/<slug>` (a file or a folder, live or archived), or `item/<id-or-prefix>`;
 * - `feature/<slug>`;
 * - `cycle/<slug>`.
 *
 * `kinds` narrows what the reference may name (`--parent` takes a feature
 * only). Anything that names nothing, or names more than one, is a
 * `UsageError`: retrying the same string fails the same way.
 */
export function resolveRef(
  model: WorkModel,
  ref: string,
  kinds: ReadonlyArray<WorkEntity["entity"]> = ["feature", "item", "cycle"]
): WorkEntity {
  const wanted = ref.trim();
  const one = (found: WorkEntity[], what: string): WorkEntity => {
    if (found.length === 0)
      throw new UsageError(`\`${ref}\` names no ${what} in this tree — expected ${FORMS}.`, {
        token: ref,
      });
    if (found.length > 1)
      throw new UsageError(
        `\`${ref}\` is ambiguous — it names ${found.length} entities: ${found
          .map((e) => (e.id ? `${shortId(e.id, modelIds(model))} ${e.path}` : e.path))
          .join(", ")}. Use a longer id prefix or the full id.`,
        { token: ref, choices: found.map((e) => e.path) }
      );
    const e = found[0] as WorkEntity;
    if (!kinds.includes(e.entity))
      throw new UsageError(
        `\`${ref}\` names a ${e.entity} (${e.path}); a ${kinds.join(" or ")} is expected here.`,
        { token: ref }
      );
    return e;
  };

  const byId = (value: string): WorkEntity[] | null => {
    const v = value.toLowerCase();
    if (isUuid(v)) return model.items.filter((e) => e.id?.toLowerCase() === v);
    if (/^[0-9a-f-]+$/.test(v) && /[0-9a-f]/.test(v)) {
      if (v.replace(/-/g, "").length < MIN_PREFIX)
        throw new UsageError(
          `\`${value}\` is too short to be an id prefix — give at least ${MIN_PREFIX} characters.`,
          { token: value }
        );
      return model.items.filter((e) => e.id?.toLowerCase().startsWith(v));
    }
    return null;
  };

  const m = /^(feature|item|cycle)\/(.+)$/.exec(wanted);
  if (m) {
    const [, kind, name] = m as unknown as [string, WorkEntity["entity"], string];
    if (kind === "feature") return one(model.featuresBySlug.get(name) ?? [], "feature");
    if (kind === "cycle") return one(model.cyclesBySlug.get(name) ?? [], "cycle");
    const bySlug = model.itemsBySlug.get(name);
    if (bySlug) return one(bySlug, "item");
    const ids = /^[0-9a-f-]+$/i.test(name) ? byId(name) : null;
    return one(ids ?? [], "item");
  }

  const ids = byId(wanted);
  if (ids !== null) return one(ids, "item");
  throw new UsageError(`\`${ref}\` is not a reference — expected ${FORMS}.`, {
    token: ref,
  });
}

/** How an entity is WRITTEN into another's frontmatter (D6): an item by its
 *  full id, a feature as `feature/<slug>`, a cycle by its bare slug in
 *  `cycle:` and as `cycle/<slug>` in `from:`. */
export function refFor(e: WorkEntity, field: "cycle" | "other" = "other"): string {
  if (e.entity === "item") return e.id ?? `item/${e.slug}`;
  if (e.entity === "cycle") return field === "cycle" ? e.slug : `cycle/${e.slug}`;
  return `feature/${e.slug}`;
}

/** The entry file's name for an owner folder (D2). */
export function entityFileName(entity: "feature" | "item"): string {
  return ENTITY_FILE[entity === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER]!.name;
}

/** `urgent` first, then down to `low`, then no priority. */
export function priorityRank(p: string | null): number {
  const i = p === null ? -1 : PRIORITIES.indexOf(p);
  return i === -1 ? PRIORITIES.length : i;
}

/** Whether a STORED `parent:` names a feature in the tree (D6: `feature/<slug>`). */
export function parentResolves(model: WorkModel, parent: string): boolean {
  const m = /^feature\/(.+)$/.exec(parent);
  return m !== null && model.featuresBySlug.has(m[1] as string);
}

/**
 * Whether a STORED `from:` resolves, in one of its four forms (D6): an item's
 * full id, `feature/<slug>`, `cycle/<slug>`, or a docs-root-relative path to a
 * document. Stored values are checked strictly — no prefixes, no `item/<slug>`;
 * those are input forms, and `pdocs` writes the full form.
 */
export function fromResolves(ctx: Ctx, model: WorkModel, from: string): boolean {
  if (UUID_RE.test(from)) return model.itemsById.has(from);
  const feature = /^feature\/(.+)$/.exec(from);
  if (feature) return model.featuresBySlug.has(feature[1] as string);
  const cycle = /^cycle\/(.+)$/.exec(from);
  if (cycle) return model.cyclesBySlug.has(cycle[1] as string);
  if (!from.endsWith(".md") || from.startsWith("/") || from.split("/").includes(".."))
    return false;
  const abs = join(ctx.docsRoot, from);
  return existsSync(abs) && statSync(abs).isFile();
}

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------
//
// Derived, never authored: each is a pure function of the model, so a UI can
// import them and get exactly what `pdocs view` prints. Every list is in one
// order — priority (urgent first, none last), then `generated.at`, then path —
// so two runs over one tree give the same bytes.

/** The order every view lists entities in. */
export function workOrder(a: WorkEntity, b: WorkEntity): number {
  // Plain `<`, never `localeCompare`: a collation is the thing that differs
  // between one machine and the next.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    cmp(a.date ?? "9999-99-99", b.date ?? "9999-99-99") ||
    cmp(a.path, b.path)
  );
}

const ordered = (list: readonly WorkEntity[]) => [...list].sort(workOrder);

/** The four state groups, in the order work moves through them. */
export const GROUPS: readonly StateGroup[] = ["unstarted", "started", "completed", "cancelled"];

/** `backlog`: items in the unstarted group. */
export function viewBacklog(model: WorkModel): WorkEntity[] {
  return ordered(model.items.filter((e) => e.group === "unstarted"));
}

/**
 * `board`: live items (and, with `features`, live features) by state group.
 * The archive stays off the board: it holds only finished work, and keeping
 * the live view short is what it is for.
 */
export function viewBoard(
  model: WorkModel,
  opts: { features?: boolean } = {}
): Record<StateGroup, WorkEntity[]> {
  const live = [...(opts.features ? model.features : []), ...model.items].filter(
    (e) => !e.archived
  );
  const out = {} as Record<StateGroup, WorkEntity[]>;
  for (const g of GROUPS) out[g] = ordered(live.filter((e) => e.group === g));
  return out;
}

/** `ready`: `ready` items whose every blocker is a `done` item. */
export function viewReady(model: WorkModel): WorkEntity[] {
  return ordered(
    model.items.filter(
      (e) =>
        e.lifecycle === "ready" &&
        e.blockedBy.every((id) => {
          const holders = model.itemsById.get(id) ?? [];
          return holders.length > 0 && holders.every((h) => h.lifecycle === "done");
        })
    )
  );
}

/** `feature <slug>`: the feature, and the items whose `parent` names it. */
export function viewFeature(
  model: WorkModel,
  feature: WorkEntity
): { feature: WorkEntity; items: WorkEntity[] } {
  const parent = `feature/${feature.slug}`;
  return { feature, items: ordered(model.items.filter((e) => e.parent === parent)) };
}

/**
 * `cycle <slug>`: the items that name the cycle — its scope is derived from
 * them — and whether it can close: it has at least one item, and every one
 * is finished or dropped.
 */
export function viewCycle(
  model: WorkModel,
  cycle: WorkEntity
): { cycle: WorkEntity; items: WorkEntity[]; closable: boolean } {
  const items = ordered(model.items.filter((e) => e.cycle === cycle.slug));
  return {
    cycle,
    items,
    // An empty cycle has done nothing, so there is nothing to close (review 5).
    closable:
      items.length > 0 &&
      items.every((e) => e.group === "completed" || e.group === "cancelled"),
  };
}

/** `scope <name>`: the features and items whose `scope` is `name`. */
export function viewScope(model: WorkModel, scope: string): WorkEntity[] {
  return ordered([...model.features, ...model.items].filter((e) => e.scope === scope));
}

/**
 * `unreleased`: done features and items with no `released_in`, archived or
 * not. `since` keeps those whose `generated.at` is on or after it. A view, not
 * a finding: `released_in` is not linted (D9).
 */
export function viewUnreleased(model: WorkModel, since?: string): WorkEntity[] {
  return ordered(
    [...model.features, ...model.items].filter(
      (e) =>
        e.lifecycle === "done" &&
        e.releasedIn === null &&
        (since === undefined || (e.date !== null && e.date >= since))
    )
  );
}

/** `released <version>`: the features and items that name it. */
export function viewReleased(model: WorkModel, version: string): WorkEntity[] {
  return ordered([...model.features, ...model.items].filter((e) => e.releasedIn === version));
}

/** The model's slug index for an entity kind. */
export function entitiesBySlug(
  model: WorkModel,
  entity: WorkEntity["entity"]
): ReadonlyMap<string, WorkEntity[]> {
  return entity === "feature"
    ? model.featuresBySlug
    : entity === "item"
      ? model.itemsBySlug
      : model.cyclesBySlug;
}

// `pdocs view <name> [<arg>]` — the backlog, the board, the ready list, a
// feature's items, a cycle's scope, a scope's work, what is done but not
// released, and the portfolio of cycles and features. None of these is an
// authored file: each is computed from fields, by the pure functions in
// `work.ts`. This file only presents them.

import type { Command, Invocation } from "../cli.ts";
import {
  ARCHIVE_WHY_HIDDEN,
  type Advisory,
  adviseArchive,
  adviseReview,
  advisoryLines,
  combineAdvisories,
  reviewItems,
  reviewViolations,
} from "../advisories.ts";
import { ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import {
  GROUPS,
  SHORT_ID,
  modelIds,
  shortId,
  type WorkEntity,
  collectWork,
  resolveRef,
  viewBacklog,
  viewBoard,
  viewCycle,
  viewFeature,
  viewPortfolio,
  viewReady,
  type GroupCounts,
  type PortfolioEntry,
  viewReleased,
  viewScope,
  viewUnreleased,
  viewUnreviewed,
} from "../work.ts";

/** One entity as a view lists it. */
export interface ViewEntry {
  path: string;
  entity: WorkEntity["entity"];
  slug: string;
  id: string | null;
  title: string | null;
  /** OKF `status` as written: `draft`, `stable`, `deprecated`; `null` when missing. */
  status: string | null;
  kind: string | null;
  lifecycle: string | null;
  group: string | null;
  priority: string | null;
  assignee: string | null;
  parent: string | null;
  cycle: string | null;
  scope: string | null;
  blockedBy: string[];
  releasedIn: string | null;
  archived: boolean;
  date: string | null;
}

const entry = (e: WorkEntity): ViewEntry => ({
  path: e.path,
  entity: e.entity,
  slug: e.slug,
  id: e.id,
  title: e.title,
  status: e.status,
  kind: e.kind,
  lifecycle: e.lifecycle,
  group: e.group,
  priority: e.priority,
  assignee: e.assignee,
  parent: e.parent,
  cycle: e.cycle,
  scope: e.scope,
  blockedBy: e.blockedBy,
  releasedIn: e.releasedIn,
  archived: e.archived,
  date: e.date,
});

/**
 * The live views: they list current work, so they leave archived records out
 * unless `--all` asks for them. `backlog` and `ready` are live too, but list
 * only unstarted items, which the archive never holds.
 */
const WITH_ARCHIVE = ["board", "scope", "unreviewed"];

/**
 * The views that take `--all`. On a live view it adds the archive; on
 * `portfolio`, which lists what is current, it adds the history — past cycles
 * and features, archived or not.
 */
const WITH_ALL = [...WITH_ARCHIVE, "portfolio"];

/** The views, in help order. `arg` names the positional a view needs. */
export const VIEWS: ReadonlyArray<{ name: string; arg?: string; summary: string }> = [
  { name: "backlog", summary: "items not yet started, by priority" },
  { name: "board", summary: "live items by state group (--features adds features, --all the archive)" },
  { name: "ready", summary: "`ready` items whose blockers are all done" },
  { name: "feature", arg: "slug", summary: "a feature and its items" },
  { name: "cycle", arg: "filename", summary: "the items naming a cycle, and whether it can close" },
  { name: "scope", arg: "name", summary: "the live features and items in a scope (--all adds the archive)" },
  { name: "unreleased", summary: "done, with no released_in (--since YYYY-MM-DD)" },
  { name: "released", arg: "version", summary: "what a version released" },
  { name: "portfolio", summary: "current cycles and features with item counts (--all adds history)" },
  { name: "unreviewed", summary: "done items whose document is not `stable`: the review audit (--all adds the archive)" },
];

/** A cycle or feature as `view portfolio` lists it. Stable JSON fields. */
export interface PortfolioJson {
  entity: "cycle" | "feature";
  path: string;
  slug: string;
  title: string | null;
  lifecycle: string | null;
  archived: boolean;
  current: boolean;
  counts: GroupCounts;
}

const portfolioEntry = (p: PortfolioEntry): PortfolioJson => ({
  entity: p.entity.entity as "cycle" | "feature",
  path: p.entity.path,
  slug: p.entity.slug,
  title: p.entity.title,
  lifecycle: p.entity.lifecycle,
  archived: p.entity.archived,
  current: p.current,
  counts: p.counts,
});

/** The data `view portfolio` prints, in JSON as it stands and in text through
 *  `renderPortfolio`. */
export interface PortfolioData {
  view: "portfolio";
  all: boolean;
  activeCycle: boolean;
  cycles: PortfolioJson[];
  features: PortfolioJson[];
  unattached: GroupCounts;
}

/** The count columns, named as `view board` names its groups. */
const COUNT_COLS = ["unstarted", "started", "completed", "cancelled"] as const;

/**
 * `view portfolio` as text. Kept apart from the data so the layout can change
 * without touching what is counted.
 *
 * A zero prints as `·`, so the counts that matter stand out. Past features
 * with no items fold into one line per lifecycle: history rows of zeros say
 * nothing a count cannot. Current features are always listed, items or not —
 * they are what the view is for. The JSON keeps every entry and every number.
 */
export function renderPortfolio(d: PortfolioData): string[] {
  const out: string[] = [];
  const lcWidth = Math.max(
    "lifecycle".length,
    ...[...d.cycles, ...d.features].map((e) => (e.lifecycle ?? "-").length)
  );
  const header = (noun: string) =>
    `  ${"lifecycle".padEnd(lcWidth)}  ${COUNT_COLS.join("  ")}  ${noun}`;
  const num = (n: number, width: number) => (n === 0 ? "·" : String(n)).padStart(width);
  const row = (e: PortfolioJson) => {
    const nums = COUNT_COLS.map((c) => num(e.counts[c], c.length)).join("  ");
    const odd = e.counts.ungrouped > 0 ? `  (+${e.counts.ungrouped} in an unknown state)` : "";
    const name = `${e.slug}${e.archived ? " [archived]" : ""}`;
    return `  ${(e.lifecycle ?? "-").padEnd(lcWidth)}  ${nums}  ${name}${e.title ? `  — ${e.title}` : ""}${odd}`;
  };
  const tally = (list: PortfolioJson[]) => {
    const n = new Map<string, number>();
    for (const e of list) n.set(e.lifecycle ?? "-", (n.get(e.lifecycle ?? "-") ?? 0) + 1);
    return [...n].map(([k, v]) => `${v} ${k}`).join(", ");
  };
  const section = (
    title: string,
    noun: string,
    list: PortfolioJson[],
    empty: string,
    fold = false
  ) => {
    out.push(list.length ? `${title} (${tally(list)})` : title);
    if (list.length === 0) {
      out.push(`  ${empty}`);
      return;
    }
    const shown = fold ? list.filter((e) => e.counts.total > 0) : list;
    const folded = fold ? list.filter((e) => e.counts.total === 0) : [];
    if (shown.length > 0) {
      out.push(header(noun));
      for (const e of shown) out.push(row(e));
    }
    const byLc = new Map<string, PortfolioJson[]>();
    for (const e of folded) byLc.set(e.lifecycle ?? "-", [...(byLc.get(e.lifecycle ?? "-") ?? []), e]);
    for (const [lc, es] of byLc) {
      const archived = es.filter((e) => e.archived).length;
      out.push(
        `  ${es.length} ${lc} ${es.length === 1 ? noun : `${noun}s`} with no items${archived ? ` (${archived} archived)` : ""}`
      );
    }
  };

  const curCycles = d.cycles.filter((e) => e.current);
  section("Cycles", "cycle", curCycles, "No current cycle — none planned or active.");
  if (curCycles.length > 0 && !d.activeCycle) out.push("  No active cycle — only planned ones.");
  out.push("");
  section(
    "Features",
    "feature",
    d.features.filter((e) => e.current),
    "No current feature — none in backlog, ready, active or review."
  );
  const u = d.unattached;
  if (u.total > 0)
    out.push(
      "",
      `Items in no cycle or feature: ${u.unstarted} unstarted, ${u.started} started, ${u.completed} completed, ${u.cancelled} cancelled (archived not counted)`
    );
  if (d.all) {
    out.push("");
    section("Past cycles", "cycle", d.cycles.filter((e) => !e.current), "None.");
    out.push("");
    section("Past features", "feature", d.features.filter((e) => !e.current), "None.", true);
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function line(e: ViewEntry, ids: readonly string[], width: number): string {
  // An item's short id (D25): unique across the tree, so the line can be
  // copied into `pdocs set`.
  const id = (e.id ? shortId(e.id, ids) : "-").padEnd(width);
  return `  ${id}  ${(e.lifecycle ?? "-").padEnd(8)}  ${(e.priority ?? "-").padEnd(6)}  ${e.path}${
    e.title ? `  — ${e.title}` : ""
  }${statusTag(e)}`;
}

/**
 * An item's status, as text shows it: nothing when it is `stable`, the norm a
 * reader need not be told; ` [draft]`, ` [deprecated]`, or ` [no status]`
 * otherwise. JSON carries `status` on every entry.
 */
export function statusTag(e: Pick<ViewEntry, "entity" | "status">): string {
  if (e.entity !== "item" || e.status === "stable") return "";
  return ` [${e.status ?? "no status"}]`;
}

export const view: Command = {
  name: "view",
  summary: "Derived views: backlog, board, ready, feature, cycle, scope, unreleased, released, portfolio, unreviewed.",
  usage: `pdocs view <${VIEWS.map((v) => v.name).join("|")}> [<arg>] [--features] [--all] [--since <YYYY-MM-DD>]`,
  positionals: [
    { name: "view", required: true },
    { name: "arg", required: false },
  ],
  options: [
    { flag: "--features", summary: "board: include features beside the items." },
    {
      flag: "--all",
      summary:
        "board, scope, unreviewed: include archived work, which a live view leaves out. " +
        "portfolio: add past cycles and features — closed or abandoned, done or dropped, archived or not.",
    },
    {
      flag: "--since",
      metavar: "<YYYY-MM-DD>",
      summary: "unreleased: only those whose `generated.at` is on or after this date.",
    },
  ],

  run({ ctx, format, flags, positionals }: Invocation): number {
    const [name, arg] = positionals;
    const names = VIEWS.map((v) => v.name);
    const spec = VIEWS.find((v) => v.name === name);
    if (!spec)
      throw new UsageError(
        `${name === undefined ? "view needs a name" : `unknown view \`${name}\``} — ${names.join(", ")}.`,
        { ...(name === undefined ? {} : { token: name }), choices: names }
      );
    if (spec.arg && arg === undefined)
      throw new UsageError(`\`view ${spec.name}\` needs a ${spec.arg} — \`pdocs view ${spec.name} <${spec.arg}>\`.`);
    if (!spec.arg && arg !== undefined)
      throw new UsageError(`\`view ${spec.name}\` takes no argument — got \`${arg}\`.`);
    const since = typeof flags["--since"] === "string" ? flags["--since"] : undefined;
    if (since !== undefined && !DATE_RE.test(since))
      throw new UsageError(`--since: \`${since}\` is not a date — expected YYYY-MM-DD.`);
    if (since !== undefined && spec.name !== "unreleased")
      throw new UsageError("--since applies to `view unreleased` only.");
    if (flags["--features"] === true && spec.name !== "board")
      throw new UsageError("--features applies to `view board` only.");
    const all = flags["--all"] === true;
    if (all && !WITH_ALL.includes(spec.name))
      throw new UsageError(
        `--all applies to ${WITH_ALL.slice(0, -1).map((v) => `\`view ${v}\``).join(", ")} and \`view ${WITH_ALL.at(-1)}\` only.`
      );

    const model = collectWork(ctx);
    const list = (items: WorkEntity[]) => ({ view: spec.name, items: items.map(entry) });
    // Every view carries `advisories`, empty when it has none, so a caller
    // reads one field whatever it asked for. Only a view that lists a type
    // across the whole tree advises on archiving it.
    let advisories: Advisory[] = [];
    let data: Record<string, unknown>;
    switch (spec.name) {
      case "backlog":
        data = list(viewBacklog(model));
        break;
      case "ready": {
        const ready = viewReady(model);
        // What an agent picks from next: an unreviewed one is reported before
        // it starts (`on-start`), not after.
        advisories = adviseReview(ctx, reviewItems(model, ready, { prospective: true }));
        data = { ...list(ready), reviewMode: ctx.config.checks.workItemReview.mode };
        break;
      }
      case "board": {
        const features = flags["--features"] === true;
        const board = viewBoard(model, { features, archived: all });
        advisories = combineAdvisories(
          adviseArchive(ctx, model, features ? ["item", "feature"] : ["item"]),
          adviseReview(ctx, reviewViolations(model))
        );
        data = {
          view: "board",
          reviewMode: ctx.config.checks.workItemReview.mode,
          groups: Object.fromEntries(GROUPS.map((g) => [g, board[g].map(entry)])),
        };
        break;
      }
      case "feature": {
        const v = viewFeature(model, resolveRef(model, `feature/${arg}`, ["feature"]));
        data = { view: "feature", feature: entry(v.feature), items: v.items.map(entry) };
        break;
      }
      case "cycle": {
        const v = viewCycle(model, resolveRef(model, `cycle/${arg}`, ["cycle"]));
        // A planned cycle's unreviewed work is reported before the cycle
        // starts; an active one's is a violation.
        advisories = adviseReview(
          ctx,
          reviewItems(model, v.items, { prospective: v.cycle.lifecycle === "planned" })
        );
        data = {
          view: "cycle",
          cycle: entry(v.cycle),
          items: v.items.map(entry),
          closable: v.closable,
          reviewMode: ctx.config.checks.workItemReview.mode,
        };
        break;
      }
      case "scope":
        data = list(viewScope(model, arg as string, { archived: all }));
        break;
      case "unreleased":
        data = list(viewUnreleased(model, since));
        break;
      case "unreviewed":
        data = list(viewUnreviewed(model, { archived: all }));
        break;
      case "portfolio": {
        const p = viewPortfolio(model, { all });
        // Portfolio leaves finished features and cycles out by default, so the
        // advice is about `--all` and the tree, not about this view's length.
        advisories = adviseArchive(ctx, model, ["feature", "cycle"], { why: ARCHIVE_WHY_HIDDEN });
        data = {
          view: "portfolio",
          all,
          activeCycle: p.activeCycle,
          cycles: p.cycles.map(portfolioEntry),
          features: p.features.map(portfolioEntry),
          unattached: p.unattached,
        } satisfies PortfolioData;
        break;
      }
      default:
        data = list(viewReleased(model, arg as string));
    }

    data.advisories = advisories;

    if (format === "json") {
      printEnvelope("view", data);
      return ExitCode.Success;
    }

    if (spec.name === "portfolio") {
      for (const l of renderPortfolio(data as unknown as PortfolioData)) console.log(l);
      // Its sections are set apart by blank lines; so is the advice after them.
      if (advisories.length > 0) console.log("");
    } else printText(data, modelIds(model));
    for (const l of advisoryLines(advisories)) console.log(l);
    return ExitCode.Success;
  },
};

/** A view's entities as text: grouped for the board, a list for the rest. */
function printText(data: Record<string, unknown>, ids: string[]): void {
  const shown = [
    ...Object.values((data.groups ?? {}) as Record<string, ViewEntry[]>).flat(),
    ...((data.items ?? []) as ViewEntry[]),
  ];
  const width = Math.max(SHORT_ID, ...shown.map((e) => (e.id ? shortId(e.id, ids).length : 1)));
  if (data.groups) {
    for (const [group, items] of Object.entries(data.groups as Record<string, ViewEntry[]>)) {
      console.log(`${group} (${items.length})`);
      for (const e of items) console.log(line(e, ids, width));
    }
    return;
  }
  const head = (data.feature ?? data.cycle) as ViewEntry | undefined;
  if (head) console.log(`${head.path}${head.title ? `  — ${head.title}` : ""}`);
  if (data.closable !== undefined) console.log(`closable: ${data.closable ? "yes" : "no"}`);
  const items = data.items as ViewEntry[];
  if (items.length === 0) console.log("  (none)");
  for (const e of items) console.log(line(e, ids, width));
}

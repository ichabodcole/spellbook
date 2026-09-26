// `pdocs view <name> [<arg>]` — the backlog, the board, the ready list, a
// feature's items, a cycle's scope, a scope's work, and what is done but not
// released. None of these is an authored file: each is computed from fields,
// by the pure functions in `work.ts`. This file only presents them.

import type { Command, Invocation } from "../cli.ts";
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
  viewReady,
  viewReleased,
  viewScope,
  viewUnreleased,
} from "../work.ts";

/** One entity as a view lists it. */
export interface ViewEntry {
  path: string;
  entity: WorkEntity["entity"];
  slug: string;
  id: string | null;
  title: string | null;
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

/** The views, in help order. `arg` names the positional a view needs. */
export const VIEWS: ReadonlyArray<{ name: string; arg?: string; summary: string }> = [
  { name: "backlog", summary: "items not yet started, by priority" },
  { name: "board", summary: "live items by state group (--features adds features)" },
  { name: "ready", summary: "`ready` items whose blockers are all done" },
  { name: "feature", arg: "slug", summary: "a feature and its items" },
  { name: "cycle", arg: "slug", summary: "the items naming a cycle, and whether it can close" },
  { name: "scope", arg: "name", summary: "the features and items in a scope" },
  { name: "unreleased", summary: "done, with no released_in (--since YYYY-MM-DD)" },
  { name: "released", arg: "version", summary: "what a version released" },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function line(e: ViewEntry, ids: readonly string[], width: number): string {
  // An item's short id (D25): unique across the tree, so the line can be
  // copied into `pdocs set`.
  const id = (e.id ? shortId(e.id, ids) : "-").padEnd(width);
  return `  ${id}  ${(e.lifecycle ?? "-").padEnd(8)}  ${(e.priority ?? "-").padEnd(6)}  ${e.path}${
    e.title ? `  — ${e.title}` : ""
  }`;
}

export const view: Command = {
  name: "view",
  summary: "Derived views: backlog, board, ready, feature, cycle, scope, unreleased, released.",
  usage: `pdocs view <${VIEWS.map((v) => v.name).join("|")}> [<arg>] [--features] [--since <YYYY-MM-DD>]`,
  positionals: [
    { name: "view", required: true },
    { name: "arg", required: false },
  ],
  options: [
    { flag: "--features", summary: "board: include features beside the items." },
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

    const model = collectWork(ctx);
    const list = (items: WorkEntity[]) => ({ view: spec.name, items: items.map(entry) });
    let data: Record<string, unknown>;
    switch (spec.name) {
      case "backlog":
        data = list(viewBacklog(model));
        break;
      case "ready":
        data = list(viewReady(model));
        break;
      case "board": {
        const board = viewBoard(model, { features: flags["--features"] === true });
        data = {
          view: "board",
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
        data = { view: "cycle", cycle: entry(v.cycle), items: v.items.map(entry), closable: v.closable };
        break;
      }
      case "scope":
        data = list(viewScope(model, arg as string));
        break;
      case "unreleased":
        data = list(viewUnreleased(model, since));
        break;
      default:
        data = list(viewReleased(model, arg as string));
    }

    if (format === "json") {
      printEnvelope("view", data);
      return ExitCode.Success;
    }

    const ids = modelIds(model);
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
      return ExitCode.Success;
    }
    const head = (data.feature ?? data.cycle) as ViewEntry | undefined;
    if (head) console.log(`${head.path}${head.title ? `  — ${head.title}` : ""}`);
    if (data.closable !== undefined) console.log(`closable: ${data.closable ? "yes" : "no"}`);
    const items = data.items as ViewEntry[];
    if (items.length === 0) console.log("  (none)");
    for (const e of items) console.log(line(e, ids, width));
    return ExitCode.Success;
  },
};

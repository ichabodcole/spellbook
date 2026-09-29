// `pdocs find` — query the tree.
//
// The command the work questions actually need: "what is in the active
// cycle", "which features claim `done`". Both are workbench
// questions, which is why this stands on `collectPages` and not on the lint's
// library-tier graph — see `pages.ts`.
//
// Filters are ANDed and every one of them is optional, so a bare `pdocs find`
// lists the tree. AN EMPTY RESULT EXITS 0: "nothing matches" is an answer, and
// a caller that has to distinguish "no documents" from "the command failed"
// reads `count`, not the status.
//
// The one thing this refuses to do is accept a filter it cannot apply. A
// `--since` that is not a date would silently match nothing, which is
// indistinguishable from a correct query over an empty corpus — the worst
// possible outcome for an agent caller, because the answer looks like data.

import type { Command, Invocation } from "../cli.ts";
import { ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import { type Page, collectPages, pageSlug } from "../pages.ts";
import { KINDS, buildRegistry, retiredWordReason } from "../lint/registry.ts";
import { DEFAULT_CONFIG } from "../docs-lint/config.ts";

/** A match, minus the edges. Whoever wants those asks `pdocs graph` or
 *  `pdocs backlinks` — `find` answers "which documents", not "what cites
 *  what". */
export interface FindMatch {
  path: string;
  /** What a reference to it is built from: `item/<slug>`, `feature/<slug>`,
   *  `cycle/<slug>`. See `pageSlug`. */
  slug: string;
  tier: "library" | "workbench";
  type: string;
  title: string | null;
  description: string | null;
  status: string | null;
  lifecycle: string | null;
  tags: string[];
  date: string | null;
  id: string | null;
  kind: string | null;
  parent: string | null;
  cycle: string | null;
  scope: string | null;
}

export interface FindData {
  matches: FindMatch[];
  count: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The filters, read off the parsed flags and validated. */
export interface FindFilters {
  type?: string;
  lifecycle?: string;
  status?: string;
  tag?: string;
  since?: string;
  kind?: string;
  parent?: string;
  cycle?: string;
  scope?: string;
  /** Lowercased: an id prefix matches in any case. */
  id?: string;
}

export function parseFilters(
  flags: Record<string, string | true>,
  knownTypes: readonly string[]
): FindFilters {
  const value = (flag: string): string | undefined => {
    const v = flags[flag];
    return typeof v === "string" ? v : undefined;
  };

  const since = value("--since");
  if (since !== undefined && !DATE_RE.test(since))
    throw new UsageError(
      `--since: \`${since}\` is not a date — expected YYYY-MM-DD. ` +
        `A filter that cannot be applied would match nothing, which reads as an answer.`
    );

  const type = value("--type");
  if (type !== undefined && !knownTypes.includes(type)) {
    const choices = [...new Set(knownTypes)].sort();
    // A type retired in 9.0.0 is named as such, with its replacement — the
    // same refusal `pdocs new` gives, not "unknown type".
    const retired = retiredWordReason(type, DEFAULT_CONFIG);
    if (retired !== null) throw new UsageError(`--type: ${retired}.`, { token: type, choices });
    throw new UsageError(
      `--type: \`${type}\` is not a type in this project. Known: ${choices.join(", ")}.`,
      { token: type, choices }
    );
  }

  const kind = value("--kind");
  if (kind !== undefined && !KINDS.includes(kind))
    throw new UsageError(`--kind: \`${kind}\` is not a kind — ${KINDS.join(" | ")}.`, {
      token: kind,
      choices: KINDS,
    });

  // A parent is written `feature/<slug>` (D6), and a filter in any other shape
  // could only ever match nothing.
  const parent = value("--parent");
  if (parent !== undefined && !/^feature\/[^/]+$/.test(parent))
    throw new UsageError(
      `--parent: \`${parent}\` is not \`feature/<slug>\`, the one form a parent is written in.`,
      { token: parent }
    );

  const id = value("--id");
  if (id !== undefined && !/^[0-9a-f-]+$/i.test(id))
    throw new UsageError(`--id: \`${id}\` is not an id or an id prefix — hex digits and hyphens.`, {
      token: id,
    });

  return {
    type,
    lifecycle: value("--lifecycle"),
    status: value("--status"),
    tag: value("--tag"),
    since,
    kind,
    parent,
    cycle: value("--cycle"),
    scope: value("--scope"),
    id: id?.toLowerCase(),
  };
}

/**
 * ANDed, and every comparison is exact.
 *
 * `--since` compares `generated.at` LEXICOGRAPHICALLY, which is correct for
 * `YYYY-MM-DD` and is why the format is validated rather than parsed: no
 * timezone, no `Date`, no drift between the machine running this and the one
 * that wrote the document. A page with no date NEVER matches `--since` — an
 * undated document is not evidence of recency.
 */
export function matches(page: Page, f: FindFilters): boolean {
  if (f.type !== undefined && page.type !== f.type) return false;
  if (f.lifecycle !== undefined && page.lifecycle !== f.lifecycle) return false;
  if (f.status !== undefined && page.status !== f.status) return false;
  if (f.tag !== undefined && !page.tags.includes(f.tag)) return false;
  if (f.since !== undefined && (page.date === null || page.date < f.since))
    return false;
  if (f.kind !== undefined && page.kind !== f.kind) return false;
  if (f.parent !== undefined && page.parent !== f.parent) return false;
  if (f.cycle !== undefined && page.cycle !== f.cycle) return false;
  if (f.scope !== undefined && page.scope !== f.scope) return false;
  if (f.id !== undefined && !(page.id ?? "").toLowerCase().startsWith(f.id)) return false;
  return true;
}

export function findData(pages: Page[], f: FindFilters): FindData {
  const found = pages
    .filter((page) => matches(page, f))
    .map(
      (page): FindMatch => ({
        path: page.path,
        slug: pageSlug(page),
        tier: page.tier,
        type: page.type,
        title: page.title,
        description: page.description,
        status: page.status,
        lifecycle: page.lifecycle,
        tags: page.tags,
        date: page.date,
        id: page.id,
        kind: page.kind,
        parent: page.parent,
        cycle: page.cycle,
        scope: page.scope,
      })
    );
  return { matches: found, count: found.length };
}

function renderText(data: FindData): void {
  if (data.count === 0) {
    console.log("no matches");
    return;
  }
  const width = Math.max(...data.matches.map((m) => m.type.length));
  for (const m of data.matches) {
    console.log(
      `${(m.date ?? "??????????").padEnd(10)}  ${(m.type || "-").padEnd(width)}  ` +
        `${(m.lifecycle ?? m.status ?? "-").padEnd(12)}  ${m.path}`
    );
  }
  console.log(`\n${data.count} document(s)`);
}

export const find: Command = {
  name: "find",
  summary: "Query the tree by type, lifecycle, status, tag, date, or work field.",
  usage:
    "pdocs find [--type <t>] [--lifecycle <l>] [--status <s>] [--tag <t>] [--since <YYYY-MM-DD>] " +
    "[--kind <k>] [--parent feature/<slug>] [--cycle <slug>] [--scope <name>] [--id <prefix>]",
  options: [
    { flag: "--type", metavar: "<type>", summary: "Documents of this type." },
    {
      flag: "--lifecycle",
      metavar: "<value>",
      summary: "Documents at this point in their lifecycle.",
    },
    {
      flag: "--status",
      metavar: "<value>",
      summary: "OKF status: draft | stable | deprecated.",
    },
    {
      flag: "--tag",
      metavar: "<tag>",
      summary: "Documents carrying this tag.",
    },
    {
      flag: "--since",
      metavar: "<YYYY-MM-DD>",
      summary: "Documents whose `generated.at` is on or after this date.",
    },
    { flag: "--kind", metavar: "<kind>", summary: "Work items of this kind: task | bug | chore | research." },
    { flag: "--parent", metavar: "feature/<slug>", summary: "Work items whose parent is this feature." },
    { flag: "--cycle", metavar: "<slug>", summary: "Work items in this cycle." },
    { flag: "--scope", metavar: "<name>", summary: "Features and items in this scope." },
    { flag: "--id", metavar: "<id-or-prefix>", summary: "The work item whose id starts with this." },
  ],

  run({ ctx, format, flags }: Invocation): number {
    // The vocabulary is the REGISTRY's, not a hardcoded list: a project that
    // declared `runbook` in `.project-docs.json` must be able to filter on it.
    // Validating against the built-ins would reject exactly the types
    // `lint.types` exists to allow.
    const data = findData(
      collectPages(ctx),
      parseFilters(
        flags,
        buildRegistry(ctx.config).map((r) => r.type)
      )
    );

    if (format === "json") printEnvelope("find", data);
    else renderText(data);

    // Zero, even on nothing. See the header.
    return ExitCode.Success;
  },
};

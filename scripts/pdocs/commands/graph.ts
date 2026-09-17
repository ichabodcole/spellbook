// `pdocs graph` — the tree's knowledge graph.
//
// PHASE 5 RESOLVED THE PROPOSAL'S OPEN QUESTION — "does `pdocs graph` emit
// today's `--json` shape, or is that shape a lint implementation detail a graph
// command should not inherit?" — in favour of a narrow, ENVELOPED shape built
// on `collectPages`, and this command now looks like every other one.
//
// Two reasons, and the second is the load-bearing one.
//
// The shape it used to emit was `DocsLintReport` raw and unenveloped, kept
// byte-identical for a consumer of `bun docs/lint.ts --json`. There is no such
// consumer: nothing in the scaffold or its fleet parses that output. A
// compatibility constraint with no beneficiary is not a constraint, it is a
// shape nobody chose.
//
// And `DocsLintReport` is a LINT artefact. It carries `problems`, `reachable`,
// `contractExempt`, `tagNeighbors` — fields that exist because a gate needed
// them — and it covers the library tier only, because that is the only tier
// with graph obligations. A graph surface built on it inherits the lint's churn
// and answers `projects/` with silence. `pages.ts` says why the read commands
// span both tiers.
//
// `pdocs orphans` is where the library-only view still lives, and it is still
// sourced from `graphTier`, because orphan-ness is defined against a catalog.

import type { Command, Invocation } from "../cli.ts";
import { ExitCode, printEnvelope } from "../envelope.ts";
import { type Page, collectPages, linksInIndex } from "../pages.ts";

/** One page as the graph reports it: identity, its edges, and nothing about
 *  whether any of it is correct. */
export interface GraphNode {
  path: string;
  tier: "library" | "workbench";
  type: string;
  title: string | null;
  tags: string[];
  related: string[];
  linksOut: string[];
  linksIn: string[];
}

export interface GraphData {
  pages: number;
  byTier: { library: number; workbench: number };
  /** Type -> count, keys sorted. `""` is the honest key for a document whose
   *  folder declares no type; text mode renders it `(none)`. */
  byType: Record<string, number>;
  /** Tag -> the paths carrying it, both levels sorted. */
  tags: Record<string, string[]>;
  /** The ten most linked-to pages, descending, ties broken by path. */
  hubs: Array<{ path: string; title: string | null; linksIn: number }>;
  nodes: GraphNode[];
}

export function graphData(pages: Page[]): GraphData {
  const linksIn = linksInIndex(pages);

  const byType: Record<string, number> = {};
  const tags: Record<string, string[]> = {};
  for (const page of pages) {
    byType[page.type] = (byType[page.type] ?? 0) + 1;
    for (const tag of page.tags) {
      const paths = tags[tag] ?? [];
      paths.push(page.path);
      tags[tag] = paths;
    }
  }

  const sortedKeys = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );

  const nodes: GraphNode[] = pages.map((page) => ({
    path: page.path,
    tier: page.tier,
    type: page.type,
    title: page.title,
    tags: page.tags,
    related: page.related,
    linksOut: page.linksOut,
    linksIn: linksIn.get(page.path) ?? [],
  }));

  return {
    pages: pages.length,
    byTier: {
      library: pages.filter((p) => p.tier === "library").length,
      workbench: pages.filter((p) => p.tier === "workbench").length,
    },
    byType: sortedKeys(byType),
    tags: sortedKeys(
      Object.fromEntries(Object.entries(tags).map(([t, p]) => [t, p.sort()]))
    ),
    // Ties broken by path, so the top ten is stable when a dozen pages have one
    // inbound link each — an unstable tail makes every run look like a change.
    hubs: [...nodes]
      .sort(
        (a, b) =>
          b.linksIn.length - a.linksIn.length ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      )
      .slice(0, 10)
      .map((n) => ({
        path: n.path,
        title: n.title,
        linksIn: n.linksIn.length,
      })),
    nodes,
  };
}

/** A shape, not a dump. Anybody who wants the graph itself asks for
 *  `--format json`. */
function renderText(data: GraphData): void {
  console.log(`── graph (both tiers) ──────────────────────────────────`);
  console.log(`  pages      ${data.pages}`);
  console.log(`  library    ${data.byTier.library}`);
  console.log(`  workbench  ${data.byTier.workbench}`);
  console.log(
    `  links      ${data.nodes.reduce((n, x) => n + x.linksOut.length, 0)}`
  );
  console.log(
    `  related    ${data.nodes.reduce((n, x) => n + x.related.length, 0)}`
  );
  console.log(`  tags       ${Object.keys(data.tags).length}`);

  const types = Object.entries(data.byType);
  if (types.length) {
    console.log(`\n  by type`);
    for (const [type, count] of types)
      console.log(`    ${(type || "(none)").padEnd(20)} ${count}`);
  }

  if (data.hubs.length) {
    console.log(`\n  most linked-to`);
    for (const hub of data.hubs)
      console.log(`    ${String(hub.linksIn).padStart(4)}  ${hub.path}`);
  }
}

export const graph: Command = {
  name: "graph",
  summary: "The knowledge graph: types, tags and edges across both tiers.",
  usage: "pdocs graph [--root <path>] [--format text|json]",
  options: [],

  run({ ctx, format }: Invocation): number {
    const data = graphData(collectPages(ctx));

    if (format === "json") printEnvelope("graph", data);
    else renderText(data);

    return ExitCode.Success;
  },
};

// `pdocs orphans` — library pages unreachable from the catalog.
//
// THE ONE READ COMMAND THAT DOES NOT COVER THE TREE, and it says so everywhere
// a caller can see: in the summary, in the JSON, and in the text header.
//
// Orphan-ness is not a property a document has on its own — it is "unreachable
// from `docs/index.md` by following links". Only the library has a catalog. A
// session note, a proposal, a backlog item are reached by their date and their
// folder README; calling all of them orphans would report a hundred findings
// about a rule that was never meant to apply to them, and the honest count
// would drown in it.
//
// So this is sourced from `graphTier` — the same walk `pdocs check` runs — and
// not from `collectPages`. That is deliberate and it is TESTED: a command that
// computed reachability a second way could disagree with the gate, and then the
// tool telling you what to fix and the gate refusing to let you land would be
// naming different files.

import { join } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import { ExitCode, printEnvelope } from "../envelope.ts";
import { graphTier } from "../lint/rules.ts";

export interface OrphansData {
  /** Always `"library"`. Present so the JSON says what was searched rather than
   *  leaving a caller to infer it from an empty list. */
  tier: "library";
  /** The page reachability is measured from, repo-relative. */
  catalog: string;
  orphans: Array<{ path: string; title: string | null }>;
  count: number;
}

export const orphans: Command = {
  name: "orphans",
  summary:
    "Library pages unreachable from the catalog. The workbench has no catalog.",
  usage: "pdocs orphans [--root <path>] [--format text|json]",
  options: [],

  run({ ctx, format }: Invocation): number {
    const report = graphTier(ctx);

    // `DocsLintNode.path` is relative to the DOCS root; every other read
    // command speaks repo-relative paths, and one tool answering in two path
    // vocabularies is a bug waiting for whoever pipes the two together.
    const rel = (p: string) => join(ctx.config.docsRoot, p);

    const data: OrphansData = {
      tier: "library",
      catalog: rel(report.catalog),
      // The contract pages are exempt from the orphan rule — SCHEMA.md is a
      // document about the tree, not an entry in it — and this must mirror the
      // lint's own exemption or the two disagree.
      orphans: report.nodes
        .filter((n) => !n.reachable && !n.contractExempt)
        .map((n) => ({ path: rel(n.path), title: n.title })),
      count: 0,
    };
    data.count = data.orphans.length;

    if (format === "json") {
      printEnvelope("orphans", data);
      return ExitCode.Success;
    }

    console.log(`── orphans (library tier only) ─────────────────────────`);
    console.log(
      `  unreachable from ${data.catalog}. The workbench is not catalogued and`
    );
    console.log(`  is not searched — see docs/SCHEMA.md.\n`);
    if (data.count === 0) console.log("  none");
    else for (const o of data.orphans) console.log(`  ${o.path}`);

    // An orphan is a finding for `pdocs check` to fail on, not for this command
    // to. This one answers a question.
    return ExitCode.Success;
  },
};

// `pdocs report` — what is missing, grouped by field.
//
// The backfill worklist. It always exits 0: "these documents are missing
// `description`" is an answer, not a failure, and a project mid-adoption runs
// this in a loop until it comes back empty.
//
// The TEXT rendering is a byte-for-byte inheritance from `bun docs/lint.ts
// --report` and is held there by `scripts/pdocs/lint/golden.test.ts`.

import type { Command, Invocation } from "../cli.ts";
import { ExitCode, printEnvelope } from "../envelope.ts";
import { reportWorklist } from "../lint/rules.ts";

export const report: Command = {
  name: "report",
  summary: "What is missing, grouped by field. Always exits 0.",
  usage: "pdocs report [--root <path>] [--format text|json]",
  options: [],

  run({ ctx, format }: Invocation): number {
    const { lines, documents } = reportWorklist(ctx);

    // `lines` is a rendering, and the envelope says so by naming the field
    // `lines` rather than dressing it up as structure it does not have.
    // `documents` is the structure: one `{ path, tier, missing }` per document
    // with anything missing, every one of them rather than ten per folder, in
    // the order `lines` names them — what a backfill split across workers
    // shards by, without a regex over the text.
    if (format === "json") printEnvelope("report", { lines, documents });
    else for (const line of lines) console.log(line);

    return ExitCode.Success;
  },
};

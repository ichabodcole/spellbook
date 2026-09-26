// `pdocs promote <ref>` — turn a single-file item into a folder, so it can own
// documents: `items/<slug>.md` becomes `items/<slug>/item.md` (D2), and every
// link to it, and every link in it, is rewritten to match.
//
// `pdocs new <owned-type> --owner item/<x>` promotes first when it has to, so
// this is the verb for doing it on purpose. Promoting an item that is already
// a folder is a no-op that succeeds: the state the caller asked for holds.

import { join } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import { ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import type { Ctx } from "../lint/rules.ts";
import { moveAndRewrite } from "../move.ts";
import { type WorkEntity, collectWork, entityFileName, resolveRef } from "../work.ts";

export interface PromoteData {
  /** The item's entity file, before and after. Equal when nothing moved. */
  from: string;
  to: string;
  moved: boolean;
  /** Files whose links were rewritten, repo-relative. */
  rewritten: string[];
  links: number;
}

/** Promote one item. A folder item comes back unchanged. */
export function promoteItem(ctx: Ctx, item: WorkEntity): PromoteData {
  if (item.folder !== null)
    return { from: item.path, to: item.path, moved: false, rewritten: [], links: 0 };
  const from = join(ctx.repoRoot, item.path);
  const to = join(from.slice(0, -".md".length), entityFileName("item"));
  const r = moveAndRewrite(ctx, from, to);
  return { from: r.from, to: r.to, moved: true, rewritten: r.rewritten, links: r.links };
}

export const promote: Command = {
  name: "promote",
  summary: "Turn a single-file item into a folder that can own documents.",
  usage: "pdocs promote <item-ref>",
  positionals: [{ name: "ref", required: true }],
  options: [],

  run({ ctx, format, positionals }: Invocation): number {
    const [ref] = positionals;
    if (ref === undefined)
      throw new UsageError("promote needs an item — `pdocs promote item/<slug>` or an id prefix.");
    const item = resolveRef(collectWork(ctx), ref, ["item"]);
    const data = promoteItem(ctx, item);

    if (format === "json") printEnvelope("promote", data);
    else if (!data.moved) console.log(`${data.from} is already a folder — nothing to do`);
    else {
      console.log(`${data.from} -> ${data.to}`);
      console.log(`  rewrote ${data.links} link(s) in ${data.rewritten.length} file(s)`);
    }
    return ExitCode.Success;
  },
};

// `pdocs archive <ref>` — move a finished feature or item into its owner's
// `_archive/` (D15), rewriting every link into it and out of it.
//
// `lifecycle` is the source of truth; `items/_archive/` and
// `features/_archive/` only mirror it, and this command is the one thing that
// moves an entity there. So it refuses an entity that is not `done` or
// `dropped`, naming the state, and moves nothing. Frontmatter is not edited:
// an item is referred to by its `id`, which does not change, so a
// `blocked_by` or `from` pointing at it still resolves.
//
// Archiving what is already archived is a no-op that succeeds.

import { join, relative } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import { ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import { FEATURES_FOLDER, ITEMS_FOLDER } from "../lint/registry.ts";
import { moveAndRewrite } from "../move.ts";
import { ARCHIVE, collectWork, resolveRef } from "../work.ts";

export interface ArchiveData {
  /** The entity's file, or its folder when it has one — before and after. */
  from: string;
  to: string;
  moved: boolean;
  rewritten: string[];
  links: number;
}

export const archive: Command = {
  name: "archive",
  summary: "Move a done or dropped feature or item into its owner's _archive/.",
  usage: "pdocs archive <feature-or-item-ref>",
  positionals: [{ name: "ref", required: true }],
  options: [],

  run({ ctx, format, positionals }: Invocation): number {
    const [ref] = positionals;
    if (ref === undefined)
      throw new UsageError("archive needs a feature or an item — `pdocs archive item/<slug>`.");

    const e = resolveRef(collectWork(ctx), ref, ["feature", "item"]);
    const owner = e.entity === "feature" ? FEATURES_FOLDER : ITEMS_FOLDER;
    const here = e.folder ?? e.docsPath;

    let data: ArchiveData;
    if (e.archived) {
      const path = relative(ctx.repoRoot, join(ctx.docsRoot, here));
      data = { from: path, to: path, moved: false, rewritten: [], links: 0 };
    } else {
      if (e.group !== "completed" && e.group !== "cancelled")
        throw new UsageError(
          `${e.path} is \`lifecycle: ${e.lifecycle ?? "(none)"}\` — only a done or dropped ${e.entity} is archived. ` +
            `Finish it or drop it first (\`pdocs set ${ref} --lifecycle done\`).`,
          { token: ref }
        );
      const from = join(ctx.docsRoot, here);
      const to = join(ctx.docsRoot, owner, ARCHIVE, here.slice(owner.length + 1));
      const r = moveAndRewrite(ctx, from, to);
      data = { ...r, moved: true };
    }

    if (format === "json") printEnvelope("archive", data);
    else if (!data.moved) console.log(`${data.from} is already archived — nothing to do`);
    else {
      console.log(`${data.from} -> ${data.to}`);
      console.log(`  rewrote ${data.links} link(s) in ${data.rewritten.length} file(s)`);
    }
    return ExitCode.Success;
  },
};

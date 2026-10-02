// `pdocs archive <ref>` — move a finished feature, item or cycle into its
// folder's `_archive/` (D15), rewriting every link into it and out of it.
//
// `lifecycle` is the source of truth; `items/_archive/`, `features/_archive/`
// and `cycles/_archive/` only mirror it, and this command is the one thing
// that moves an entity there. So it refuses a feature or item that is not
// `done` or `dropped`, and a cycle that is not `closed` or `abandoned`, naming
// the state, and moves nothing. Frontmatter is not edited: an item is referred
// to by its `id` and a cycle by its slug, neither of which changes, so a
// `blocked_by`, `from` or `cycle:` pointing at it still resolves.
//
// Archiving what is already archived is a no-op that succeeds.

import { join, relative } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import { ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import { CYCLE_ENDS, CYCLES_FOLDER, FEATURES_FOLDER, ITEMS_FOLDER } from "../lint/registry.ts";
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
  summary: "Move a done or dropped feature or item, or a closed or abandoned cycle, into its _archive/.",
  usage: "pdocs archive <feature-item-or-cycle-ref>",
  positionals: [{ name: "ref", required: true }],
  options: [],

  run({ ctx, format, positionals }: Invocation): number {
    const [ref] = positionals;
    if (ref === undefined)
      throw new UsageError(
        "archive needs a feature, an item or a cycle — `pdocs archive item/<slug>`."
      );

    const e = resolveRef(collectWork(ctx), ref, ["feature", "item", "cycle"]);
    const owner =
      e.entity === "feature" ? FEATURES_FOLDER : e.entity === "item" ? ITEMS_FOLDER : CYCLES_FOLDER;
    const here = e.folder ?? e.docsPath;

    let data: ArchiveData;
    if (e.archived) {
      const path = relative(ctx.repoRoot, join(ctx.docsRoot, here));
      data = { from: path, to: path, moved: false, rewritten: [], links: 0 };
    } else {
      // A cycle ends `closed` or `abandoned`; a feature or an item ends in the
      // `completed` or `cancelled` group (`done`, `dropped`).
      const ended =
        e.entity === "cycle"
          ? e.lifecycle !== null && CYCLE_ENDS.includes(e.lifecycle)
          : e.group === "completed" || e.group === "cancelled";
      if (!ended)
        throw new UsageError(
          e.entity === "cycle"
            ? `${e.path} is \`lifecycle: ${e.lifecycle ?? "(none)"}\` — only a closed or abandoned cycle is archived. ` +
                `Close it first (\`pdocs set ${ref} --lifecycle closed --closed YYYY-MM-DD\`, ` +
                `or \`--lifecycle abandoned\` if it was dropped rather than finished).`
            : `${e.path} is \`lifecycle: ${e.lifecycle ?? "(none)"}\` — only a done or dropped ${e.entity} is archived. ` +
                `Finish it or drop it first (\`pdocs set ${ref} --lifecycle done\`).`,
          { token: ref }
        );
      // A cycle is a file directly in `cycles/`; `cycles/_archive/` is the
      // only place it moves to, and the only place it is read as archived.
      if (e.entity === "cycle" && here.split("/").length !== 2)
        throw new UsageError(
          `${e.path} is not directly in ${CYCLES_FOLDER}/ — only \`${CYCLES_FOLDER}/<slug>.md\` is archived.`,
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

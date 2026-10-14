/**
 * The kit path's CLI: the kit's workspace verbs under Scriptorium's name.
 *
 * Reached only through `../cli.ts`'s `run()`, which hands off here when
 * `SCRIPTORIUM_KIT=1`. The launcher (`scripts/cli.ts`) is the shipped one,
 * unchanged, and so is the built artifact it imports (`dist/cli.js`): this
 * module is bundled into it.
 *
 * ⛔ THE DAEMON IS SPAWNED THROUGH THE SAME LAUNCHER AS THE SHIPPED ONE
 * (`scripts/server.ts` → `dist/server.js`), and the caller passes that path in.
 * It is computed in `../cli.ts`, where `import.meta.url` is the bundle's own
 * address; a path computed here would be right in the source tree and wrong in
 * `dist/`, or the other way round. The flag rides the daemon's environment, so
 * its `run()` takes the same turn.
 *
 * No surface yet: `open` prints the handshake and, without `--no-open`, opens a
 * browser on a page that says so (`./server.ts`). The verbs that differ from the
 * shipped CLI are the kit's; the item records the delta.
 */

import { createWorkspaceCli, type WorkspaceCli } from "../../../kit/workspace/verbs";
import { KIT_FLAG, kitSessionsRoot, scriptoriumApp } from "./app";

export type KitCliDeps = {
  /** The daemon launcher, absolute: `<skill>/scripts/server.ts`. */
  serverScript: string;
  /** The shipped `version` row's payload, so both paths answer the same `--version`. */
  version: () => Record<string, unknown>;
};

export function scriptoriumKitCli(deps: KitCliDeps): WorkspaceCli {
  return createWorkspaceCli({
    app: scriptoriumApp,
    summary:
      "a co-present markdown editor on the workspace kit (SCRIPTORIUM_KIT=1): the human edits, you write new versions.",
    daemon: {
      command: "bun",
      args: ["run", deps.serverScript],
      // Explicit, not inherited by accident: the daemon must take the kit path too.
      env: { ...process.env, [KIT_FLAG]: "1" },
    },
    sessionsRoot: () => kitSessionsRoot(),
    version: () => ({ ...deps.version(), path: "kit" }),
    helpFooter:
      "  This is the kit path (SCRIPTORIUM_KIT=1). Its sessions live under\n  $SCRIPTORIUM_HOME/kit/sessions, apart from the shipped Scriptorium's. It has no\n  surface yet: run open with --no-open, and work through these verbs.",
  });
}

/** The hand-off `../cli.ts` makes. Returns the exit code, as the shipped `run()` does. */
export async function runKitCli(argv: string[], deps: KitCliDeps): Promise<number> {
  return await scriptoriumKitCli(deps).run(argv);
}

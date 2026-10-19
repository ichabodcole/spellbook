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

import { resolve } from "node:path";
import { errorEnvelope } from "../../../kit/wire/errors";
import { createWorkspaceCli, type WorkspaceCli } from "../../../kit/workspace/verbs";
import {
  KIT_FLAG,
  kitMigrateRefusal,
  kitSessionsRoot,
  MIGRATE_FLAG,
  scriptoriumApp,
  scriptoriumHome,
} from "./app";
import { scriptoriumKitCommands } from "./commands";
// Scriptorium's document kinds (`.mdx`), registered before any name is judged.
import "./docKinds";
import { scriptoriumWikiCommands, WIKI_OPTIONS } from "./wikiCommands";

export type KitCliDeps = {
  /** The daemon launcher, absolute: `<skill>/scripts/server.ts`. */
  serverScript: string;
  /** Where the daemon runs (Contract 5): `src/scriptorium/` in dev mode, for its bunfig. */
  daemonCwd: () => string;
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
      cwd: deps.daemonCwd(),
      // Explicit, not inherited by accident: the daemon must take the kit path too.
      env: { ...process.env, [KIT_FLAG]: "1" },
    },
    sessionsRoot: () => kitSessionsRoot(),
    // `open` run in `$SCRIPTORIUM_HOME`, or a folder in it (the shipped
    // `sessions/`), adds no set that would mirror a session's own files.
    appHome: () => scriptoriumHome(),
    version: () => ({ ...deps.version(), path: "kit" }),
    // The shipped verbs, with the shipped words: the kit path keeps the hidden
    // lists in its app slot (`./hide.ts`), not on the kit's entries.
    options: WIKI_OPTIONS,
    commands: (h) => [
      ...scriptoriumKitCommands(h),
      ...scriptoriumWikiCommands(h),
      {
        name: "hide",
        flags: [...h.SESSION],
        positionals: [{ name: "path", required: true }],
        describe: "remove a document, folder or set from Scriptorium — the files stay on disk",
        run: async (inv) => {
          h.printJson(
            await h.postCmd(h.sessionOf(inv), {
              op: "scriptorium.hide",
              path: resolve(inv.pos[0] as string),
            }),
          );
        },
      },
      {
        name: "unhide",
        flags: [...h.SESSION],
        positionals: [{ name: "entry", required: true }],
        describe: "bring back everything hidden in a set (its entry id, from state)",
        run: async (inv) => {
          h.printJson(
            await h.postCmd(h.sessionOf(inv), { op: "scriptorium.unhide", entry: inv.pos[0] }),
          );
        },
      },
    ],
    helpFooter:
      "  This is the kit path (SCRIPTORIUM_KIT=1). Its sessions live under\n  $SCRIPTORIUM_HOME/kit/sessions, apart from the shipped Scriptorium's. Its surface\n  is an interim frame (sets, chat, notes, tasks): it shows no document yet, so\n  read and write documents through these verbs.",
  });
}

/** The hand-off `../cli.ts` makes. Returns the exit code, as the shipped `run()` does. */
export async function runKitCli(argv: string[], deps: KitCliDeps): Promise<number> {
  // The conversion dry run on the real home is refused before any verb runs.
  const refused = kitMigrateRefusal();
  if (refused !== null) {
    process.stderr.write(
      errorEnvelope("usage", refused, {
        hint: `unset ${MIGRATE_FLAG}, or set SCRIPTORIUM_HOME to a scratch copy of the sessions`,
      }),
    );
    return 2;
  }
  return await scriptoriumKitCli(deps).run(argv);
}

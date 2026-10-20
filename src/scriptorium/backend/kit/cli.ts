/**
 * Scriptorium's CLI: the kit's workspace verbs under Scriptorium's name.
 *
 * Reached through `../cli.ts`'s `run()`, which hands off here unless the
 * earlier Scriptorium is asked for (`SCRIPTORIUM_SHIPPED=1`, `../hatch.ts`).
 * The launcher (`scripts/cli.ts`) imports the built artifact (`dist/cli.js`):
 * this module is bundled into it.
 *
 * ⛔ THE DAEMON IS SPAWNED THROUGH THE SKILL'S LAUNCHER
 * (`scripts/server.ts` → `dist/server.js`), and the caller passes that path in.
 * It is computed in `../cli.ts`, where `import.meta.url` is the bundle's own
 * address; a path computed here would be right in the source tree and wrong in
 * `dist/`, or the other way round.
 *
 * `open` prints the handshake and, without `--no-open`, opens a browser on the
 * kit page: the workspace shell around the document pane (`./server.ts`,
 * `surface/kit/`). The verbs that differ from the shipped CLI are the kit's;
 * the item records the delta.
 */

import { resolve } from "node:path";
import { createWorkspaceCli, type WorkspaceCli } from "../../../kit/workspace/verbs";
import { scriptoriumApp, scriptoriumHome, sessionsRoot } from "./app";
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
    summary: "a co-present markdown editor: the human edits, you write new versions.",
    daemon: {
      command: "bun",
      args: ["run", deps.serverScript],
      cwd: deps.daemonCwd(),
      // The CLI's own environment: `SCRIPTORIUM_HOME` rides along, and the
      // hatch variable is never `1` here (`../cli.ts` would not have come here).
      env: { ...process.env },
    },
    sessionsRoot: () => sessionsRoot(),
    // `open` run in `$SCRIPTORIUM_HOME`, or a folder in it (the shipped
    // `sessions/`), adds no set that would mirror a session's own files.
    appHome: () => scriptoriumHome(),
    version: deps.version,
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
      "  Sessions live under $SCRIPTORIUM_HOME/sessions. A session the earlier\n  Scriptorium saved is converted the first time it is restored; its old\n  manifest is kept beside it as manifest.pre-migrate.json. The surface\n  is the kit's workspace shell: the sets, the open document (raw, rendered or\n  split, with versions and compare), and chat, notes and tasks, where the human\n  reads and edits while you work through these verbs.",
  });
}

/** The hand-off `../cli.ts` makes. Returns the exit code, as the shipped `run()` does. */
export async function runKitCli(argv: string[], deps: KitCliDeps): Promise<number> {
  return await scriptoriumKitCli(deps).run(argv);
}

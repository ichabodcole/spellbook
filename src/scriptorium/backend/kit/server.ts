/**
 * The kit path's daemon: the kit's workspace daemon under Scriptorium's name.
 *
 * Reached only through `../server.ts`'s `run()`, which hands off here when
 * `SCRIPTORIUM_KIT=1`; the launcher (`scripts/server.ts`) and the artifact it
 * imports (`dist/server.js`) are the shipped ones.
 *
 * What it does not have yet: a surface, a later cycle's. `GET /` answers with
 * a short page saying so, so a browser that `open` started shows a sentence and
 * not a JSON 404.
 *
 * The wiki layer is here: `hide` and `unhide` (`./hide.ts`), frontmatter
 * references and wiki forms (`./links.ts`), and meta, find, forget, the move
 * plan and the remove verbs (`./wiki.ts`); `make-set` and `add-folder` are the
 * kit's structure ops (`./commands.ts`).
 *
 * It has no workspace to set, so no undo for setting one: the app declares no
 * home workspace (`homeWorkspace: false`, `./app.ts`), and new files go where
 * the caller points.
 */

import {
  createWorkspaceDaemon,
  runWorkspaceDaemon,
  type WorkspaceDaemon,
  type WorkspaceDaemonOptions,
} from "../../../kit/workspace/server";
import type { AppDeclaration } from "../../../kit/workspace/session";
import {
  kitMigrateOn,
  kitMigrateRefusal,
  kitMigrateWriteRefusal,
  kitSessionsRoot,
  scriptoriumApp,
  scriptoriumHome,
} from "./app";
import { convertShippedManifest } from "./convert";
import { hideVerbs, liveHiddenLists } from "./hide";
import { scriptoriumLinkSlot } from "./links";
import { docMeta, wikiVerbs } from "./wiki";

/**
 * The app in the conversion dry run (`SCRIPTORIUM_KIT_MIGRATE=1`): the kit
 * path's own, with the converter for the shipped Scriptorium's sessions. Only
 * the daemon restores, so only the daemon carries it.
 */
export const migratingApp: AppDeclaration = {
  ...scriptoriumApp,
  migrateManifest: convertShippedManifest,
  // Asked again where the conversion is written, not only at boot.
  migrateWriteRefusal: (at) => kitMigrateWriteRefusal(at),
};

/** What a browser shows at the session's URL while the kit path has no surface. */
export const NO_SURFACE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Scriptorium (kit path)</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem">
<h1 style="font-size: 1.25rem">Scriptorium, kit path</h1>
<p>This session is running on the workspace kit (<code>SCRIPTORIUM_KIT=1</code>). It has no
surface yet: the agent works with it through the CLI, and you can follow along in its chat.</p>
</body>
`;

export function kitDaemonOptions(
  overrides: Partial<WorkspaceDaemonOptions> = {},
): WorkspaceDaemonOptions {
  return {
    app: kitMigrateOn() ? migratingApp : scriptoriumApp,
    sessionsRoot: kitSessionsRoot(),
    // $SCRIPTORIUM_HOME: the shipped sessions, the kit path's, logs and prefs.
    // No set shows it and nothing is written in it from a structure op.
    appHome: scriptoriumHome(),
    verbs: { ...hideVerbs, ...wikiVerbs },
    // What `hide` left out, per entry id: the shipped state carried it on each
    // entry (`hidden`); the kit's entries are the kit's, so it rides here.
    appState: (ctx) => ({ hidden: liveHiddenLists(ctx.session), ...docMeta(ctx.session) }),
    // Frontmatter references as edges, and the wiki forms as a resolver (kit-link-edges-slot).
    links: scriptoriumLinkSlot(),
    http: (req, url) =>
      req.method === "GET" && url.pathname === "/"
        ? new Response(NO_SURFACE_PAGE, {
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        : undefined,
    ...overrides,
  };
}

export const kitDaemon = (overrides: Partial<WorkspaceDaemonOptions> = {}): WorkspaceDaemon =>
  createWorkspaceDaemon(kitDaemonOptions(overrides));

/** The hand-off `../server.ts` makes: parse the daemon's flags, boot, handshake, wait. */
export async function runKitDaemon(argv: string[]): Promise<number> {
  // The dry-run flag on the real home is refused before anything boots.
  const refused = kitMigrateRefusal();
  if (refused !== null) {
    process.stderr.write(`scriptorium: ${refused}\n`);
    return 2;
  }
  return await runWorkspaceDaemon(argv, (flags) => kitDaemon({ ...flags }), "scriptorium");
}

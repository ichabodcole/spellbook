/**
 * The kit path's daemon: the kit's workspace daemon under Scriptorium's name.
 *
 * Reached only through `../server.ts`'s `run()`, which hands off here when
 * `SCRIPTORIUM_KIT=1`; the launcher (`scripts/server.ts`) and the artifact it
 * imports (`dist/server.js`) are the shipped ones.
 *
 * What it does not have yet, each a later cycle's:
 * - a surface. `GET /` answers with a short page saying so, so a browser that
 *   `open` started shows a sentence and not a JSON 404;
 * - the rest of the wiki layer (meta, find, make-set, forget, …); `hide` and
 *   `unhide` are here (`./hide.ts`);
 * - undo for setting the workspace, which the shipped Scriptorium keeps.
 */

import {
  createWorkspaceDaemon,
  runWorkspaceDaemon,
  type WorkspaceDaemon,
  type WorkspaceDaemonOptions,
} from "../../../kit/workspace/server";
import { kitSessionsRoot, scriptoriumApp } from "./app";
import { hideVerbs, liveHiddenLists } from "./hide";

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
    app: scriptoriumApp,
    sessionsRoot: kitSessionsRoot(),
    verbs: { ...hideVerbs },
    // What `hide` left out, per entry id: the shipped state carried it on each
    // entry (`hidden`); the kit's entries are the kit's, so it rides here.
    appState: (ctx) => ({ hidden: liveHiddenLists(ctx.session) }),
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
  return await runWorkspaceDaemon(argv, (flags) => kitDaemon({ ...flags }), "scriptorium");
}

/**
 * The kit path's daemon: the kit's workspace daemon under Scriptorium's name.
 *
 * Reached only through `../server.ts`'s `run()`, which hands off here when
 * `SCRIPTORIUM_KIT=1`; the launcher (`scripts/server.ts`) and the artifact it
 * imports (`dist/server.js`) are the shipped ones.
 *
 * Its surface is the interim frame (`src/scriptorium/surface/kit/`, built into
 * the skill's `dist/kit/`): the kit's context and chat panes, until cycle 5's
 * shell replaces it. See `frameSurface` below for where it is found.
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

import { existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The daemon's own folder: the skill's `dist/` once bundled into
 * `dist/server.js` (the launcher's, and a published plugin's).
 */
const HERE = import.meta.dir;
/** The built frame (`src/build.ts` builds `surface/kit/` into `dist/kit/`): release mode. */
const FRAME_DIST = join(HERE, "kit");
/**
 * The frame's source page, for dev mode (`SPELLBOOK_SURFACE_MODE=dev`, or no
 * built frame): from `dist/`, five levels up is the repository. Imported by a
 * computed path, so the backend build does not follow it into the surface's
 * `.tsx` and Tailwind graph (the shipped daemon's literal import is left out by
 * `src/build.ts`'s `external` instead, which matches only `surface/index.html`).
 */
const FRAME_DEV_ENTRY = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "src",
  "scriptorium",
  "surface",
  "kit",
  "index.html",
);

/**
 * Where the interim frame is, as the kit daemon's `surface` option.
 *
 * ⚠ BOTH PATHS ARE TRUE ONLY IN THE BUNDLE (`grimoire/spawn-path-ward.test.ts`
 * resolves them from the emitted `dist/server.js`). Run from source, as the
 * tests run it, `HERE` is this folder: there is no built frame beside it, so
 * the daemon is in dev mode, and no source page five levels up, so it serves
 * no page. A test that wants the page passes the committed build as `distDir`.
 */
export function frameSurface(): { distDir: string; devIndex: () => Promise<unknown> } {
  return {
    distDir: FRAME_DIST,
    devIndex: async () =>
      existsSync(FRAME_DEV_ENTRY) ? (await import(FRAME_DEV_ENTRY)).default : undefined,
  };
}

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
    // The interim frame at `/` (release: `dist/kit/`, and its chunks beside it).
    surface: frameSurface(),
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

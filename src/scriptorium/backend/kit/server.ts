/**
 * The kit path's daemon: the kit's workspace daemon under Scriptorium's name.
 *
 * Reached only through `../server.ts`'s `run()`, which hands off here when
 * `SCRIPTORIUM_KIT=1`; the launcher (`scripts/server.ts`) and the artifact it
 * imports (`dist/server.js`) are the shipped ones.
 *
 * Its surface is the kit's shell around the kit's document pane
 * (`src/scriptorium/surface/kit/`, built into the skill's `dist/kit/`). See
 * `frameSurface` below for where it is found, and `kitLauncher` for the
 * restore command the surface prints.
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
import { commandLine } from "../../../kit/wire/tailHandoff";
import {
  createWorkspaceDaemon,
  runWorkspaceDaemon,
  type WorkspaceDaemon,
  type WorkspaceDaemonOptions,
} from "../../../kit/workspace/server";
import type { AppDeclaration } from "../../../kit/workspace/session";
import {
  KIT_FLAG,
  kitMigrateOn,
  kitMigrateRefusal,
  kitMigrateWriteRefusal,
  kitSessionsRoot,
  scriptoriumApp,
  scriptoriumHome,
} from "./app";
import { convertShippedManifest } from "./convert";
// Scriptorium's document kinds (`.mdx`), registered before any tree is read.
import "./docKinds";
import { hideVerbs, liveHiddenLists } from "./hide";
import { scriptoriumLinkSlot } from "./links";
import { mapVerbs } from "./map";
import { docMeta, noFrontmatter, wikiVerbs } from "./wiki";

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

/**
 * How the human runs this Scriptorium's CLI, as the surface prints it in the
 * ended dialog's restore command (`AppDeclaration.launcher`): the flag, then
 * `bun` on the skill's CLI launcher, `<skill>/scripts/cli.ts`, found from the
 * bundle's `dist/`. Without the flag the command would reach the shipped
 * Scriptorium, which refuses a kit-path session. A `SCRIPTORIUM_HOME` the
 * daemon was given rides along too, since the session lives under it.
 *
 * Undefined where no launcher sits beside the daemon (run from source, as the
 * tests run it): the surface then prints the bare verb, as it always has.
 */
export function kitLauncher(
  here: string = HERE,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const cli = join(here, "..", "scripts", "cli.ts");
  if (!existsSync(cli)) return undefined;
  const home = env.SCRIPTORIUM_HOME ? [`SCRIPTORIUM_HOME=${scriptoriumHome(env)}`] : [];
  return commandLine([...home, `${KIT_FLAG}=1`, "bun", cli]);
}

/** The app as the daemon declares it: with its launcher, where there is one. */
function withLauncher(app: AppDeclaration): AppDeclaration {
  const launcher = kitLauncher();
  return launcher ? { ...app, launcher } : app;
}

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
 * Where the kit page is (the shell, `surface/kit/`), as the kit daemon's `surface` option.
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
    app: withLauncher(kitMigrateOn() ? migratingApp : scriptoriumApp),
    sessionsRoot: kitSessionsRoot(),
    // $SCRIPTORIUM_HOME: the shipped sessions, the kit path's, logs and prefs.
    // No set shows it and nothing is written in it from a structure op.
    appHome: scriptoriumHome(),
    verbs: { ...hideVerbs, ...wikiVerbs, ...mapVerbs },
    // What `hide` left out, per entry id: the shipped state carried it on each
    // entry (`hidden`); the kit's entries are the kit's, so it rides here.
    // Which open documents have no block (E35's offer), read by every surface.
    appState: (ctx) => ({
      hidden: liveHiddenLists(ctx.session),
      ...docMeta(ctx.session),
      ...noFrontmatter(ctx.session),
    }),
    // Frontmatter references as edges, and the wiki forms as a resolver (kit-link-edges-slot).
    links: scriptoriumLinkSlot(),
    // The shipped map said "N leaving the set": the link check lists them, in Scriptorium's word.
    linkCheck: { leaving: true, noun: "set" },
    // The kit page at `/` (release: `dist/kit/`, and its chunks beside it).
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

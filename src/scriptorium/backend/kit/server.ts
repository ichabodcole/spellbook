/**
 * Scriptorium's daemon: the kit's workspace daemon under Scriptorium's name.
 *
 * Reached through `../server.ts`'s `run()`. The launcher (`scripts/server.ts`)
 * imports the built artifact (`dist/server.js`): this module is bundled into
 * it.
 *
 * Its surface is the kit's shell around the kit's document pane
 * (`src/scriptorium/surface/`, built into the skill's `dist/`). See
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
import { migrateWriteRefusal, scriptoriumApp, scriptoriumHome, sessionsRoot } from "./app";
import { convertShippedManifest } from "./convert";
// Scriptorium's document kinds (`.mdx`), registered before any tree is read.
import "./docKinds";
import { hideVerbs, liveHiddenLists } from "./hide";
import { scriptoriumLinkSlot } from "./links";
import { mapVerbs } from "./map";
import { docMeta, noFrontmatter, wikiVerbs } from "./wiki";

/**
 * The app as the daemon runs it: Scriptorium's, with the converter for the
 * sessions the earlier Scriptorium saved in the same root. Only the daemon
 * restores, so only the daemon carries it (the CLI's bundle need not).
 */
export const daemonApp: AppDeclaration = {
  ...scriptoriumApp,
  migrateManifest: convertShippedManifest,
  // Asked where the conversion is written, on the paths as they are then.
  migrateWriteRefusal: (at) => migrateWriteRefusal(at),
};

/**
 * The daemon's own folder: the skill's `dist/` once bundled into
 * `dist/server.js` (the launcher's, and a published plugin's).
 */
const HERE = import.meta.dir;

/**
 * How the human runs this Scriptorium's CLI, as the surface prints it in the
 * ended dialog's restore command (`AppDeclaration.launcher`): `bun` on the
 * skill's CLI launcher, `<skill>/scripts/cli.ts`, found from the bundle's
 * `dist/`. A `SCRIPTORIUM_HOME` the daemon was given rides along, since the
 * session lives under it.
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
  return commandLine([...home, "bun", cli]);
}

/** The app as the daemon declares it: with its launcher, where there is one. */
function withLauncher(app: AppDeclaration): AppDeclaration {
  const launcher = kitLauncher();
  return launcher ? { ...app, launcher } : app;
}

/** The skill's `dist/`: see `frameSurface`. */
const DIST_DIR = join(HERE, "..", "dist");

/**
 * Where Scriptorium's page is, as the kit daemon's `surface` option.
 *
 * Release: the built page is in the skill's `dist/` (`src/build.ts` builds
 * `src/scriptorium/surface/` there), named up and back down from this
 * module's folder (`DIST_DIR`), which in the bundle (`dist/server.js`) is
 * `dist/` itself. The house's spelling: `grimoire/spawn-path-ward.test.ts`
 * reads the `join` as a directory pin and asserts it lands on a built page.
 *
 * Dev (`SPELLBOOK_SURFACE_MODE=dev`, or no built page): the source page, by
 * the house's literal import, five levels up from `dist/` to the repository.
 * `src/build.ts`'s `external` leaves that one specifier unresolved in the
 * bundle, byte for byte, so it is resolved at runtime against `dist/`, and the
 * backend build never follows it into the surface's `.tsx` and Tailwind graph
 * (`grimoire/import-boundary-wards.test.ts` pins it).
 *
 * ⚠ BOTH ARE TRUE ONLY IN THE BUNDLE. Run from source, as the tests run it,
 * `HERE` is this folder: there is no built page at `DIST_DIR`, so the daemon
 * is in dev mode, and the specifier resolves to no file from here, so the import
 * fails and it serves no page, as it did when the frame's path was computed.
 * A test that wants the page passes the committed build as `distDir`.
 */
export function frameSurface(): { distDir: string; devIndex: () => Promise<unknown> } {
  return {
    distDir: DIST_DIR,
    devIndex: async () => {
      try {
        return (await import("../../../../../src/scriptorium/surface/index.html")).default;
      } catch {
        // No source page at that address: a published plugin, or the source tree.
        return undefined;
      }
    },
  };
}

export function kitDaemonOptions(
  overrides: Partial<WorkspaceDaemonOptions> = {},
): WorkspaceDaemonOptions {
  return {
    app: withLauncher(daemonApp),
    sessionsRoot: sessionsRoot(),
    // $SCRIPTORIUM_HOME: the sessions, the logs and the prefs.
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
    // The page at `/` (release: `dist/`, and its chunks beside it).
    surface: frameSurface(),
    ...overrides,
  };
}

export const kitDaemon = (overrides: Partial<WorkspaceDaemonOptions> = {}): WorkspaceDaemon =>
  createWorkspaceDaemon(kitDaemonOptions(overrides));

/** The hand-off `../server.ts` makes: parse the daemon's flags, boot, handshake, wait. */
export async function runKitDaemon(argv: string[]): Promise<number> {
  return await runWorkspaceDaemon(argv, (flags) => kitDaemon({ ...flags }), "scriptorium");
}

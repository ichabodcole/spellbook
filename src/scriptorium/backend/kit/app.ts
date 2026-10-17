/**
 * The second Scriptorium: the app declaration the kit path runs on.
 *
 * With `SCRIPTORIUM_KIT=1`, Scriptorium's CLI and daemon run on the kit's
 * workspace daemon (`createWorkspaceDaemon`, `createWorkspaceCli`) instead of
 * the shipped backend beside this folder. Nothing else changes without the
 * flag. The two Scriptoriums live side by side until the cutover cycle.
 *
 * ⛔ THIS FILE IS SHARED BY BOTH ENTRIES, so it imports no daemon code: the
 * CLI's bundle (`dist/cli.js`) must not carry the kit's server. Types only from
 * the kit.
 *
 * ⛔ THE SESSIONS ROOT IS SEPARATE, AND THAT IS THE WHOLE SAFETY OF THE FLAG.
 * Both apps write `format: 1` manifests. The kit refuses a Scriptorium manifest
 * (`kit-workspace-manifest-guard`), but the shipped Scriptorium does not refuse
 * a kit one. So the kit path keeps its sessions under
 * `$SCRIPTORIUM_HOME/kit/sessions`, which the shipped daemon never lists or
 * restores from (it reads `$SCRIPTORIUM_HOME/sessions/<id>` only). The kit's
 * logs and prefs sit beside it (`kit/logs`, `kit/prefs.json`), not beside the
 * shipped ones.
 *
 * The one exception is the conversion dry run (`SCRIPTORIUM_KIT_MIGRATE=1`,
 * below), which reads the shipped root on purpose, converting each session as
 * it is restored, and is refused anywhere but a scratch copy of the sessions.
 */

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
// The kit's one reader of the home: a test preload moves it, and a test run
// that has the real home is refused it (`os.homedir()` is neither).
import { accountHome, homeDir } from "../../../kit/lib/home";
// The kit's one `onDisk`: it follows a link that leads nowhere yet, and a
// `..` that passes through a link, exactly as the disk would. A copy here
// once did neither, and a dangling `sessions` link passed the refusal.
import { onDisk, within } from "../../../kit/workspace/noHome";
import type { AppDeclaration } from "../../../kit/workspace/session";

/**
 * What the kit path keeps in the app slot for `hide`: per context entry, the
 * rels hidden in it (POSIX, from the entry's root), as the shipped
 * `ContextEntry.hidden` holds them. A hidden folder hides everything under it.
 */
export type HiddenLists = Record<string, string[]>;

/** The slot's hidden lists, whatever the slot holds (a missing or odd value is none). */
export function hiddenLists(slot: Readonly<Record<string, unknown>>): HiddenLists {
  const h = slot.hidden;
  if (h === null || typeof h !== "object" || Array.isArray(h)) return {};
  const out: HiddenLists = {};
  for (const [id, rels] of Object.entries(h as Record<string, unknown>))
    if (Array.isArray(rels)) out[id] = rels.filter((r): r is string => typeof r === "string");
  return out;
}

/** The flag. Exactly `1`: any other value, or none, is the shipped Scriptorium. */
export const KIT_FLAG = "SCRIPTORIUM_KIT";

export function kitPathOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KIT_FLAG] === "1";
}

/** `$SCRIPTORIUM_HOME`, default `~/.scriptorium`: the shipped daemon's rule, read the same way. */
export function scriptoriumHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SCRIPTORIUM_HOME ?? join(homeDir(), ".scriptorium"));
}

/**
 * The conversion dry run's flag: the kit path reads the shipped Scriptorium's
 * own sessions, converting each as it is restored (`./convert.ts`).
 *
 * ⛔ OFF FOR REAL USE UNTIL THE CUTOVER, three ways:
 * - it does nothing without `SCRIPTORIUM_KIT=1` as well;
 * - it is refused unless `SCRIPTORIUM_HOME` is set, and is not the default
 *   `~/.scriptorium`: a dry run works on a copy, never on the real sessions,
 *   because a converted manifest is the kit's and the shipped daemon refuses it;
 * - without it, the kit path's app has no converter and its sessions root is
 *   `kit/sessions`, so a shipped manifest is never converted, and is refused
 *   (`refuseScriptorium`) if one is ever found there.
 *
 * Why a second flag, and not "convert whatever is under the shipped root": the
 * kit path never reads the shipped root, so that rule would never fire, and
 * pointing it there is the whole act. One flag that both points it there and
 * turns the converter on keeps the two from ever happening apart. The cutover
 * drops the flag and the home check, and makes both the default.
 */
export const MIGRATE_FLAG = "SCRIPTORIUM_KIT_MIGRATE";

/**
 * Why the dry-run flag is refused here, or null when it is off or allowed.
 *
 * ⛔ THE REAL SESSIONS ARE REFUSED BY ANY SPELLING. `homeDir()` reads `HOME`,
 * which a caller can point anywhere, so the real home is also found apart from
 * it (`realHome`, by default the account's own home from the user database),
 * and the paths are compared as the disk resolves them: a symlinked
 * `SCRIPTORIUM_HOME`, or a scratch home whose `sessions` is a symlink to the
 * real one, is the real sessions. Refused when `SCRIPTORIUM_HOME` resolves to
 * either home's `.scriptorium`, or the sessions root resolves to either home's
 * `.scriptorium/sessions` or inside it. `realHome` is a parameter so a test can
 * stand up a fake one; nothing else passes it.
 */
export function kitMigrateRefusal(
  env: NodeJS.ProcessEnv = process.env,
  realHome: string | null = accountHome(),
): string | null {
  if (!kitPathOn(env) || env[MIGRATE_FLAG] !== "1") return null;
  const set = env.SCRIPTORIUM_HOME;
  if (set === undefined || set === "")
    return `${MIGRATE_FLAG}=1 converts the sessions under $SCRIPTORIUM_HOME, and SCRIPTORIUM_HOME is not set: until the cutover it runs only on a copy. Copy the sessions into a scratch home and set SCRIPTORIUM_HOME to it`;
  const users = [homeDir(), ...(realHome ? [realHome] : [])];
  const homes = users.map((h) => onDisk(join(h, ".scriptorium")));
  const home = onDisk(set);
  const sessions = onDisk(join(resolve(set), "sessions"));
  // Refused: a home that is a user's home itself, or lies in a real
  // `.scriptorium` (it, or a folder inside it); a sessions root that lies in
  // one, or holds one (a `sessions` linked to the real `.scriptorium` or to
  // the real home). Each compared as the disk resolves it.
  const real = (p: string) => homes.some((h) => within(p, h) || within(h, p));
  if (users.some((u) => home === onDisk(u)) || homes.some((h) => within(home, h)) || real(sessions))
    return REAL_REFUSAL;
  return null;
}

const REAL_REFUSAL = `${MIGRATE_FLAG}=1 will not convert the real sessions in ~/.scriptorium before the cutover: copy them into a scratch home and set SCRIPTORIUM_HOME to it`;

/**
 * Why the dry run may not write the conversion of the session at `at` now, or
 * null. Asked when the converted manifest and its kept copy are about to be
 * written (`AppDeclaration.migrateWriteRefusal`), so a sessions folder swapped
 * for a link after boot is caught where it matters:
 * - the boot rule again (`kitMigrateRefusal`), on the paths as they are now;
 * - the session's folder must really be inside the sessions root as the disk
 *   resolves both (one session folder linked in from elsewhere is refused),
 *   and must not lie in a real `.scriptorium`;
 * - its manifest must not be a hard link (a second name for a file elsewhere).
 */
export function kitMigrateWriteRefusal(
  at: { dir: string; sessionsRoot: string },
  env: NodeJS.ProcessEnv = process.env,
  realHome: string | null = accountHome(),
): string | null {
  const boot = kitMigrateRefusal(env, realHome);
  if (boot !== null) return boot;
  const dir = onDisk(at.dir);
  const root = onDisk(at.sessionsRoot);
  if (dir === root || !within(dir, root))
    return `its folder ${at.dir} leads outside the sessions folder (to ${dir}): it is converted only where it is`;
  const homes = [homeDir(), ...(realHome ? [realHome] : [])].map((h) =>
    onDisk(join(h, ".scriptorium")),
  );
  if (homes.some((h) => within(dir, h))) return REAL_REFUSAL;
  try {
    if (lstatSync(join(at.dir, "manifest.json")).nlink > 1)
      return "its manifest is a hard link to a file elsewhere: copy the session folder, do not link it";
  } catch {
    /* no manifest: the restore says so */
  }
  return null;
}

/** The dry run is on: both flags, and a home that is not the real one. */
export function kitMigrateOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return kitPathOn(env) && env[MIGRATE_FLAG] === "1" && kitMigrateRefusal(env) === null;
}

/**
 * Where the kit path keeps its sessions: `$SCRIPTORIUM_HOME/kit/sessions`; in
 * the conversion dry run, the shipped root `$SCRIPTORIUM_HOME/sessions`, where
 * the sessions stay after the cutover (their version files never move).
 */
export function kitSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (kitMigrateOn(env)) return join(scriptoriumHome(env), "sessions");
  return join(scriptoriumHome(env), "kit", "sessions");
}

export const scriptoriumApp: AppDeclaration = {
  name: "scriptorium",
  title: "Scriptorium",
  // Slot version 2: the hidden lists (`hide`). Version 1 kept nothing, so it
  // gains an empty `hidden`. docMeta is not stored: it is computed for
  // `appState` (`./wiki.ts`).
  slot: { version: 2, migrate: (prev) => ({ ...prev, hidden: hiddenLists(prev) }) },
  // `hide` on the kit's tree scan: what an entry's hidden list names is left
  // out of the tree, and so out of search, links and the graph. The files stay
  // on disk, and the list rides the manifest, so a restart and every rescan
  // see it.
  scan: ({ entryId, slot }) => {
    const rels = hiddenLists(slot)[entryId];
    if (!rels?.length) return undefined;
    const skip = new Set(rels);
    return { skip: (rel) => skip.has(rel) };
  },
  // No default workspace (`scriptorium-no-default-workspace`, ruled
  // 2026-10-16): a new file or folder goes where the caller points, never to
  // a folder nobody chose. The folder `open` ran in is an ordinary set.
  homeWorkspace: false,
  locationHint:
    "name a place inside a set (`state` lists them), such as the folder of the document under discussion: `new-doc <folder>/<name>.md`, `new-folder <folder>/<name>`, `import <file> --into <folder>`. To make a new place: `add-folder <path>` (anywhere, as a new set), `make-set <doc>`, or `add <folder>` for one that exists",
  // Both apps are named scriptorium, so the kit's generic refusal ("restore it
  // with the app that wrote it; scriptorium will not read it") names this app
  // twice. Say which Scriptorium wrote it, and how to open it there.
  refuseScriptorium: (sessionId) => ({
    message: `session ${sessionId} is a shipped Scriptorium session, not a kit-path one`,
    hint: `open it without SCRIPTORIUM_KIT: unset SCRIPTORIUM_KIT, then open --restore ${sessionId} (its home is $SCRIPTORIUM_HOME/sessions, not kit/sessions)`,
  }),
};

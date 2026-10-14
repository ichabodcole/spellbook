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
 */

import { join, resolve } from "node:path";
// The kit's one reader of the home: a test preload moves it, and a test run
// that has the real home is refused it (`os.homedir()` is neither).
import { homeDir } from "../../../kit/lib/home";
import type { AppDeclaration } from "../../../kit/workspace/session";

/** The flag. Exactly `1`: any other value, or none, is the shipped Scriptorium. */
export const KIT_FLAG = "SCRIPTORIUM_KIT";

export function kitPathOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KIT_FLAG] === "1";
}

/** `$SCRIPTORIUM_HOME`, default `~/.scriptorium`: the shipped daemon's rule, read the same way. */
export function scriptoriumHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SCRIPTORIUM_HOME ?? join(homeDir(), ".scriptorium"));
}

/** Where the kit path keeps its sessions: `$SCRIPTORIUM_HOME/kit/sessions`. */
export function kitSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(scriptoriumHome(env), "kit", "sessions");
}

export const scriptoriumApp: AppDeclaration = {
  name: "scriptorium",
  title: "Scriptorium",
  // Slot version 1: the app keeps nothing of its own in the manifest yet. The
  // wiki layer (docMeta, hidden entries) moves in here in a later cycle, with
  // a migrate from this shape.
  slot: { version: 1, migrate: (prev) => ({ ...prev }) },
  // Both apps are named scriptorium, so the kit's generic refusal ("restore it
  // with the app that wrote it; scriptorium will not read it") names this app
  // twice. Say which Scriptorium wrote it, and how to open it there.
  refuseScriptorium: (sessionId) => ({
    message: `session ${sessionId} is a shipped Scriptorium session, not a kit-path one`,
    hint: `open it without SCRIPTORIUM_KIT: unset SCRIPTORIUM_KIT, then open --restore ${sessionId} (its home is $SCRIPTORIUM_HOME/sessions, not kit/sessions)`,
  }),
};

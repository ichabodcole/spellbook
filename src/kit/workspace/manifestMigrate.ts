/**
 * The whole-manifest migrate: an app's hook that rewrites a stored manifest
 * before a restore reads it (`AppDeclaration.migrateManifest`).
 *
 * The app slot's `migrate` (`AppSlot`) brings only the app's own slot forward.
 * This one sees the whole manifest, for an app whose sessions were written by
 * something with another core shape (Scriptorium's shipped daemon, before it
 * moved onto the kit): times, speakers, tasks, versions.
 *
 * The rules, each kept by `WorkspaceSession.restore`:
 *
 * - **Lazy and per session.** It runs when a session is restored, on that
 *   session's manifest only. Nothing walks the sessions folder converting.
 * - **Before every check.** It runs on the parsed JSON, before the format
 *   check and the foreign-manifest guard, so a manifest the kit would refuse
 *   can be converted first. What it returns then goes through every check a
 *   stored kit manifest does: a converter cannot let a bad shape through.
 * - **A refusal is said and nothing is written.** A hook that throws refuses
 *   the restore (409) with its reason; the manifest on disk is left exactly as
 *   it was, and so is everything else in the session folder.
 * - **A conversion is written once, with the original kept.** The restore
 *   persists the converted manifest and keeps the bytes it replaced beside it
 *   (`PRE_MIGRATE_FILE`), so the next restore reads the kit's own shape and a
 *   person can still see, or put back, what was there.
 * - **The version files never move.** The hook returns a manifest; it is given
 *   no way to write, and the restore writes only `manifest.json` and the kept
 *   copy.
 */

import { join } from "node:path";
import { writeFileAtomic } from "../wire/discovery.ts";

/** Where a restore keeps the manifest a whole-manifest migrate replaced, in the session folder. */
export const PRE_MIGRATE_FILE = "manifest.pre-migrate.json";

/** What a hook is told about the manifest it is given. Read-only: the hook writes nothing. */
export type ManifestMigrateContext = {
  sessionId: string;
  /** The session's folder (`<sessionsRoot>/<id>`): where its version files are. */
  dir: string;
  sessionsRoot: string;
};

/**
 * What a hook returns for a manifest it converted: the new manifest, and a
 * sentence for the human about what the conversion did (said once, in the
 * chat, when the restored session starts).
 */
export type ManifestMigration = { manifest: Record<string, unknown>; note?: string };

/**
 * The hook. Return null for a manifest that needs nothing (the app's own
 * shape: most restores), a `ManifestMigration` for one converted, and throw
 * (any Error; its message is the reason shown) for one it recognises but
 * cannot convert.
 */
export type MigrateManifest = (
  raw: Record<string, unknown>,
  at: ManifestMigrateContext,
) => ManifestMigration | null;

/** What a restore records of a conversion (`RestoreReport.manifestMigrated`). */
export type ManifestMigrated = {
  /** The app's sentence about it, when it gave one. */
  note?: string;
  /** Where the replaced manifest is kept (absolute). */
  kept: string;
};

/** The refusal's words, shared so a test and the daemon say the same thing. */
export function migrateRefusal(app: string, sessionId: string, reason: string): string {
  return `session ${sessionId} could not be converted for ${app}: ${reason}. Nothing was changed`;
}

/**
 * Run the app's hook on a parsed manifest. Returns the manifest the restore
 * reads, and the conversion's facts when there was one. Throws the refusal
 * (via `refuse`) when the hook does, or returns something that is not a
 * manifest object.
 */
export function runManifestMigrate(
  hook: MigrateManifest | undefined,
  raw: Record<string, unknown>,
  at: ManifestMigrateContext,
  refuse: (reason: string) => never,
): { raw: Record<string, unknown>; migration: ManifestMigration | null } {
  if (!hook) return { raw, migration: null };
  let out: ManifestMigration | null;
  try {
    // A copy: a hook that edits what it was given and then refuses must not
    // leave the edit in what the restore goes on to read.
    out = hook(structuredClone(raw), at);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  if (out === null) return { raw, migration: null };
  const m = out?.manifest;
  if (m === null || typeof m !== "object" || Array.isArray(m))
    return refuse("the converter returned something that is not a manifest");
  return { raw: m, migration: out };
}

/**
 * Keep the bytes a conversion replaced, beside the manifest, before the
 * converted one is written. A conversion only ever happens to a manifest the
 * hook did not recognise as the app's own, so a second one means someone put
 * an old manifest back (and maybe used it): the bytes it is about to replace
 * are the ones worth keeping, and they take the place of the earlier copy.
 */
export function keepPreMigrate(dir: string, originalText: string): string {
  const kept = join(dir, PRE_MIGRATE_FILE);
  writeFileAtomic(kept, originalText);
  return kept;
}

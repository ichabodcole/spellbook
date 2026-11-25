/**
 * Our own manifest code: the refusals a restore runs on a raw manifest before
 * it reads one (malformed, or not this app's), and `migrateSlot`, which brings
 * a stored app slot to the declared version. Tier 0 of the session parts
 * (docs/architecture/workspace-session.md).
 */

import { isAbsolute } from "node:path";
import type { Session } from "../protocol";
import { safeExt, safeSlug } from "../safeNames";
import { SessionError } from "./errors.ts";
import type { AppDeclaration, RestoreReport } from "./types.ts";

/**
 * ⛔ Refuse a manifest that is not this app's own, by its shape, never by its
 * path. Scriptorium's session manifests say `format: 1` too, and a restore that
 * took one would throw on a missing `tasks` or, worse, misread `who`, times in
 * milliseconds and `author` without a word, then persist it as the kit's.
 *
 * - Scriptorium's shape (millisecond `createdAt`, chat by `who`) is refused
 *   whatever else the manifest carries, an `app` slot included.
 * - The kit always writes an `app` slot (an object); a manifest without one is
 *   not the kit's.
 * - `appName` names the app that wrote it; another app's is refused.
 * - Stamped (`appName` present): the slot's `version` is a whole number from 0,
 *   as every stamping build writes it.
 * - Unstamped: a kit manifest from before `appName`. It is told from a foreign
 *   one by the kit's own marks: an ISO `createdAt` (a string), and a slot
 *   `version` that is absent (migrated from 0) or a whole number from 0.
 */
/**
 * Refuses (409) a manifest that is this app's but not of the shape a restore
 * reads: the lists it walks, and the fields of each entry it reads, are of
 * their type. Nothing is changed or written before it answers.
 */
export function refuseMalformedManifest(raw: Record<string, unknown>, sessionId: string): void {
  const refuse = (what: string): never => {
    throw new SessionError(
      `session ${sessionId} has a malformed manifest: ${what}. Nothing was changed`,
      409,
      undefined,
      "the manifest was edited by hand or written by something else: fix it, or start a new session",
    );
  };
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const list = (key: string): Record<string, unknown>[] => {
    const v = raw[key];
    if (!Array.isArray(v)) return refuse(`\`${key}\` is not a list`);
    v.forEach((x, i) => {
      if (!isObj(x)) refuse(`\`${key}[${i}]\` is not an object`);
    });
    return v as Record<string, unknown>[];
  };
  const fields = (at: string, o: Record<string, unknown>, spec: Record<string, string>) => {
    for (const [k, type] of Object.entries(spec)) {
      const v = o[k];
      const ok =
        type === "list"
          ? Array.isArray(v)
          : type === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : typeof v === type;
      if (!ok) refuse(`\`${at}.${k}\` is not ${type === "list" ? "a list" : `a ${type}`}`);
    }
  };
  list("context").forEach((e, i) => {
    fields(`context[${i}]`, e, {
      id: "string",
      root: "string",
      membership: "string",
      nodes: "list",
    });
    // A relative root would be read against the daemon's working directory.
    if (!isAbsolute(e.root as string)) refuse(`\`context[${i}].root\` is not a full path`);
  });
  list("docs").forEach((d, i) => {
    fields(`docs[${i}]`, d, {
      slug: "string",
      name: "string",
      original: "string",
      versions: "list",
      active: "number",
      notes: "list",
    });
    // ⛔ Both become part of a path the kit writes (`docs/<slug>/v<n><ext>`):
    // one that climbs out would put a version anywhere (`safeNames.ts`).
    const badSlug = safeSlug(d.slug);
    if (badSlug !== null) refuse(`\`docs[${i}].slug\` is not one safe folder name: ${badSlug}`);
    const badExt = safeExt(d.ext);
    if (badExt !== null) refuse(`\`docs[${i}].ext\` is not a plain extension: ${badExt}`);
    (d.versions as unknown[]).forEach((v, j) => {
      if (!isObj(v)) refuse(`\`docs[${i}].versions[${j}]\` is not an object`);
      fields(`docs[${i}].versions[${j}]`, v as Record<string, unknown>, { n: "number" });
    });
    (d.notes as unknown[]).forEach((n, j) => {
      if (!isObj(n)) refuse(`\`docs[${i}].notes[${j}]\` is not an object`);
    });
  });
  list("chat");
  list("tasks").forEach((t, i) => {
    fields(`tasks[${i}]`, t, { id: "string", status: "string" });
  });
  if (raw.openDoc != null && typeof raw.openDoc !== "string")
    refuse("`openDoc` is not a string or null");
}

export function refuseForeignManifest(
  raw: Record<string, unknown>,
  app: AppDeclaration,
  sessionId: string,
): void {
  const refuse = (message: string, what: string): never => {
    throw new SessionError(
      `session ${sessionId} was not written by ${app.name}: ${message}`,
      409,
      undefined,
      `it looks like ${what}. Restore it with the app that wrote it; ${app.name} will not read it`,
    );
  };
  if (looksLikeScriptorium(raw))
    refuse(
      "its manifest has Scriptorium's shape",
      "a Scriptorium session (format 1, times in milliseconds, chat by `who`)",
    );
  const slot = raw.app;
  if (slot === null || typeof slot !== "object" || Array.isArray(slot))
    refuse(
      "its manifest has no app slot",
      "a manifest with no `app` slot, so not one a workspace-kit app wrote",
    );
  const owner = raw.appName;
  if (owner !== undefined && owner !== app.name) {
    const name = typeof owner === "string" ? owner : JSON.stringify(owner);
    throw new SessionError(
      `session ${sessionId} belongs to ${name}, not ${app.name}`,
      409,
      undefined,
      `it looks like a ${name} session. Restore it with ${name}; ${app.name} will not read it`,
    );
  }
  const version = (slot as Record<string, unknown>).version;
  const wholeVersion = typeof version === "number" && Number.isInteger(version) && version >= 0;
  if (owner === undefined) {
    if (typeof raw.createdAt !== "string")
      refuse(
        "its manifest has no `appName` and no ISO `createdAt`",
        "a manifest no workspace-kit app wrote",
      );
    if (version !== undefined && !wholeVersion)
      refuse(
        `its app slot's version is ${JSON.stringify(version)}`,
        "a manifest no workspace-kit app wrote",
      );
  } else if (!wholeVersion)
    refuse(
      `its app slot's version is ${JSON.stringify(version)}, not a whole number`,
      "a damaged or hand-made manifest",
    );
}

/** Scriptorium's manifest: `createdAt` in milliseconds, or chat messages that say `who`. */
function looksLikeScriptorium(raw: Record<string, unknown>): boolean {
  if (typeof raw.createdAt === "number") return true;
  return (
    Array.isArray(raw.chat) &&
    raw.chat.some((m) => m !== null && typeof m === "object" && "who" in m)
  );
}

/** Bring a stored app slot to the declared version, or refuse one from the future. */
export function migrateSlot(
  app: AppDeclaration,
  stored: unknown,
  sessionId: string,
  report: RestoreReport,
): Session["app"] {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const { version, ...prev } = raw;
  const prevVersion = typeof version === "number" && Number.isInteger(version) ? version : 0;
  if (prevVersion > app.slot.version)
    throw new SessionError(
      `session ${sessionId} was written by a newer ${app.name} (app data version ${prevVersion}; this build reads up to ${app.slot.version})`,
      409,
    );
  if (prevVersion === app.slot.version) return { ...prev, version: prevVersion };
  report.slotMigratedFrom = prevVersion;
  const next = app.slot.migrate(prev, prevVersion);
  if ("version" in next) throw new Error(`app ${app.name}: migrate() may not set \`version\``);
  return { ...next, version: app.slot.version };
}

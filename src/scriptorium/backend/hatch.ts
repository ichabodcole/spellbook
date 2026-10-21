/**
 * The escape hatch: `SCRIPTORIUM_SHIPPED=1` runs the earlier (shipped)
 * Scriptorium instead of the current one, until the shipped code is deleted.
 *
 * ⛔ REFUSED ONCE ANY SESSION IN THE HOME IS IN THE KIT'S SHAPE (the cutover
 * cycle's ruling 2), whether a converted one or one started on the current
 * Scriptorium. That is the condition under which the shipped app can no longer
 * show everything: it refuses a kit-shaped manifest (`./session.ts`), and its
 * reader is the test here, so the two cannot disagree. The shape is read from
 * each `manifest.json`, not from a `manifest.pre-migrate.json` beside it, so a
 * session started on the current Scriptorium counts too.
 *
 * Both entries ask (`./cli.ts` and `./server.ts`), so a hand-run daemon
 * launcher cannot pass it either. No daemon imports: the CLI's bundle reads
 * this.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SHIPPED_HATCH = "SCRIPTORIUM_SHIPPED";

/** The hatch is asked for: exactly `1`. Any other value, or none, is the current Scriptorium. */
export function shippedHatchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHIPPED_HATCH] === "1";
}

/**
 * The manifest the shipped reader refuses as the kit's (`Session.restore`):
 * the kit stamps `appName` and writes ISO times. An unreadable manifest is not
 * counted: the shipped app says what is wrong with it when it is opened.
 */
export function kitShaped(manifestText: string): boolean {
  let m: unknown;
  try {
    m = JSON.parse(manifestText);
  } catch {
    return false;
  }
  if (m === null || typeof m !== "object" || Array.isArray(m)) return false;
  return "appName" in m || typeof (m as { createdAt?: unknown }).createdAt !== "number";
}

/** The sessions under `<home>/sessions` whose manifest is in the kit's shape, sorted. */
export function kitShapedSessions(home: string): string[] {
  const root = join(home, "sessions");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of ids) {
    let text: string;
    try {
      text = readFileSync(join(root, id, "manifest.json"), "utf8");
    } catch {
      continue;
    }
    if (kitShaped(text)) out.push(id);
  }
  return out.sort();
}

/** Why the hatch is refused in `home`, or null when it may open. */
export function shippedHatchRefusal(home: string): { message: string; hint: string } | null {
  const ids = kitShapedSessions(home);
  if (ids.length === 0) return null;
  const n = ids.length === 1 ? "1 session" : `${ids.length} sessions`;
  return {
    message: `${SHIPPED_HATCH}=1 is closed: ${n} in ${join(home, "sessions")} ${ids.length === 1 ? "is" : "are"} in the current Scriptorium's shape (e.g. ${ids[0]}), which the earlier Scriptorium cannot read`,
    hint: `unset ${SHIPPED_HATCH} and run the same command: the current Scriptorium opens every session, and converts an earlier one the first time it is restored, keeping its old manifest beside it as manifest.pre-migrate.json`,
  };
}

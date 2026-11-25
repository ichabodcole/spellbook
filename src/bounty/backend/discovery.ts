// bounty's discovery files: where a running board says it is, so a joining
// agent or a stateless CLI can find it without copy-paste. Moved out of
// server.ts's boot path (2026-11-24) as one piece: the two files, the write and
// the cleanup, which only ever change together.
//
// Two files, in the OS temp directory:
//   - bounty-<session_id>.json  (specific lookup by --id)
//   - bounty-latest.json        (always overwritten by most recent
//                                   host; default target for joiners)

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";

export type DiscoveryFiles = { sessionFile: string; latestFile: string };

/** The two discovery files for one session, in the current TMPDIR. */
export function discoveryFiles(sessionId: string): DiscoveryFiles {
  return {
    sessionFile: join(tmpdir(), `bounty-${sessionId}.json`),
    latestFile: join(tmpdir(), "bounty-latest.json"),
  };
}

/** Write the session's own file and make it the latest. Never throws. */
export function publishDiscovery(files: DiscoveryFiles, sessionInfo: string): void {
  // ⚠ ATOMIC, because readSession now treats unparseable content as corruption
  // rather than absence. A bare writeFileSync is not atomic: a CLI reading while
  // the daemon writes can observe a half-written pointer, and under the old
  // best-effort read that surfaced as "no running session". Write beside the
  // target and rename — rename within one directory is atomic, so a reader sees
  // either the previous pointer or the new one, never a partial file.
  //
  // ⛔ IT IS `src/kit/wire/discovery.ts`'s `writeFileAtomic` NOW. bounty's local
  // `writeAtomic` was one of the four hand-rolled copies the recon found on
  // 2026-09-08 (fixed in glamour, then found standing in three siblings), and
  // the kit's is the same tmp+rename with the same cleanup-on-throw. This is a
  // de-duplication and NOT a behaviour change: census defect L3 was already
  // CORRECT in the four session spells, bounty among them.
  try {
    writeFileAtomic(files.sessionFile, sessionInfo);
    writeFileAtomic(files.latestFile, sessionInfo);
  } catch (e) {
    // Discovery files are nice-to-have, not load-bearing. Log to stderr
    // and continue — the session id printed to stdout still lets the
    // user paste a URL into a joining agent manually.
    process.stderr.write(
      `bounty: could not write discovery file: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/** The session_id a discovery file names, or null when it names none. */
function sessionIdOf(raw: string): string | null {
  try {
    return (JSON.parse(raw) as { session_id?: string }).session_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort cleanup on exit. Won't fire on SIGKILL, but stale files
 * produce a clean "session not running" error when a joiner connects.
 *
 * ⛔ THE `latest` POINTER IS ONLY REMOVED IF IT STILL NAMES US — otherwise a
 * newer host has taken over the slot and we would delete a LIVE board's
 * pointer on our way out. `unlinkIfMatches`'s `identify` hook is what lets one
 * shared predicate serve both discovery conventions; bounty's identity is
 * `session_id`, which is what the hand-rolled version compared.
 */
export function cleanupDiscovery(files: DiscoveryFiles, sessionId: string): void {
  try {
    unlinkSync(files.sessionFile);
  } catch {}
  unlinkIfMatches(files.latestFile, sessionId, sessionIdOf);
}

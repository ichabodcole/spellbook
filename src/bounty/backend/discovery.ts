// bounty's discovery files: where a running board says it is, so a joining
// agent or a stateless CLI can find it without copy-paste. Moved out of
// server.ts's boot path (2026-11-24) as one piece: the two files, the write and
// the cleanup, which only ever change together.
//
// Two files, in the OS temp directory:
//   - bounty-<session_id>.json  (specific lookup by --id)
//   - bounty-latest.json        (always overwritten by most recent
//                                   host; default target for joiners)

import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** A discovery file's text and what it names, or null when it names no board. */
type Discovered = { raw: string; session_id: string; url: string; mtimeMs: number };

function readDiscovered(path: string): Discovered | null {
  try {
    const raw = readFileSync(path, "utf8");
    const s = JSON.parse(raw) as { session_id?: unknown; url?: unknown };
    if (typeof s.session_id !== "string" || typeof s.url !== "string") return null;
    return { raw, session_id: s.session_id, url: s.url, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Whether a board answers: GET /state with a short budget, the same question
 * `list`'s probe asks, so `latest` never names a board `list` would not show.
 */
export async function boardAnswers(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/state?lean=1`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The newest OTHER board still running: every bounty-<id>.json beside the
 * latest pointer but our own, newest file first (a board writes its own file
 * once, at boot), probed together. Null when none answers.
 */
async function newestLiveBoard(
  files: DiscoveryFiles,
  sessionId: string,
  answers: (url: string) => Promise<boolean>,
): Promise<Discovered | null> {
  const dir = dirname(files.latestFile);
  const latestName = basename(files.latestFile);
  let names: string[];
  try {
    names = readdirSync(dir).filter(
      (f) => f.startsWith("bounty-") && f.endsWith(".json") && f !== latestName,
    );
  } catch {
    return null;
  }
  const candidates = names
    .map((f) => readDiscovered(join(dir, f)))
    .filter((d): d is Discovered => d !== null && d.session_id !== sessionId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const live = await Promise.all(candidates.map((d) => answers(d.url)));
  return candidates.find((_, i) => live[i]) ?? null;
}

/**
 * Best-effort cleanup on exit. Won't fire on SIGKILL, but stale files
 * produce a clean "session not running" error when a joiner connects.
 *
 * ⛔ THE `latest` POINTER IS ONLY TOUCHED IF IT STILL NAMES US — otherwise a
 * newer host has taken over the slot and we would delete a LIVE board's
 * pointer on our way out. `unlinkIfMatches`'s `identify` hook is what lets one
 * shared predicate serve both discovery conventions; bounty's identity is
 * `session_id`, which is what the hand-rolled version compared.
 *
 * ⛔ AND WHEN IT NAMES US, IT IS HANDED BACK, NOT DROPPED, while another board
 * still runs (bounty-latest-pointer-and-list-title, 2026-11-24). Every boot
 * takes `latest`, keyed or not, so closing a keyed board K opened over an
 * unkeyed board A used to delete the pointer, and every unpinned verb then
 * exited 5 "no running bounty session" while `list` showed A running. Now
 * `latest` goes to the newest board that still answers, and is removed only
 * when none does. The pointer is re-read just before the write, so a host that
 * took the slot while we probed keeps it.
 */
export async function cleanupDiscovery(
  files: DiscoveryFiles,
  sessionId: string,
  answers: (url: string) => Promise<boolean> = boardAnswers,
): Promise<void> {
  try {
    unlinkSync(files.sessionFile);
  } catch {}
  if (readDiscovered(files.latestFile)?.session_id !== sessionId) return;
  const successor = await newestLiveBoard(files, sessionId, answers);
  if (successor && readDiscovered(files.latestFile)?.session_id === sessionId) {
    try {
      writeFileAtomic(files.latestFile, successor.raw);
      return;
    } catch {
      /* could not hand it over: remove it, as before, rather than leave ours */
    }
  }
  unlinkIfMatches(files.latestFile, sessionId, sessionIdOf);
}

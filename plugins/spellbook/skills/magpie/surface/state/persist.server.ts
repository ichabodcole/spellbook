// surface/state/persist.server.ts
// Server/CLI-only snapshot persistence for the magpie daemon. Snapshots live
// under $MAGPIE_HOME/snapshots/<sessionId>.json (default ~/.magpie) so a session
// resumes across restarts (cli.ts open --restore <id>). Do NOT import from
// browser code — this uses node:fs + node:os.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultState, type MagpieState } from "./types";

export function magpieHome(): string {
  return process.env.MAGPIE_HOME ?? join(homedir(), ".magpie");
}

export function snapshotsDir(): string {
  return join(magpieHome(), "snapshots");
}

export function snapshotPath(sessionId: string): string {
  return join(snapshotsDir(), `${sessionId}.json`);
}

// Persist the canonical state (best-effort — persistence must never crash the
// daemon). Called debounced (~1s) on change and once on close.
export function saveSnapshot(sessionId: string, state: MagpieState): void {
  try {
    mkdirSync(snapshotsDir(), { recursive: true });
    writeFileSync(snapshotPath(sessionId), JSON.stringify(state));
  } catch {
    /* persistence is best-effort */
  }
}

// Load a snapshot by session id OR an explicit path, merged over defaults so an
// older snapshot gains any new fields. Returns null if it can't be read.
export function loadSnapshot(idOrPath: string, title: string): MagpieState | null {
  const path = idOrPath.endsWith(".json") ? idOrPath : snapshotPath(idOrPath);
  try {
    const snap = JSON.parse(readFileSync(path, "utf8")) as Partial<MagpieState>;
    const merged = { ...defaultState(title), ...snap } as MagpieState;
    // Normalize the phase cursor for snapshots that predate the phase spine (or
    // were saved at intake with elements already present): land them in Slice so
    // the board renders instead of the intake/scanning view.
    if (merged.phase === "intake" && merged.elements.length > 0) merged.phase = "slice";
    return merged;
  } catch {
    return null;
  }
}

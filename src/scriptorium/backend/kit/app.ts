/**
 * Scriptorium's app declaration: the kit's workspace daemon and CLI
 * (`createWorkspaceDaemon`, `createWorkspaceCli`) under Scriptorium's name.
 *
 * ⛔ THIS FILE IS SHARED BY BOTH ENTRIES, so it imports no daemon code: the
 * CLI's bundle (`dist/cli.js`) must not carry the kit's server. Types only from
 * the kit.
 *
 * The sessions live in `$SCRIPTORIUM_HOME/sessions`, the earlier (shipped)
 * Scriptorium's own root, with the logs and prefs beside them. A session the
 * earlier Scriptorium saved is converted to the kit's shape the first time the
 * daemon restores it (`./convert.ts`), and its old manifest is kept beside it
 * as `manifest.pre-migrate.json`. The earlier Scriptorium itself was deleted
 * at the cutover (scriptorium-delete-shipped); the converter is the only part
 * of it that remains.
 */

import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
// The kit's one reader of the home: a test preload moves it, and a test run
// that has the real home is refused it (`os.homedir()` is neither).
import { homeDir } from "../../../kit/lib/home";
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

/** `$SCRIPTORIUM_HOME`, default `~/.scriptorium`: the shipped daemon's rule, read the same way. */
export function scriptoriumHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.SCRIPTORIUM_HOME ?? join(homeDir(), ".scriptorium"));
}

/**
 * Why the conversion of the session at `at` may not be written now, or null.
 * Asked when the converted manifest and its kept copy are about to be written
 * (`AppDeclaration.migrateWriteRefusal`), so a sessions folder swapped for a
 * link after boot is caught where it matters:
 * - the session's folder must really be inside the sessions root as the disk
 *   resolves both (one session folder linked in from elsewhere is refused);
 * - its manifest must not be a hard link (a second name for a file elsewhere).
 */
export function migrateWriteRefusal(at: { dir: string; sessionsRoot: string }): string | null {
  const dir = onDisk(at.dir);
  const root = onDisk(at.sessionsRoot);
  if (dir === root || !within(dir, root))
    return `its folder ${at.dir} leads outside the sessions folder (to ${dir}): it is converted only where it is`;
  try {
    if (lstatSync(join(at.dir, "manifest.json")).nlink > 1)
      return "its manifest is a hard link to a file elsewhere: copy the session folder, do not link it";
  } catch {
    /* no manifest: the restore says so */
  }
  return null;
}

/**
 * Where Scriptorium keeps its sessions: `$SCRIPTORIUM_HOME/sessions`, where the
 * earlier Scriptorium kept them (their version files never move). Each one it
 * saved is converted to the kit's shape the first time it is restored.
 */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(scriptoriumHome(env), "sessions");
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
  // No words of its own for a shipped manifest: the daemon converts one, so
  // the only one it refuses is a hybrid the converter declines
  // (`./convert.ts`), and the kit's generic words are right for that.
};

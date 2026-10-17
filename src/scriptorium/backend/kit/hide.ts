/**
 * `hide` and `unhide` on the kit path: "Remove from Scriptorium", never from
 * disk (E24), on the kit's tree-scan filter (`AppDeclaration.scan` in
 * `./app.ts`).
 *
 * The shipped model (S/backend/session.ts `hide`, `unhide`) kept each entry's
 * hidden list on the entry (`ContextEntry.hidden`). The kit's entries are the
 * kit's, so here the lists live in the app slot, keyed by entry id, and the
 * kit's scan asks the app what to leave out. The kit's own removal, `trash`,
 * is the human's alone (E68) and is not touched by any of this.
 *
 * Daemon side only: `./app.ts` is shared with the CLI bundle and holds the
 * pure parts.
 */

import { existsSync, statSync } from "node:fs";
import type { VerbHandler, WorkspaceContext } from "../../../kit/workspace/server";
import { SessionError, type WorkspaceSession } from "../../../kit/workspace/session";
import { type HiddenLists, hiddenLists } from "./app";

export type HideResult = { path: string; entry: string; removedEntry: boolean };
export type UnhideResult = { entry: string; restored: number };

/** Write one entry's list (empty drops it), keep only lists of entries still in the context, refilter. */
function setHidden(s: WorkspaceSession, entryId: string, rels: readonly string[]): void {
  s.updateApp((slot) => {
    const live = new Set(s.context.map((e) => e.id));
    const next: HiddenLists = {};
    for (const [id, list] of Object.entries(hiddenLists(slot)))
      if (live.has(id) && id !== entryId && list.length > 0) next[id] = list;
    if (rels.length > 0 && live.has(entryId)) next[entryId] = [...rels];
    slot.hidden = next;
  });
  if (s.context.some((e) => e.id === entryId)) s.refilter(entryId);
}

const hiddenOf = (s: WorkspaceSession, entryId: string): string[] => [
  ...(hiddenLists(s.appSlot)[entryId] ?? []),
];

/**
 * Hide a document, folder or set. A whole entry (a set's own folder, a listed
 * document) leaves the context; anything inside a set joins the set's hidden
 * list, a folder with everything under it.
 */
export function hide(s: WorkspaceSession, rawPath: string): HideResult & { before?: string[] } {
  const at = s.shownAt(rawPath);
  if (at.whole) {
    s.removeContext(at.entryId);
    // Its list goes with it.
    setHidden(s, at.entryId, []);
    return { path: at.abs, entry: at.entryId, removedEntry: true };
  }
  const before = hiddenOf(s, at.entryId);
  setHidden(s, at.entryId, [...before.filter((h) => h !== at.rel), at.rel]);
  return { path: at.abs, entry: at.entryId, removedEntry: false, before };
}

/** Bring back everything hidden in an entry. */
export function unhide(s: WorkspaceSession, entryId: string): UnhideResult & { before: string[] } {
  if (!s.context.some((e) => e.id === entryId))
    throw new SessionError(
      `no context entry ${entryId}`,
      404,
      s.context.map((e) => e.id),
    );
  const before = hiddenOf(s, entryId);
  setHidden(s, entryId, []);
  return { entry: entryId, restored: before.length, before };
}

const who = (from: "agent" | "surface") => (from === "agent" ? "Agent" : "You");
const by = (from: "agent" | "surface") => (from === "agent" ? "agent" : "human");

/** The way back for a change to one entry's list: set it to what it was, and forward again. */
function pushListAct(ctx: WorkspaceContext, label: string, entryId: string, was: string[]) {
  const now = hiddenOf(ctx.session, entryId);
  const put = (rels: string[]) => () => {
    if (!ctx.session.context.some((e) => e.id === entryId))
      throw new SessionError(`no context entry ${entryId}: it left the context`, 409);
    setHidden(ctx.session, entryId, rels);
    ctx.broadcast();
  };
  ctx.history.push({ label, undo: put(was), redo: put(now) });
}

export const hideVerbs: Record<string, VerbHandler> = {
  "scriptorium.hide": (ctx, args, call) => {
    if (typeof args.path !== "string" || args.path === "")
      throw new SessionError("hide needs a path", 400);
    const { before, ...r } = hide(ctx.session, args.path);
    const shown = ctx.session.display(r.path);
    // ⚠ The parenthetical has to be true (the shipped line's lesson): a ghost
    // is already gone from disk, and a folder is not a file.
    const gone = !existsSync(r.path);
    const kind = gone ? "" : statSync(r.path).isDirectory() ? "folder" : "file";
    ctx.announce(
      gone
        ? `${who(call.from)} removed ${shown} from Scriptorium (it was already gone from disk).`
        : `${who(call.from)} removed ${shown} from Scriptorium (the ${kind} is still on disk).`,
      { fact: "hide", by: by(call.from), ...r },
    );
    if (before) pushListAct(ctx, `hide ${shown}`, r.entry, before);
    // The watched folders follow the context (a whole set taken out), and
    // every surface gets the new tree.
    ctx.broadcast();
    return r;
  },
  "scriptorium.unhide": (ctx, args, call) => {
    if (typeof args.entry !== "string" || args.entry === "")
      throw new SessionError(
        "unhide needs an entry id",
        400,
        ctx.session.context.map((e) => e.id),
      );
    const { before, ...r } = unhide(ctx.session, args.entry);
    ctx.announce(
      `${who(call.from)} brought back ${r.restored} hidden item${r.restored === 1 ? "" : "s"}.`,
      { fact: "unhide", by: by(call.from), ...r },
    );
    if (r.restored > 0) pushListAct(ctx, "unhide", r.entry, before);
    ctx.broadcast();
    return r;
  },
};

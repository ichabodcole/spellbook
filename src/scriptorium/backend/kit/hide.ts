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
import { basename } from "node:path";
import type { AppAct } from "../../../kit/workspace/history";
import type { ContextEntry } from "../../../kit/workspace/protocol";
import type { VerbHandler } from "../../../kit/workspace/server";
import { GoneError, SessionError, type WorkspaceSession } from "../../../kit/workspace/session";
import { type HiddenLists, hiddenLists } from "./app";

export type HideResult = { path: string; entry: string; removedEntry: boolean };
export type UnhideResult = { entry: string; restored: number };

/**
 * What a hide changed, for its undo: the entry's hidden list before it, and,
 * for a whole entry, the entry as `removeContext` took it out and where it stood.
 */
export type HideBefore = {
  hidden: string[];
  removed?: { entry: ContextEntry; index: number };
};

const live = (s: WorkspaceSession, entryId: string): boolean =>
  s.context.some((e) => e.id === entryId);

/**
 * Write one entry's list (empty drops it) and refilter. Lists of entries no
 * longer in the context are pruned here: nothing reads them (an entry put back
 * by a hide's undo gets its list back from the act, not from the slot), and
 * one left behind would be a second, stale say about an entry that is gone.
 */
function setHidden(s: WorkspaceSession, entryId: string, rels: readonly string[]): void {
  s.updateApp((slot) => {
    const next: HiddenLists = {};
    for (const [id, list] of Object.entries(hiddenLists(slot)))
      if (live(s, id) && id !== entryId && list.length > 0) next[id] = list;
    if (rels.length > 0 && live(s, entryId)) next[entryId] = [...rels];
    slot.hidden = next;
  });
  if (live(s, entryId)) s.refilter(entryId);
}

const hiddenOf = (s: WorkspaceSession, entryId: string): string[] => [
  ...(hiddenLists(s.appSlot)[entryId] ?? []),
];

/** The hidden lists of the entries in the context: what the agent reads (`appState`). */
export function liveHiddenLists(s: WorkspaceSession): HiddenLists {
  const out: HiddenLists = {};
  for (const [id, list] of Object.entries(hiddenLists(s.appSlot))) if (live(s, id)) out[id] = list;
  return out;
}

/**
 * Hide a document, folder or set. A whole entry (a set's own folder, a listed
 * document) leaves the context; anything inside a set joins the set's hidden
 * list, a folder with everything under it.
 */
export function hide(s: WorkspaceSession, rawPath: string): HideResult & { before: HideBefore } {
  const at = s.shownAt(rawPath);
  const hidden = hiddenOf(s, at.entryId);
  if (at.whole) {
    const removed = s.removeContext(at.entryId);
    // Its list goes with it (the undo puts it back).
    setHidden(s, at.entryId, []);
    return { path: at.abs, entry: at.entryId, removedEntry: true, before: { hidden, removed } };
  }
  setHidden(s, at.entryId, [...hidden.filter((h) => h !== at.rel), at.rel]);
  return { path: at.abs, entry: at.entryId, removedEntry: false, before: { hidden } };
}

/** Bring back everything hidden in an entry. */
export function unhide(s: WorkspaceSession, entryId: string): UnhideResult & { before: string[] } {
  if (!live(s, entryId))
    throw new SessionError(
      `no context entry ${entryId}`,
      404,
      s.context.map((e) => e.id),
    );
  const before = hiddenOf(s, entryId);
  setHidden(s, entryId, []);
  return { entry: entryId, restored: before.length, before };
}

/**
 * The way back for a whole-entry hide: undo puts the same entry back (its id,
 * so its hidden list and every act naming it find it again) where it stood,
 * with its list (`restoreContext`); redo takes it out again. One that can
 * never apply (the entry is back already, or gone from disk) throws a
 * `GoneError`, so it comes off the list.
 */
export function removalAct(
  s: WorkspaceSession,
  label: string,
  removed: { entry: ContextEntry; index: number },
  hidden: readonly string[],
  after: () => void = () => {},
): AppAct {
  const id = removed.entry.id;
  let at = removed;
  return {
    label,
    undo: () => {
      s.restoreContext(at.entry, at.index);
      if (hidden.length > 0) setHidden(s, id, hidden);
      after();
    },
    redo: () => {
      if (!live(s, id))
        throw new GoneError(`no context entry ${id}: it is no longer in the context`, 409);
      at = s.removeContext(id);
      setHidden(s, id, []);
      after();
    },
  };
}

/**
 * The way back for a change to one entry's list: set it to what it was, and
 * forward again. Once the entry has left the context it can never apply: a
 * `GoneError`, so the act comes off the list and the older ones are reached.
 */
export function listAct(
  s: WorkspaceSession,
  label: string,
  entryId: string,
  was: readonly string[],
  after: () => void = () => {},
): AppAct {
  const now = hiddenOf(s, entryId);
  const put = (rels: readonly string[]) => () => {
    if (!live(s, entryId))
      throw new GoneError(`no context entry ${entryId}: it left the context`, 409);
    setHidden(s, entryId, rels);
    after();
  };
  return { label, undo: put(was), redo: put(now) };
}

const who = (from: "agent" | "surface") => (from === "agent" ? "Agent" : "You");
const by = (from: "agent" | "surface") => (from === "agent" ? "agent" : "human");

/**
 * The acts' labels are the shipped ones (S/backend/history.ts), so the chat
 * says "You undid: removed solo.md from the context." and "You undid: brought
 * back 2 hidden items.". A redo says the same label, the forward act's words
 * ("You redid: removed drafts from the context."), where the shipped redo of
 * a hide said "brought items back".
 */
export const hideLabel = (path: string) => `removed ${basename(path)} from the context`;
export const unhideLabel = (n: number) => `brought back ${n} hidden item${n === 1 ? "" : "s"}`;

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
    const after = () => ctx.broadcast();
    ctx.history.push(
      before.removed
        ? removalAct(ctx.session, hideLabel(r.path), before.removed, before.hidden, after)
        : listAct(ctx.session, hideLabel(r.path), r.entry, before.hidden, after),
    );
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
    if (r.restored > 0)
      ctx.history.push(
        listAct(ctx.session, unhideLabel(r.restored), r.entry, before, () => ctx.broadcast()),
      );
    ctx.broadcast();
    return r;
  },
};

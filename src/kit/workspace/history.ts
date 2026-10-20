// Undo and redo for the context: moving, renaming and creating things.
//
// This is not the editor's undo, and the surface says so by putting these
// arrows in the context header rather than near the text. The editor's history
// owns keystrokes inside a document; this owns acts on the shape of the
// context, which is the thing that had no way back at all.
//
// Undoing a creation deletes, but only behind a confirmation. Blocking it does
// not refuse one step, it strands everything behind it: create a folder, do two
// moves, and you could undo the moves and then meet a wall you can never pass,
// at which point the history has stopped being a history. The thing undo would
// remove is one the session itself made moments ago, usually empty, which is
// categorically different from deleting work. So the arrow stays enabled and
// the confirmation is the gate.
//
// One limit is not negotiable by dialog: a non-empty folder is refused
// outright. Undo works backwards, so it empties a folder before it reaches that
// folder's creation; if the folder still has contents, something put them there
// that this history does not know about, and removing a directory tree is a
// different act from removing the empty thing you just made.
//
// The inverse is built when the act happens, from what was actually true then,
// not reconstructed later from the op. A `move` records where the thing came
// from because only the mover knows.
//
// An app's own acts (a stage's reorder, skip, take) go on the same stacks
// through `ctx.history.push`, so one arrow steps back through "moved the
// keeper, then renamed it" whichever side made each. The app holds its way
// back as functions; the kit holds the order, the labels, the confirmation
// and the Trash.
import type { StructureOp } from "./protocol";

/**
 * How to put one act back. Each variant is something the session can already
 * do, so undo introduces no new way to change the world: it only replays the
 * existing ones with recorded arguments.
 */
export type Inverse =
  /** `follow`: what the app did to follow it (`hooks.followMove`), put back after it. */
  | { kind: "move"; path: string; into: string; links?: LinkEdit[]; follow?: Follow }
  /**
   * `title`: a bundle's title to put back with its name (absent: it had none),
   * set only for a rename that changed one.
   */
  | {
      kind: "rename";
      path: string;
      name: string;
      links?: LinkEdit[];
      follow?: Follow;
      title?: { to?: string };
    }
  /**
   * Remove what the act created. `dir` decides both the dialog's words and the
   * emptiness rule: a file is confirmed, a folder is confirmed and must be empty.
   */
  | {
      kind: "delete";
      path: string;
      dir: boolean;
      /**
       * Set for something whose contents were written by the act
       * (`describe-image`'s skeleton, a new or duplicated bundle, a duplicated
       * document): its hash then (`treeHash`). Undo then refuses once it
       * differs, and sends an unchanged one to the Trash rather than unlinking
       * it.
       */
      unchanged?: string;
    }
  /**
   * An app's own act (`ctx.history.push`): the app holds the way back, as a
   * function that runs it. `undo` is what to run now, `redo` what puts it back
   * after that (absent: no redo). `creates`: what the act brought into
   * existence, each by its hash then; running this removes them too, to the
   * Trash and only while unchanged, after `undo`, and asks first.
   *
   * `links`: links rewritten as part of the act (an accepted `relink` after
   * `set.make`, which moves a document), put back after `undo` as a move's
   * are; `what` names what moved, as the chat does.
   */
  | {
      kind: "app";
      label: string;
      undo: () => void | Promise<void>;
      redo?: () => void | Promise<void>;
      creates?: Created[];
      links?: { edits: LinkEdit[]; what: string };
    };

/** Something an app's act made, to be removed by its undo: its hash then (`treeHash` for a folder). */
export type Created = { path: string; dir: boolean; unchanged: string };

/**
 * An act an app pushes onto the context's history (`ctx.history.push`), from
 * the surface or the agent alike. `label` says what happened, as a kit act's
 * does ("moved 02-the-keeper.md after 10-the-light.md on the stage The
 * lighthouse"); it is the arrow's tooltip and the chat's "You undid: …".
 *
 * `undo` and `redo` name what they act on by name, never by position, and
 * check that it is still there: one that can never apply again throws a
 * `GoneError` (it comes off the list), one that cannot apply now (a file that
 * does not read) any other error (it stays). Both refuse before they change
 * anything.
 *
 * `creates`: paths the act made (a copy, a new folder). Undoing it then
 * removes them, behind the arrow's confirmation, to the Trash, and only while
 * each is as it was made; it has no redo, as a kit creation has none.
 */
export type AppAct = {
  label: string;
  undo: () => void | Promise<void>;
  redo?: () => void | Promise<void>;
  creates?: { path: string; dir: boolean }[];
};

/**
 * Links rewritten as part of a move or rename (kit-rename-updates-references),
 * so one undo puts the file AND its links back. Applied after the move or
 * rename it rides on: in the document now at `at` (it was at `was` before that
 * move), each link written as a swap's first is written as its second.
 */
export type LinkEdit = { at: string; was: string; swaps: [string, string][] };

/**
 * What an app did to follow a rename or move (`hooks.followMove`: a stage's
 * order entry and audio folder following its document), as the way to put it
 * back. Like `LinkEdit`s it rides on the act, so one arrow covers the file and
 * the app's part: the kit runs it after its own undo or redo of the rename or
 * move, and it returns the way to do its part again (absent: nothing to do
 * again). It names what it acts on by name and reads the world as it is when
 * it runs, as an `AppAct`'s undo does.
 *
 * Done only in part (a folder it could not rename), or done in full but with
 * something the human should read (a renders folder it left where it was), a
 * follow, or the hook, throws a `FollowError` carrying the way back from what
 * it DID do: the kit keeps that on the act as if it had returned it, and the
 * chat line says the message. Any other throw keeps no way back.
 */
export type Follow = () => Follow | undefined;

/** A follow that did only part of its work, or has something to say: `follow` puts back what it did. */
export class FollowError extends Error {
  constructor(
    message: string,
    readonly follow?: Follow,
  ) {
    super(message);
    this.name = "FollowError";
  }
}

/** The edits that undo `edits`, applied after the move that undoes theirs. */
export function reverseLinkEdits(edits: readonly LinkEdit[]): LinkEdit[] {
  return edits.map((e) => ({
    at: e.was,
    was: e.at,
    swaps: e.swaps.map(([a, b]): [string, string] => [b, a]),
  }));
}

/** One act, with the way back and a sentence for the arrow's tooltip. */
export type Act = {
  /** What happened, for the tooltip: "moved note.md into drafts". */
  label: string;
  inverse: Inverse;
};

/** What the act returned: the session's own result, narrowed to what we use. */
export type After = {
  path?: string;
  /** Where a move or rename came from, or what was duplicated. */
  from?: string;
  /** What a creation wrote, by `treeHash`: a bundle's or a copy's undo checks it. */
  hash?: string;
  /** What a duplicate made is a folder (a bundle's copy). */
  dir?: boolean;
  /**
   * What the act acted on is called, before and after, when that is not its
   * file name: a bundle, by its title.
   */
  names?: { from?: string; to?: string };
  /** A bundle's title, before and after a rename that changed it. */
  title?: { from?: string; to?: string };
  /** What a folder creation made has an entry of its own: a set. */
  set?: boolean;
  /**
   * The way back the session holds and only the daemon can call (`set.make`'s
   * `unmakeSet`), as an app's act holds one: run as one.
   */
  inverse?: Extract<Inverse, { kind: "app" }>;
};

const base = (p: string): string => p.split("/").pop() ?? p;
const parent = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/";

/**
 * The way back from one act, or null for an act with no inverse worth keeping.
 */
export function planInverse(op: StructureOp, after: After): Act | null {
  const fromName = (p: string | undefined) => after.names?.from ?? base(p ?? "");
  const toName = (p: string | undefined) => after.names?.to ?? base(p ?? "");
  switch (op.op) {
    // Brought something into existence: no inverse that does not delete.
    case "doc.create":
      return {
        label: `created ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false },
      };
    case "folder.create":
      return {
        label: `created the ${after.set ? "set" : "folder"} ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: true },
      };
    case "folder.add":
      return {
        label: `created the ${after.set ? "set" : "folder"} ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: true },
      };
    // Its way back is the session's (`unmakeSet`): the daemon hands it in.
    case "set.make":
      return after.inverse ? { label: after.inverse.label, inverse: after.inverse } : null;
    case "import":
      return {
        label: `copied in ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false },
      };
    // Made whole by the act, files and all: undone to the Trash, and only
    // while it is still as it was made.
    case "bundle.create":
      if (after.hash === undefined) return null;
      return {
        label: `created ${toName(after.path)}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: true, unchanged: after.hash },
      };
    case "duplicate":
      if (after.hash === undefined) return null;
      return {
        label: `duplicated ${fromName(after.from)} as ${toName(after.path)}`,
        inverse: {
          kind: "delete",
          path: after.path ?? "",
          dir: after.dir === true,
          unchanged: after.hash,
        },
      };

    // Not part of the context's shape: nothing to put back with the arrows.
    case "workspace.set":
      return null;

    // Reversible, with arguments only the act knew.
    case "move": {
      if (after.path === undefined || after.from === undefined) return null;
      return {
        label: `moved ${fromName(after.from)} into ${base(parent(after.path))}`,
        inverse: { kind: "move", path: after.path, into: parent(after.from) },
      };
    }
    case "rename": {
      if (after.path === undefined || after.from === undefined) return null;
      return {
        label: `renamed ${fromName(after.from)} to ${toName(after.path)}`,
        inverse: {
          kind: "rename",
          path: after.path,
          name: base(after.from),
          ...(after.title
            ? { title: { ...(after.title.from !== undefined ? { to: after.title.from } : {}) } }
            : {}),
        },
      };
    }
  }
}

/** What the arrows need to know, and nothing else. */
export type HistoryView = {
  canUndo: boolean;
  canRedo: boolean;
  /** "moved note.md into drafts", for the tooltip. */
  undoLabel?: string;
  redoLabel?: string;
  /**
   * Set when the next undo would delete something, so the surface can raise a
   * confirmation before sending it. Present means "ask first", not "refuse".
   * `also`: further paths the same undo removes (an app's act that made several).
   */
  undoDeletes?: { path: string; dir: boolean; also?: string[] };
};

/** What the act's undo would delete, when it would: the first path, and the rest. */
export function deletesOf(act: Act | null): HistoryView["undoDeletes"] {
  const inv = act?.inverse;
  if (inv?.kind === "delete") return { path: inv.path, dir: inv.dir };
  if (inv?.kind !== "app" || !inv.creates || inv.creates.length === 0) return undefined;
  const [first, ...rest] = inv.creates as [Created, ...Created[]];
  return {
    path: first.path,
    dir: first.dir,
    ...(rest.length > 0 ? { also: rest.map((c) => c.path) } : {}),
  };
}

/**
 * The two stacks.
 *
 * In memory, not in the manifest, and that is a decision rather than laziness:
 * an inverse recorded now describes the world as it is now, and a session
 * restored tomorrow may meet a file somebody has since moved by hand. Offering
 * an undo whose arguments have gone stale is worse than starting each session
 * with an empty history, so the arrows are grey after a restore.
 */
export class History {
  private undos: Act[] = [];
  private redos: Act[] = [];

  /** Record an act. A new act makes the redo stack meaningless. */
  did(act: Act | null): void {
    if (!act) return;
    this.undos.push(act);
    this.redos = [];
  }

  /** What the next undo would do, without doing it. */
  peekUndo(): Act | null {
    return this.undos[this.undos.length - 1] ?? null;
  }

  peekRedo(): Act | null {
    return this.redos[this.redos.length - 1] ?? null;
  }

  /**
   * Take the next undo, having applied it. `redo` is the act that would put it
   * back, built by the caller because only the caller knows what its own
   * inverse produced.
   */
  tookUndo(redo: Act | null): void {
    const act = this.undos.pop();
    if (!act) return;
    if (redo) this.redos.push(redo);
  }

  tookRedo(undo: Act | null): void {
    const act = this.redos.pop();
    if (!act) return;
    if (undo) this.undos.push(undo);
  }

  /**
   * Take the next undo off without applying it: it can never succeed (it names
   * a place that is gone), and left on top it would hide every older act.
   */
  dropUndo(): Act | null {
    return this.undos.pop() ?? null;
  }

  dropRedo(): Act | null {
    return this.redos.pop() ?? null;
  }

  view(): HistoryView {
    const undo = this.peekUndo();
    const redo = this.peekRedo();
    const deletes = deletesOf(undo);
    return {
      // A deleting undo is still undoable: the gate is the dialog, not the
      // disabled state.
      canUndo: undo !== null,
      canRedo: redo !== null,
      ...(undo ? { undoLabel: undo.label } : {}),
      ...(redo ? { redoLabel: redo.label } : {}),
      ...(deletes ? { undoDeletes: deletes } : {}),
    };
  }

  /** How deep the stacks are, for tests. */
  depth(): { undo: number; redo: number } {
    return { undo: this.undos.length, redo: this.redos.length };
  }
}

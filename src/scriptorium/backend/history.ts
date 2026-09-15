// Undo and redo for the CONTEXT — moving things around, adding, hiding (E60).
//
// ⛔ THIS IS NOT THE EDITOR'S UNDO, and the surface says so by putting these
// arrows in the context header rather than anywhere near the text. CodeMirror's
// history owns keystrokes inside a document; this owns acts on the SHAPE of the
// context, which is the thing that had no way back at all. Cole: "letting the
// user know that there's an undo for this sidebar that isn't the same as undo
// redo when you're in the editor."
//
// ⛔ UNDOING A CREATION DELETES, BUT ONLY BEHIND A CONFIRMATION. This started as
// a hard block — undo never deletes — and Cole pushed back, correctly: blocking
// does not refuse one step, it STRANDS EVERYTHING BEHIND IT. Create a folder, do
// two moves, and you can undo the moves and then meet a wall you can never
// pass, at which point the history has stopped being a history. And the thing
// undo would remove is one the session itself made moments ago, usually empty —
// categorically different from deleting work, and the app already has the
// pattern for it in the version-delete dialog. So the arrow stays enabled and
// the CONFIRMATION is the gate.
//
// ⛔ WITH ONE HARD LIMIT THAT IS NOT NEGOTIABLE BY DIALOG: a NON-EMPTY folder is
// refused outright. Undo works backwards, so it empties a folder before it
// reaches that folder's creation; if the folder still has contents, something
// put them there that this history does not know about, and removing a
// directory tree is a different act from removing the empty thing you just
// made. That case stops and says why.
//
// ⚠ THE INVERSE IS BUILT WHEN THE ACT HAPPENS, from what was actually true
// then — not reconstructed later from the op. A `move` records where the thing
// CAME from because only the mover knows; a `hide` records the entry's whole
// hidden list because that is what restores it exactly, including the case
// where hiding removed a single-document entry outright.
import type { StructureOp } from "./protocol";

/**
 * How to put one act back. Each variant is something the session can already
 * do, so undo introduces no new way to change the world — it only replays the
 * existing ones with recorded arguments.
 */
export type Inverse =
  | { kind: "move"; path: string; into: string }
  | { kind: "rename"; path: string; name: string }
  /** Set an entry's hidden list to exactly these relative paths. */
  | { kind: "hidden"; entry: string; rels: string[] }
  /** Put a whole document or folder back in the context. */
  | { kind: "context.add"; path: string }
  /** Take a context entry back out (the inverse of putting one in). */
  | { kind: "context.remove"; entry: string }
  | { kind: "workspace"; path: string }
  /**
   * Remove what the act created. `dir` decides both the dialog's words and the
   * emptiness rule — a file is confirmed, a folder is confirmed AND must be
   * empty.
   */
  | { kind: "delete"; path: string; dir: boolean };

/** One act, with the way back and a sentence for the arrow's tooltip. */
export type Act = {
  /** What happened, for the tooltip: "moved note.md into drafts". */
  label: string;
  inverse: Inverse;
};

/**
 * What the session knew before the act — the parts an inverse may need.
 *
 * ⚠ Passed in rather than read back afterwards, because every field here is
 * something the act itself CHANGES. Reading `hidden` after a hide returns the
 * list including the thing just hidden, which restores nothing.
 */
export type Before = {
  /** The entry's hidden list before the act, when the act touched one. */
  hidden?: { entry: string; rels: string[] };
  /** The workspace before the act. */
  workspace?: string;
};

/** What the act returned — the session's own result, narrowed to what we use. */
export type After = {
  path?: string;
  /** Where a move or rename came FROM. */
  from?: string;
  /** The folder `set.make` created. */
  folder?: string;
  /** The entry a hide touched, and whether it removed that entry entirely. */
  entry?: string;
  removedEntry?: boolean;
};

const base = (p: string): string => p.split("/").pop() ?? p;
const parent = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/"))) || "/";

/**
 * The way back from one act.
 *
 * Returns null for an act not worth a history entry at all — `unhide` on an
 * entry that had nothing hidden changed nothing, and an undo arrow that steps
 * over no-ops is an arrow that lies about how far back it can go.
 */
export function planInverse(op: StructureOp, after: After, before: Before): Act | null {
  switch (op.type) {
    // ── brought something into existence: no inverse that does not delete ──
    case "doc.create":
      return {
        label: `created ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false },
      };
    case "folder.create":
      return {
        label: `created the folder ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: true },
      };
    case "import":
      return {
        label: `copied in ${base(after.path ?? "")}`,
        inverse: { kind: "delete", path: after.path ?? "", dir: false },
      };
    case "set.make":
      // ⚠ THE FOLDER IS THE THING TO UNDO, not the move inside it. `set.make`
      // creates a folder and moves the document in, so the inverse is to
      // remove the folder — which the emptiness rule will refuse while the
      // document is still in there. That refusal is correct and readable
      // ("the folder is not empty"), and the way through it is to move the
      // document out first, which is itself an undoable act.
      return {
        label: `turned ${base(op.path)} into a set`,
        inverse: { kind: "delete", path: after.folder ?? "", dir: true },
      };

    // ── reversible, with arguments only the act knew ──
    case "move": {
      if (after.path === undefined || after.from === undefined) return null;
      return {
        label: `moved ${base(after.from)} into ${base(parent(after.path))}`,
        inverse: { kind: "move", path: after.path, into: parent(after.from) },
      };
    }
    case "rename": {
      if (after.path === undefined || after.from === undefined) return null;
      return {
        label: `renamed ${base(after.from)} to ${base(after.path)}`,
        inverse: { kind: "rename", path: after.path, name: base(after.from) },
      };
    }
    case "hide": {
      // Two shapes: hiding one item inside a set, or hiding a single-document
      // entry, which removes the entry outright.
      if (after.removedEntry) {
        return {
          label: `removed ${base(after.path ?? "")} from the context`,
          inverse: { kind: "context.add", path: after.path ?? "" },
        };
      }
      const had = before.hidden;
      if (!had) return null;
      return {
        label: `removed ${base(after.path ?? "")} from the context`,
        inverse: { kind: "hidden", entry: had.entry, rels: had.rels },
      };
    }
    case "unhide": {
      const had = before.hidden;
      // Nothing was hidden, so nothing happened: not history.
      if (!had || had.rels.length === 0) return null;
      return {
        label: `brought back ${had.rels.length} hidden item${had.rels.length === 1 ? "" : "s"}`,
        inverse: { kind: "hidden", entry: had.entry, rels: had.rels },
      };
    }
    case "workspace.set": {
      const was = before.workspace;
      if (was === undefined || was === after.path) return null;
      return {
        label: `set the workspace to ${base(after.path ?? "")}`,
        inverse: { kind: "workspace", path: was },
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
   * Set when the next undo would DELETE something, so the surface can raise a
   * confirmation before sending it. Present means "ask first", not "refuse".
   */
  undoDeletes?: { path: string; dir: boolean };
};

/**
 * The two stacks.
 *
 * ⚠ IN MEMORY, NOT IN THE MANIFEST, and that is a decision rather than
 * laziness: an inverse recorded now describes the world as it is now, and a
 * session restored tomorrow may meet a file somebody has since moved by hand.
 * Offering an undo whose arguments have gone stale is worse than starting each
 * session with an empty history — so the arrows are grey after a restore, which
 * is honest about what can still be put back.
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
   * back — built by the caller, because only the caller knows what its own
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

  view(): HistoryView {
    const undo = this.peekUndo();
    const redo = this.peekRedo();
    const deletes = undo?.inverse.kind === "delete" ? undo.inverse : undefined;
    return {
      // ⛔ A DELETING UNDO IS STILL UNDOABLE — the gate is the dialog, not the
      // disabled state (Cole's ruling, reversing an earlier design that
      // stranded every act behind a creation).
      canUndo: undo !== null,
      canRedo: redo !== null,
      ...(undo ? { undoLabel: undo.label } : {}),
      ...(redo ? { redoLabel: redo.label } : {}),
      ...(deletes ? { undoDeletes: { path: deletes.path, dir: deletes.dir } } : {}),
    };
  }

  /** How deep the stacks are — for tests and for `state --full`. */
  depth(): { undo: number; redo: number } {
    return { undo: this.undos.length, redo: this.redos.length };
  }
}

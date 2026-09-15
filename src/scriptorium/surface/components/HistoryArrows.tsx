// The context's undo and redo (E60) — Cole's shape: "those left and right undo
// redo arrows… at the top of the context header… as you're moving things
// around, those buttons light up."
//
// ⛔ THEY LIVE IN THE CONTEXT HEADER BECAUSE THEY ARE NOT THE EDITOR'S UNDO,
// and placement is the only honest way to say so. ⌘Z inside the text belongs to
// CodeMirror and always will; these step back through acts on the SHAPE of the
// context — a move, a rename, a document removed from the list. Cole: "letting
// the user know that there's an undo for this sidebar that isn't the same as
// undo redo when you're in the editor."
//
// ⛔ AND A DELETING UNDO ASKS FIRST. Undoing a creation removes what it created,
// which Cole ruled should be possible rather than blocked — blocking strands
// every act behind it — so the arrow stays live and the CONFIRMATION is the
// gate, in the same dialog shape as deleting a version.
import { cn } from "cn";
import { Redo2Icon, Undo2Icon } from "lucide-react";
import { useConfirm } from "../../../kit/ui/ConfirmDialog";
import type { HistoryView } from "../../backend/protocol";

export function HistoryArrows({
  history,
  display,
  onUndo,
  onRedo,
}: {
  history: HistoryView;
  /** Shorten a path the way the rest of the surface does (`~/notes/a.md`). */
  display: (path: string) => string;
  /** `confirmDelete` is only ever true after the human has said so. */
  onUndo: (confirmDelete: boolean) => void;
  onRedo: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const deletes = history.undoDeletes;

  const undoTitle = history.canUndo
    ? deletes
      ? `Undo: ${history.undoLabel} — this deletes ${display(deletes.path)}`
      : `Undo: ${history.undoLabel}`
    : "Nothing to undo in the context";

  return (
    <>
      <button
        type="button"
        aria-label={undoTitle}
        title={undoTitle}
        disabled={!history.canUndo}
        onClick={async () => {
          if (!deletes) {
            onUndo(false);
            return;
          }
          // ⚠ NAMED, AND STYLED AS DANGER, because the human is one click from
          // removing a file. The same dialog the version delete uses, for the
          // same reason: a confirmation that does not say WHAT gets a reflexive
          // yes.
          const ok = await confirm({
            title: deletes.dir ? "Delete this folder?" : "Delete this document?",
            message: `Undoing "${history.undoLabel}" removes ${display(deletes.path)}.`,
            warning: deletes.dir
              ? "The folder must be empty; anything still inside it stops this."
              : "Anything written in it is lost, and this step cannot be redone.",
            confirmLabel: "Delete",
            confirmClassName: "bg-danger text-bg hover:bg-danger/90",
          });
          if (ok) onUndo(true);
        }}
        className={cn(
          "flex size-6 items-center justify-center rounded-sm outline-none",
          "text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
          "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-ink-faint",
          // A deleting undo is available but marked, so "lit up" never means
          // "safe" without looking.
          deletes && history.canUndo && "text-attention hover:text-attention",
        )}
      >
        <Undo2Icon aria-hidden className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={
          history.canRedo ? `Redo: ${history.redoLabel}` : "Nothing to redo in the context"
        }
        title={history.canRedo ? `Redo: ${history.redoLabel}` : "Nothing to redo in the context"}
        disabled={!history.canRedo}
        onClick={() => onRedo()}
        className={cn(
          "flex size-6 items-center justify-center rounded-sm outline-none",
          "text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
          "disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-ink-faint",
        )}
      >
        <Redo2Icon aria-hidden className="size-3.5" />
      </button>
      {dialog}
    </>
  );
}

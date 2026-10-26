// The context's undo and redo. They live in the context's header because they
// are not the editor's undo, and placement is the only honest way to say so:
// they step back through acts on the SHAPE of the context (a move, a rename, a
// new document), while undo inside the text belongs to the editor.
//
// A deleting undo asks first. Undoing a creation removes what it created, which
// stays possible rather than blocked (blocking strands every act behind it), so
// the arrow stays live and the confirmation is the gate.

import { Redo2Icon, Undo2Icon } from "lucide-react";
import { bundleOf } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { useConfirm } from "../ui/ConfirmDialog.tsx";
import type { HistoryView } from "../workspace/protocol";

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
  // One undo may remove several things an app's act made (a stage's copies):
  // every one is named, never "and others".
  const many = (deletes?.also?.length ?? 0) > 0;
  const named = deletes ? listed([deletes.path, ...(deletes.also ?? [])].map(display)) : "";

  const undoTitle = history.canUndo
    ? deletes
      ? `Undo: ${history.undoLabel} — this deletes ${named}`
      : `Undo: ${history.undoLabel}`
    : "Nothing to undo in the context";

  return (
    <>
      <button
        type="button"
        aria-label={undoTitle}
        data-action="history-undo"
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
          // A bundle (a board, a stage) is a folder by its files, but one
          // thing to the human: it goes to the Trash whole, while unchanged,
          // so the folder's emptiness rule does not apply to it.
          const bundle = !many && deletes.dir ? bundleOf(deletes.path) : null;
          const whole = bundle?.inner === "" ? bundle.type.label : null;
          const ok = await confirm({
            title: many
              ? "Delete these?"
              : whole
                ? `Delete this ${whole}?`
                : deletes.dir
                  ? "Delete this folder?"
                  : "Delete this document?",
            message: `Undoing "${history.undoLabel}" removes ${named}.`,
            warning: many
              ? "Each goes to the Trash only while it is as it was made, and this step cannot be redone."
              : whole
                ? `The ${whole} goes to the Trash whole, with everything in it, and only while it is as it was made; this step cannot be redone.`
                : deletes.dir
                  ? "The folder must be empty; anything still inside it stops this."
                  : "Anything written in it is lost, and this step cannot be redone.",
            confirmLabel: "Delete",
            confirmClassName: "border border-danger bg-danger text-bg hover:bg-danger/90",
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

/** Names as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

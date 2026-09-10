import { useEffect, useState } from "react";
import type { Task } from "../state/types";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * The card's full title and its editable description.
 *
 * ⚠ THE TASK IS CAPTURED AT OPEN, ON PURPOSE. `task` is the object the board
 * held when the modal opened; a concurrent `task.update` replaces the array
 * entry rather than mutating it, so the open modal keeps showing what the human
 * opened. That was the old page's behaviour and it is faithful here — the
 * alternative silently rewrites the title under an editor's hands.
 *
 * Save sends only on a real change. "" is a valid clear and IS sent when it
 * differs from the current notes.
 */
export function DetailDialog({
  task,
  onClose,
  onSave,
}: {
  task: Task | null;
  onClose: () => void;
  onSave: (id: string, notes: string) => void;
}) {
  const [notes, setNotes] = useState("");

  // Re-buffer whenever a different card is opened. Closing resets it, so
  // reopening always re-reads from the task.
  useEffect(() => {
    setNotes(task?.notes ?? "");
  }, [task]);

  if (!task) return null;

  const save = () => {
    if (notes !== (task.notes ?? "")) onSave(task.id, notes);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[520px] gap-3 border-edge-hover bg-surface">
        <DialogHeader>
          <DialogTitle className="text-base break-words">{task.title}</DialogTitle>
        </DialogHeader>
        <Label htmlFor="detail-notes" className="text-[0.68rem] tracking-[0.05em] uppercase">
          Description
        </Label>
        <Textarea
          id="detail-notes"
          rows={7}
          autoFocus
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="No description yet — add one…"
          className="min-h-28 resize-y bg-bg text-[0.85rem]"
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

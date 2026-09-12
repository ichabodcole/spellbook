// Naming a new version (E37), modelled on Operator's `SaveVersionDialog.vue`.
//
// ⛔ IT IS A SNAPSHOT, NOT A BRANCH — you keep editing the version you were on,
// and the copy sits in the list until you choose it. This is Operator's model
// ("Preserve the current document state so you can refer back to it later")
// and it is the one that matches when a human reaches for this: BEFORE doing
// something risky, wanting to carry on where they are. Switching to the copy
// is one click away in the menu, so the other reading is not lost. The wording
// here used to describe a branch while the code made a snapshot; the browser
// showed the mismatch.
//
// ⛔ THE NAME IS ABOUT INTENT, NOT CHRONOLOGY. Operator's hint — "Use a
// descriptive name like 'Before AI cleanup' or 'Draft 2'" — is the whole
// design in one sentence: the version number is already known, so the only
// thing a human can add is WHY they made it. That is also why an empty name is
// allowed here where Operator requires one: `v3` is a perfectly good name for
// a snapshot taken in a hurry, and a forced field would just collect "asdf".
import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Input } from "@/ui/input";

export function NewVersionDialog({
  open,
  from,
  next,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  /** The version the copy is taken from — named so the human knows what they get. */
  from: number;
  /** The number the new version will get — the placeholder, so it is not a guess. */
  next: number;
  onOpenChange: (open: boolean) => void;
  onCreate: (label: string) => void;
}) {
  const [label, setLabel] = useState("");
  const field = useRef<HTMLInputElement>(null);

  // A dialog that keeps the last name typed would offer it for the next
  // version, which is a different snapshot entirely.
  useEffect(() => {
    if (open) setLabel("");
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreate(label.trim());
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New version from v{from}</DialogTitle>
            <DialogDescription>
              A snapshot of v{from} as it is now. You carry on editing v{from}; the copy waits here
              in case you want it back — useful before handing the document to the agent, or before
              a rewrite you might not keep.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor="version-label" className="text-sm font-medium text-ink">
              Name
            </label>
            <Input
              id="version-label"
              ref={field}
              value={label}
              autoComplete="off"
              placeholder={`v${next}`}
              onChange={(e) => setLabel(e.target.value)}
            />
            <p className="text-xs text-ink-faint">
              Say what it is for — “before the agent's pass”, “shorter draft”. Leave it empty and it
              is just its number.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Make version</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

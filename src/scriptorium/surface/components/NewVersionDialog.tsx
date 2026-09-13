// Naming a new version (E37), in whichever of the two intentions the human
// picked (E42).
//
// ⛔ TWO INTENTIONS, AND THE LABEL IS THE TELL. Both make the same file — a
// byte-identical copy of what is in front of you — and differ only in which
// copy you keep typing into, which decides what the name you type DESCRIBES:
//
//   BRANCH   "I'm going somewhere new."   You move to the copy; the name says
//                                         what you are about to do there.
//   SNAPSHOT "Mark this, I'm staying."    You stay; the name says what the
//                                         frozen copy preserves.
//
// This dialog used to offer both examples in ONE hint — "before the agent's
// pass", "shorter draft" — which is two mental models in a single sentence and
// is the evidence the design had not decided. Version labels are write-once
// (there is no rename-version verb), so a name attached to the wrong side stays
// wrong: the words have to match the act before the file is made, not after.
//
// The wording for each is Operator's for snapshot ("preserve the current
// document state so you can refer back to it later") and ours for branch.
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

/** Which intention the human picked — the whole difference between the two. */
export type VersionIntent = "branch" | "snapshot";

export function NewVersionDialog({
  open,
  intent,
  from,
  next,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  intent: VersionIntent;
  /** The version the copy is taken from — named so the human knows what they get. */
  from: number;
  /** The number the new version will get — the placeholder, so it is not a guess. */
  next: number;
  onOpenChange: (open: boolean) => void;
  onCreate: (label: string) => void;
}) {
  const branching = intent === "branch";
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
              {branching ? (
                <>
                  A copy of v{from} to work in.{" "}
                  <strong className="font-semibold text-ink">You will be editing v{next}</strong>{" "}
                  from here; v{from} stays exactly as it is now.
                </>
              ) : (
                <>
                  A copy of v{from} as it is now, kept as v{next}.{" "}
                  <strong className="font-semibold text-ink">You carry on editing v{from}</strong> —
                  useful before handing the document to the agent, or before a rewrite you might not
                  keep.
                </>
              )}
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
              {branching
                ? "Say what you are about to do — “shorter draft”, “rewrite the opening”."
                : "Say what it preserves — “before the agent's pass”, “end of Tuesday”."}{" "}
              Leave it empty and it is just its number.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">
              {branching ? `Make v${next} and edit it` : `Snapshot as v${next}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// L2 — the rail's `+`: a Dialog with a name and an optional topic; Enter
// submits. The daemon's 409 for an archived name is named in place and the
// footer offers _Unarchive instead_.

import { useId, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { type CreateOutcome, createArchivedText, createTopicHint } from "../state/lifecycle";

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreate,
  onUnarchive,
  finalFocus,
  signer,
  existingNames,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, topic: string) => Promise<CreateOutcome>;
  onUnarchive: (name: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  // The dialog is opened by state, not a DialogTrigger, so Base UI has no
  // trigger to hand focus back to on close — the rail passes its `+`.
  finalFocus: React.RefObject<HTMLElement | null>;
  // Who a given topic is signed as (L3a); the daemon signs `system` otherwise.
  signer: string | null;
  // L2c — the rail's channel names, so the topic hint can say what a typed
  // topic will actually do for a name that already exists.
  existingNames: string[];
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const nameId = useId();
  const topicId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setName("");
    setTopic("");
    setBusy(false);
    setOutcome(null);
  };
  const change = (o: boolean) => {
    if (!o) reset();
    onOpenChange(o);
  };

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const r = await onCreate(n, topic);
    setOutcome(r);
    setBusy(false);
    if (r.kind === "created") change(false);
  };

  const archived = outcome?.kind === "archived";
  const error = outcome?.kind === "error" ? outcome.message : null;

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent finalFocus={finalFocus}>
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>
              Creates the channel, or opens it if it already exists.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor={nameId}>Name</FieldLabel>
              <Input
                id={nameId}
                ref={nameRef}
                autoFocus
                value={name}
                placeholder="design-review"
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setOutcome(null);
                }}
              />
              {error && <FieldError>{error}</FieldError>}
              {archived && <FieldDescription>{createArchivedText(name.trim())}</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel htmlFor={topicId}>Topic (optional)</FieldLabel>
              <Input
                id={topicId}
                value={topic}
                placeholder="what this channel is for"
                onChange={(e) => setTopic(e.target.value)}
              />
              {topic.trim() && (
                <FieldDescription>
                  {createTopicHint(existingNames.includes(name.trim()), signer)}
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            {archived ? (
              <Button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r = await onUnarchive(name.trim());
                  setBusy(false);
                  // L2b — a failed unarchive keeps the dialog open and names
                  // the daemon's reason on the field; focus stays inside.
                  if (r.ok) change(false);
                  else {
                    setOutcome({ kind: "error", message: r.message });
                    // The button that had focus is replaced by Create; keep
                    // focus in the dialog, on the field that carries the error.
                    requestAnimationFrame(() => nameRef.current?.focus());
                  }
                }}
              >
                Unarchive instead
              </Button>
            ) : (
              <Button type="submit" disabled={!name.trim() || busy}>
                Create
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

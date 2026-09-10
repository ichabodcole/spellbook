// H1–H3 — the leaf, `grapevine · <channel>`, and the topic line; L3 — the
// topic line edits in place: click (or Enter on it) turns it into an Input,
// Enter commits, Escape and blur cancel. Disabled with a tooltip on an
// archived channel or when there is no alias to sign the edit with.

import { cn } from "cn";
import { useEffect, useId, useRef, useState } from "react";
import { Field, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { shouldCancelEdit } from "../state/lifecycle";

export function Header({
  channel,
  topic,
  editState,
  editRequest,
  signer,
  onCommit,
}: {
  channel: string;
  topic: string;
  editState: { disabled: false } | { disabled: true; reason: string };
  // Who the edit is signed as (L3a) — shown in the editor's placeholder, since
  // the You box may read a different (override) name while lurking.
  signer: string | null;
  // Bumped by whoever wants the editor open (the rail's _Edit topic_).
  editRequest: number;
  onCommit: (topic: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(topic);
  const topicId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const lastRequest = useRef(editRequest);
  // Enter and Escape close the editor from the keyboard, so focus goes back to
  // the line it came from; a blur means focus already went somewhere else.
  const restoreFocus = useRef(false);

  const start = () => {
    if (editState.disabled) return;
    setDraft(topic);
    setEditing(true);
  };

  // A request from outside opens the editor once per bump; the menu that
  // raised it is still closing, so focus is taken on the next frame.
  useEffect(() => {
    if (editRequest === lastRequest.current) return;
    lastRequest.current = editRequest;
    if (editState.disabled) return;
    setDraft(topic);
    setEditing(true);
  }, [editRequest, editState.disabled, topic]);
  useEffect(() => {
    if (editing) {
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    if (restoreFocus.current) {
      restoreFocus.current = false;
      buttonRef.current?.focus();
    }
  }, [editing]);

  const close = (fromKeyboard: boolean) => {
    restoreFocus.current = fromKeyboard;
    setEditing(false);
  };
  // L3c — an archive that lands while the editor is open (the agent's, over
  // the poll) cancels the edit and hands focus back to the line; and commit
  // re-reads the state, so an Enter that races the poll sends nothing.
  useEffect(() => {
    if (shouldCancelEdit(editing, editState.disabled)) close(true);
  }, [editing, editState.disabled]);

  const commit = async () => {
    if (editState.disabled) return close(true);
    close(true);
    await onCommit(draft.trim());
  };

  return (
    <header className="flex items-center gap-4 border-b border-edge bg-surface px-6 py-4">
      <span className="text-[22px]">🌿</span>
      <div className="flex-1">
        <h1 className="m-0 text-base font-semibold tracking-[0.01em]">
          grapevine<span className="mx-1.5 text-ink-dim">·</span>
          <span className="text-leaf-soft">{channel}</span>
        </h1>
        {editing ? (
          <Field className="max-w-[560px]">
            <FieldLabel htmlFor={topicId} className="sr-only">
              Topic
            </FieldLabel>
            <Input
              id={topicId}
              ref={inputRef}
              value={draft}
              placeholder={signer ? `set a topic (as ${signer})…` : "set a topic…"}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => close(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close(true);
                }
              }}
            />
          </Field>
        ) : editState.disabled ? (
          // `aria-disabled`, not `disabled`: a disabled control is unfocusable and
          // takes no pointer events, so the tooltip that explains WHY could never
          // open. This one stays reachable and does nothing.
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={buttonRef}
                  type="button"
                  aria-disabled="true"
                  aria-label="Edit topic"
                  className={cn(
                    "m-0 cursor-not-allowed rounded-sm border-0 bg-transparent p-0 text-left text-[13px] text-ink-dim opacity-70 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    !topic && "italic",
                  )}
                />
              }
            >
              {topic || "no topic set"}
            </TooltipTrigger>
            <TooltipContent>{editState.reason}</TooltipContent>
          </Tooltip>
        ) : (
          <button
            ref={buttonRef}
            type="button"
            aria-label="Edit topic"
            title={signer ? `Click to edit the topic (as ${signer})` : "Click to edit the topic"}
            className={cn(
              "m-0 rounded-sm border-0 bg-transparent p-0 text-left text-[13px] text-ink-dim outline-none hover:text-ink focus-visible:ring-3 focus-visible:ring-ring/50",
              !topic && "italic",
            )}
            onClick={start}
          >
            {topic || "no topic set"}
          </button>
        )}
      </div>
    </header>
  );
}

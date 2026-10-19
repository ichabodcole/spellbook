// Ending a session, and what the page says once it has ended.
//
// One dialog carries both halves when the human ends it here: it asks first, and
// on confirm the same dialog turns into the ended state (who ended it, the command
// that brings the session back, and Copy). When the agent or the idle timeout ends
// it there is nothing to ask, so the ended dialog opens on its own. Once closed,
// the top bar keeps a small "Ended" chip whose popover says the same again. No
// banner: the read-only editor and the disabled controls already show it.

import { CheckIcon, CopyIcon, InfoIcon } from "lucide-react";
import { type Ref, type RefObject, useRef, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { cn } from "../lib/cn.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/index.ts";

/** Where the end dialog has got to: asking, waiting on the daemon, or ended. */
export type EndPhase = "confirm" | "ending" | "ended";

const BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50";

/** Who ended the session, in a sentence. */
export function endedSentence(by: Daemon["endedBy"]): string {
  return by === "human"
    ? "You ended this session."
    : by === "timeout"
      ? "This session closed after it sat idle."
      : "The agent ended this session.";
}

/** Who ended it and the command that brings it back: what the dialog describes. */
export function EndedMessage({
  command,
  by,
  codeRef,
}: {
  command: string;
  by: Daemon["endedBy"];
  codeRef?: Ref<HTMLElement>;
}) {
  return (
    <>
      <p className="text-sm leading-relaxed text-ink-dim">
        {endedSentence(by)} What is on screen stays here to look at. To keep working, run
      </p>
      <code
        ref={codeRef}
        data-slot="restore-command"
        className="block rounded-md border border-edge bg-bg px-2.5 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-ink"
      >
        {command}
      </code>
    </>
  );
}

/**
 * Copy the command. Where the clipboard refuses (no permission, no secure
 * context), the command is selected instead and the button says to copy it.
 */
export function CopyCommand({
  command,
  codeRef,
}: {
  command: string;
  codeRef: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<"idle" | "copied" | "select">("idle");
  const selectIt = () => {
    const code = codeRef.current;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (code && sel) {
      sel.removeAllRanges();
      sel.selectAllChildren(code);
    }
    setState("select");
  };
  return (
    <div className="flex justify-end">
      <button
        type="button"
        data-slot="copy-command"
        onClick={() => {
          const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
          if (!clip) return selectIt();
          clip.writeText(command).then(() => setState("copied"), selectIt);
        }}
        className={cn(BUTTON, "border border-edge bg-surface text-ink hover:bg-bg")}
      >
        {state === "copied" ? (
          <CheckIcon aria-hidden className="size-3.5" />
        ) : (
          <CopyIcon aria-hidden className="size-3.5" />
        )}
        {state === "copied" ? "Copied" : state === "select" ? "Select and copy" : "Copy command"}
      </button>
    </div>
  );
}

/** The ended state's body: who ended it, the command that brings it back, and Copy. */
export function EndedDetails({ command, by }: { command: string; by: Daemon["endedBy"] }) {
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div data-slot="session-ended-details" className="grid gap-3">
      <EndedMessage command={command} by={by} codeRef={codeRef} />
      <CopyCommand command={command} codeRef={codeRef} />
    </div>
  );
}

/** The one dialog for ending: the question, then the ended state in its place. */
export function SessionEndDialog({
  phase,
  onOpenChange,
  onConfirm,
  sessionId,
  command,
  by,
  connected,
  notice,
  finalFocus,
}: {
  /** Null is closed. */
  phase: EndPhase | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  sessionId: string;
  command: string;
  by: Daemon["endedBy"];
  /** Whether the daemon can hear a close: End session waits on it. */
  connected: boolean;
  /** Why the last confirm did not end it, shown under the question. */
  notice?: string | null;
  /** Where focus goes when the dialog closes: it has no trigger of its own. */
  finalFocus?: () => HTMLElement | boolean | null;
}) {
  const codeRef = useRef<HTMLElement>(null);
  return (
    <Dialog open={phase !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="session-end-dialog"
        data-phase={phase ?? undefined}
        finalFocus={finalFocus}
        className="border border-edge bg-surface text-ink sm:max-w-md"
      >
        {phase === "ended" ? (
          <>
            <DialogTitle className="text-sm font-semibold text-ink">Session ended</DialogTitle>
            <DialogDescription render={<div />} className="grid gap-3 text-ink-dim">
              <EndedMessage command={command} by={by} codeRef={codeRef} />
            </DialogDescription>
            <CopyCommand command={command} codeRef={codeRef} />
          </>
        ) : (
          <>
            <DialogTitle className="text-sm font-semibold text-ink">
              End session {sessionId}?
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed text-ink-dim">
              The daemon stops and the agent is told you ended it. The session stays on disk, so it
              can be reopened with {command}.
            </DialogDescription>
            {notice && (
              <p
                role="alert"
                data-slot="end-notice"
                className="rounded-md border border-attention/40 bg-attention/10 px-2.5 py-2 text-xs leading-relaxed text-ink"
              >
                {notice}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={cn(BUTTON, "border border-edge bg-surface text-ink hover:bg-bg")}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={phase === "ending" || !connected}
                className={cn(
                  BUTTON,
                  "border border-brand bg-brand text-on-brand hover:opacity-90",
                )}
              >
                {phase === "ending" ? "Ending…" : "End session"}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where End session was, once the session has ended: a chip that says so and opens
 * the same details in a popover. Never faded: an ended session is news.
 */
export function EndedChip({
  command,
  by,
  chipRef,
}: {
  command: string;
  by: Daemon["endedBy"];
  /** The chip itself, so the ended dialog can hand focus back to it on close. */
  chipRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Popover>
      <PopoverTrigger
        ref={chipRef}
        data-slot="ended-chip"
        aria-label="Session ended: how to keep working"
        title="Session ended: how to keep working"
        className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-edge bg-bg px-2 text-xs text-ink outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <InfoIcon aria-hidden className="size-3.5 text-ink-dim" />
        Ended
      </PopoverTrigger>
      <PopoverContent data-slot="ended-popover" className="grid gap-2">
        <PopoverTitle>Session ended</PopoverTitle>
        <EndedDetails command={command} by={by} />
      </PopoverContent>
    </Popover>
  );
}

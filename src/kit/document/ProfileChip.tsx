// The frontmatter header's profile chip: a document's profile warnings collapsed
// into one amber chip ("2 profile warnings"), or, when its kind's profile file is
// broken, a quiet "profile broken". Opening it lists each problem with the file
// whose rule it is, and "Ask the agent to fix", which posts a chat message from
// the human naming the document and the problem.
//
// WARNINGS, NOT ERRORS. Amber (the `attention` token), never red, and nothing
// here touches saving. A document with no warnings and a usable profile draws
// nothing at all.
//
// ASKING MOVES NOTHING. The button posts the message and says so in place: it
// does not open the chat, focus the composer, or take the pointer's press from
// the document (its mousedown is held back, so a selection the human made in
// the text stays theirs).

import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import type { DocumentProfile } from "../workspace/protocol";
import {
  askBrokenText,
  askFixText,
  brokenFileShown,
  profileSentence,
  profileSourceTitle,
  warningCountLabel,
  warningSentence,
} from "./profileHeader.ts";

/** "Ask the agent to fix": the chat message, ready to post. */
export type AskProfileFix = (text: string, profile: DocumentProfile) => void;

const CHIP = "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium";

function AskButton({ onAsk, label, asked }: { onAsk: () => void; label: string; asked: boolean }) {
  return (
    <button
      type="button"
      data-slot="profile-ask"
      aria-label={asked ? `Asked the agent: ${label}` : `Ask the agent to fix: ${label}`}
      // Not `disabled`: a focused button that disables drops focus to the page.
      aria-disabled={asked || undefined}
      // Held back so the press neither takes focus nor collapses a selection.
      onMouseDown={(e) => e.preventDefault()}
      onClick={asked ? undefined : onAsk}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        asked ? "text-ink-faint" : "text-brand hover:bg-brand/10",
      )}
    >
      {asked ? (
        <>
          <CheckIcon aria-hidden className="size-3" />
          Asked in the chat
        </>
      ) : (
        "Ask the agent to fix"
      )}
    </button>
  );
}

export function ProfileChip({
  profile,
  onAsk,
}: {
  profile: DocumentProfile;
  /** Absent (no daemon to post through): the list is shown without the buttons. */
  onAsk?: AskProfileFix;
}) {
  const [open, setOpen] = useState(false);
  // What was asked, by the message posted: it outlives the popover closing, so
  // reopening it still says so, and a warning that changes can be asked again.
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const ask = (text: string) => {
    onAsk?.(text, profile);
    setAsked((was) => new Set(was).add(text));
  };
  const broken = profile.match === "broken";
  const n = profile.warnings.length;
  if (!broken && (profile.match !== "matched" || n === 0)) return null;
  const label = broken ? "profile broken" : warningCountLabel(n);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="profile-chip"
        data-state={broken ? "broken" : "warnings"}
        aria-label={broken ? "Profile broken: show why" : `${label}: show them`}
        title={broken ? "This kind's profile file cannot be used" : label}
        className={cn(
          CHIP,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          broken
            ? "bg-surface-raised text-ink-dim hover:text-ink"
            : "bg-attention/15 text-attention ring-1 ring-attention/30 ring-inset hover:bg-attention/25",
        )}
      >
        <TriangleAlertIcon aria-hidden className="size-3" />
        {label}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        data-slot="profile-popover"
        // Never taller than the room the positioner says there is: the title
        // and the description stay, and the list scrolls inside.
        className="flex max-h-[min(var(--available-height,32rem),32rem)] w-[min(28rem,calc(100vw-1rem))] flex-col"
      >
        {broken ? (
          <>
            <PopoverTitle>Profile broken</PopoverTitle>
            <PopoverDescription className="text-[12px]">
              This document's kind matches nothing until its profile file is fixed, so it is not
              checked. Saving is never blocked.
            </PopoverDescription>
            <div className="mt-2 flex flex-col gap-1 rounded-md bg-surface-raised px-2 py-1.5">
              <span data-slot="profile-reason" className="text-[12px] text-ink">
                {profileSentence(profile.reason ?? "the file cannot be used")}
              </span>
              <span className="flex items-center gap-2">
                <span
                  data-slot="profile-broken-file"
                  className="truncate font-mono text-[10px] text-ink-faint"
                >
                  {brokenFileShown(profile)}
                </span>
                {onAsk && (
                  <span className="ml-auto">
                    <AskButton
                      label={brokenFileShown(profile)}
                      asked={asked.has(askBrokenText(profile))}
                      onAsk={() => ask(askBrokenText(profile))}
                    />
                  </span>
                )}
              </span>
            </div>
          </>
        ) : (
          <>
            <PopoverTitle>{warningCountLabel(n)}</PopoverTitle>
            <PopoverDescription className="text-[12px]">
              Warnings against the {profile.label ?? "kind's"} profile, not errors: saving is never
              blocked.
            </PopoverDescription>
            <ul
              data-slot="profile-warnings"
              className="mt-2 flex min-h-0 flex-col gap-1.5 overflow-y-auto overscroll-contain"
              title={profileSourceTitle(profile)}
            >
              {profile.warnings.map((w, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: one field may fail two rules, and the list is the daemon's, in its order.
                  key={`${w.field}:${w.rule}:${i}`}
                  data-slot="profile-warning"
                  data-field={w.field}
                  data-rule={w.rule}
                  className="flex shrink-0 flex-col gap-0.5 rounded-md bg-surface-raised px-2 py-1.5"
                >
                  <span className="text-[12px] text-ink">{warningSentence(w)}</span>
                  <span className="flex items-center gap-2">
                    <span
                      data-slot="profile-warning-file"
                      className="truncate font-mono text-[10px] text-ink-faint"
                    >
                      {w.fileShown ?? profile.sourceShown}
                    </span>
                    {onAsk && (
                      <span className="ml-auto">
                        <AskButton
                          label={w.message}
                          asked={asked.has(askFixText(profile, w))}
                          onAsk={() => ask(askFixText(profile, w))}
                        />
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

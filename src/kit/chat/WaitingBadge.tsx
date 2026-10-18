// "Something is happening": the reassurance after you send a message, or leave
// a note.
//
// It sits on the message (or the note) it is about, not at the bottom of the
// log and not in a bar of its own: a panel or a status line would be a second
// place to look for one fact, and the fact belongs where the reply is going to
// land.
//
// And `stalled` does not pulse. The animation is a claim, "work is happening",
// so it must not run when the honest answer is "I cannot tell any more". Stalled
// is static, dimmer, and says the quiet part in words.
import { cn } from "../lib/cn.ts";
import type { Waiting } from "../workspace/protocol";

/** The words, kept next to the thing that shows them; `workspace/waiting.ts` has the same (a test holds them equal). */
export const WAITING_LABEL: Record<Waiting["badge"], string> = {
  working: "working on this...",
  stalled: "took this in, then went quiet; may be stuck",
};

/**
 * A note's words. The daemon knows the note was delivered, not that it was
 * read, so they claim no more than "with the agent".
 */
export const NOTE_WAITING_LABEL: Record<Waiting["badge"], string> = {
  working: "with the agent...",
  stalled: "no word from the agent; may be stuck",
};

/**
 * What the badge says while no agent is listening: the surface's own reading of
 * the daemon's `agentListening`, so it is not one of the daemon's badges. "Working"
 * would be a claim nobody is there to make, so this one does not pulse either.
 */
export const UNHEARD_LABEL = "no agent is listening yet; this waits until one is";

/** A badge as the surface shows it: the daemon's two, or `unheard` (`UNHEARD_LABEL`). */
export type BadgeKind = Waiting["badge"] | "unheard";

/** What is waiting: a message or a note. The same rule, each in its own words. */
export type WaitingOf = "message" | "note";

/**
 * The badge to show: `unheard` over the daemon's while no agent listens, except
 * while the agent's own "still working" holds, which is better evidence than
 * presence and must never be overruled by it. A message's wait or a note's.
 */
export function badgeFor(
  waiting: Pick<Waiting, "badge" | "acknowledged">,
  agentListening: boolean,
): BadgeKind {
  return agentListening || waiting.acknowledged ? waiting.badge : "unheard";
}

export const labelOf = (badge: BadgeKind, of: WaitingOf = "message"): string =>
  badge === "unheard" ? UNHEARD_LABEL : (of === "note" ? NOTE_WAITING_LABEL : WAITING_LABEL)[badge];

export function WaitingBadge({
  badge,
  of = "message",
  flush = false,
  className,
}: {
  badge: BadgeKind;
  /** What is waiting: a message, or a note. */
  of?: WaitingOf;
  /** No space above it: on a line of its own rather than under a message. */
  flush?: boolean;
  className?: string;
}) {
  const working = badge === "working";
  return (
    <p
      // A live region, because the whole point is that it appears without the
      // human doing anything, and `polite`, because it must not interrupt.
      aria-live="polite"
      data-badge={badge}
      data-waiting-of={of}
      className={cn(
        "flex items-center gap-1.5 text-[11px]",
        !flush && "mt-1",
        working || badge === "unheard" ? "text-ink-dim" : "text-attention",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 shrink-0 rounded-full",
          working
            ? "animate-pulse bg-brand"
            : badge === "unheard"
              ? "bg-ink-faint"
              : "bg-attention",
        )}
      />
      {labelOf(badge, of)}
    </p>
  );
}

/**
 * The same state as a dot, for where there is no room for words (a tab). Its
 * words are still there for a screen reader, and on hover.
 */
export function WaitingDot({
  badge,
  of = "message",
  label,
}: {
  badge: BadgeKind;
  of?: WaitingOf;
  /** Words to use instead of the badge's own: what a dot standing for several counts. */
  label?: string;
}) {
  const working = badge === "working";
  return (
    <span
      role="img"
      aria-label={label ?? labelOf(badge, of)}
      title={label ?? labelOf(badge, of)}
      data-badge={badge}
      data-waiting-of={of}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        working ? "animate-pulse bg-brand" : badge === "unheard" ? "bg-ink-faint" : "bg-attention",
      )}
    />
  );
}

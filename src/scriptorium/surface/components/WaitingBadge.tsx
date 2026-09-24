// "Something is happening" — the reassurance after you send a message (E53).
//
// ⛔ IT SITS ON THE MESSAGE IT IS ABOUT, not at the bottom of the log and not in
// a bar of its own. mind-mapper's R11 ruling, and the reason carries over: a
// panel or a status line would be a second place to look for one fact, and the
// fact belongs where the reply is going to land.
//
// ⛔ AND `stalled` DOES NOT PULSE. The animation is a claim — "work is
// happening" — so it must not run when the honest answer is "I cannot tell any
// more". Stalled is static, dimmer, and says the quiet part in words.
import { cn } from "cn";
import type { Waiting } from "../../backend/protocol";

/**
 * The words, kept next to the thing that shows them. A note's are its own
 * (E65): the daemon knows the note was delivered, not that it was read, so the
 * note's words claim no more than "with the agent".
 */
const LABEL: Record<"message" | "note" | "asked", Record<Waiting["badge"], string>> = {
  message: {
    working: "working on this…",
    stalled: "took this in, then went quiet — may be stuck",
  },
  note: {
    working: "with the agent…",
    stalled: "no word from the agent — may be stuck",
  },
  // A note the human has asked about (E65, verifier D1): it now waits on that
  // message, and reads E53's badge for it.
  asked: {
    working: "asked in the conversation…",
    stalled: "asked, and still no word — may be stuck",
  },
};

export type WaitingOf = keyof typeof LABEL;

export function WaitingBadge({
  badge,
  of = "message",
  className,
}: {
  badge: Waiting["badge"];
  /** What is waiting — a message (E53) or a note (E65). Same rule, own words. */
  of?: WaitingOf;
  className?: string;
}) {
  const working = badge === "working";
  return (
    <p
      // A live region, because the whole point is that it appears without the
      // human doing anything — and `polite`, because it must not interrupt.
      aria-live="polite"
      className={cn(
        "mt-1 flex items-center gap-1.5 text-[11px]",
        working ? "text-ink-dim" : "text-attention",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 shrink-0 rounded-full",
          working ? "animate-pulse bg-rubric" : "bg-attention",
        )}
      />
      {LABEL[of][badge]}
    </p>
  );
}

/**
 * The same state as a dot, for where there is no room for words — a tab. Its
 * words are still there for a screen reader, and on hover.
 */
export function WaitingDot({
  badge,
  of,
  label,
}: {
  badge: Waiting["badge"];
  of: WaitingOf;
  /** Words to use instead of the badge's own — e.g. what a session-wide dot counts. */
  label?: string;
}) {
  const working = badge === "working";
  return (
    <span
      role="img"
      aria-label={label ?? LABEL[of][badge]}
      title={label ?? LABEL[of][badge]}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        working ? "animate-pulse bg-rubric" : "bg-attention",
      )}
    />
  );
}

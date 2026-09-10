/** What the session-id pill says after a copy attempt, and how long it says it.
 *
 *  ⛔ THE LABEL REPORTS WHAT HAPPENED. Until 2026-09-08 the write was wrapped
 *  in a bare `catch {}` and the label flipped to "Copied!" after it,
 *  unconditionally — so a rejected write told the user their id was on the
 *  clipboard when it was not, and their remedy (pasting it to the agent) failed
 *  with no explanation. `navigator.clipboard` is restricted on a non-secure
 *  origin, under some enterprise policies, and whenever the document is not
 *  focused.
 *
 *  This lives here rather than in the component because it is the whole
 *  decision and it touches nothing — so it can be tested without a DOM, which
 *  is the only way this property is guarded under `bun test`. */
export type CopyOutcome = "copied" | "failed";

export function copyFeedback(ok: boolean): { outcome: CopyOutcome; label: string; holdMs: number } {
  return ok
    ? { outcome: "copied", label: "Copied!", holdMs: 1200 }
    : // Longer, because the message is longer and its remedy is manual: the id
      // is short and selectable by hand (Cole, 2026-09-08).
      { outcome: "failed", label: "Copy failed — select it", holdMs: 2400 };
}

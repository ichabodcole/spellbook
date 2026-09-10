import { useEffect, useRef, useState } from "react";
import { copyFeedback } from "../state/clipboard";

/**
 * The session id, click-to-copy. The id is what the agent needs to relaunch a
 * recovered session (`--id`), which is why it is on screen at all.
 *
 * ⛔ THE LABEL REPORTS WHAT HAPPENED, WHICH IT DID NOT UNTIL 2026-09-08.
 * The write was wrapped in a bare `catch {}` and the label flipped to "Copied!"
 * AFTER it, unconditionally (template.html 1043–1053, ported faithfully, then
 * filed). Driven with `writeText` stubbed to reject: the promise rejects, zero
 * errors reach the page, and the user is told a thing happened that did not —
 * while their remedy, pasting the id to the agent, silently fails.
 *
 * `navigator.clipboard` is restricted on a non-secure origin, under some
 * enterprise policies, and whenever the document is not focused. 127.0.0.1 is a
 * secure context in Chrome and Firefox, so this is not the common case; it is
 * not hypothetical either. On rejection the pill says so and names the fallback
 * (Cole, 2026-09-08) — the id is short and selectable by hand.
 */
export function SessionIdButton({ sessionId }: { sessionId: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);
  const copied = result === "copied";

  return (
    <button
      id="session-id"
      type="button"
      title="Click to copy session ID — give this to the agent if you need to recover an interrupted session"
      data-copied={copied ? "1" : undefined}
      data-copy-failed={result === "failed" ? "1" : undefined}
      onClick={async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(sessionId);
          ok = true;
        } catch {
          // denied, insecure origin, unfocused document, or headless
        }
        const fb = copyFeedback(ok);
        setResult(fb.outcome);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult("idle"), fb.holdMs);
      }}
      className="cursor-pointer rounded-full border border-edge bg-surface-soft px-2.5 py-1.5 font-mono text-[11px] font-bold text-ink-dim hover:bg-surface hover:text-brand-ink data-[copied=1]:border-brand data-[copied=1]:text-brand-strong data-[copy-failed=1]:border-alarm-edge data-[copy-failed=1]:bg-alarm-bg data-[copy-failed=1]:text-alarm"
    >
      {result === "copied"
        ? "Copied!"
        : result === "failed"
          ? "Copy failed — select it"
          : sessionId}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";

/**
 * The session id, click-to-copy. The id is what the agent needs to relaunch a
 * recovered session (`--id`), which is why it is on screen at all.
 *
 * ⚠ A clipboard rejection is SWALLOWED and the label still says "Copied!"
 * (template.html 1043–1053). That is the old page's behaviour and it is carried
 * across deliberately: a headless or permission-denied clipboard would
 * otherwise leave the user with a control that appears to do nothing, and the
 * id is also selectable by hand.
 */
export function SessionIdButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  return (
    <button
      id="session-id"
      type="button"
      title="Click to copy session ID — give this to the agent if you need to recover an interrupted session"
      data-copied={copied ? "1" : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sessionId);
        } catch {
          // denied, insecure origin, or headless — the label still flips
        }
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1200);
      }}
      className="cursor-pointer rounded-full border border-edge bg-surface-soft px-2.5 py-1.5 font-mono text-[11px] font-bold text-ink-dim hover:bg-surface hover:text-brand-ink data-[copied=1]:border-brand data-[copied=1]:text-brand-strong"
    >
      {copied ? "Copied!" : sessionId}
    </button>
  );
}

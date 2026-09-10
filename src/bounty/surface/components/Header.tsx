import { cn } from "cn";
import type { ConnState } from "../state/types";

/** The status dot's three states. Grey while connecting, warm gold with a
 *  glow once connected, danger red once closed. */
const DOT: Record<ConnState, string> = {
  "": "bg-ink-faint",
  connected: "bg-mammoth shadow-[0_0_6px_var(--color-mammoth)]",
  closed: "bg-danger",
};

export function Header({
  title,
  conn,
  statusText,
  sessionId,
}: {
  title: string;
  conn: ConnState;
  statusText: string;
  sessionId: string;
}) {
  return (
    <header className="mb-5 flex items-center justify-between gap-4">
      <div className="flex flex-col items-start gap-[0.2rem]">
        <img src="/assets/wordmark.webp" alt="Bounty Board" className="block h-12 w-auto" />
        <h1 className="m-0 text-base font-medium tracking-[-0.005em] text-ink-dim">{title}</h1>
      </div>
      <div className="text-right text-xs tabular-nums text-ink-dim">
        <span>
          <span
            className={cn(
              "mr-1.5 inline-block size-[0.55rem] rounded-full align-middle transition-colors",
              DOT[conn],
            )}
          />
          <span>{statusText}</span>
        </span>
        <div className="text-ink-faint">
          <code>{sessionId}</code>
        </div>
      </div>
    </header>
  );
}

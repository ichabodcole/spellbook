// H1–H3 — the leaf, `grapevine · <channel>`, and the topic line.

import { cn } from "cn";

export function Header({ channel, topic }: { channel: string; topic: string }) {
  return (
    <header className="flex items-center gap-4 border-b border-edge bg-surface px-6 py-4">
      <span className="text-[22px]">🌿</span>
      <div className="flex-1">
        <h1 className="m-0 text-base font-semibold tracking-[0.01em]">
          grapevine<span className="mx-1.5 text-ink-dim">·</span>
          <span className="text-leaf-soft">{channel}</span>
        </h1>
        <p className={cn("m-0 text-[13px] text-ink-dim", !topic && "italic")}>
          {topic || "no topic set"}
        </p>
      </div>
    </header>
  );
}

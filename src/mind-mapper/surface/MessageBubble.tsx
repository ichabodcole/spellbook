// Sibling of glamour's MessageBubble (adapted, not imported — house rule):
// user right / agent left, ground line above the bubble, who-caption below.
// Tokens instead of glamour's raw palette; ground resolves against map nodes.

import { CheckSquare } from "lucide-react";
import type { MapNode, Message } from "./types";

export function MessageBubble({ message, nodes }: { message: Message; nodes: MapNode[] }) {
  const isUser = message.who === "user";
  const groundTitles = message.ground
    .map((id) => nodes.find((n) => n.id === id)?.title)
    .filter((t): t is string => Boolean(t));

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {groundTitles.length > 0 && (
        <span className="mb-1 flex items-center gap-1 text-[10px] text-canon/90">
          <CheckSquare className="h-3 w-3" />
          about: {groundTitles.join(", ")}
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isUser ? "bg-canon/15 text-ink" : "bg-surface-raised"
        } ${!isUser && message.kind === "info" ? "italic text-ink-faint" : "text-ink"}`}
      >
        {message.text}
      </div>
      <span className="mt-0.5 text-[10px] text-ink-faint">{isUser ? "you" : "agent"}</span>
    </div>
  );
}

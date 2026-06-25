import { CheckSquare } from "lucide-react";
import type { LibraryItem, Message } from "../state/types";

const KIND_TINT: Record<Message["kind"], string> = {
  info: "text-slate-200",
  working: "text-amber-300",
  result: "text-slate-100",
  error: "text-rose-300",
};

export function MessageBubble({ message, library }: { message: Message; library: LibraryItem[] }) {
  const isUser = message.who === "user";
  const groundTitles = message.ground
    .map((id) => library.find((i) => i.id === id)?.title)
    .filter((t): t is string => Boolean(t));

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      {groundTitles.length > 0 && (
        <span className="mb-1 flex items-center gap-1 text-[10px] text-fuchsia-300/90">
          <CheckSquare className="h-3 w-3" />
          about: {groundTitles.join(", ")}
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
          isUser ? "bg-fuchsia-600/20" : "bg-white/5"
        } ${isUser ? "text-slate-100" : KIND_TINT[message.kind]}`}
      >
        {message.text}
      </div>
      <span className="mt-0.5 text-[10px] text-slate-500">{isUser ? "you" : "agent"}</span>
    </div>
  );
}

import { ArrowRight, Bot } from "lucide-react";

export function FocusDrawer({ note, count }: { note: string; count: number }) {
  if (!note) return null;
  return (
    <div className="flex items-start gap-2.5 border-t border-violet-700/40 bg-violet-950/30 px-4 py-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-600">
        <Bot className="h-3.5 w-3.5 text-white" />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-300/80">
          Agent · about these {count}
        </div>
        <div className="mt-0.5 text-xs leading-snug text-slate-200">{note}</div>
      </div>
      <span className="ml-auto mt-0.5 flex shrink-0 items-center gap-1 text-[10px] italic text-slate-500">
        respond in chat <ArrowRight className="h-3 w-3" />
      </span>
    </div>
  );
}

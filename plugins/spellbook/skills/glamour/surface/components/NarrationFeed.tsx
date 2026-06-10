import type { Narration } from "../state/types";

const COLOR: Record<string, string> = {
  info: "text-slate-300",
  working: "text-violet-300",
  result: "text-emerald-300",
  error: "text-rose-300",
};
export function NarrationFeed({ items }: { items: Narration[] }) {
  if (!items.length) return null;
  return (
    <div className="fixed bottom-0 inset-x-0 max-h-40 overflow-y-auto bg-[#0f0b17]/95 border-t border-[#2a2238] p-2 text-xs space-y-1">
      {items.slice(-12).map((n) => (
        <div key={n.id} className={COLOR[n.kind] ?? "text-slate-300"}>
          {n.kind === "working" ? "⋯ " : n.kind === "error" ? "✗ " : "• "}
          {n.text}
        </div>
      ))}
    </div>
  );
}

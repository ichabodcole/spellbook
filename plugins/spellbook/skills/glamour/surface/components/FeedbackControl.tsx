import { useState } from "react";

export type FeedbackMode = "correct" | "augment";

// Two-mode feedback: "that's not quite right" (correct) vs "yes, and…" (augment).
// onSubmit receives the chosen mode + text; the parent decides which message to send.
export function FeedbackControl({
  onSubmit,
}: {
  onSubmit: (mode: FeedbackMode, text: string) => void;
}) {
  const [mode, setMode] = useState<FeedbackMode>("augment");
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(mode, text.trim());
    setText("");
  };
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("augment")}
          className={`text-xs px-3 py-1 rounded border ${mode === "augment" ? "bg-violet-600 text-white border-violet-600" : "border-[#2e2640] text-slate-300"}`}
        >
          yes, and…
        </button>
        <button
          type="button"
          onClick={() => setMode("correct")}
          className={`text-xs px-3 py-1 rounded border ${mode === "correct" ? "bg-amber-600 text-white border-amber-600" : "border-[#2e2640] text-slate-300"}`}
        >
          that's not quite right
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          mode === "augment"
            ? "add more — another lens, a detail to include…"
            : "what's off, and what you'd rather…"
        }
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
        rows={3}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="text-sm px-4 py-2 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        send feedback
      </button>
    </div>
  );
}

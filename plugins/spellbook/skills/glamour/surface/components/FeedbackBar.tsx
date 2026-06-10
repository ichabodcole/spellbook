// surface/components/FeedbackBar.tsx
import { useState } from "react";
import type { ClientToServer, Phase } from "../state/types";

// FEAT-3: always-on, non-terminating feedback channel. Sends a `note` to the
// agent tagged with the current phase (breadcrumb) + correct/augment mode.
// Does NOT end the session. Server echoes it into the narration feed.
export function FeedbackBar({ phase, send }: { phase: Phase; send: (m: ClientToServer) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"correct" | "augment">("augment");
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: "note", text: t, scope: phase, mode });
    setText("");
    setOpen(false);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-40 text-xs px-3 py-2 rounded-full font-medium bg-violet-600 text-white shadow-lg"
      >
        ✎ feedback
      </button>
    );
  }
  return (
    <div className="fixed bottom-3 right-3 z-40 w-72 bg-[#1b1626] border border-[#2e2640] rounded-xl p-3 space-y-2 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-500">note · {phase}</span>
        <button type="button" onClick={() => setOpen(false)} className="text-slate-500 text-xs">
          ✕
        </button>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("augment")}
          className={`text-[11px] px-2 py-1 rounded border ${mode === "augment" ? "bg-violet-600 text-white border-violet-600" : "border-[#2e2640] text-slate-300"}`}
        >
          yes, and…
        </button>
        <button
          type="button"
          onClick={() => setMode("correct")}
          className={`text-[11px] px-2 py-1 rounded border ${mode === "correct" ? "bg-amber-600 text-white border-amber-600" : "border-[#2e2640] text-slate-300"}`}
        >
          not quite
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="a note to the agent — bug, idea, steer…"
        className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-xs text-slate-200 outline-none"
        rows={3}
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim()}
        className="w-full text-xs px-3 py-1.5 rounded-lg font-medium bg-violet-600 text-white disabled:opacity-40"
      >
        send
      </button>
    </div>
  );
}

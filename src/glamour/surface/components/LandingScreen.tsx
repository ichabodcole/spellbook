import { useState } from "react";

const ARCHETYPES: { label: string; starter: string; directSend?: boolean }[] = [
  { label: "Mood board", starter: "I want to create a mood board for " },
  { label: "Define a style", starter: "Help me define an overall visual style for " },
  { label: "Logo / brand mark", starter: "I'm designing a logo / brand mark for " },
  { label: "Full brand board", starter: "I want to build a complete branding board for " },
  {
    label: "Redecorate a space",
    starter: "I want to redesign a space (e.g. a room) with image generation — ",
  },
  {
    label: "Not sure yet",
    starter: "I'm exploring — not sure exactly what yet; let's figure it out.",
    directSend: true,
  },
];

export function LandingScreen({ onStart }: { onStart: (text: string) => void }) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onStart(text);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6 py-12">
      <div className="text-center">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">
          What are you here to do?
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Pick a starting point or describe what you have in mind.
        </p>
      </div>

      <div className="grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
        {ARCHETYPES.map(({ label, starter, directSend }) => (
          <button
            key={label}
            type="button"
            onClick={() => {
              if (directSend) {
                onStart(starter);
              } else {
                setDraft(starter);
              }
            }}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left text-xs text-slate-300 transition-colors hover:border-fuchsia-500/40 hover:bg-fuchsia-500/10 hover:text-slate-100"
          >
            <span className="block font-medium text-slate-200">{label}</span>
            {!directSend && (
              <span className="mt-0.5 block truncate text-[10px] text-slate-500">{starter}</span>
            )}
            {directSend && (
              <span className="mt-0.5 block text-[10px] text-slate-500">send directly →</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex w-full max-w-2xl flex-col gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="…or just say what you're here to do"
          className="min-h-20 max-h-48 w-full resize-y rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-slate-200 outline-none ring-fuchsia-400/50 placeholder:text-slate-600 focus:ring-1"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="rounded-lg bg-fuchsia-600/80 px-4 py-1.5 text-xs text-fuchsia-50 hover:bg-fuchsia-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start →
          </button>
        </div>
      </div>
    </div>
  );
}

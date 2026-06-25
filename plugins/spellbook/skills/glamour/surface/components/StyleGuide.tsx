import type { SectionStatus, StyleSection } from "../state/types";

const DOT: Record<SectionStatus, string> = {
  agreed: "bg-emerald-400",
  forming: "bg-amber-400",
  empty: "bg-slate-600",
};
const BADGE: Record<SectionStatus, string> = {
  agreed: "bg-emerald-500/15 text-emerald-300",
  forming: "bg-amber-500/15 text-amber-300",
  empty: "bg-slate-700/40 text-slate-500",
};
const BORDER: Record<SectionStatus, string> = {
  agreed: "border-emerald-700/40",
  forming: "border-amber-700/40",
  empty: "border-slate-700/50",
};

export function StyleGuide({
  sections,
  canonicalItems = [],
}: {
  sections: StyleSection[];
  canonicalItems?: { id: string; title: string; src: string }[];
}) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-5">
      {sections.map((s) => (
        <div
          key={s.key}
          className={`rounded-lg border bg-slate-800/30 px-4 py-3 ${BORDER[s.status]}`}
        >
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${DOT[s.status]}`} />
            <span className="text-sm font-medium">{s.label}</span>
            <span
              className={`ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${BADGE[s.status]}`}
            >
              {s.status}
            </span>
          </div>

          {s.content && (
            <p className="mt-1.5 pl-3.5 text-xs leading-relaxed text-slate-300">{s.content}</p>
          )}

          {(s.colors ?? []).length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 pl-3.5">
              {(s.colors ?? []).map((c) => (
                <div
                  key={`${c.hex}-${c.name ?? ""}`}
                  className="flex items-center gap-1.5"
                  title={`${c.name ? `${c.name} · ` : ""}${c.hex}`}
                >
                  <span
                    className="h-5 w-5 shrink-0 rounded border border-white/20 shadow-sm"
                    style={{ backgroundColor: c.hex }}
                  />
                  <span className="text-[10px] leading-tight">
                    {c.name && <span className="block text-slate-300">{c.name}</span>}
                    <span className="font-mono text-slate-500">{c.hex}</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {s.prompts.length > 0 && (
            <div className="mt-2 space-y-1.5 pl-3.5">
              {s.prompts.map((p) => (
                <p
                  key={p}
                  className="rounded border border-slate-700/50 bg-slate-900/60 px-2 py-1.5 font-mono text-[11px] text-slate-400"
                >
                  {p}
                </p>
              ))}
            </div>
          )}

          {/* Canonical section is a LIVE view of pinned items — pin an image and
              it appears here (the agent's prose above is optional context). */}
          {s.key === "canonical" ? (
            canonicalItems.length > 0 ? (
              <div className="mt-2 grid grid-cols-3 gap-1.5 pl-3.5">
                {canonicalItems.map(
                  (c) =>
                    c.src && (
                      <img
                        key={c.id}
                        src={c.src}
                        alt={c.title}
                        title={c.title}
                        className="aspect-square w-full rounded border border-white/10 object-cover"
                      />
                    ),
                )}
              </div>
            ) : (
              <p className="mt-1 pl-3.5 text-[10px] text-slate-600">
                pin images (📌) to mark them canonical
              </p>
            )
          ) : (
            s.status === "empty" && (
              <p className="mt-1 pl-3.5 text-[10px] text-slate-600">
                fills in as the conversation converges
              </p>
            )
          )}
        </div>
      ))}
    </div>
  );
}

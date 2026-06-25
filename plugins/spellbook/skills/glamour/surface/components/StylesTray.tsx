import { ArrowRightToLine, Check, Library, Palette, X } from "lucide-react";
import type { SavedStyle } from "../state/types";

export function StylesTray({
  tray,
  inLibrary,
  onBringIn,
  onClose,
}: {
  tray: SavedStyle[];
  inLibrary: (id: string) => boolean;
  onBringIn: (id: string) => void;
  onClose: () => void;
}) {
  const styles = tray.filter((s) => !s.archived);
  return (
    <aside className="absolute bottom-0 left-0 top-0 z-20 flex w-80 flex-col border-r border-white/10 bg-slate-900 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Library className="h-4 w-4 text-fuchsia-300" />
        <span className="text-sm font-semibold">Styles · this project</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="close tray"
          className="ml-auto text-slate-500 hover:text-slate-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="border-b border-white/10 px-4 py-2 text-[10px] leading-snug text-slate-500">
        Styles you've defined in this checkout. Not loaded automatically — bring one in to use it as
        a reference.
      </p>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {styles.length === 0 ? (
          <p className="text-xs text-slate-500">No saved styles yet.</p>
        ) : (
          styles.map((st) => {
            const present = inLibrary(`style-${st.id}`);
            return (
              <div
                key={st.id}
                className="rounded-lg border border-slate-700/60 bg-slate-800/40 p-3"
              >
                <div className="flex items-center gap-1.5">
                  <Palette className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-xs font-medium text-slate-200">{st.label}</span>
                </div>
                {st.text && <p className="mt-1 text-[10px] text-slate-500">{st.text}</p>}
                <p className="mt-1 text-[10px] text-slate-600">
                  {st.canonical.length} canonical image
                  {st.canonical.length === 1 ? "" : "s"}
                </p>
                <button
                  type="button"
                  onClick={() => onBringIn(st.id)}
                  disabled={present}
                  className={`mt-2 flex w-full items-center justify-center gap-1 rounded-md border py-1.5 text-[11px] ${
                    present
                      ? "cursor-default border-slate-700 text-slate-600"
                      : "border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-600/20"
                  }`}
                >
                  {present ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <ArrowRightToLine className="h-3 w-3" />
                  )}
                  {present ? "in palette" : "bring into session"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

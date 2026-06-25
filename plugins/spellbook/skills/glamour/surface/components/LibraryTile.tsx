import { FileText, Heart, Palette, Star } from "lucide-react";
import type { LibraryItem } from "../state/types";

export function LibraryTile({
  item,
  selected,
  onClick,
}: {
  item: LibraryItem;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative aspect-square overflow-hidden rounded-lg border text-left transition-colors ${
        selected
          ? "border-fuchsia-400 ring-2 ring-fuchsia-400/60"
          : "border-white/10 hover:border-white/30"
      }`}
    >
      {item.kind === "style" ? (
        <div className="relative flex h-full flex-col bg-slate-800/80 p-2.5">
          <span className="absolute left-1.5 top-1.5 rounded-full bg-fuchsia-600/80 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-white">
            style
          </span>
          <Palette className="mb-1 mt-3 h-4 w-4 text-slate-500" />
          <p className="line-clamp-3 text-[10px] leading-snug text-slate-400">{item.text}</p>
          {item.canon.length > 0 && (
            <div className="mt-auto flex gap-1 pt-2">
              {item.canon.map((c) => (
                <img
                  key={c.title}
                  src={c.src}
                  alt={c.title}
                  className="h-5 flex-1 rounded-sm object-cover"
                />
              ))}
            </div>
          )}
        </div>
      ) : item.src ? (
        <img src={item.src} alt={item.title} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full flex-col gap-2 bg-white/5 p-3">
          <FileText className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="line-clamp-6 text-xs text-slate-300">{item.text || item.title}</p>
        </div>
      )}
      <div className="absolute right-1 top-1 flex gap-1">
        {item.starred && <Star className="h-4 w-4 fill-amber-300 text-amber-300" />}
        {item.liked && <Heart className="h-4 w-4 fill-rose-400 text-rose-400" />}
      </div>
      <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-[10px] text-slate-200">
        {item.title}
      </div>
    </button>
  );
}

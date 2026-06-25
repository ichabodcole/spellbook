import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect } from "react";
import type { LibraryItem } from "../state/types";

export function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: LibraryItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const item = items[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
      else if (e.key === "ArrowRight") onIndex((index + 1) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);

  if (!item?.src) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85">
      <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-300">
        <span>
          {index + 1} / {items.length} · {item.title}
        </span>
        <button type="button" onClick={onClose} aria-label="close lightbox">
          <X className="h-5 w-5 hover:text-white" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-between gap-2 px-2">
        <button
          type="button"
          onClick={() => onIndex((index - 1 + items.length) % items.length)}
          aria-label="previous"
          className="rounded-full bg-white/10 p-2 hover:bg-white/20"
        >
          <ChevronLeft className="h-6 w-6 text-white" />
        </button>
        <img src={item.src} alt={item.title} className="max-h-full max-w-full object-contain" />
        <button
          type="button"
          onClick={() => onIndex((index + 1) % items.length)}
          aria-label="next"
          className="rounded-full bg-white/10 p-2 hover:bg-white/20"
        >
          <ChevronRight className="h-6 w-6 text-white" />
        </button>
      </div>
    </div>
  );
}

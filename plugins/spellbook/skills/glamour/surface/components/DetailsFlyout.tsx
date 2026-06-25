import { Archive, ArchiveRestore, Heart, Maximize2, Pin, Star, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "../state/types";

export function DetailsFlyout({
  item,
  onStar,
  onLike,
  onAnnotate,
  onCanonical,
  onArchive,
  onClose,
  onEnlarge,
}: {
  item: LibraryItem;
  onStar: (b: boolean) => void;
  onLike: (b: boolean) => void;
  onAnnotate: (human: string) => void;
  onCanonical: (canonical: boolean) => void;
  onArchive: (archived: boolean) => void;
  onClose: () => void;
  onEnlarge?: () => void;
}) {
  const [human, setHuman] = useState(item.annotations.human);
  // Local echo stays live, but the network broadcast is committed deliberately —
  // on blur and on unmount (incl. switching items, since this is keyed by id) —
  // so a multi-word annotation emits ONE event, not one per typing pause. A
  // keystroke debounce still floods agent consumers + the replay log. See
  // grimoire/scenarios/2026-06-24-throttle-agent-facing-event-volume.md.
  const latest = useRef(human);
  const committed = useRef(item.annotations.human);
  const commit = useRef(() => {});
  commit.current = () => {
    if (latest.current !== committed.current) {
      committed.current = latest.current;
      onAnnotate(latest.current);
    }
  };

  useEffect(() => () => commit.current(), []);

  const edit = (v: string) => {
    setHuman(v);
    latest.current = v;
  };

  return (
    <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l border-white/10 bg-black/20 p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 break-all text-sm font-semibold">{item.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          title="Close panel"
          className="shrink-0"
        >
          <X className="h-4 w-4 text-slate-400 hover:text-slate-200" />
        </button>
      </div>

      {item.src ? (
        <button
          type="button"
          className="relative overflow-hidden rounded-lg"
          onClick={() => onEnlarge?.()}
          title="Enlarge (focus / lightbox)"
        >
          <img src={item.src} alt={item.title} className="w-full" />
          <Maximize2 className="absolute right-2 top-2 h-4 w-4 text-white/80" />
        </button>
      ) : (
        <pre className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded bg-white/5 p-2 text-xs text-slate-300">
          {item.text}
        </pre>
      )}

      <div className="flex items-center gap-2 text-xs">
        <span className="rounded bg-white/10 px-2 py-0.5">{item.kind}</span>
        <button
          type="button"
          onClick={() => onStar(!item.starred)}
          className="ml-auto"
          aria-label="star"
          title={item.starred ? "Unstar" : "Star — shortlist (keep this in play)"}
        >
          <Star
            className={`h-4 w-4 ${item.starred ? "fill-amber-300 text-amber-300" : "text-slate-400"}`}
          />
        </button>
        <button
          type="button"
          onClick={() => onLike(!item.liked)}
          aria-label="like"
          title={item.liked ? "Unlike" : "Like — taste signal (this is the vibe)"}
        >
          <Heart
            className={`h-4 w-4 ${item.liked ? "fill-rose-400 text-rose-400" : "text-slate-400"}`}
          />
        </button>
        {item.kind !== "style" && (
          <button
            type="button"
            onClick={() => onCanonical(!item.canonical)}
            aria-label="pin as canonical reference"
            title="Pin as a canonical reference — pinned images travel with the saved style"
          >
            <Pin
              className={`h-4 w-4 ${item.canonical ? "fill-fuchsia-300 text-fuchsia-300" : "text-slate-400"}`}
            />
          </button>
        )}
        <button
          type="button"
          onClick={() => onArchive(!item.archived)}
          aria-label={item.archived ? "unarchive" : "archive"}
          title={item.archived ? "Unarchive" : "Archive (hide from the gallery)"}
        >
          {item.archived ? (
            <ArchiveRestore className="h-4 w-4 text-emerald-300" />
          ) : (
            <Archive className="h-4 w-4 text-slate-400 hover:text-slate-200" />
          )}
        </button>
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Agent</p>
        <p className="rounded bg-white/5 p-2 text-xs text-slate-300">
          {item.annotations.agent || <span className="text-slate-500">— no agent note yet —</span>}
        </p>
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">You</p>
        <textarea
          value={human}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => commit.current()}
          placeholder="what do you like about this?"
          className="h-20 w-full resize-none rounded bg-white/5 p-2 text-xs text-slate-200 outline-none ring-fuchsia-400/50 focus:ring-1"
        />
      </div>

      {item.gen && (
        <div className="text-xs">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-500">Generation</p>
          <dl className="space-y-1 text-slate-300">
            <div className="flex gap-2">
              <dt className="text-slate-500">model</dt>
              <dd>{item.gen.model}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-slate-500">round</dt>
              <dd>{item.gen.round}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-slate-500">prompt</dt>
              <dd className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white/5 p-1.5">
                {item.gen.prompt}
              </dd>
            </div>
            {item.gen.seed != null && (
              <div className="flex gap-2">
                <dt className="text-slate-500">seed</dt>
                <dd>{item.gen.seed}</dd>
              </div>
            )}
            {item.gen.cost != null && (
              <div className="flex gap-2">
                <dt className="text-slate-500">cost</dt>
                <dd>${item.gen.cost.toFixed(4)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </aside>
  );
}

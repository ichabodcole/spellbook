import { Heart, Star } from "lucide-react";
import { useState } from "react";
import { Lightbox } from "../components/Lightbox";
import type { GlamourState, Variant } from "../state/types";

interface SpecGalleryProps {
  state: GlamourState;
}

export function SpecGallery({ state }: SpecGalleryProps) {
  const [zoom, setZoom] = useState<Variant | null>(null);

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center">
        <div className="section-title">Gallery · everything generated</div>
        <span className="text-faint ml-auto">★ canonical · ♥ liked · round #</span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {state.variants.map((v) => (
          <div key={v.id} className="tile">
            <button type="button" className="block w-full h-full" onClick={() => setZoom(v)}>
              <img src={v.src} alt={v.label || v.prompt} className="w-full h-full object-cover" />
            </button>
            {/* Non-interactive indicators of the choices made */}
            {v.canonical && (
              <div className="absolute top-1 left-1 z-10 pointer-events-none">
                <Star className="w-3.5 h-3.5 text-amber-300 fill-current drop-shadow" />
              </div>
            )}
            {v.liked && (
              <div className="absolute top-1 right-1 z-10 pointer-events-none">
                <Heart className="w-3.5 h-3.5 text-rose-300 fill-current drop-shadow" />
              </div>
            )}
            <div className="absolute bottom-1 left-1 z-10 pointer-events-none">
              <span className="badge-muted !text-[9px] !py-0">round {v.round}</span>
            </div>
          </div>
        ))}
      </div>

      {zoom && (
        <Lightbox src={zoom.src} alt={zoom.label || zoom.prompt} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}

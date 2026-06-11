import { Star } from "lucide-react";
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
        <span className="text-faint ml-auto">★ = canonical</span>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {state.variants.map((v) => (
          <div key={v.id} className="tile">
            <button type="button" className="block w-full h-full" onClick={() => setZoom(v)}>
              <img src={v.src} alt={v.label || v.prompt} className="w-full h-full object-cover" />
            </button>
            {v.canonical && (
              <div className="absolute top-1 left-1 z-10 pointer-events-none">
                <Star className="w-3.5 h-3.5 text-amber-300 fill-current" />
              </div>
            )}
          </div>
        ))}
      </div>

      {zoom && (
        <Lightbox src={zoom.src} alt={zoom.label || zoom.prompt} onClose={() => setZoom(null)} />
      )}
    </div>
  );
}

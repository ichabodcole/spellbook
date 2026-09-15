// surface/components/Lightbox.tsx
import { useEffect } from "react";

// Full-screen image view at true aspect ratio. Dismiss via Escape or click-out
// (also addresses the old un-dismissable overlay, dogfood BUG-2).
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <button
      type="button"
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
    >
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg" />
    </button>
  );
}

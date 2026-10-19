import { type RefObject, useLayoutEffect, useState } from "react";
import { FALLBACK_SIZE, type Size } from "../lib/viewport.ts";

/**
 * A pane's size, kept current: a ResizeObserver where there is one, and the
 * window's resize as well. A pane that reports nothing is FALLBACK_SIZE.
 * Shared by Atlas's map and the kit's image viewer.
 */
export function usePaneSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(FALLBACK_SIZE);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const next =
        r.width > 0 && r.height > 0
          ? { w: Math.round(r.width), h: Math.round(r.height) }
          : FALLBACK_SIZE;
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next));
    };
    measure();
    // The column beside it resizing moves the pane without moving the window,
    // so the observer is what matters; the window's resize is the backstop.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return size;
}

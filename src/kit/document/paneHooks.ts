// THE PANE'S SMALL HOOKS: its own width, the status strip's counts, and the
// clock the "Updated" time is read against. Hooks of `DocumentPane`'s, each
// called where it was called before, so the hooks keep their order.

import { useEffect, useLayoutEffect, useState } from "react";
import { contentStats } from "../ui/index.ts";

/**
 * The pane's own width, watched: a container query can restyle a layout but cannot
 * change a MODE. Measured once before the first paint, so a saved split in a narrow
 * pane is drawn as raw from the start rather than flashing split and then falling
 * back; 0 until then (and where nothing lays out, as in a test DOM) reads as fitting.
 */
export function usePaneWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Recount after typing pauses: counting a long document on every key would be the slowest thing here. */
export function useDebouncedStats(text: string | undefined, ms = 300) {
  const [stats, setStats] = useState(() => contentStats(text ?? ""));
  useEffect(() => {
    const t = setTimeout(() => setStats(contentStats(text ?? "")), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return stats;
}

/** Re-render on a slow clock so "5 min ago" stays true. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

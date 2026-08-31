import { useEffect } from "react";

// Tab title + favicon dot, so a needs-you lands even on another tab (ported from
// the t13 surface). Reads the dot color from the live theme tokens (so a
// data-theme swap recolors it; the board uses bg-attention/bg-positive, so those
// vars are emitted, not tree-shaken). Setting a <link rel=icon> data-URL also
// stops the browser's default /favicon.ico request (no stray 404).
export function useReflectAttention(attentionCount: number, title: string) {
  useEffect(() => {
    const base = title || "Observatory";
    document.title = (attentionCount > 0 ? `● (${attentionCount}) ` : "") + base;
    try {
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const cs = getComputedStyle(document.body);
      const tok = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
      ctx.fillStyle =
        attentionCount > 0
          ? tok("--color-attention", "#f59e0b")
          : tok("--color-positive", "#34d399");
      ctx.beginPath();
      ctx.arc(16, 16, 12, 0, Math.PI * 2);
      ctx.fill();
      let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = c.toDataURL("image/png");
    } catch {
      /* favicon is best-effort */
    }
  }, [attentionCount, title]);
}

// surface/components/breakdown/typeColor.ts
// The single source of truth for element-type → color. Types are grouped into
// three identity bands (the magpie palette lives as CSS tokens in styles.css, so
// the eventual identity re-skin is a one-file swap — no hex literals in
// components). Returns a CSS `var(...)` so it themes through the token layer.
import type { ElementType } from "../../state/types";

type TypeBand = "mark" | "pictorial" | "meta";

const BAND: Record<ElementType, TypeBand> = {
  wordmark: "mark",
  tagline: "mark",
  typography: "mark",
  icon: "pictorial",
  illustration: "pictorial",
  sticker: "pictorial",
  palette: "meta",
  screenshot: "meta",
  other: "meta",
};

// the type's band color, as a themeable CSS variable reference.
export function typeColor(t: ElementType): string {
  return `var(--color-type-${BAND[t]})`;
}

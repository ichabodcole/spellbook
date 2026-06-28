// surface/state/alpha.ts
// The type-driven alpha policy — which ELEMENT TYPES get background removal.
// Browser-safe (no node:*, no Bun): the surface reads it to show "Remove bg" vs a
// "kept whole" note; scripts/backend.ts + remove.py mirror the same rule. This is
// about element TYPES (which live in the UI), NOT models (which never do).
import type { ElementType } from "./types";

export type AlphaPolicy = "auto" | "all" | "none";

// rembg reliably produces usable alpha for these (under `auto`).
export const ALPHA_AUTO_TYPES: ReadonlySet<ElementType> = new Set([
  "illustration",
  "sticker",
  "icon",
  "wordmark",
]);

// rembg destroys these (flat-color content) — never alpha them, even under `all`.
export const ALPHA_FORBIDDEN_TYPES: ReadonlySet<ElementType> = new Set([
  "palette",
  "screenshot",
  "typography",
]);

// Should an element of `type` get background removal under `policy`? Mirrors
// remove.py's should_remove exactly.
export function shouldRemove(type: string, policy: AlphaPolicy): boolean {
  if (policy === "none") return false;
  if (policy === "all") return !ALPHA_FORBIDDEN_TYPES.has(type as ElementType);
  return ALPHA_AUTO_TYPES.has(type as ElementType); // auto (default)
}

// Surface helper: is this element type a candidate for removal under the default
// `auto` policy? Drives the "Remove bg" action vs the "kept whole" explainer.
export function isAlphaEligible(type: ElementType): boolean {
  return ALPHA_AUTO_TYPES.has(type);
}

// Is this type explicitly kept whole (flat color rembg would destroy)?
export function isKeptWhole(type: ElementType): boolean {
  return ALPHA_FORBIDDEN_TYPES.has(type);
}

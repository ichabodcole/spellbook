// surface/state/constants.ts
import type { Phase } from "./types";

export const PHASES: { key: Phase; label: string }[] = [
  { key: "gather", label: "Gather" },
  { key: "analysis", label: "Analyze" },
  { key: "direction", label: "Direction" },
  { key: "prompts", label: "Prompts" },
  { key: "variants", label: "Variants" },
  { key: "spec", label: "Spec" },
];

export const ASPECTS = [
  "color",
  "light",
  "subject",
  "style",
  "composition",
  "type",
  "mood",
  "accent",
] as const;

export const STEER_CHIPS = [
  "warmer / more sun-faded",
  "less neon",
  "more negative space",
  "tighter crop",
  "softer grain",
  "bolder type",
] as const;

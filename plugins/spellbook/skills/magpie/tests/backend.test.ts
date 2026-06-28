// Pure unit tests for the alpha-policy decision in backend.ts (shouldRemove).
// This is the TypeScript mirror of remove.py's should_remove; the two must agree
// on intent. No subprocess / no rembg — fast and deterministic.

import { expect, test } from "bun:test";
import { type AlphaPolicy, shouldRemove } from "../scripts/backend";
import { ELEMENT_TYPES } from "../surface/state/types";

// The 9 element types from the taxonomy, plus the policy axis.
const TYPES = ELEMENT_TYPES; // wordmark, tagline, icon, illustration, sticker, palette, typography, screenshot, other
const GRAPHIC = new Set(["illustration", "sticker", "icon", "wordmark"]); // auto-removed
const FORBIDDEN = new Set(["palette", "screenshot", "typography"]); // never removed

test("taxonomy has all 9 element types", () => {
  expect(TYPES).toHaveLength(9);
});

test("policy 'none' never removes — for every type", () => {
  for (const t of TYPES) {
    expect(shouldRemove(t, "none")).toBe(false);
  }
});

test("policy 'auto' removes only the 4 graphic types", () => {
  for (const t of TYPES) {
    expect(shouldRemove(t, "auto")).toBe(GRAPHIC.has(t));
  }
});

test("policy 'all' removes everything except the 3 forbidden flat-color types", () => {
  for (const t of TYPES) {
    expect(shouldRemove(t, "all")).toBe(!FORBIDDEN.has(t));
  }
});

test("palette / screenshot / typography never get alpha under 'all'", () => {
  for (const t of ["palette", "screenshot", "typography"]) {
    expect(shouldRemove(t, "all")).toBe(false);
  }
});

test("full 9 × 3 matrix is internally consistent", () => {
  const policies: AlphaPolicy[] = ["auto", "all", "none"];
  for (const t of TYPES) {
    for (const p of policies) {
      const got = shouldRemove(t, p);
      const want = p === "none" ? false : p === "all" ? !FORBIDDEN.has(t) : GRAPHIC.has(t);
      expect(got).toBe(want);
    }
  }
});

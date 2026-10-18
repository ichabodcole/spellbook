// Painting highlights never spreads its ranges as arguments: past the engine's
// argument limit that throws, and a throw in a layout effect blanked the page.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { highlightRegistry, makeHighlight, paintHighlight } from "./highlight.ts";

/** A Highlight that, like the real one, takes ranges as constructor arguments or by `add`. */
class FakeHighlight extends Set<unknown> {
  constructor(...ranges: unknown[]) {
    super(ranges);
  }
}
const registry = new Map<string, FakeHighlight>();
let before: PropertyDescriptor | undefined;

beforeEach(() => {
  before = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights: registry },
    configurable: true,
    writable: true,
  });
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
});
afterEach(() => {
  registry.clear();
  delete (globalThis as { Highlight?: unknown }).Highlight;
  if (before) Object.defineProperty(globalThis, "CSS", before);
  else delete (globalThis as { CSS?: unknown }).CSS;
});

test("a million ranges are painted without overflowing the stack", () => {
  // More than any engine takes as spread arguments (Bun throws well before this).
  const ranges = Array.from({ length: 1_000_000 }, () => ({}) as Range);
  expect(() => paintHighlight("find-match", ranges)).not.toThrow();
  expect(registry.get("find-match")?.size).toBe(1_000_000);
});

test("without the API nothing is painted, and nothing throws", () => {
  delete (globalThis as { Highlight?: unknown }).Highlight;
  expect(highlightRegistry()).toBeNull();
  expect(makeHighlight([])).toBeNull();
  expect(paintHighlight("find-match", [])).toBe(false);
});

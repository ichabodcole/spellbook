// The drop geometry. These cells exist because a drag is a POINTER SEQUENCE
// and a browser drive of it is expensive and flaky; the arithmetic that decides
// where the card lands should not need a browser to be checked at all.
import { describe, expect, test } from "bun:test";
import { type CardBox, dropIndex, dropMarker } from "./drag";

// Three 100px cards stacked from y=0: midpoints at 50, 150, 250.
const boxes: CardBox[] = [
  { id: "a", top: 0, height: 100 },
  { id: "b", top: 100, height: 100 },
  { id: "c", top: 200, height: 100 },
];

describe("dropIndex (D12)", () => {
  test("above the first midpoint -> 0", () => {
    expect(dropIndex(boxes, 0)).toBe(0);
    expect(dropIndex(boxes, 49)).toBe(0);
  });
  test("exactly ON a midpoint belongs to the card BELOW it (strict <)", () => {
    expect(dropIndex(boxes, 50)).toBe(1);
    expect(dropIndex(boxes, 150)).toBe(2);
  });
  test("past the last midpoint -> append", () => {
    expect(dropIndex(boxes, 999)).toBe(3);
  });
  test("an empty column always appends at 0", () => {
    expect(dropIndex([], 42)).toBe(0);
  });
});

describe("dropMarker (D8, D10)", () => {
  test("before the card the drop would push down", () => {
    expect(dropMarker(boxes, 10)).toEqual({ id: "a", edge: "before" });
    expect(dropMarker(boxes, 160)).toEqual({ id: "c", edge: "before" });
  });
  test("after the LAST card when the drop appends", () => {
    expect(dropMarker(boxes, 999)).toEqual({ id: "c", edge: "after" });
  });
  test("an empty column has no card to mark — the drop zone's own border is the cue", () => {
    expect(dropMarker([], 42)).toBeNull();
  });
});

import { expect, test } from "bun:test";
import type { Mark } from "../../../../../plugins/spellbook/skills/imago/shared/types";
import { eraseMarks, erasePolyline } from "./erase";

/**
 * Element `i` of a list this test's own setup is contracted to have filled, or a
 * failure NAMING that contract (type-debt T11/T22: a LOCAL copy — a test under
 * `src/` imports nothing from `grimoire/`). Not `?.`: `expect(xs[1]?.src)
 * .toBeUndefined()` passes when there is no element at all.
 */
function at<T>(xs: readonly T[] | undefined, i: number, what: string): T {
  const v = xs?.[i];
  if (v === undefined) throw new Error(`INVARIANT VIOLATED — ${what} has an element ${i}`);
  return v;
}

const R = 0.025;
// a horizontal stroke at y=0.5, x = 0.1 … 0.9 (9 evenly spaced points)
const linePts = Array.from({ length: 9 }, (_, i) => ({ x: 0.1 + i * 0.1, y: 0.5 }));
const stroke: Mark = { id: "s", tool: "draw", points: linePts, color: "#fff", width: 4 };
const pin: Mark = { id: "p", tool: "pin", label: "n", x: 0.5, y: 0.5 };

const drawn = (marks: Mark[]) =>
  marks.filter((m): m is Extract<Mark, { tool: "draw" }> => m.tool === "draw");

test("erasePolyline: far path keeps the whole stroke as one run", () => {
  const runs = erasePolyline(linePts, [{ x: 0.5, y: 0.9 }], R);
  expect(runs.length).toBe(1);
  expect(at(runs, 0, "runs").length).toBe(9);
});

test("erasePolyline: erasing the middle splits into two runs", () => {
  const runs = erasePolyline(linePts, [{ x: 0.5, y: 0.5 }], R);
  expect(runs.length).toBe(2);
  expect(at(runs, 0, "runs").length).toBe(4); // 0.1–0.4
  expect(at(runs, 1, "runs").length).toBe(4); // 0.6–0.9
});

test("eraseMarks: erase nothing → identity (same points, count)", () => {
  const out = eraseMarks([stroke], [{ x: 0.5, y: 0.9 }], R);
  expect(out.length).toBe(1);
  expect(at(out, 0, "out").id).toBe("s");
  expect(at(drawn(out), 0, "the drawn marks").points.length).toBe(9);
});

test("eraseMarks: erase an endpoint → trims the stroke (same id, fewer points)", () => {
  const out = eraseMarks([stroke], [{ x: 0.9, y: 0.5 }], R);
  expect(out.length).toBe(1);
  expect(at(out, 0, "out").id).toBe("s");
  expect(at(drawn(out), 0, "the drawn marks").points.length).toBe(8); // 0.9 removed, 0.1–0.8 survive
});

test("eraseMarks: erase the middle → splits into two draw marks (first keeps id)", () => {
  const out = eraseMarks([stroke], [{ x: 0.5, y: 0.5 }], R);
  expect(out.length).toBe(2);
  expect(at(out, 0, "out").id).toBe("s"); // first run keeps the id
  expect(at(out, 1, "out").id).not.toBe("s"); // second run is a new mark
  expect(at(out, 1, "out").tool).toBe("draw");
  expect(at(drawn(out), 0, "the drawn marks").points.length).toBe(4);
  expect(at(drawn(out), 1, "the drawn marks").points.length).toBe(4);
  // split copies style
  expect(at(drawn(out), 1, "the drawn marks").color).toBe("#fff");
  expect(at(drawn(out), 1, "the drawn marks").width).toBe(4);
});

test("eraseMarks: scrubbing the whole stroke drops it", () => {
  const out = eraseMarks([stroke], linePts, R); // path over every point
  expect(out.length).toBe(0);
});

test("eraseMarks: non-draw marks pass through untouched", () => {
  const out = eraseMarks([pin, stroke], linePts, R);
  expect(out.length).toBe(1);
  expect(out[0]).toBe(pin); // same reference, the stroke is gone
});

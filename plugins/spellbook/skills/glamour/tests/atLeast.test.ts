import { expect, test } from "bun:test";
import { atLeast } from "../surface/state/atLeast";

test("atLeast is true when current phase is at or past target", () => {
  expect(atLeast("direction", "gather")).toBe(true);
  expect(atLeast("direction", "direction")).toBe(true);
  expect(atLeast("gather", "direction")).toBe(false);
  expect(atLeast("spec", "variants")).toBe(true);
});

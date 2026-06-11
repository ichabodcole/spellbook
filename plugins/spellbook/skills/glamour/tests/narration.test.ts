import { expect, test } from "bun:test";
import { defaultState } from "../surface/state/types";

test("state carries a narration array and content-bearing spec modules", () => {
  const s = defaultState("X", "");
  expect(Array.isArray(s.narration)).toBe(true);
  expect(s.spec.modules[0]).toHaveProperty("content");
});

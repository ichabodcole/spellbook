import { expect, test } from "bun:test";
import { advancePhase } from "../scripts/server";

test("advancePhase moves forward only, never backward", () => {
  expect(advancePhase("gather", "analysis")).toBe("analysis");
  expect(advancePhase("analysis", "direction")).toBe("direction");
  expect(advancePhase("prompts", "variants")).toBe("variants");
  expect(advancePhase("variants", "direction")).toBe("variants");
  expect(advancePhase("spec", "gather")).toBe("spec");
  expect(advancePhase("prompts", "prompts")).toBe("prompts");
});

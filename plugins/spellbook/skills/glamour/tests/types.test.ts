import { expect, test } from "bun:test";
import { AGENT_EVENT_TYPES, defaultState } from "../surface/state/types";

test("agent event set is complete and frozen", () => {
  expect(AGENT_EVENT_TYPES).toContain("steer");
  expect(AGENT_EVENT_TYPES).toContain("direction.correct");
  expect(AGENT_EVENT_TYPES).toContain("variant.like");
  expect(Object.isFrozen(AGENT_EVENT_TYPES)).toBe(true);
});

test("defaultState seeds gather phase with empty collections", () => {
  const s = defaultState("Glamour", "");
  expect(s.phase).toBe("gather");
  expect(s.influences).toEqual([]);
  expect(s.narration).toEqual([]);
});

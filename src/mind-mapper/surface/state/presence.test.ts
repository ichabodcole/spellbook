// Pure-logic test for the presence dot rule (Claim C).

import { expect, test } from "bun:test";
import { dotState } from "./presence";

test("a closed socket reads unreachable regardless of the last-known agents count", () => {
  expect(dotState("closed", 0)).toBe("unreachable");
  expect(dotState("closed", 3)).toBe("unreachable");
});

test("a connecting socket also reads unreachable (no live measurement yet)", () => {
  expect(dotState("connecting", 1)).toBe("unreachable");
});

test("open with zero agents is connected-no-agent", () => {
  expect(dotState("open", 0)).toBe("connected-no-agent");
});

test("open with any agents is agent-here", () => {
  expect(dotState("open", 1)).toBe("agent-here");
  expect(dotState("open", 2)).toBe("agent-here");
});
